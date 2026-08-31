# Backend Optimization Plan

Status as of 2026-08-30. Written for step-by-step execution by a person or an AI
agent, one phase/step at a time, with progress checkpointed in the table at the
bottom of this file (update it as you go — that table is the source of truth for
"what's left").

## How to use this plan

- Work top to bottom. Phases 0–2 are unconditionally recommended (low risk, no
  architecture change, pure runtime wins). Phases 3–4 are **decision points** —
  read the tradeoffs, pick an option (or "do nothing"), record the choice in the
  progress table, then execute only the steps for the chosen option.
- Each step is small enough to be one commit. Commit after each step so progress
  is resumable and bisectable if something regresses.
- After any step that touches `generate_csv`, run it against a copy of real (or
  representative) data and diff the output CSV against the pre-change CSV to
  confirm no behavior change, unless the step is explicitly a behavior change.
- "Runtime" below means Lambda wall-clock duration (billed duration), which is
  dominated by network I/O (S3/Drive round trips) in every one of these
  functions, not CPU. That's why concurrency (parallel requests), not
  micro-optimizing JS, is the highest-leverage lever throughout.

## Current architecture (for context, not something to change)

5 Lambdas, 2 main S3 buckets (`SURVEY_BUCKET` for survey JSON/CSV, `RESOURCES_BUCKET`
for the resources dataset + analytics), plus Google Drive as the durable/human-facing
store:

1. `process_response` — API endpoint, appends one survey response to a monthly
   JSON file in `SURVEY_BUCKET` (`json/{yyyy-mm}.json` / `test_json/{yyyy-mm}.json`).
2. `get_local_resources` — API endpoint, serves resources near a ZIP from
   `resources.csv`, writes one analytics JSON per request to `data/new/` in
   `RESOURCES_BUCKET`.
3. `download_from_drive` — scheduled, pulls `resources.csv` from a Drive Sheet into
   `RESOURCES_BUCKET`.
4. `generate_csv` — scheduled, rebuilds `csv/*.csv` and `test_csv/*.csv` from all
   survey JSON, merging in resource analytics. **Primary optimization target.**
5. `upload_to_drive` — scheduled, syncs JSON/CSV from S3 to Drive for human access.

## Phase 0 — Baseline & measurement

Do this before changing anything, so later phases have a before/after number
instead of a guess. You said things are "fine for now" — this phase exists to
confirm that and catch anything surprising cheaply.

- [x] **0.1** For each of the 5 functions, record current config:
  ```bash
  for fn in processResponse getLocalResources downloadFromDrive generateCsv uploadToDrive; do
    echo "== $fn =="
    aws lambda get-function-configuration --function-name "$fn" \
      --query '{Runtime:Runtime,Memory:MemorySize,Timeout:Timeout,Layers:Layers[*].Arn}'
  done
  ```
- [x] **0.2** Pull last 20 durations for `generateCsv` specifically (it's the target):
  ```bash
  aws logs filter-log-events --log-group-name /aws/lambda/generateCsv \
    --filter-pattern "REPORT" --max-items 20 \
    --query 'events[*].message' --output text
  ```
  Each `REPORT` line has `Duration`, `Billed Duration`, `Max Memory Used`. Note
  these in the progress table (`Baseline` row) so Phase 1's effect is measurable.
- [SKIP] **0.3** Confirm Node.js runtime version across functions (`nodejs18.x` /
  `20.x` / `22.x` from 0.1). If any function is still on `nodejs18.x`, bumping to
  `nodejs22.x` is a free win (faster cold start, newer V8) — schedule it as a
  quick config-only change (`aws lambda update-function-configuration --runtime nodejs22.x`)
  with a smoke test after, independent of everything else here.

## Phase 1 — `generate_csv` concurrency (no architecture change)

Everything in this phase is: replace a sequential `for` loop of AWS SDK calls
with a concurrency-limited parallel one. Same S3 calls, same data, same output —
just issued concurrently instead of one-at-a-time. This is safe because none of
these S3 calls depend on each other's results (each `Get`/`Copy`/`Delete` targets
a different key).

