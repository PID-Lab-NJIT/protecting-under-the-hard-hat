// Lambda handler for the anonymous contact-us form.
//
// Invoked directly via a Lambda Function URL (API Gateway payload format 2.0), not through
// Express/serverless-http, since this service only ever needs a single route.
//
// Flow (see ../docs/spec.md):
//   1. Rate limit the request by source IP (DynamoDB fixed-window counter).
//   2. Validate the payload.
//   3. Send the email via SES.
//   4. Return a JSON status response.

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import {
  DynamoDBClient,
  ConditionalCheckFailedException,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

// ---------------------------------------------------------------------------
// Config (env vars)
// ---------------------------------------------------------------------------

const RATE_LIMIT_TABLE_NAME = process.env.RATE_LIMIT_TABLE_NAME as string;
const RATE_LIMIT_WINDOW_SECONDS = Number(process.env.RATE_LIMIT_WINDOW_SECONDS);
const RATE_LIMIT_MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX_REQUESTS);
const RATE_LIMIT_TTL_SECONDS = Number(process.env.RATE_LIMIT_TTL_SECONDS);
const SENDER_EMAIL_ADDRESS = process.env.SENDER_EMAIL_ADDRESS as string;
const RECIPIENT_EMAIL_ADDRESSES = process.env.RECIPIENT_EMAIL_ADDRESSES as string;

// ---------------------------------------------------------------------------
// AWS clients
// ---------------------------------------------------------------------------

const ddbClient = new DynamoDBClient({});
const ddbDocClient = DynamoDBDocumentClient.from(ddbClient);
const sesClient = new SESClient({});

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
//
// Structured logs so that debugging can happen entirely from CloudWatch, without needing to
// modify code and redeploy to add ad-hoc print statements.

type LogLevel = "info" | "warn" | "error";

function log(
  level: LogLevel,
  message: string,
  data?: Record<string, unknown>,
): void {
  const entry = JSON.stringify({ level, message, ...(data ? { data } : {}) });
  if (level === "error") {
    console.error(entry);
  } else if (level === "warn") {
    console.warn(entry);
  } else {
    console.log(entry);
  }
}

// ---------------------------------------------------------------------------
// Response helper
// ---------------------------------------------------------------------------

function buildResponse(
  status: number,
  message: string,
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status, message }),
  };
}

// ---------------------------------------------------------------------------
// Payload validation
// ---------------------------------------------------------------------------

interface ContactFormPayload {
  name: string;
  email: string;
  message: string;
}

// Simple, deliberately permissive check for "looks like an email" — full RFC 5322 validation
// isn't warranted here since SES will reject genuinely malformed addresses at send time anyway.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type ValidationResult =
  | { valid: true; payload: ContactFormPayload }
  | { valid: false; reason: string };

function validateContactPayload(body: unknown): ValidationResult {
  if (typeof body !== "object" || body === null) {
    return { valid: false, reason: "Request body must be a JSON object." };
  }

  const { name, email, message } = body as Record<string, unknown>;

  if (typeof name !== "string" || name.trim().length === 0) {
    return { valid: false, reason: 'Field "name" must be a non-empty string.' };
  }
  if (typeof email !== "string" || email.trim().length === 0) {
    return {
      valid: false,
      reason: 'Field "email" must be a non-empty string.',
    };
  }
  if (typeof message !== "string" || message.trim().length === 0) {
    return {
      valid: false,
      reason: 'Field "message" must be a non-empty string.',
    };
  }
  if (!EMAIL_REGEX.test(email)) {
    return {
      valid: false,
      reason: 'Field "email" is not a valid email address.',
    };
  }

  return { valid: true, payload: { name, email, message } };
}

// ---------------------------------------------------------------------------
// Rate limiting (see ../docs/db_schema.md)
// ---------------------------------------------------------------------------

interface RateLimitResult {
  allowed: boolean;
  requestCount?: number;
  windowStart: number;
}

