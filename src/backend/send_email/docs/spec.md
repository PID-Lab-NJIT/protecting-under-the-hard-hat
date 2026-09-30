# `send_email` Spec

A Lambda function that receives an anonymous contact-us payload from the frontend and sends an email to a particular email address with the user's message using AWS SES (Simple Email Service). The Lambda implements a basic rate limiting via DynamoDB.

## Lambda Overview

- Single route (`POST /`) (and most likely so for the future)
- Thus event-based (not Express/`serverless-http`)
- Invoked directly through Lambda function URL

## Flow

1. User fills out contact form and submits. Frontend sends form data payload.
2. Lambda executes from now on.
3. Performs basic rate limiting as in a later section.
   - Rejects if above limit.
4. Validates payload.
   - Reject if invalid format.
5. SES sends the email.
6. Lambda returns a successful response to the frontend.

## Payload Schema

Note: all form fields are user-inputted.

```json
{
  "name": "str - user's name",
  "email": "str - user's email address",
  "message": "str - message / body"
}
```

Validate every payload:

- All fields exist
- All values are the correct data type
- Email is a valid format

## Source IP Rate Limiting through DynamoDB

Env vars supply:

- Rate limiting window in seconds (e.g. 3600 for hourly windows)
- Limit for that window
- Time to live (TTL) before an IP request record gets deleted

Implement basic rate limiting using windowed intervals. Base the request counts upon the user's IP (via the request received).

Acceptable tradeoff: 2x limit when traffic arrives at window boundaries.

See `./db_schema.md` for more info.

## Email Characteristics

Sender address: directly from SES
Recipient address: specified by env var `RECIPIENT_EMAIL_ADDRESS`
Reply-to address: {user email}

Skip injection prevention since non-raw SES already does its own checks robustly, and the subject is static, not concatenated with user input.

Subject: "PUTHH: New Contact Message"

Body:

```
Message:
{message}

---
From:
Name: {name}
Email: {user email}
IP: {user IP}
Timestamp: {YYYY-MM-DD HH:MM:SS (ET)}
```

ET refers to the timezone America/New_York, accounting for daylight savings.

Notably, the timestamp here is when the **server** received the frontend request to avoid spoofing.

## Response Contract

| Status Code | Condition                                             |
| ----------- | ----------------------------------------------------- |
| `200`       | Successful email send                                 |
| `400`       | Validation error (e.g. mal-formatted request payload) |
| `429`       | Rate limit from an IP exceeded for current window     |
| `500`       | Any other uncaught error                              |

Response format:

```json
{
  "status": "number - status code",
  "message": "str - short message corresponding to status"
}
```

## Code Requirements

- Language: Typescript
- Handles errors gracefully. The user/frontend should never see any unhandled, raw error that's potentially compromising.
- Maintainability above all: comments, variable names, general syntax should favor long-term code comprehension especially by others who've never seen the code before.
- Log at key events: rate limit pass/reject (and stats), validation pass/reject (log relevant payload details upon reject), SES success/failure, and overall success/failure. Future debugging should be possible just from looking at the logs rather than having to modify the code with print statements.
  - Basic structure: log message (mandatory) and JSON body (if needed).
  - Use log levels appropriately (info, warn, error).

[TODO] Ask any questions you have. Give any suggestions for optimization, accuracy, security. Polish the architecture.

[TODO] AFTER GENERATING CODE: Any important info to add to this spec for future devs?
