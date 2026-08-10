// Given a user ZIP code and max radius (meters), returns resources located within that radius.
// See spec.md for the full request/response contract.

import express from "express";
import serverless from "serverless-http";
import {
    S3Client,
    GetObjectCommand,
    PutObjectCommand,
} from "@aws-sdk/client-s3";
import Papa from "papaparse";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { validate as uuidValidate, version as uuidVersion } from "uuid";

// S3 Configuration
const S3_BUCKET = process.env.S3_BUCKET_NAME;
const s3 = new S3Client({ region: process.env.AWS_REGION });
const SAVE_PATH = "data/new";       // for request analytics

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ZIP_CODE_DATA_PATH = "data/zip-codes.csv";
const MARGIN = 5000;                // meters; filtering leeway for floating point errors
const EARTH_RADIUS_M = 6371000;     // meters

// ---------------------------------------------------------------------------
// Module Scope: load datasets once per Lambda container (cold start).
// ---------------------------------------------------------------------------

/**
 * Zero-pads a ZIP code to guarantee a length of 5, e.g. "680" -> "00680".
 * @param {string|number} zip
 * @returns {string} Zero-padded ZIP code.
 */
function normalizeZip(zip) {
    return String(zip).padStart(5, "0");
}

/**
 * Loads and parses the local ZIP codes dataset into:
 * { [normalizedZip]: { lat, long, city, state } }
 * @returns {Object}
 */
function loadZipData() {
    const csvText = fs.readFileSync(
        path.join(__dirname, ZIP_CODE_DATA_PATH),
        "utf-8",
    );
    const { data: rows } = Papa.parse(csvText, {
        header: true,
        dynamicTyping: true,
        skipEmptyLines: true,
    });

    const zipData = {};
    for (const row of rows) {
        const zip = normalizeZip(row.Zip);
        zipData[zip] = {
            lat: row.Latitude,
            long: row.Longitude,
            city: row.City,
            state: row.State,
        };
    }
    return zipData;
}

const zipData = loadZipData();

/**
 * Finds the resources dataset's ZIP code column (schema is flexible/manually
 * maintained), matching the first header containing "zip" case-insensitively.
 * @param {string[]} fields - CSV header names.
 * @returns {string}
 */
function findZipColumn(fields) {
    const zipColumn = fields.find((field) =>
        field.toLowerCase().includes("zip"),
    );
    if (!zipColumn)
        throw new Error("Resources dataset is missing a ZIP code column.");
    return zipColumn;
}

/**
 * Fetches resources.csv from S3 and parses it into the resource objects as-is
 * (one per CSV row), alongside the name of their ZIP code column.
 * @returns {Promise<{ resources: Object[], zipColumn: string }>}
 */
async function loadResourcesData() {
    const response = await s3.send(
        new GetObjectCommand({ Bucket: S3_BUCKET, Key: "resources.csv" }),
    );
    const csvText = await response.Body.transformToString();
    const { data: resources, meta } = Papa.parse(csvText, {
        header: true,
        dynamicTyping: true,
        skipEmptyLines: true,
    });
    const zipColumn = findZipColumn(meta.fields);
    return { resources, zipColumn };
}

const RESOURCES_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

// Cached across warm invocations; refetched after RESOURCES_TTL_MS or if the
// previous fetch failed, so a stale or dead cache is never served forever.
let resourcesDataPromise = null;
let resourcesDataFetchedAt = null;
function getResourcesData() {
    const isStale =
        resourcesDataFetchedAt != null &&
        Date.now() - resourcesDataFetchedAt > RESOURCES_TTL_MS;

    if (!resourcesDataPromise || isStale) {
        resourcesDataFetchedAt = Date.now();
        resourcesDataPromise = loadResourcesData().catch((e) => {
            resourcesDataPromise = null;
            resourcesDataFetchedAt = null;
            throw e;
        });
    }
    return resourcesDataPromise;
}

// ---------------------------------------------------------------------------
// Function Scope: validation
// ---------------------------------------------------------------------------

/**
 * Checks whether a value is a strict UUIDv4 string.
 * @param {any} value
 * @returns {boolean}
 */
function isUuidV4(value) {
    return (
        uuidValidate(value) &&
        uuidVersion(value) === 4
    );
}

