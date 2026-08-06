# `download_from_drive` Spec

- An AWS Lambda function that is scheduled to run periodically.
- Syncs various files from a Google Drive root folder to AWS S3.

## Environment Variables

```plaintext
DRIVE_RESOURCES_FILE_ID="resources_file_id_here"
S3_BUCKET_NAME="bucket_name_here"
SERVICE_ACCOUNT_SECRET_ID="secret_id_here"
```

## Files to Download

| Drive Path  | File Type    | Notes                                         |
| ----------- | ------------ | --------------------------------------------- |
| `Resources` | Google Sheet | Export as CSV to S3 with name `resources.csv` |

## Source Structure

```plaintext
src/
    index.mjs        # main driver
    drive.mjs        # util for Google Drive interaction
    resources.mjs    # downloads resources Sheet/CSV from Drive
```

- Every file except `index.mjs` and `drive.mjs` is for downloading specific files. For now, only the resources dataset need to be downloaded via `resources.mjs`.

## Functionality

### `index.mjs`

- Call `download()` in `resources.mjs`, using `plimit` of 5 to limit max concurrent connections to Drive (in case there are more downloads added in the future).
- Use `allSettled` to ensure one failed download doesn't tear down the others.
- Catch and log errors from per download, and proceed with the next download.
- Log `"<success>/<total> downloads succeeded"`, and return a simple `{ message }` object with that same message.

### `drive.mjs`

Contains functions for interacting with Google Drive. See `src/backend/upload_to_drive/**/drive.js` for the structure to follow.

- `authorize(scopes)`: a function to authorize to Drive via AWS Secrets with ID given by the env var `SERVICE_ACCOUNT_SECRET_ID`. Takes in array of strings `scopes`.
- `getDrive(authClient)`: a function to get the Drive client. Use caching for the Drive client.

### `resources.mjs`

Contains functions for downloading the resources dataset from Drive to an S3 bucket.

- Use `drive.mjs` for connecting to Drive.
- `download()`:
    - First check if Google Sheet of ID given by env var `DRIVE_RESOURCES_FILE_ID` exists. If not, throw an error.
    - Otherwise, export that Google Sheet as a CSV stream. Load it into memory as a buffer so S3 can calculate the content length itself.
    - Upload the stream to the S3 bucket of name given by the env var `S3_BUCKET_NAME` at the root as `resources.csv` (overriding the previous file of that name).
    - Log the success as well as the Drive and S3 file names.

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
