// Given a user ZIP code and max radius (meters), returns resources located within that radius.
// See spec.md for the full request/response contract.

import express from "express";
import serverless from "serverless-http";
import { normalizeZip, loadZipData, getResourcesData, validateQueryParams, haversineDistance, saveAnalytics } from "./util.mjs";

const MARGIN = 5000;                // meters; filtering leeway for floating point errors

// Module Scope: load datasets once per Lambda container (cold start).
const zipData = loadZipData();

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