// Performs the fixed-window rate-limit check and increment as a single atomic UpdateItem,
// avoiding a read-then-write race between concurrent invocations for the same IP.
async function checkRateLimit(sourceIp: string): Promise<RateLimitResult> {
  const nowEpochSeconds = Math.floor(Date.now() / 1000);
  const windowStart =
    Math.floor(nowEpochSeconds / RATE_LIMIT_WINDOW_SECONDS) *
    RATE_LIMIT_WINDOW_SECONDS;
  const expiresAt =
    windowStart + RATE_LIMIT_WINDOW_SECONDS + RATE_LIMIT_TTL_SECONDS;

  try {
    const result = await ddbDocClient.send(
      new UpdateCommand({
        TableName: RATE_LIMIT_TABLE_NAME,
        Key: { sourceIp, windowStart },
        UpdateExpression:
          "ADD requestCount :inc SET expiresAt = if_not_exists(expiresAt, :expiresAt)",
        ConditionExpression:
          "attribute_not_exists(requestCount) OR requestCount < :limit",
        ExpressionAttributeValues: {
          ":inc": 1,
          ":limit": RATE_LIMIT_MAX_REQUESTS,
          ":expiresAt": expiresAt,
        },
        ReturnValues: "UPDATED_NEW",
      }),
    );

    return {
      allowed: true,
      requestCount: result.Attributes?.requestCount as number | undefined,
      windowStart,
    };
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      return { allowed: false, windowStart };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Timestamp formatting
// ---------------------------------------------------------------------------

// Formats a Date as "YYYY-MM-DD HH:MM:SS" in America/New_York, accounting for daylight savings.
function formatEasternTimestamp(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const partMap: Record<string, string> = {};
  for (const part of parts) {
    partMap[part.type] = part.value;
  }

  // Intl can format midnight as hour "24" instead of "00" depending on the runtime.
  const hour = partMap.hour === "24" ? "00" : partMap.hour;

  return `${partMap.year}-${partMap.month}-${partMap.day} ${hour}:${partMap.minute}:${partMap.second}`;
}

// ---------------------------------------------------------------------------
// Email sending
// ---------------------------------------------------------------------------

async function sendContactEmail(
  payload: ContactFormPayload,
  sourceIp: string,
  timestamp: string,
): Promise<void> {
  const body = [
    `Message:`,
    payload.message,
    ``,
    `---`,
    `From:`,
    `Name: ${payload.name}`,
    `Email: ${payload.email}`,
    `IP: ${sourceIp}`,
    `Timestamp: ${timestamp} (ET)`,
  ].join("\n");

  await sesClient.send(
    new SendEmailCommand({
      Source: SENDER_EMAIL_ADDRESS,
      Destination: { ToAddresses: RECIPIENT_EMAIL_ADDRESSES.split(',') },
      ReplyToAddresses: [payload.email],
      Message: {
        Subject: { Data: "PUTHH: New Contact Message", Charset: "UTF-8" },
        Body: { Text: { Data: body, Charset: "UTF-8" } },
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> => {
  const sourceIp = event.requestContext.http.sourceIp;

  try {
    // 1. Rate limiting
    const rateLimitResult = await checkRateLimit(sourceIp);
    if (!rateLimitResult.allowed) {
      log("warn", "Rate limit exceeded", {
        sourceIp,
        windowStart: rateLimitResult.windowStart,
      });
      return buildResponse(429, "Rate limit exceeded. Please try again later.");
    }
    log("info", "Rate limit check passed", {
      sourceIp,
      requestCount: rateLimitResult.requestCount,
      windowStart: rateLimitResult.windowStart,
    });

    // 2. Validate payload
    let rawBody: unknown;
    try {
      rawBody = event.body ? JSON.parse(event.body) : undefined;
    } catch {
      log("warn", "Request body is not valid JSON", {
        sourceIp,
        body: event.body,
      });
      return buildResponse(400, "Malformed request payload.");
    }

    const validation = validateContactPayload(rawBody);
    if (!validation.valid) {
      log("warn", "Payload validation failed", {
        sourceIp,
        reason: validation.reason,
        body: rawBody,
      });
      return buildResponse(400, "Malformed request payload.");
    }
    log("info", "Payload validation passed", { sourceIp });

    // 3. Send the email
    const timestamp = formatEasternTimestamp(new Date());
    try {
      await sendContactEmail(validation.payload, sourceIp, timestamp);
    } catch (err) {
      log("error", "SES failed to send email", {
        sourceIp,
        error: (err as Error).message,
      });
      return buildResponse(500, "Failed to send message.");
    }
    log("info", "SES email sent successfully", { sourceIp });

    log("info", "Contact request handled successfully", { sourceIp });
    return buildResponse(200, "Message sent successfully.");
  } catch (err) {
    log("error", "Unhandled error while processing request", {
      sourceIp,
      error: (err as Error).message,
    });
    return buildResponse(500, "An unexpected error occurred.");
  }
};
