// Syncs files from Google Drive to S3

import pLimit from "p-limit";
import { download as downloadResources } from "./resources.mjs";

// limit the number of concurrent Drive connections
const limit = pLimit(5);

// each entry downloads one file/dataset from Drive to S3
const DOWNLOADS = [downloadResources];

/**
 * Runs all Drive-to-S3 downloads concurrently (up to a limit of 5), logging the
 * outcome of each and returning a summary of how many succeeded.
 * @returns {Promise<{ message: string }>} A summary message reporting successes over total downloads.
 */
export const handler = async () => {
    const results = await Promise.allSettled(
        DOWNLOADS.map((downloadFn) => limit(downloadFn))
    );

    let successCount = 0;
    for (const result of results) {
        if (result.status === "fulfilled") {
            successCount++;
        } else {
            console.error("Download failed:", result.reason);
        }
    }

    const message = `${successCount}/${DOWNLOADS.length} downloads succeeded`;
    console.log(message);
    return { message };
};
