# `process_response` Spec

- An AWS Lambda function exposed as an HTTP API endpoint.
- Written in JavaScript.
- Accepts one new survey response from the frontend, enriches it with IP-based geolocation, and appends it to the appropriate monthly JSON file in S3.

## Environment Variables

```plaintext
S3_BUCKET_NAME="bucket_name_here"
```

## Overview

- Use `express` for request/response handling, wrapped for Lambda via `serverless-http`.
- Trust the `X-Forwarded-For` header (`app.set('trust proxy', 1)`) so `req.ip` reflects the real client IP behind API Gateway/CloudFront rather than the proxy's own address.

## Source Structure

```plaintext
src/
    index.mjs        # main driver with Express code
```

## Endpoint

`POST /survey`

## Request Body

```json
{
  "data": {
    "...": "the full survey payload as built by the frontend; passed through mostly as-is"
  }
}
```

- `data.isTest`, `data.test.status`, or `data.query.test` (whichever is truthy) marks the response as a test submission. No other validation is performed on the body — the frontend's shape is trusted and stored as-is under the `data` key.

## Response Schema

### `200`

```json
{
  "message": "Survey response saved successfully!"
}
```

### `500`

Conditions:

- Fetching the current month's existing file from S3 failed for a reason other than the file not existing yet (`NoSuchKey` is expected and handled, not an error).
- Writing the updated file back to S3 failed.

```json
{
  "message": "string - Descriptive error message."
}
```

## S3 Storage

- File path: `json/{yyyy-mm}.json` for real submissions, `test_json/{yyyy-mm}.json` for test submissions, where `{yyyy-mm}` is the _current_ server date at request time (not any timestamp in the payload).
- Each file holds a JSON array of response entries for that month. A new month starts a new file; if the file for the current month doesn't exist yet (`NoSuchKey`), start from an empty array instead of erroring.
- The full existing array is read, the new entry is appended, and the whole array is written back with `PutObjectCommand` (no partial/append writes) — same read-modify-write pattern `generate_csv` later depends on for its write-back step.

## Functionality

### `lookupGeo(ip)`

- Looks up city/region/country/lat/lon/timezone for a client IP via `https://ipinfo.io/{ip}/json`, using the platform `fetch` with a 3-second timeout (`AbortSignal.timeout`).
- Returns `null` on any failure (non-OK response, timeout, network error, malformed `loc` field) rather than throwing — geolocation is a best-effort enrichment, not a requirement for saving a response.
- `d.loc` is `"lat,lon"`; split and parsed to numbers, each defaulting to `null` if not a valid number.

### `POST /survey` handler

1. Destructure `data` from the request body — this is the entire survey payload, stored mostly opaquely.
2. Compute the destination file path (see S3 Storage above) from the current date and the test/real classification.
3. Fetch the existing monthly file from S3, tolerating a missing file (see above); any other fetch error returns `500`.
4. Build the new entry:
   - `id`: a fresh `randomUUID()`.
   - `s3_timestamp`: current server time, ISO string.
   - `uploaded_to_drive: false` — a flag `upload_to_drive` flips once it has synced this entry to Drive.
   - `clientInfo`: the request IP plus whatever `lookupGeo()` returned (each field `null` if the lookup failed or didn't return that field).
   - `data`: the raw survey payload from the request body, unmodified.
5. Append the entry to the in-memory array and `PutObject` the whole array back to the same key, overwriting the previous version of the file. Any write failure returns `500`.
6. Return `200` on success.

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
- No authentication, rate limiting, or payload validation is performed on this endpoint beyond what's described above — any well-formed POST body is accepted and stored.