/**
 * Validates query params against the spec's requirements.
 * @param {{ isTest, sessionId: any, deviceId: any, zipCode: any, maxRadius: any }} body
 * @returns {string|null} Descriptive error message, or null if valid.
 */
function validateQueryParams({
	isTest,
	sessionId,
	deviceId,
	zipCode,
	maxRadius,
}) {
    // Field requirement deviation
	if (isTest == null) {
        return "is-test is required.";
    }
    if (sessionId == null) {
        return "session-id is required.";
    }
    if (deviceId == null) {
        return "device-id is required.";
    }
    if (maxRadius == null) {
        return "max-radius is required.";
    }
	if (maxRadius === "-1") {
        // max-radius == -1 is the sole indicator of "no ZIP code" requests.
        if (zipCode != null) {
            return "zip-code must not be provided when max-radius is -1.";
        }
    } else {
        if (zipCode == null) {
            return "zip-code is required when max-radius is not -1.";
        }
    }

    // Advanced checks
    if (isTest !== "true" && isTest !== "false") {
        return "is-test must be either 'true' or 'false'.";
    }
	if (!isUuidV4(sessionId)) {
        return "session-id must be a valid UUIDv4.";
    }
    if (!isUuidV4(deviceId)) {
        return "device-id must be a valid UUIDv4.";
    }
	if (maxRadius !== "-1" && zipCode.length !== 5) {
		return "zip-code must be exactly 5 characters long.";
	}
	if (maxRadius !== "-1" && !/^\d+$/.test(zipCode)) {
        return "zip-code must contain only numeric characters.";
    }
	const maxRadiusNum = Number(maxRadius);
    if (
        Number.isNaN(maxRadiusNum) ||
        !(maxRadiusNum === -1 || maxRadiusNum >= 0)
    ) {
        return "max-radius must be a non-negative number, or -1 to retrieve all resources.";
    }    
    return null;
}

// ---------------------------------------------------------------------------
// Function Scope: distance calculation
// ---------------------------------------------------------------------------

function toRadians(degrees) {
    return (degrees * Math.PI) / 180;
}

/**
 * Great-circle distance between two lat/long pairs, in meters (Haversine formula).
 * @param {number} lat1
 * @param {number} long1
 * @param {number} lat2
 * @param {number} long2
 * @returns {number} Distance in meters.
 */
