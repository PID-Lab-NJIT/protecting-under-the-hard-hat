// Generates a CSV from all survey response JSON files in S3 and stores it in the csv/ folder

import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { flattenObj, csvEscape } from './util.js';
import { DISCARD_KEYS, RENAME_KEYS, ORDERED_KEYS, START_KEYS } from './cleaning.js';

const S3_BUCKET = process.env.S3_BUCKET_NAME;
const s3 = new S3Client({ region: process.env.AWS_REGION });

async function processDirectory(sourcePrefix, destPrefix) {
    // 1. List all JSON files from S3
    console.log(`[${sourcePrefix}] 1. Listing all data files from S3...`);
    let files = [];

    try {
        let response = await s3.send(new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: sourcePrefix }));
        let objects = response.Contents ?? [];

        while (response.IsTruncated) {
            response = await s3.send(new ListObjectsV2Command({
                Bucket: S3_BUCKET,
                Prefix: sourcePrefix,
                ContinuationToken: response.NextContinuationToken,
            }));
            objects = objects.concat(response.Contents ?? []);
        }

        files = objects.map(item => item.Key).filter(key => key.endsWith('.json'));
    } catch (e) {
        console.error(`[${sourcePrefix}] Error listing S3 files:`, e);
        return { message: `[${sourcePrefix}] Error listing S3 files` };
    }

    // 2. Fetch all entries and check for new data
    console.log(`[${sourcePrefix}] 2. Fetching entries...`);
    const allEntries = [];
    let hasNewData = false;
    const filesToUpdate = {}; // files containing un-flagged entries, written back after upload

    for (const filePath of files) {
        try {
            const response = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: filePath }));
            const jsonStr = await response.Body.transformToString();
            const entries = JSON.parse(jsonStr);
            let fileHasNewData = false;

            for (const entry of entries) {
                if (!entry.generated_as_csv) {
                    hasNewData = true;
                    fileHasNewData = true;
                }
                allEntries.push(entry);
            }

            if (fileHasNewData) {
                filesToUpdate[filePath] = entries;
            }
        } catch (e) {
            console.error(`[${sourcePrefix}] Error fetching file ${filePath}:`, e);
            return { message: `[${sourcePrefix}] Error fetching file ${filePath}` };
        }
    }

    if (!hasNewData) {
        console.log(`[${sourcePrefix}] No new data since last CSV generation, skipping.`);
        return { message: `[${sourcePrefix}] No new data since last CSV generation` };
    }

    // 3. Flatten and clean all entries
    console.log(`[${sourcePrefix}] 3. Cleaning entries...`);

    // Pre-compute which dest keys have multiple source keys (merge groups)
    const mergeGroups = {};
    for (const [src, dest] of Object.entries(RENAME_KEYS)) {
        (mergeGroups[dest] = mergeGroups[dest] || []).push(src);
    }
    const mergedDests = new Set(Object.keys(mergeGroups).filter(d => mergeGroups[d].length > 1));

    const masterData = [];
    for (const entry of allEntries) {
        // normalize malformed data field: [{...}] -> {...}
        const base = Array.isArray(entry.data) && entry.data.length === 1
            ? { ...entry, data: entry.data[0] }
            : entry;
        const flat = flattenObj(base, '');
        // discard specified keys
        for (const key of DISCARD_KEYS) delete flat[key];

        const cleaned = {};
        // rename & merge keys
        for (const key in flat) {
            const newKey = RENAME_KEYS[key] ?? key.split('.').pop();
            if (mergedDests.has(newKey) && newKey in cleaned) {
                const existing = cleaned[newKey];
                const incoming = flat[key];
                if (incoming != null && existing != null && incoming !== existing) {
                    console.warn(`[cleaning] Merge conflict on "${newKey}" (entry ${flat['id'] ?? '?'}): keeping "${existing}", discarding "${incoming}" from source key "${key}"`);
                } else if (incoming != null) {
                    cleaned[newKey] = incoming;
                }
            } else {
                cleaned[newKey] = flat[key];
            }
        }
        masterData.push(cleaned);
    }

    // 4. Resolve session_id pairs: drop completed:false if a completed:true partner exists,
    // but carry over its timestamps and clientInfo onto the completed entry.
    console.log(`[${sourcePrefix}] 4. Resolving session_id pairs...`);
    const bySession = {};
    const noSession = [];
    for (const entry of masterData) {
        const sid = entry['session_id'];
        const groupKey = sid ? `session:${sid}` : null;
        if (!groupKey) {
            noSession.push(entry);
        } else {
            (bySession[groupKey] = bySession[groupKey] || []).push(entry);
        }
    }

    const resolvedData = [...noSession];
    for (const sid in bySession) {
        const group = bySession[sid];
        const completes = group.filter(e => e['completed'] === true);
        const incompletes = group.filter(e => e['completed'] === false);
        incompletes.sort((a, b) => (a['timestamp'] ?? '') < (b['timestamp'] ?? '') ? -1 : 1);

        if (completes.length >= 1) {
            // Keep latest complete entry; merge START_KEYS from earliest incomplete
            completes.sort((a, b) => (a['timestamp'] ?? '') < (b['timestamp'] ?? '') ? -1 : 1);
            const latest = completes[completes.length - 1];
            if (incompletes.length > 0) {
                for (const key of START_KEYS) {
                    latest[key + '_start'] = incompletes[0][key];
                }
            }
            latest['num_incomplete'] = incompletes.length;
            resolvedData.push(latest);
        } else if (incompletes.length > 0) {
            // Abandoned: keep latest incomplete (furthest progress), start info from earliest
            const latest = incompletes[incompletes.length - 1];
            if (incompletes.length > 1) {
                for (const key of START_KEYS) {
                    latest[key + '_start'] = incompletes[0][key];
                }
            }
            latest['num_incomplete'] = incompletes.length;
            resolvedData.push(latest);
        } else {
            resolvedData.push(...group);
        }
    }

    // 5. Sort descending by timestamp
    console.log(`[${sourcePrefix}] 5. Sorting entries...`);
    resolvedData.sort((a, b) => {
        const ta = a['timestamp'] ?? '';
        const tb = b['timestamp'] ?? '';
        return tb < ta ? -1 : tb > ta ? 1 : 0;
    });

    // 6. Build headers: establish base order (ORDERED_KEYS first, then remaining),
    // then insert each _start column immediately after its counterpart.
    // JS sets are ordered by insertion order.
    console.log(`[${sourcePrefix}] 6. Building CSV headers...`);
    const allKeys = new Set();
    for (const entry of resolvedData) {
        for (const key in entry) allKeys.add(key);
    }

    // start with ORDERED_KEYS, then add remaining keys
    const orderedSet = new Set(ORDERED_KEYS.filter(k => allKeys.has(k)));
    for (const key of allKeys) {
        if (!orderedSet.has(key) && !key.endsWith('_start')) orderedSet.add(key);
    }

    const headers = [];
    for (const key of orderedSet) {
        headers.push(key);
        // push _start columns after their non-_start counterparts
        if (allKeys.has(key + '_start')) headers.push(key + '_start');
    }

    // 7. Build CSV
    console.log(`[${sourcePrefix}] 7. Building CSV...`);
    const rows = [headers.map(csvEscape).join(',')];
    for (const entry of resolvedData) {
        rows.push(headers.map(h => csvEscape(entry[h])).join(','));
    }
    const csv = rows.join('\n');

    // 8. Upload CSV to S3
    console.log(`[${sourcePrefix}] 8. Uploading CSV to S3...`);
    const csvKey = `${destPrefix}${new Date().toISOString()}.csv`;
    try {
        await s3.send(new PutObjectCommand({
            Bucket: S3_BUCKET,
            Key: csvKey,
            ContentType: 'text/csv',
            Body: csv,
        }));
    } catch (e) {
        console.error(`[${sourcePrefix}] Error uploading CSV to S3:`, e);
        return { message: `[${sourcePrefix}] Error uploading CSV to S3` };
    }

    // 9. Mark all entries in affected files as generated_as_csv
    console.log(`[${sourcePrefix}] 9. Marking entries as generated_as_csv...`);
    for (const [filePath, entries] of Object.entries(filesToUpdate)) {
        try {
            for (const entry of entries) {
                entry.generated_as_csv = true;
            }
            await s3.send(new PutObjectCommand({
                Bucket: S3_BUCKET,
                Key: filePath,
                ContentType: 'application/json',
                Body: JSON.stringify(entries),
            }));
        } catch (e) {
            console.error(`[${sourcePrefix}] Error marking entries in ${filePath}:`, e);
            return { message: `[${sourcePrefix}] Error marking entries in ${filePath}` };
        }
    }

    console.log(`[${sourcePrefix}] CSV uploaded to s3://${S3_BUCKET}/${csvKey}`);
    return { message: `CSV uploaded to s3://${S3_BUCKET}/${csvKey}` };
}

export const handler = async () => {
    const [prodResult, testResult] = await Promise.all([
        processDirectory('json/', 'csv/'),
        processDirectory('test_json/', 'test_csv/'),
    ]);
    return { prod: prodResult, test: testResult };
};
