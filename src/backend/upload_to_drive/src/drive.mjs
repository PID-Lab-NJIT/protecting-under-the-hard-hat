import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { drive as createDrive } from '@googleapis/drive';
import { GoogleAuth } from 'google-auth-library';
import { readFile } from "node:fs/promises";
import { join } from "node:path";

let drive = null;

/**
 * Retrieves the Google Drive API client.
 * @param {object} authClient An authorized auth client.
 * @returns {object} The Google Drive API client.
 */
function getDrive(authClient) {
    if (drive == null) {
        drive = createDrive({ version: 'v3', auth: authClient });
    }
    return drive;
}

/**
 * Recursively creates a folder structure in Google Drive.
 * @param {object} authClient An authorized auth client.
 * @param {string} folderId The ID of the parent folder.
 * @param {string} path The path to the folder to create.
 * @returns {Promise<string> | null} The ID of the created folder or null if an error occurred.
 */
async function createFolders(authClient, folderId, path) {
    const drive = getDrive(authClient);

    const folders = path.split('/').filter(f => f !== '');
    let currentFolderId = folderId;

    for (const folderName of folders) {
        // check if folder already exists
        const searchQuery = `name = '${folderName}' and '${currentFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;

        const response = await drive.files.list({
            q: searchQuery,
            fields: 'files(id)',
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
        });

        if (response.data.files.length > 0) {
            currentFolderId = response.data.files[0].id;
            continue;
        }

        // otherwise, create the folder
        const folder = await drive.files.create({
            requestBody: {
                name: folderName,
                mimeType: 'application/vnd.google-apps.folder',
                parents: [currentFolderId],
            },
            fields: 'id',
            supportsAllDrives: true,
        });
        currentFolderId = folder.data.id;
    }
    return currentFolderId;
}

/**
 * Retrieves the service account credentials for Google Drive API.
 * @returns {Promise<object>} The credentials object.
 */
async function getCredentials() {
    if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
        console.log("🛠️ Running locally: Loading JSON from disk");
        const filePath = join(process.cwd(), 'private/service_account.json');
        const fileContent = await readFile(filePath, 'utf8');
        return JSON.parse(fileContent);
    }

    console.log("☁️ Running in Lambda: Fetching from Secrets Manager");
    const client = new SecretsManagerClient({ region: process.env.AWS_REGION });
    const command = new GetSecretValueCommand({ SecretId: "GoogleServiceAccount" });

    const response = await client.send(command);
    return JSON.parse(response.SecretString);
}

/**
 * Authorizes the service account to access Google Drive APIs.
 * @param {string[]} scopes - The scopes to request access to.
 * @returns {Promise<object>} An authorized Google Auth client.
 */
async function authorize(scopes) {
    try {
        const auth = new GoogleAuth({
            credentials: await getCredentials(),
            scopes,
        });

        const authClient = await auth.getClient();
        console.log("Service account authenticated successfully.");
        return authClient;
    } catch (e) {
        console.error("Authentication failed. Please check that 'service_account.json' exists and is valid.");
        throw e;
    }
}

/**
 * Uploads a JavaScript object as a JSON file to a specific Google Drive location.
 * @param {object} authClient An authorized auth client.
 * @param {string} folderId The ID of the folder to upload the file to.
 * @param {string} fileName The name of the file to upload.
 * @param {object} data The JavaScript object to upload as JSON.
 * @returns {Promise<string> | null} The ID of the uploaded file or null if an error occurred.
 */
async function uploadJsonToDrive(authClient, folderId, fileName, data) {
    const drive = getDrive(authClient);

    // pretty print the JSON data
    const jsonString = JSON.stringify(data, null, 4);

    try {
        console.log(`Uploading '${fileName}' to Google Drive...`);
        const file = await drive.files.create({
            requestBody: {
                name: fileName,
                parents: [folderId]
            },
            fields: 'id',
            media: {
                mimeType: 'application/json',
                body: jsonString,
            },
            // Essential for uploading to shared Drives
            supportsAllDrives: true,
        });

        console.log(`Successfully uploaded file to folder. File ID: ${file.data.id}`);
        return file.data.id;
    } catch (e) {
        console.error(`An error occurred during upload: ${e}`);
        return null;
    }
}

/**
 * Uploads a CSV string as a file to a specific Google Drive location.
 * @param {object} authClient An authorized auth client.
 * @param {string} folderId The ID of the folder to upload the file to.
 * @param {string} fileName The name of the file to upload.
 * @param {string} csvContent The CSV content to upload.
 * @returns {Promise<string> | null} The ID of the uploaded file or null if an error occurred.
 */
async function uploadCsvToDrive(authClient, folderId, fileName, csvContent) {
    const drive = getDrive(authClient);

    try {
        console.log(`Uploading '${fileName}' to Google Drive...`);
        const file = await drive.files.create({
            requestBody: {
                name: fileName,
                parents: [folderId]
            },
            fields: 'id',
            media: {
                mimeType: 'text/csv',
                body: csvContent,
            },
            supportsAllDrives: true,
        });

        console.log(`Successfully uploaded file to folder. File ID: ${file.data.id}`);
        return file.data.id;
    } catch (e) {
        console.error(`An error occurred during upload: ${e}`);
        return null;
    }
}

export { authorize, createFolders, uploadJsonToDrive, uploadCsvToDrive };