function haversineDistance(lat1, long1, lat2, long2) {
    const dLat = toRadians(lat2 - lat1);
    const dLong = toRadians(long2 - long1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRadians(lat1)) *
            Math.cos(toRadians(lat2)) *
            Math.sin(dLong / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return EARTH_RADIUS_M * c;
}

// ---------------------------------------------------------------------------
// Function Scope: analytics
// ---------------------------------------------------------------------------

/**
 * Saves basic analytics data about a request to S3 as a JSON file named
 * `{datetime}_{uuid}{suffix}.json` under `SAVE_PATH`. Throws on S3 errors - the
 * caller is responsible for catching and logging, per the spec.
 * @param {{ sessionId: string, deviceId: string, zipCode: string|null, maxRadius: number, numResources: number }} data
 * @returns {Promise<void>}
 */
async function saveAnalytics({
    isTest,
    sessionId,
    deviceId,
    zipCode,
    maxRadius,
    numResources,
}) {
    const datetime = new Date().toISOString().replace(/:/g, "-");
    const key = `${SAVE_PATH}/${datetime}_${randomUUID()}${isTest ? "_test" : ""}.json`;
    const body = JSON.stringify({
        is_test: isTest,
        session_id: sessionId,
        device_id: deviceId,
        zip_code: zipCode,
        max_radius: maxRadius,
        num_resources: numResources,
    });

    await s3.send(
        new PutObjectCommand({
            Bucket: S3_BUCKET,
            Key: key,
            Body: body,
            ContentType: "application/json",
        }),
    );
}

// ---------------------------------------------------------------------------
// Express.js Setup
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

/**
 * GET /local-resources
 *
 * Returns resources within `max-radius` meters of `zip-code`, or all resources
 * when `max-radius` is -1 (in which case `zip-code` must be omitted).
 *
 * Query params:
 * 		is-test: "true" or "false",
 * 		session-id: UUIDv4
 * 		device-id: UUIDv4
 * 		zip-code?: 5-character integer string
 * 		max-radius: string entirely a number >= 0 or -1
 *
 * Responses:
 *   200 - { success: true, type, message, zip_code_info?, resources: [...] }
 *   400 - { success: false, error } - missing/invalid fields
 *   404 - { success: false, error } - zip_code not found in ZIP dataset
 *   500 - { success: false, error: "Internal server error." } - unhandled error
 */
app.get("/local-resources", async (req, res) => {
	const isTestRaw = req.query["is-test"];
	const sessionIdRaw = req.query["session-id"];
	const deviceIdRaw = req.query["device-id"];
	const zipCodeRaw = req.query["zip-code"];
	const maxRadiusRaw = req.query["max-radius"];
    console.log(
        `Request: is-test=${isTestRaw}, session-id=${sessionIdRaw}, device-id=${deviceIdRaw}, zip-code=${zipCodeRaw}, max-radius=${maxRadiusRaw}`,
    );

    try {
        const validationError = validateQueryParams({
            isTest: isTestRaw,
			sessionId: sessionIdRaw,
            deviceId: deviceIdRaw,
            zipCode: zipCodeRaw,
			maxRadius: maxRadiusRaw,
        });
        if (validationError) {
            console.warn(`400: ${validationError}`);
            return res
                .status(400)
                .json({ success: false, error: validationError });
        }
		
		const isTest = isTestRaw === "true";
		const sessionId = sessionIdRaw;
		const deviceId = deviceIdRaw;
		const zipCode = zipCodeRaw;
		const maxRadius = Number(maxRadiusRaw);

        const { resources, zipColumn } = await getResourcesData();

        // max-radius == -1: return every resource, unsorted, with no distance/ZIP info.
        if (maxRadius === -1) {
            try {
                await saveAnalytics({
                    isTest,
                    sessionId,
                    deviceId,
                    zipCode: null,
                    maxRadius,
                    numResources: resources.length,
                });
                console.log("Analytics saved successfully.");
            } catch (e) {
                console.error("Failed to save analytics:", e);
            }

            console.log(`200: all_resources, ${resources.length} resource(s)`);
            return res.status(200).json({
                success: true,
                type: "all_resources",
                message: `Found ${resources.length} resource(s).`,
                resources,
            });
        }

        const userZip = normalizeZip(zipCode);
        const userZipInfo = zipData[userZip];
        if (!userZipInfo) {
            const error = `ZIP code ${zipCode} not found.`;
            console.warn(`404: ${error}`);
            return res.status(404).json({ success: false, error });
        }

        // Distance from the user ZIP to each resource's own ZIP, filtered to
        // max-radius (plus MARGIN leeway), closest first. Resources are the
        // limiting factor here (few), so only their ZIPs are considered -
        // not every ZIP in the dataset.
        const resourceDistances = [];
        for (const resource of resources) {
            const resourceZip = normalizeZip(resource[zipColumn]);
            const resourceZipInfo = zipData[resourceZip];
            if (!resourceZipInfo) {
                console.warn(
                    `Resource ZIP code ${resourceZip} not found in ZIP dataset; excluding resource.`,
                );
                continue;
            }

            const distance = haversineDistance(
                userZipInfo.lat,
                userZipInfo.long,
                resourceZipInfo.lat,
                resourceZipInfo.long,
            );
            if (distance <= maxRadius + MARGIN) {
                resourceDistances.push([distance, resource]);
            }
        }

        resourceDistances.sort((a, b) => a[0] - b[0]);

        const localResources = resourceDistances.map(([distance, resource]) => ({
            ...resource,
            distance,
        }));

        try {
            await saveAnalytics({
                isTest,
                sessionId,
                deviceId,
                zipCode,
                maxRadius,
                numResources: localResources.length,
            });
            console.log("Analytics saved successfully.");
        } catch (e) {
            console.error("Failed to save analytics:", e);
        }

        console.log(
            `200: local_resources, ${localResources.length} resource(s)`,
        );
        return res.status(200).json({
            success: true,
            type: "local_resources",
            message: `Found ${localResources.length} resource(s) within ${maxRadius} meters of ZIP code ${zipCode}.`,
            zip_code_info: {
                zip_code: zipCode,
                city: userZipInfo.city,
                state: userZipInfo.state,
            },
            resources: localResources,
        });
    } catch (e) {
        console.error("500: Internal server error:", e);
        return res
            .status(500)
            .json({ success: false, error: "Internal server error." });
    }
});

export const handler = serverless(app);
