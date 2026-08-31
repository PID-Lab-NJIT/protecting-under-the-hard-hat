# `upload_to_drive` Spec

- An AWS Lambda function that is scheduled to run periodically.
- Syncs new survey-response JSON entries and generated CSVs from AWS S3 to a Google Drive folder, for human access to data that otherwise only lives in S3.

## Environment Variables

```plaintext
GOOGLE_DRIVE_FOLDER_ID="folder_id_here"
S3_BUCKET_NAME="bucket_name_here"
SERVICE_ACCOUNT_SECRET_ID="secret_id_here"
FLAG_UPLOAD_JSON_DATA=true      # both test and real
FLAG_UPLOAD_CSV_DATA=true       # both test and real
```

- `FLAG_UPLOAD_JSON_DATA` / `FLAG_UPLOAD_CSV_DATA`: independently toggle each half of the sync (`"true"`/`"false"`, case-insensitive; any other value falls back to `true`). Useful for running just one half during debugging without touching the other's state.

## S3 ↔ Drive Mapping

| S3 Prefix   | Drive Folder        |
| ----------- | ------------------- |
| `csv/`      | `Responses/`        |
| `test_csv/` | `Responses (Test)/` |

- Any other S3 prefix (not expected in normal operation) falls back to a Drive folder named after the prefix itself (`s3/{prefix}` for JSON, `default/{prefix}` for CSV), so the sync never silently drops an unrecognized file.
- Folders are created on demand under `GOOGLE_DRIVE_FOLDER_ID` (looked up by name first, created only if missing), so re-runs reuse the same folder rather than duplicating it.

## Source Structure

```plaintext
src/
    index.mjs        # main driver
    drive.mjs        # util for Google Drive interaction
```

## Functionality

### `index.mjs`

Runs in two independent phases, each gated by its own flag.

#### JSON phase (`FLAG_UPLOAD_JSON_DATA`)

1. List every `.json` file under `json/` and `test_json/`.
2. Fetch each file and keep only those with at least one entry where `uploaded_to_drive` is not `true` — a file can be partially uploaded (some entries already synced from a prior run, others new), so the check is per-entry, not per-file.
3. For each such file, resolve/create its destination Drive folder (mapped from the S3 prefix per the table above), then upload each not-yet-uploaded entry as its own JSON file, named `{surveyTimestamp}_{entryId}.json` (survey timestamp from `data.timestamp` with `:`/`.` replaced by `-`; falls back to `unknown`/a fresh UUID if either is missing). Uploads for entries within one file run concurrently through a `p-limit` of 5; uploads across different files also proceed concurrently (each file's upload batch isn't awaited before starting the next file's).
4. Before uploading, the entry is deep-copied and stripped of its `uploaded_to_drive` and `generated_as_csv` bookkeeping fields, and stamped with `drive_timestamp` (upload time) — the copy on Drive should read as a finished, external-facing record, not carry S3-internal state.
5. On a successful upload, the _original_ in-memory entry (not the copy) is marked `uploaded_to_drive: true` and given the same `drive_timestamp`.
6. After all uploads for a source file settle (`Promise.allSettled`, so one failed entry doesn't block the rest), if any entry in that file was newly uploaded, the whole file is `PutObject`'d back to S3 with the updated flags — same read-modify-write pattern `process_response` and `generate_csv` use. Files with no successful upload are left untouched (so a fully-failed file is retried whole on the next run).

#### CSV phase (`FLAG_UPLOAD_CSV_DATA`)

1. List files directly under `csv/` and `test_csv/` (top-level only — `Delimiter: '/'` excludes anything already moved into a `yyyy-mm/` subfolder, which is how an already-processed CSV is distinguished from a new one; there's no per-entry flag like JSON's `uploaded_to_drive`).
2. For each CSV, resolve/create a `{Drive folder}/{yyyy-mm}/` folder (month taken from the filename's own ISO prefix) and upload the raw CSV content as a Drive file.
3. On a successful upload, move the S3 object from `{prefix}/{fileName}` to `{prefix}/{yyyy-mm}/{fileName}` via `Copy` + `Delete` — this both archives it and removes it from the top-level listing so it isn't re-uploaded next run. On upload failure, skip the move and leave the file at the top level so it's retried next run.
4. CSVs are processed one at a time (no concurrency) — there are normally only two per run (prod/test), so the added complexity of parallelizing wasn't worth it.

If neither phase finds anything new (no unuploaded JSON entries and no top-level CSVs), log and return early without touching Drive or S3 further.

### `drive.mjs`

Contains functions for interacting with Google Drive. Shared shape with `download_from_drive`'s `drive.mjs` (`authorize`, `getDrive` with client caching), plus:

- `createFolders(authClient, folderId, path)`: given a `/`-delimited path, resolves or creates each segment as a nested Drive folder under `folderId` in turn, returning the final (leaf) folder's ID. Existing folders are found by an exact-name `files.list` query (scoped to the current parent, restricted to folder mime type, excluding trashed) so re-runs don't create duplicates.
- `uploadJsonToDrive(authClient, folderId, fileName, data)` / `uploadCsvToDrive(authClient, folderId, fileName, csvContent)`: create a new Drive file with the given content (`JSON.stringify(data, null, 4)` for JSON; the CSV string as-is), returning the new file's ID, or `null` if the upload failed (logged, not thrown — a single failed upload shouldn't crash the run).
- Both folder and file operations pass `supportsAllDrives`/`includeItemsFromAllDrives` so the function works against a shared Drive, not just the service account's own My Drive.

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

- Allow for shared Drives.
- Take a look in `package.json`, and assume the listed modules are installed. Confirm if any more modules are needed.
- A listing or fetch failure aborts the whole run (returns an error message) rather than proceeding partially, since a broken listing can't be trusted to represent "what's actually new."
