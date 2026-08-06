// Downloads the resources Google Sheet from Drive and uploads it as a CSV to S3

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { authorize, getDrive } from "./drive.mjs";

const SHEET_MIME_TYPE = "application/vnd.google-apps.spreadsheet";
const S3_BUCKET = process.env.S3_BUCKET_NAME;

const s3 = new S3Client({ region: process.env.AWS_REGION });

/**
 * Finds the resources Google Sheet in the Drive root folder.
 * Looks for a sheet named exactly "Resources" first, falling back to any sheet
 * whose name contains "resources" (case insensitive) if no exact match is found.
 * @param {object} drive The Google Drive API client.
 * @returns {Promise<object | null>} The found file's metadata (id, name), or null if none found.
 */
async function findResourcesSheet(drive) {
    const rootFolderId = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
    const baseQuery = `'${rootFolderId}' in parents and mimeType = '${SHEET_MIME_TYPE}' and trashed = false`;

    const exactMatch = await drive.files.list({
        q: `name = 'Resources' and ${baseQuery}`,
        fields: "files(id, name)",
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
    });

    if (exactMatch.data.files.length > 0) {
        return exactMatch.data.files[0];
    }

    // fall back to a case-insensitive substring name match
    // Drive's `contains` operator only does word-prefix matching, not true substring
    // matching, so list all sheets in the folder and filter for a substring match in JS.
    const allSheets = await drive.files.list({
        q: baseQuery,
        fields: "files(id, name)",
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
    });

    const fallbackFile = (allSheets.data.files ?? []).find((file) =>
        file.name.toLowerCase().includes("resources")
    );

    if (fallbackFile != null) {
        console.log(`Exact "Resources" sheet not found. Falling back to "${fallbackFile.name}".`);
        return fallbackFile;
    }

    return null;
}

/**
 * Downloads the resources dataset from Drive and uploads it to S3 as `resources.csv`.
 * @returns {Promise<void>}
 */
async function download() {
    const authClient = await authorize(["https://www.googleapis.com/auth/drive.readonly"]);
    const drive = getDrive(authClient);

    const sheet = await findResourcesSheet(drive);
    if (sheet == null) {
        throw new Error("No resources Google Sheet found in the Drive root folder.");
    }

    console.log(`Exporting "${sheet.name}" as CSV...`);
    const exportResponse = await drive.files.export(
        { fileId: sheet.id, mimeType: "text/csv" },
        { responseType: "stream" }
    );

    await s3.send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: "resources.csv",
        ContentType: "text/csv",
        Body: exportResponse.data,
    }));

    console.log("Uploaded resources.csv to S3.");
}

export { download };
