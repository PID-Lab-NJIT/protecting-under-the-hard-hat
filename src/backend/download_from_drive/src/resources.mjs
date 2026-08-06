// Downloads the resources Google Sheet from Drive and uploads it as a CSV to S3

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { authorize, getDrive } from "./drive.mjs";

const S3_BUCKET = process.env.S3_BUCKET_NAME;
const S3_FILE_NAME = "resources.csv";

const s3 = new S3Client({ region: process.env.AWS_REGION });

/**
 * Downloads the resources dataset from Drive and uploads it to S3 as `resources.csv`.
 * @returns {Promise<void>}
 */
async function download() {
    const fileId = process.env.DRIVE_RESOURCES_FILE_ID;
    const authClient = await authorize(["https://www.googleapis.com/auth/drive.readonly"]);
    const drive = getDrive(authClient);

    // check the resources Google Sheet exists before attempting to export it
    let file;
    try {
        const response = await drive.files.get({
            fileId,
            fields: "id, name",
            supportsAllDrives: true,
        });
        file = response.data;
    } catch (e) {
        throw new Error(`Resources Google Sheet not found in Drive.`);
    }

    const exportResponse = await drive.files.export(
        { fileId: file.id, mimeType: "text/csv" },
        { responseType: "stream" }
    );

    await s3.send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: S3_FILE_NAME,
        ContentType: "text/csv",
        Body: exportResponse.data,
    }));

    console.log(`Downloaded "${file.name}" from Drive and uploaded to S3 as "${S3_FILE_NAME}".`);
}

export { download };
