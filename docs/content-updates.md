# Updating Website Content (Supporters / Testimonies)

The Supporters, Contractors, Unions, and Testimonies sections are driven by
Google Sheets. You edit a Sheet; the website picks up the changes on its own —
no developer, no deploy, no code.

---

## One-time setup (per sheet)

1. Open the template file (`docs/templates/`) and import it into Google Sheets
   (or recreate the columns exactly).
2. In Google Sheets: **File → Share → Publish to web**.
3. Under "Link", pick the **tab** you want and choose **Comma-separated values (.csv)**.
4. Click **Publish**, copy the generated link, and send it to whoever maintains
   `src/frontend/static/config.js` (it goes into `SUPPORTERS_SHEET_URL` /
   `TESTIMONIES_SHEET_URL`).

That link is set once. After that, edits to the Sheet appear on the site
automatically (can take a few minutes — Google caches the published file).

## Editing rules

### Supporters sheet
| Column        | What goes in it |
| ------------- | --------------- |
| `Tab`         | `Associations`, `Contractors`, or `Unions` (decides which page the row shows on) |
| `Entity Name` | The org name as it should appear |
| `Website Link`| Full URL (e.g. `https://…`) — leave blank for no link |
| `Logo Link`   | Optional. One of: a direct image URL, a Google Drive share link, or a repo path like `logos/Contractors/waters-bugbee.jpeg`. Leave blank → a placeholder icon shows instead. |

- Keep one row per organization. Delete a row = remove it from the site.
- Logos: **the file must be shared as "Anyone with the link"** or it will not
  load. Drive-hosted images can occasionally be rate-limited by Google at high
  traffic — if a logo ever looks flaky, host the file on the website instead
  (drop it in `src/frontend/static/assets/logos/…` and commit).

### Testimonies sheet
| Column        | What goes in it |
| ------------- | --------------- |
| `Name`        | Person's name (required) |
| `Role`        | e.g. "Foreman" |
| `Affiliation` | e.g. "Waters & Bugbee — Laborers' Union Local 172" |
| `Quote`       | The testimonial text (required) |
| `Photo`       | Optional. Same rules as logos; blank → placeholder headshot |

## Good to know

- **Renaming a tab is fine** — the published link targets the tab itself, not
  its name. Do **not** rename the column headers.
- **Fallback guarantee:** if the published link ever breaks (unpublished,
  deleted, Google outage), the website automatically falls back to the bundled
  copy of the content — the page never breaks.
- **Reverting:** unpublish the sheet (or remove the link from `config.js`) and
  the site is back to the bundled content immediately.
- Changes can take a few minutes to appear (Google caches published files).
