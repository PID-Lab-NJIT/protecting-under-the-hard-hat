// Uploads existing survey responses from S3 to Google Drive folder

import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command, CopyObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import pLimit from 'p-limit';
import { authorize, createFolders, uploadJsonToDrive, uploadCsvToDrive } from './drive.js';

// env vars
const GOOGLE_DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;

const parseFlag = (flag, defaultValue) => {
    flag = flag.toLowerCase();
    if (flag === "true") {
        return true;
    }
    if (flag === "false") {
        return false
    }
    return defaultValue
};

// flags
const FLAG_UPLOAD_JSON_DATA = parseFlag(process.env.FLAG_UPLOAD_JSON_DATA, true);
const FLAG_UPLOAD_CSV_DATA = parseFlag(process.env.FLAG_UPLOAD_CSV_DATA, true);

// S3 configuration
const S3_BUCKET = process.env.S3_BUCKET_NAME;
const s3 = new S3Client({ region: process.env.AWS_REGION });

// Drive authorization
const authClient = await authorize(['https://www.googleapis.com/auth/drive']);

// limit the number of concurrent uploads
const limit = pLimit(5);

// S3 dirs to Drive dirs
const S3_TO_DRIVE_DIRS = {
    "csv": "Responses",
    "test_csv": "Responses (Test)"
};

