# `generate_csv` Spec

Spec status: incomplete. Currently only spells out the resource analytics merging.

## Resource Analytics

### Filenames

Format:

```plaintext
{ISO_datestring}_{UUIDv4}{"_test" if test else nothing}.json
```

Examples:

```plaintext
2026-08-28T16-41-38.320Z_3b780e8b-47a4-4de1-b723-732987ccc29c_test.json
2025-12-05T17-42-19.515Z_7cad15bb-283e-4104-850a-2216bf2655bb.json
```

### Filepaths

All filepaths from the root of an S3 bucket given by the environment variable `RESOURCES_BUCKET`.

Unmerged analytics (before):

```plaintext
data/new/*.json
```

Merged analytics (after) format:

```plaintext
data/{yyyy-mm}/*.json
```

`yyyy-mm` is taken from the file's own ISO string prefix.

Merged analytics (after) example:

```plaintext
data/2026-08/*.json
```

### Data Schema

```json
{
  "is_test": "boolean - Whether the analytics data point is test or real.",
  "session_id": "string (UUIDv4) - The user session ID (unique for every page load / refresh).",
  "device_id": "string (UUIDv4) - Device ID proxy (locally stored on the browser).",
  "zip_code": "string - 5-digit US ZIP code.",
  "max_radius": "number - Integer representing the maximum meters within which to fetch resources.",
  "num_resources": "number - Integer representing the number of resources found."
}
```

No change to the data after merging.

### Merging

Merge (inner join) the analytics data with the main data on `session_id` depending on if the data point is test or real and after `session_id` pairs get resolved based on complete/incomplete responses.

- If no matching `session_id` found, don't merge the data, move the analytics file to `/data/unmatched`, and continue to the next data file.

- If the analytics filename ends in `_test.json` or `"is_test"` is `true`, merge with test data. If not, merge with real data.

Rename and merge these fields (don't merge the ones not mentioned):

| Analytics Field (Before) | Merged Field (After)     |
| ------------------------ | ------------------------ |
| `zip_code`               | `resources_req_zip_code` |
| `max_radius`             | `resources_max_radius`   |
| `num_resources`          | `num_resources`          |

Merge the fields into the CSV being generated and the original JSON survey data as well.

### Edge Cases

- If there are no new survey entries but there are new analytics data points, skip the merging entirely.
- If there are new survey entires but no new analytics data points, proceed with CSV generation as normal - just without merging.
- If parsing a file fails or some other unexpected/non-business-logic error occurs for a particular entry, warn in the console and move to the next entry.
