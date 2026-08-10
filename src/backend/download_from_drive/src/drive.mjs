import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { drive as createDrive } from "@googleapis/drive";
import { GoogleAuth } from "google-auth-library";

let drive = null;

/**
 * Authorizes a service account to access Google Drive APIs, using credentials
 * fetched from AWS Secrets Manager (secret ID given by env var `SERVICE_ACCOUNT_SECRET_ID`).
 * @param {string[]} scopes - The scopes to request access to.
 * @returns {Promise<object>} An authorized Google Auth client.
 */
async function authorize(scopes) {
    try {
        const client = new SecretsManagerClient({ region: process.env.AWS_REGION });
        const command = new GetSecretValueCommand({ SecretId: process.env.SERVICE_ACCOUNT_SECRET_ID });
        const response = await client.send(command);
        const credentials = JSON.parse(response.SecretString);

        const auth = new GoogleAuth({ credentials, scopes });
        const authClient = await auth.getClient();
        console.log("Service account authenticated successfully.");
        return authClient;
    } catch (e) {
        console.error("Authentication failed. Please check that the service account secret is valid.");
        throw e;
    }
}

/**
 * Retrieves the Google Drive API client.
 * @param {object} authClient An authorized auth client.
 * @returns {object} The Google Drive API client.
 */
function getDrive(authClient) {
    if (drive == null) {
        drive = createDrive({ version: "v3", auth: authClient });
    }
    return drive;
}

export { authorize, getDrive };