Add `p-limit` to `generate_csv` (already a dependency in `download_from_drive`
and `upload_to_drive`, so it's a proven, already-vetted choice — no new library
to evaluate):

```bash
cd src/backend/generate_csv && npm install p-limit
```

Remember to add `p-limit`'s entry to `deploy_list.txt` if it isn't picked up
automatically by however `node_modules` gets bundled into the layer (check
`deploy.sh` step 4 — it zips `node_modules` wholesale, so this should be automatic,
but confirm after deploying).

- [x] **1.1** Parallelize analytics file fetching in `fetchResourceAnalytics`
  (currently: one `GetObjectCommand` per file, awaited sequentially in a `for`
  loop — [index.mjs:43-53](generate_csv/src/index.mjs#L43-L53)):

  ```js
  import pLimit from 'p-limit';
  const limit = pLimit(10); // tune after Phase 0 baseline; 10 is a safe starting point

  const results = await Promise.allSettled(files.map(key => limit(async () => {
      const response = await s3.send(new GetObjectCommand({ Bucket: RESOURCES_BUCKET, Key: key }));
      const jsonStr = await response.Body.transformToString();
      const data = JSON.parse(jsonStr);
      const isTest = key.endsWith('_test.json') || data.is_test === true;
      return { key, data, isTest };
  })));

  const test = [], real = [];
  for (const r of results) {
      if (r.status === 'rejected') {
          console.warn('[analytics] Error fetching/parsing analytics file, skipping:', r.reason);
          continue;
      }
      (r.value.isTest ? test : real).push({ key: r.value.key, data: r.value.data });
  }
  ```
  Using `allSettled` (rather than `all`) means one failed fetch never aborts the
  whole batch — each file's success/failure is independent.

- [x] **1.2** Parallelize survey file fetching in `processDirectory` step 2
  ([index.mjs:133-157](generate_csv/src/index.mjs#L133-L157)). This one is
  slightly trickier because a single fetch failure currently aborts the whole
  run (`return { message: ... }` inside the loop) — preserve that behavior:

  ```js
  const results = await Promise.all(files.map(filePath => limit(async () => {
      const response = await s3.send(new GetObjectCommand({ Bucket: SURVEY_BUCKET, Key: filePath }));
      const jsonStr = await response.Body.transformToString();
      return { filePath, entries: JSON.parse(jsonStr) };
  })));
  // if any promise rejected, Promise.all above throws — wrap the whole block in
  // try/catch (as the surrounding code already does) to preserve the existing
  // "abort on first fetch error" behavior and error message.

  const allEntries = [];
  let hasNewData = false;
  const fileEntries = {};
  const dirtyFiles = new Set();

  for (const { filePath, entries } of results) {
      fileEntries[filePath] = entries;
      let fileHasNewData = false;
      for (const entry of entries) {
          entry[SOURCE_FILE] = filePath;
          if (!entry.generated_as_csv) { hasNewData = true; fileHasNewData = true; }
          allEntries.push(entry);
      }
      if (fileHasNewData) dirtyFiles.add(filePath);
  }
  ```

- [x] **1.3** Parallelize the copy+delete pair per analytics file in
  `mergeResourceAnalytics` ([index.mjs:89-98](generate_csv/src/index.mjs#L89-L98)).
  Note the copy and delete *within* one file must stay sequential (can't delete
  before the copy confirms), but different files are independent:

  ```js
  await Promise.allSettled(analyticsFiles.map(({ key, data }) => limit(async () => {
      const fileName = key.slice(ANALYTICS_SOURCE_PREFIX.length);
      const match = data.session_id ? bySessionId[data.session_id] : null;

      let destKey;
      if (!match) {
          destKey = `data/unmatched/${fileName}`;
      } else {
          const rawEntry = match[RAW_ENTRY];
          for (const [srcKey, dest] of Object.entries(ANALYTICS_RENAME_KEYS)) {
              const value = data[srcKey];
              match[dest] = value;
              if (rawEntry) rawEntry[dest] = value;
          }
          if (rawEntry?.[SOURCE_FILE]) dirtyFiles.add(rawEntry[SOURCE_FILE]);
          destKey = `data/${fileName.slice(0, 7)}/${fileName}`;
      }

      try {
          await s3.send(new CopyObjectCommand({ Bucket: RESOURCES_BUCKET, CopySource: `${RESOURCES_BUCKET}/${key}`, Key: destKey }));
          await s3.send(new DeleteObjectCommand({ Bucket: RESOURCES_BUCKET, Key: key }));
      } catch (e) {
          console.warn(`[${sourcePrefix}] Error moving resource analytics file ${key} to ${destKey}:`, e);
      }
  })));
  ```
  Note: `dirtyFiles.add(...)` from concurrent callbacks is safe — `Set.add` is
  synchronous and there's no `await` between the read and the add in each callback.

- [ ] **1.4** Parallelize the step-9 "mark as generated + write back" S3 puts
  ([index.mjs:314-330](generate_csv/src/index.mjs#L314-L330)) the same way,
  preserving the existing abort-on-error behavior via `Promise.all` + surrounding
  try/catch.

- [ ] **1.5** Re-run Phase 0.2's log query, compare `Billed Duration` before/after
  in the progress table. At <500 total entries, expect this alone to cut
  `generate_csv` duration substantially since it currently makes every S3 call
  one at a time (that's ~2-3 sequential round trips per file across listing,
  fetching, and the analytics merge).

## Phase 2 — Same concurrency pattern in `upload_to_drive`

`upload_to_drive` already uses `p-limit` for per-entry JSON uploads (good
precedent), but the CSV-file loop is still sequential
([index.mjs:165-191](upload_to_drive/src/index.mjs#L165-L191)): each CSV does
get → Drive-folder-lookup → upload → copy → delete, one CSV at a time.

- [ ] **2.1** Wrap the `for (const csvKey of csvFiles)` body in the same
  `limit(async () => {...})` pattern and `Promise.all` the results. Low urgency
  (there are usually only 2 CSVs — prod/test — per run) but free and consistent
  with the rest of the codebase once Phase 1 lands.

`download_from_drive` and `process_response` don't have an equivalent
sequential-loop-over-independent-items pattern today — no changes needed there.

## Phase 3 — Decision: stop reprocessing all-time history on every `generate_csv` run

**This is the structural issue, separate from Phase 1's concurrency wins.**
Every run of `generate_csv` lists, fetches, flattens, cleans, and re-sorts
*every survey JSON file ever written*, to rebuild one cumulative CSV — not just
the new entries since last run. Phase 1 makes each of those S3 calls faster
via concurrency, but the *amount* of work still grows linearly with total
history, forever. At <500 entries total this costs nothing today; it's the
kind of thing that's cheap to fix now and annoying to fix once the fix requires
a real migration.

You asked for the tradeoffs rather than a fixed direction, so here they are.
**Recommendation: Option A**, given your stated priority (future-proof without
much added complexity) and current low volume — it's the smallest diff that
removes the unbounded growth, with no new AWS resources or migration to run.

### Option A (recommended): cache the resolved master dataset in S3

Persist the *already cleaned, renamed, and session-resolved* dataset (the
`resolvedData` array, minus the `[RAW_ENTRY]`/`[SOURCE_FILE]` symbols, which
aren't serializable anyway) as one JSON file per prefix, e.g.
`cache/resolved-real.json` / `cache/resolved-test.json` in `SURVEY_BUCKET`.

Each run then:
1. Loads the cache (if present) instead of re-fetching/re-cleaning everything.
2. Lists survey files as today, but only fetches files whose `LastModified` (from
   `ListObjectsV2`'s response, no extra call needed) is newer than the cache's
   own last-write time, **or** whose entries aren't all `generated_as_csv` yet
   (belt-and-suspenders against clock skew) — cleans/resolves only those.
3. Merges the newly-resolved entries into the cached set (same `bySessionId`
   join logic already in the code, just applied incrementally).
4. Writes the CSV from the merged set, and overwrites the cache with the new
   merged set.

Tradeoffs:
- **Pro:** No new AWS resource, no migration script, no schema design. It's a
  refactor of existing logic (extract "fetch → clean → resolve" into a function
  that can run on a subset) plus one new S3 read/write per run.
- **Pro:** Fully reversible — delete the cache file and the next run rebuilds
  from scratch, identical to today's behavior.
- **Con:** The cache file itself grows forever (one row per historical entry),
  though as *pre-cleaned* JSON it's smaller and cheaper to parse than re-deriving
  it from all raw files every time. At construction-survey data rates this is a
  non-issue for years.
- **Con:** Session-pair resolution (the `bySession` logic, [index.mjs:204-250](generate_csv/src/index.mjs#L204-L250))
  assumes it sees both halves of a session together. If a session's "complete"
  and "incomplete" entries can land in *different* survey files fetched in
  different runs, incremental resolution needs the cache to hold unresolved
  per-session state until both halves arrive, not just the final resolved rows.
  **Before implementing, check whether that cross-file-split case is possible
  in practice** (it depends on whether a browser's incomplete-then-complete
  pair for one session can straddle a month boundary — look at how `process_response`
  buckets by `yyyy-mm`). If it can happen, the cache needs to key by `session_id`
  and only "finalize" a session once no new incomplete-but-unresolved sibling
  can plausibly still arrive (e.g. after some grace period), rather than
  finalizing on every run.

### Option B: migrate survey storage to DynamoDB

Replace the per-month JSON files with a DynamoDB table (partition key
`session_id` or `id`), written to directly by `process_response`. `generate_csv`
then queries only new/unprocessed items (e.g. a GSI on a `generated_as_csv`
flag, or a `createdAt` sort key + a stored watermark) instead of listing S3.

Tradeoffs:
- **Pro:** Removes the S3 list+get-per-file pattern entirely; scales indefinitely
  without any cache-invalidation reasoning like Option A's session-split concern.
- **Con:** Real migration: new IAM permissions, a one-time backfill script for
  existing JSON files, changes to `process_response` and `generate_csv` and
  anything else touching the JSON layout (`upload_to_drive` reads `json/`/`test_json/`
  directly too, per [upload_to_drive/src/index.mjs:51-64](upload_to_drive/src/index.mjs#L51-L64)
  — that would need updating or would need to keep reading a JSON export instead).
  This is a genuinely bigger lift given your "don't want much added complexity"
  preference, and unjustified at <500 total entries.
- Only revisit this if growth projections change materially (say, tens of
  thousands of entries, or a need for concurrent writers/transactions that flat
  JSON files can't give you).

### Option C: do nothing beyond Phase 1/2

Valid choice given current volume. Phase 1 alone likely takes `generate_csv`'s
runtime from "trivial" to "more trivial." Revisit Phase 3 later if volume grows
or if `generate_csv`'s duration in Phase 0's baseline turns out to already be
non-trivial (in which case, do Option A sooner rather than later).

- [ ] **3.0** Decide: A / B / C. Record the choice + date in the progress table.
- [ ] **3.x** (if A or B) — break the chosen option into its own sub-checklist in
  this file before starting, following the same one-step-per-commit approach as
  Phase 1.

## Phase 4 — Decision: Python + pandas for `generate_csv`

You floated converting `generate_csv` (specifically the `cleaning.mjs`/flatten/CSV-build
logic) to Python using pandas instead of hand-rolled JS. Tradeoffs, since you
asked to decide later:

**Runtime:** pandas will not make this *faster* at your data volume — the
bottleneck here is S3 I/O (network round trips), not the flatten/clean/sort CPU
work, which operates on a few hundred small JSON objects. A vectorized pandas
`json_normalize` + column rename + groupby is elegant but isn't solving a
performance problem that exists today. This only starts to matter if history
grows into the tens/hundreds of thousands of rows *and* you've stuck with
Option C from Phase 3 (i.e., still reprocessing everything every run) — pandas'
vectorized operations do meaningfully outperform the current per-entry JS loops
at that scale. If you go with Phase 3 Option A or B, this stops mattering
entirely, since each run only processes new entries.

**Cost of switching:**
- New Lambda runtime (`python3.x`) alongside the 4 existing Node functions —
  `deploy.sh` is Node/layer-specific (zips `node_modules` into a `nodejs/`
  layer structure per [deploy.sh:82-95](deploy.sh#L82-L95)); it would need a
  parallel path for a `python/` layer structure (pandas + dependencies), or a
  separate deploy script.
  - Pandas is a heavy dependency for a Lambda layer (tens of MB); check it stays
    under Lambda's layer size limits together with any other deps, or use an
    AWS-provided pandas layer ARN instead of bundling your own.
- The `RENAME_KEYS`/`ORDERED_KEYS`/`DISCARD_KEYS`/`ANALYTICS_RENAME_KEYS` logic
  in `cleaning.mjs` is pure data (no I/O) and would port over almost 1:1 as
  Python dicts/lists — the actual porting effort is small and mechanical, it's
  the deploy-pipeline and language-fragmentation cost that's the real tradeoff.
- Team/maintenance: one more language in a 5-function codebase that's currently
  100% JS, with its own linting/formatting/test conventions to set up (see
  `TODO.md`'s existing "use ESLint" / "add test suite" items, which would now
  need a JS flavor and a Python flavor).

**Recommendation:** skip this unless/until Phase 3 stays at Option C *and*
volume grows enough that CPU-bound flatten/clean work (not S3 I/O) shows up as
the dominant cost in Phase 0-style profiling. If that day comes, re-profile
first to confirm the bottleneck actually moved from I/O to CPU before paying
the two-runtime-in-one-codebase cost.

- [ ] **4.0** Decision: convert / don't convert / revisit later. Record choice
  + date in the progress table. If "convert," this plan doesn't prescribe the
  steps — come back and add a sub-checklist once decided, informed by whatever
  Phase 3 option was chosen (a Python rewrite of the *cache-based* Option A
  flow looks different from a Python rewrite of the current full-rescan flow).

## Out of scope (adjacent, not runtime optimization)

Several `TODO.md` items overlap this area but aren't runtime concerns — noted
so nobody double-counts them as part of "optimization": ESLint, a test suite,
converting JS→TS, splitting `deploy.sh` into separate CI/CD, and the
`resolvedData.push(...group)` dead-code question at
[index.mjs:248](generate_csv/src/index.mjs#L248) (worth a correctness look, but
that's a bug-hunt, not a perf task — flagging it here only so it isn't lost).

## Progress tracking

| Phase | Step | Status | Notes / measurements / decisions |
|-------|------|--------|-----------------------------------|
| 0 | 0.1 config snapshot | Not started | |
| 0 | 0.2 baseline durations | Not started | Fill in avg Billed Duration + Max Memory here |
| 0 | 0.3 runtime version check | Not started | |
| 1 | 1.1 parallelize analytics fetch | Done | Switched to Promise.allSettled so one failed fetch doesn't abort the batch |
| 1 | 1.2 parallelize survey file fetch | Done | Kept Promise.all (not allSettled) since a partial fetch must still abort the whole run |
| 1 | 1.3 parallelize analytics move (copy+delete) | Done | Used Promise.allSettled; per-item try/catch already isolates failures so this is mostly for consistency/explicitness |
| 1 | 1.4 parallelize dirty-file writeback | Not started | |
| 1 | 1.5 measure improvement | Not started | Compare against 0.2 baseline |
| 2 | 2.1 parallelize CSV upload loop | Not started | |
| 3 | 3.0 decide A/B/C | Not started | |
| 3 | 3.x implement chosen option | Not started | |
| 4 | 4.0 decide Python conversion | Not started | |
