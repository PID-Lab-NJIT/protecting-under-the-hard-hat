// Generates a CSV from all survey response JSON files in S3 and stores it in the csv/ folder

import { S3Client, GetObjectCommand, PutObjectCommand, CopyObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import pLimit from 'p-limit';
import { flattenObj, csvEscape } from './util.mjs';
import { DISCARD_KEYS, RENAME_KEYS, ORDERED_KEYS, START_KEYS, ANALYTICS_RENAME_KEYS } from './cleaning.mjs';

const SURVEY_BUCKET = process.env.SURVEY_BUCKET;
const RESOURCES_BUCKET = process.env.RESOURCES_BUCKET;
const ANALYTICS_SOURCE_PREFIX = 'data/new/';
const s3 = new S3Client({ region: process.env.AWS_REGION });
const limit = pLimit(10); // tune after Phase 0 baseline; 10 is a safe starting point

// Hidden (non-enumerable, non-serialized) links from a cleaned entry back to its raw
// JSON entry and source file, so analytics merges can also be written back to S3.
const RAW_ENTRY = Symbol('rawEntry');
const SOURCE_FILE = Symbol('sourceFile');

// Lists and fetches all unmerged resource analytics files once, split into test/real
// based on the filename suffix or the "is_test" field (whichever says test).
async function fetchResourceAnalytics() {
    console.log('[analytics] Listing unmerged resource analytics files...');
    let objects = [];
    try {
        let response = await s3.send(new ListObjectsV2Command({ Bucket: RESOURCES_BUCKET, Prefix: ANALYTICS_SOURCE_PREFIX }));
        objects = response.Contents ?? [];

        while (response.IsTruncated) {
            response = await s3.send(new ListObjectsV2Command({
                Bucket: RESOURCES_BUCKET,
                Prefix: ANALYTICS_SOURCE_PREFIX,
                ContinuationToken: response.NextContinuationToken,
            }));
            objects = objects.concat(response.Contents ?? []);
        }
    } catch (e) {
        console.error('[analytics] Error listing resource analytics files:', e);
        return { test: [], real: [] };
    }

    const files = objects.map(item => item.Key).filter(key => key.endsWith('.json'));

    const results = await Promise.allSettled(files.map(key => limit(async () => {
        const response = await s3.send(new GetObjectCommand({ Bucket: RESOURCES_BUCKET, Key: key }));
        const jsonStr = await response.Body.transformToString();
        const data = JSON.parse(jsonStr);
        const isTest = key.endsWith('_test.json') || data.is_test === true;
        return { key, data, isTest };
    })));

    const test = [];
    const real = [];
    for (const r of results) {
        if (r.status === 'rejected') {
            console.warn('[analytics] Error fetching/parsing analytics file, skipping:', r.reason);
            continue;
        }
        (r.value.isTest ? test : real).push({ key: r.value.key, data: r.value.data });
    }

    return { test, real };
}

// Merges resource analytics onto the matching (already session-resolved) survey entries,
// keyed on session_id, writes the same fields back onto the raw JSON entry (marking its
// source file dirty for rewrite), and moves successfully-merged analytics files to
// data/{yyyy-mm}/ (or data/unmatched/ if no session_id match was found).
async function mergeResourceAnalytics(sourcePrefix, resolvedData, analyticsFiles, dirtyFiles) {
    console.log(`[${sourcePrefix}] Merging resource analytics...`);
    const bySessionId = {};
    for (const entry of resolvedData) {
        const sid = entry['session_id'];
        if (sid) bySessionId[sid] = entry;
    }

    const results = await Promise.allSettled(analyticsFiles.map(({ key, data }) => limit(async () => {
        const fileName = key.slice(ANALYTICS_SOURCE_PREFIX.length);
        const match = data.session_id ? bySessionId[data.session_id] : null;

        let destKey;
        if (!match) {
            destKey = `data/unmatched/${fileName}`;
        } else {
            const rawEntry = match[RAW_ENTRY];
            for (const [srcKey, dest] of Object.entries(ANALYTICS_RENAME_KEYS)) {
                const value = data[srcKey];
                match[dest] = value;
                if (rawEntry) rawEntry[dest] = value;
            }
            if (rawEntry?.[SOURCE_FILE]) dirtyFiles.add(rawEntry[SOURCE_FILE]);
            const yyyyMm = fileName.slice(0, 7);
            destKey = `data/${yyyyMm}/${fileName}`;
        }

        try {
            await s3.send(new CopyObjectCommand({
                Bucket: RESOURCES_BUCKET,
                CopySource: `${RESOURCES_BUCKET}/${key}`,
                Key: destKey,
            }));
            await s3.send(new DeleteObjectCommand({ Bucket: RESOURCES_BUCKET, Key: key }));
        } catch (e) {
            console.warn(`[${sourcePrefix}] Error moving resource analytics file ${key} to ${destKey}:`, e);
        }
    })));

    for (const r of results) {
        if (r.status === 'rejected') {
            console.warn(`[${sourcePrefix}] Error merging resource analytics file, skipping:`, r.reason);
        }
    }
}

async function processDirectory(sourcePrefix, destPrefix, analyticsFiles) {
    // 1. List all JSON files from S3
    console.log(`[${sourcePrefix}] 1. Listing all data files from S3...`);
    let files = [];

    try {
        let response = await s3.send(new ListObjectsV2Command({ Bucket: SURVEY_BUCKET, Prefix: sourcePrefix }));
        let objects = response.Contents ?? [];

        while (response.IsTruncated) {
            response = await s3.send(new ListObjectsV2Command({
                Bucket: SURVEY_BUCKET,
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
    const fileEntries = {}; // filePath: entries
    const dirtyFiles = new Set(); // filePaths needing rewrite (new data and/or analytics merge)

    const settled = await Promise.allSettled(files.map(filePath => limit(async () => {
        const response = await s3.send(new GetObjectCommand({ Bucket: SURVEY_BUCKET, Key: filePath }));
        const jsonStr = await response.Body.transformToString();
        return { filePath, entries: JSON.parse(jsonStr) };
    })));

    const failedIndex = settled.findIndex(r => r.status === 'rejected');
    if (failedIndex !== -1) {
        const filePath = files[failedIndex];
        console.error(`[${sourcePrefix}] Error fetching file ${filePath}:`, settled[failedIndex].reason);
        return { message: `[${sourcePrefix}] Error fetching file ${filePath}` };
    }
    const fetchResults = settled.map(r => r.value);

    for (const { filePath, entries } of fetchResults) {
        fileEntries[filePath] = entries;
        let fileHasNewData = false;

        for (const entry of entries) {
            entry[SOURCE_FILE] = filePath;
            if (!entry.generated_as_csv) {
                hasNewData = true;
                fileHasNewData = true;
            }
            allEntries.push(entry);
        }

        if (fileHasNewData) {
            dirtyFiles.add(filePath);
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
        cleaned[RAW_ENTRY] = entry;
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

    // 4b. Merge resource analytics onto resolved entries by session_id
    await mergeResourceAnalytics(sourcePrefix, resolvedData, analyticsFiles, dirtyFiles);

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
        for (const key in entry) {
            if (entry[key] != null) {
                allKeys.add(key);
            }
        }
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
            Bucket: SURVEY_BUCKET,
            Key: csvKey,
            ContentType: 'text/csv',
            Body: csv,
        }));
    } catch (e) {
        console.error(`[${sourcePrefix}] Error uploading CSV to S3:`, e);
        return { message: `[${sourcePrefix}] Error uploading CSV to S3` };
    }

    // 9. Mark all entries in affected files as generated_as_csv and write back any merged analytics fields
    console.log(`[${sourcePrefix}] 9. Marking entries as generated_as_csv...`);
    for (const filePath of dirtyFiles) {
        const entries = fileEntries[filePath];
        try {
            for (const entry of entries) {
                entry.generated_as_csv = true;
            }
            await s3.send(new PutObjectCommand({
                Bucket: SURVEY_BUCKET,
                Key: filePath,
                ContentType: 'application/json',
                Body: JSON.stringify(entries),
            }));
        } catch (e) {
            console.error(`[${sourcePrefix}] Error marking entries in ${filePath}:`, e);
            return { message: `[${sourcePrefix}] Error marking entries in ${filePath}` };
        }
    }

    console.log(`[${sourcePrefix}] CSV uploaded to s3://${SURVEY_BUCKET}/${csvKey}`);
    return { message: `CSV uploaded to s3://${SURVEY_BUCKET}/${csvKey}` };
}

export const handler = async () => {
    const { test: testAnalytics, real: realAnalytics } = await fetchResourceAnalytics();
    const [prodResult, testResult] = await Promise.all([
        processDirectory('json/', 'csv/', realAnalytics),
        processDirectory('test_json/', 'test_csv/', testAnalytics),
    ]);
    return { prod: prodResult, test: testResult };
};
