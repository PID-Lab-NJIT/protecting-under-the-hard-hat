# `generate_csv` Spec

- An AWS Lambda function that is scheduled to run periodically.
- Rebuilds a cumulative CSV of all survey responses from the raw per-month JSON files in S3, merging in resource-analytics data collected by `get_local_resources`.
- Runs the same pipeline twice per invocation: once for real (prod) data, once for test data, in parallel.

## Environment Variables

```plaintext
SURVEY_BUCKET="survey_bucket_name_here"
RESOURCES_BUCKET="resources_bucket_name_here"
```

## S3 Layout

All paths are relative to the bucket root.

| Bucket             | Path                          | Contents                                                                                                                                                              |
| ------------------ | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SURVEY_BUCKET`    | `json/{yyyy-mm}.json`         | Raw survey response entries for real submissions, one array per month (written by `process_response`).                                                                |
| `SURVEY_BUCKET`    | `test_json/{yyyy-mm}.json`    | Same, for test submissions.                                                                                                                                           |
| `SURVEY_BUCKET`    | `csv/{ISO_datetime}.csv`      | Generated cumulative CSV of real responses, one new file per run.                                                                                                     |
| `SURVEY_BUCKET`    | `test_csv/{ISO_datetime}.csv` | Same, for test responses.                                                                                                                                             |
| `RESOURCES_BUCKET` | `data/new/*.json`             | Unmerged resource-analytics files written by `get_local_resources` (see that spec's Analytics Storage section).                                                       |
| `RESOURCES_BUCKET` | `data/{yyyy-mm}/*.json`       | Analytics files successfully merged into a survey entry, moved here for archival. `yyyy-mm` comes from the analytics filename's own ISO prefix, not the current date. |
| `RESOURCES_BUCKET` | `data/unmatched/*.json`       | Analytics files with no matching survey `session_id`, moved here instead of being merged.                                                                             |

## Source Structure

```plaintext
src/
    index.mjs       # main driver, S3 orchestration, both pipeline stages
    cleaning.mjs    # static column discard/rename/order/merge tables
    util.mjs        # generic flatten + CSV-escape helpers
```

## Functionality

### Overview

Each survey response is stored as one JSON object per submission, nested and Express/browser-shaped (e.g. `data.answers.*`, `clientInfo.*`, `data.gps.*`). The pipeline flattens each into a single-level row, renames/merges keys into stable CSV column names via a static lookup table, resolves duplicate submissions from the same session, merges in resource-analytics fields, and writes the result as one cumulative CSV per run. Already-processed entries are marked so unchanged history doesn't need to be redone next run (though it's still re-read and re-flattened every run — see `generated_as_csv` below).

`handler()` fetches resource-analytics files once (split into test/real), then runs `processDirectory()` for the real and test prefixes concurrently via `Promise.all`, passing each its matching analytics set.

### `fetchResourceAnalytics()`

- Lists every object under `data/new/` in `RESOURCES_BUCKET` (paginating via `ListObjectsV2`'s continuation token), then fetches and parses each JSON file concurrently, capped at a `p-limit` of 10.
- Classifies each file as test or real: a filename ending in `_test.json`, or an `is_test: true` field, means test.
- Uses `Promise.allSettled` so one corrupt/unreadable analytics file is logged and skipped rather than aborting the whole run. A listing failure (not a per-file fetch failure) returns empty test/real sets instead of throwing, since analytics are secondary to the core CSV generation.

### `processDirectory(sourcePrefix, destPrefix, analyticsFiles)`

Run once per real/test pair. Steps:

1. **List** all `.json` files under `sourcePrefix` (paginated).
2. **Fetch** each file concurrently (same `p-limit` of 10), tagging every entry with a hidden `SOURCE_FILE` symbol key pointing back at its origin file (needed later for write-back). A fetch failure aborts the whole run for this prefix (returns an error message) rather than silently producing a partial CSV — unlike the analytics fetch, missing survey data is a correctness problem, not a secondary one.
3. **Skip early** if every entry across every file already has `generated_as_csv: true` (no new submissions since the last run) — return without touching S3 further.
4. **Flatten and clean** each entry:
   - `flattenObj()` recursively collapses nested objects to dot-notation keys (arrays are JSON-stringified rather than expanded, since a CSV cell holds one scalar).
   - Keys listed in `DISCARD_KEYS` (internal bookkeeping fields, redundant test/branching flags, etc.) are dropped.
   - Remaining keys are renamed per `RENAME_KEYS` (e.g. `clientInfo.ip` → `ip_addr`, numbered survey-question keys like `data.answers.k10_3` → `03_k10_3`); a key with no entry in the table keeps just its last dot-segment. Multiple source keys can map to the same destination (e.g. legacy vs. current question-key spelling) — when that happens and both have non-null values that disagree, the first-seen value wins and a warning is logged; only one wins silently if the other is null.
   - Each cleaned row keeps a hidden `RAW_ENTRY` symbol reference back to its original (pre-flatten) JSON object, so later analytics merges can be written onto both the cleaned row and the raw entry that gets persisted back to S3.
5. **Resolve session pairs**: entries are grouped by `session_id`. A session with at least one `completed: true` entry keeps only the latest complete entry, decorated with `_start`-suffixed columns (timestamp, IP/geo fields) copied from its _earliest_ incomplete sibling if any exist, plus `num_incomplete`. A session with only incomplete entries keeps the latest (furthest-progress) one, similarly decorated from the earliest, since an abandoned session's most useful row is its last state with the first state's context attached. Entries with no `session_id` pass through unchanged.
6. **Merge resource analytics** onto the resolved rows (see below).
7. **Sort** resolved rows descending by `timestamp` (newest first).
8. **Build headers**: start from `ORDERED_KEYS` (filtered to columns actually present), append any remaining columns found in the data in encounter order, then insert each `*_start` column immediately after its non-`_start` counterpart. This keeps a stable, human-reviewable column order across runs regardless of which optional fields a given batch of entries happens to include.
9. **Build and upload the CSV**: one row per resolved entry, values escaped per RFC 4180 (`csvEscape`), uploaded to `{destPrefix}{ISO datetime}.csv` — every run produces a new timestamped file rather than overwriting, so history of generated CSVs is preserved.
10. **Write back**: for every source file that contained new (not-yet-`generated_as_csv`) entries and/or received an analytics merge, mark all its entries `generated_as_csv: true` and re-`PutObject` the whole file. Write-backs run concurrently (same `p-limit`); a failure aborts with an error naming the offending file, mirroring step 2's approach, since a partially-marked file left over would cause re-merging analytics next run.

### Resource Analytics Merging

- Analytics are matched to a resolved survey row by exact `session_id` equality, using a `session_id → row` map built from `resolvedData` (post pair-resolution, so re-runs match the same canonical row a session would already collapse to).
- On a match: fields are renamed per `ANALYTICS_RENAME_KEYS` (`zip_code` → `resources_req_zip_code`, `max_radius` → `resources_max_radius`, `num_resources` unchanged) and written onto both the resolved row and its linked raw JSON entry (via the `RAW_ENTRY`/`SOURCE_FILE` symbols), so the merge survives into the next run's write-back. The raw entry's source file is marked dirty so it gets rewritten in step 10.
- On no match: the analytics file is left unmerged.
- Regardless of match, the analytics file itself is moved out of `data/new/` — to `data/{yyyy-mm}/` (matched) or `data/unmatched/` (unmatched) — via a `Copy` + `Delete` pair per file, run concurrently across files (`p-limit`) but sequential within one file (delete only after copy confirms). Per-file copy/delete failures are logged and skipped rather than aborting the batch, since one stuck analytics file shouldn't block the CSV run.
- If a source directory has no new survey entries, the whole run for that prefix (including analytics merging) is skipped — analytics wait in `data/new/` for a future run once new entries exist. If there are new survey entries but no analytics files, merging is simply a no-op and CSV generation proceeds.

### `cleaning.mjs`

Pure data: no logic, only the lookup tables described above (`DISCARD_KEYS`, `RENAME_KEYS`, `ANALYTICS_RENAME_KEYS`, `ORDERED_KEYS`, `START_KEYS`). `RENAME_KEYS` is built partly programmatically (numbered question keys following a `prefix+index` pattern) and partly as explicit non-sequential entries, each also mapping its own already-prefixed form back to itself so a row that was cleaned in a previous run and re-flattened still resolves to the same column.

### `util.mjs`

- `flattenObj(obj, prefix)`: recursive dot-notation flattener described in step 4 above.
- `csvEscape(val)`: wraps a value in quotes (doubling internal quotes) if it contains a comma, quote, or newline; renders `null`/`undefined` as an empty cell.

## Concurrency

- Every batch of independent S3 calls (analytics fetch, survey file fetch, analytics copy/delete, dirty-file write-back) runs through a shared `p-limit(10)` limiter rather than sequentially, since Lambda duration here is dominated by S3 round-trip latency, not CPU work.
- `Promise.allSettled` is used wherever one item's failure shouldn't sink the batch (analytics fetch, analytics move); a manual `findIndex` over settled results (instead of nested `try`/`catch`) is used where the first failure should still abort the run but the run needs to log _which_ file failed (survey fetch, write-back).

## Coding Conventions

- Code style (in order of most to least preferred):
  - Readable
  - Efficient
  - Compact
- Add docstrings for all key functions, including description, params, return values, etc.
- Use comments generously but concisely.
- Use Prettier for formatting.
- Always use camelCase for variable and function names.
- Use `variable == null` or `variable != null` if `variable` can plausibly be either `null` or `undefined`. Do NOT use `variable === null || variable === undefined` (and similarly for the `!==` conditions).

## Notes

- Take a look in `package.json`, and assume the listed modules are installed. Confirm if any more modules are needed.
- Every run reprocesses every historical survey entry (list + fetch + flatten + resolve for the whole bucket, not just new entries) even though only new/dirty files get written back. This is an accepted tradeoff at current data volume, not a bug to silently fix.