export const handler = async () => {
    console.log("Flags:");
    console.log({FLAG_UPLOAD_JSON_DATA, FLAG_UPLOAD_CSV_DATA});
    console.log('1. Listing all data files from S3...');
    let jsonFiles = [];
    let csvFiles = [];

    try {
        if (FLAG_UPLOAD_JSON_DATA) {
            // list JSON data files across json/ and test_json/ prefixes
            for (const prefix of ['json/', 'test_json/']) {
                let response = await s3.send(new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: prefix }));
                let objects = response.Contents ?? [];
                let nextToken = response.NextContinuationToken;

                // handle pagination
                while (response.IsTruncated) {
                    response = await s3.send(new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: prefix, ContinuationToken: nextToken }));
                    objects = objects.concat(response.Contents ?? []);
                    nextToken = response.NextContinuationToken;
                }

                jsonFiles = jsonFiles.concat(objects.map(item => item.Key).filter(key => key.endsWith('.json')));
            }
        }

        if (FLAG_UPLOAD_CSV_DATA) {
            // list unuploaded CSVs from both csv/ and test_csv/ (Delimiter excludes subfoldered/uploaded ones)
            for (const csvPrefix of ['csv/', 'test_csv/']) {
                const csvResponse = await s3.send(new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: csvPrefix, Delimiter: '/' }));
                csvFiles = csvFiles.concat((csvResponse.Contents ?? []).map(item => item.Key).filter(key => key.endsWith('.csv')));
            }
        }
    } catch (e) {
        console.error('Error listing S3 data files:', e);
        return { message: 'Error listing S3 data files' };
    }

    console.log('2. Fetching files with unuploaded entries...');
    // { 'path/to/file.json': [entry1, entry2, ...], ... }
    let unuploadedJsonData = {};

    for (const filePath of jsonFiles) {
        try {
            const response = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: filePath }));
            const jsonStr = await response.Body.transformToString();
            const data = JSON.parse(jsonStr);
            // include even partially unuploaded files (certain entries uploaded, others not)
            const uploaded = data.every(item => item.uploaded_to_drive);

            if (!uploaded) {
                unuploadedJsonData[filePath] = data;
            }
        } catch (e) {
            console.error(`Error fetching file ${filePath} from S3:`, e);
            return { message: `Error fetching file ${filePath} from S3` };
        }
    }

    if (Object.keys(unuploadedJsonData).length === 0 && csvFiles.length === 0) {
        console.log('No new entries or CSVs to upload');
        return { message: 'No new entries or CSVs to upload' };
    }

    console.log('3. Uploading files to Google Drive...');
    const written = {};
    const promises1 = Object.entries(unuploadedJsonData).map(async ([filePath, data]) => {
        // if the file name contains a path, create / retrieve the folders first
        // test/2026-04.json (file) -> test/2026-04 (folder)
        const s3Prefix = filePath.split('/').slice(0, -1).join('/');
        const drivePrefix = S3_TO_DRIVE_DIRS[s3Prefix] ?? `s3/${s3Prefix}`
        const folderId = await createFolders(authClient, GOOGLE_DRIVE_FOLDER_ID, drivePrefix);

        const promises2 = data.filter(entry => !entry.uploaded_to_drive).map((entry) => {
            return limit(async () => {
                try {
                    const timestamp = new Date().toISOString();
                    const surveyTsConv = entry.data?.timestamp?.replace(/[:.]/g, '-') || 'unknown';

                    const fileName = `${surveyTsConv}_${entry.id ?? 'new_uuid_' + crypto.randomUUID()}.json`;
                    // copy to avoid modifying the original entry
                    const dataToUpload = JSON.parse(JSON.stringify(entry));
                    dataToUpload.drive_timestamp = timestamp;
                    delete dataToUpload.uploaded_to_drive;
                    delete dataToUpload.generated_as_csv;

                    const fileId = await uploadJsonToDrive(authClient, folderId, fileName, dataToUpload);

                    if (fileId) {
                        written[filePath] = true;
                        entry.uploaded_to_drive = true;
                        entry.drive_timestamp = timestamp;
                    }
                } catch (e) {
                    console.error(`Error uploading entry ${entry.id} to Drive:`, e);
                    return { message: `Error uploading entry ${entry.id} to Drive` };
                }
            });
        });

        // resolve the promises concurrently since they're independent of each other
        return Promise.allSettled(promises2);
    });

    await Promise.allSettled(promises1);

    console.log('4. Updating the files in S3 with the new upload statuses...');
    for (const [filePath, data] of Object.entries(unuploadedJsonData)) {
        if (written[filePath]) {
            try {
                await s3.send(new PutObjectCommand({
                    Bucket: S3_BUCKET,
                    Key: filePath,
                    ContentType: 'application/json',
                    Body: JSON.stringify(data),
                }));
            } catch (e) {
                console.error(`Error updating file ${filePath} in S3:`, e);
                return { message: `Error updating file ${filePath} in S3` };
            }
        }
    }

    console.log('5. Uploading CSVs to Google Drive and moving in S3...');
    for (const csvKey of csvFiles) {
        try {
            const parts = csvKey.split('/');
            const s3Prefix = parts.slice(0, -1).join('/');
            const drivePrefix = S3_TO_DRIVE_DIRS[s3Prefix] ?? `default/${s3Prefix}`;
            const fileName = parts.at(-1);
            const yyyymm = fileName.slice(0, 7);
            const destKey = `${s3Prefix}/${yyyymm}/${fileName}`;

            const response = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: csvKey }));
            const csvContent = await response.Body.transformToString();

            const folderId = await createFolders(authClient, GOOGLE_DRIVE_FOLDER_ID, `${drivePrefix}/${yyyymm}`);
            const fileId = await uploadCsvToDrive(authClient, folderId, fileName, csvContent);

            if (fileId) {
                // move in S3: copy to csv/yyyy-mm/ subfolder, then delete from root csv/
                await s3.send(new CopyObjectCommand({ Bucket: S3_BUCKET, CopySource: `${S3_BUCKET}/${csvKey}`, Key: destKey }));
                await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: csvKey }));
            } else {
                console.error(`Drive upload failed for ${csvKey}, skipping S3 move.`);
            }
        } catch (e) {
            console.error(`Error processing CSV ${csvKey}:`, e);
            return { message: `Error processing CSV ${csvKey}` };
        }
    }

    console.log('Synced S3 bucket contents to Google Drive');
    return { message: 'Synced S3 bucket contents to Google Drive' };
};
