// Utility functions for getLocalResources: data management, validation,
// distance calculation, analytics.

import fs from "fs";
import {
    S3Client,
    GetObjectCommand,
    PutObjectCommand,
} from "@aws-sdk/client-s3";
import Papa from "papaparse";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { validate as uuidValidate, version as uuidVersion } from "uuid";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// S3 Configuration
const _S3_BUCKET = process.env.S3_BUCKET_NAME;
const _s3 = new S3Client({ region: process.env.AWS_REGION });

const _SAVE_PATH = "data/new";       // for request analytics
const _ZIP_CODE_DATA_PATH = "data/zip-codes.csv";   // on Lambda itself
const _RESOURCES_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const _EARTH_RADIUS_M = 6371000;     // meters

// ---------------------------------------------------------------------------
// Data management
// ---------------------------------------------------------------------------

/**
 * Zero-pads a ZIP code to guarantee a length of 5, e.g. "680" -> "00680".
 * @param {string|number} zip
 * @returns {string} Zero-padded ZIP code.
 */
export function normalizeZip(zip) {
    return String(zip).padStart(5, "0");
}

/**
 * Finds the resources dataset's ZIP code column (schema is flexible/manually
 * maintained), matching the first header containing "zip" case-insensitively.
 * @param {string[]} fields - CSV header names.
 * @returns {string}
 */
function _findZipColumn(fields) {
    const zipColumn = fields.find((field) =>
        field.toLowerCase().includes("zip"),
    );
    if (!zipColumn)
        throw new Error("Resources dataset is missing a ZIP code column.");
    return zipColumn;
}

/**
 * Loads and parses the local ZIP codes dataset into:
 * { [normalizedZip]: { lat, long, city, state } }
 * @returns {Object}
 */
export function loadZipData() {
    const csvText = fs.readFileSync(
        path.join(__dirname, _ZIP_CODE_DATA_PATH),
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

/**
 * Fetches resources.csv from S3 and parses it into the resource objects as-is
 * (one per CSV row), alongside the name of their ZIP code column.
 * @returns {Promise<{ resources: Object[], zipColumn: string }>}
 */
async function _loadResourcesData() {
    const response = await _s3.send(
        new GetObjectCommand({ Bucket: _S3_BUCKET, Key: "resources.csv" }),
    );
    const csvText = await response.Body.transformToString();
    const { data: resources, meta } = Papa.parse(csvText, {
        header: true,
        dynamicTyping: true,
        skipEmptyLines: true,
    });
    const zipColumn = _findZipColumn(meta.fields);
    return { resources, zipColumn };
}

// Cached across warm invocations; refetched after RESOURCES_TTL_MS or if the
// previous fetch failed, so a stale or dead cache is never served forever.
let resourcesDataPromise = null;
let resourcesDataFetchedAt = null;
export function getResourcesData() {
    const isStale =
        resourcesDataFetchedAt != null &&
        Date.now() - resourcesDataFetchedAt > _RESOURCES_TTL_MS;

    if (!resourcesDataPromise || isStale) {
        resourcesDataFetchedAt = Date.now();
        resourcesDataPromise = _loadResourcesData().catch((e) => {
            resourcesDataPromise = null;
            resourcesDataFetchedAt = null;
            throw e;
        });
    }
    return resourcesDataPromise;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Checks whether a value is a strict UUIDv4 string.
 * @param {any} value
 * @returns {boolean}
 */
function _isUuidV4(value) {
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
export function validateQueryParams({
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
    if (!_isUuidV4(sessionId)) {
        return "session-id must be a valid UUIDv4.";
    }
    if (!_isUuidV4(deviceId)) {
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
// Distance calculation
// ---------------------------------------------------------------------------

function _toRadians(degrees) {
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
export function haversineDistance(lat1, long1, lat2, long2) {
    const dLat = _toRadians(lat2 - lat1);
    const dLong = _toRadians(long2 - long1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(_toRadians(lat1)) *
            Math.cos(_toRadians(lat2)) *
            Math.sin(dLong / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return _EARTH_RADIUS_M * c;
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

/**
 * Saves basic analytics data about a request to S3 as a JSON file named
 * `{datetime}_{uuid}{suffix}.json` under `SAVE_PATH`. Throws on S3 errors - the
 * caller is responsible for catching and logging, per the spec.
 * @param {{ sessionId: string, deviceId: string, zipCode: string|null, maxRadius: number, numResources: number }} data
 * @returns {Promise<void>}
 */
export async function saveAnalytics({
    isTest,
    sessionId,
    deviceId,
    zipCode,
    maxRadius,
    numResources,
}) {
    const datetime = new Date().toISOString().replace(/:/g, "-");
    const key = `${_SAVE_PATH}/${datetime}_${randomUUID()}${isTest ? "_test" : ""}.json`;
    const body = JSON.stringify({
        is_test: isTest,
        session_id: sessionId,
        device_id: deviceId,
        zip_code: zipCode,
        max_radius: maxRadius,
        num_resources: numResources,
    });

    await _s3.send(
        new PutObjectCommand({
            Bucket: _S3_BUCKET,
            Key: key,
            Body: body,
            ContentType: "application/json",
        }),
    );
}
