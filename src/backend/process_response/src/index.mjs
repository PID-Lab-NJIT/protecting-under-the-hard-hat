// Accepts a new survey response and stores it to S3 bucket

import express from 'express';
import serverless from 'serverless-http';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
// S3 Configuration
const S3_BUCKET = process.env.S3_BUCKET_NAME;
const s3 = new S3Client({ region: process.env.AWS_REGION });

// Geo lookup via ipinfo.io (no bundled database — fetch built into Node 18+)
async function lookupGeo(ip) {
    try {
        const res = await fetch(`https://ipinfo.io/${ip}/json`, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) return null;
        const d = await res.json();
        const [lat, lon] = (d.loc ?? ',').split(',').map(Number);
        return {
            city: d.city ?? null,
            region: d.region ?? null,
            country: d.country ?? null,
            lat: isNaN(lat) ? null : lat,
            lon: isNaN(lon) ? null : lon,
            timezone: d.timezone ?? null,
        };
    } catch {
        return null;
    }
}

// Express.js Setup
const app = express();
app.set('trust proxy', 1);
app.use(express.json());

// handle new survey responses
app.post('/survey', async (req, res) => {
    const { data: newResponse } = req.body;

    const currDate = new Date();
    const yyyymm = currDate.getFullYear() + "-" + String(currDate.getMonth() + 1).padStart(2, '0');
    const filePath = newResponse.test || newResponse.isTest || newResponse.query?.test ? `test_json/${yyyymm}.json` : `json/${yyyymm}.json`;

    console.log('1. Fetching current file from S3...');
    let currFileData = [];
    try {
        const response = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: filePath }));
        const bodyContents = await response.Body.transformToString();
        currFileData = JSON.parse(bodyContents);
    } catch (e) {
        // Suppress no file found since we can just start with an empty array
        if (e.name !== 'NoSuchKey') {
            console.error('Error fetching current file:', e);
            return res.status(500).json({ message: 'Error fetching current file' });
        } else {
            console.log('No existing current file found, creating new one...');
        }
    }

    console.log('2. Appending new response...');
    const now = new Date();
    const ip = req.ip;
    const geo = await lookupGeo(ip);
    currFileData.push({
        id: randomUUID(),
        s3_timestamp: now.toISOString(),
        uploaded_to_drive: false,
        clientInfo: {
            ip,
            city: geo?.city ?? null,
            region: geo?.region ?? null,
            country: geo?.country ?? null,
            lat: geo?.lat ?? null,
            lon: geo?.lon ?? null,
            timezone: geo?.timezone ?? null,
        },
        data: newResponse,
    });

    console.log('3. Writing updated data back to S3...');
    try {
        await s3.send(new PutObjectCommand({
            Bucket: S3_BUCKET,
            Key: filePath,
            ContentType: 'application/json',
            Body: JSON.stringify(currFileData),
        }));
    } catch (e) {
        console.error('Error writing updated data back to S3:', e);
        return res.status(500).json({ message: 'Error writing updated data back to S3' });
    }

    console.log('4. Survey response saved successfully!');
    return res.status(200).json({ message: 'Survey response saved successfully!' });
});

export const handler = serverless(app);
