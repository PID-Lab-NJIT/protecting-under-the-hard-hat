# `send_email` Spec

A Lambda function that receives an anonymous contact-us payload from the frontend and sends an email to a particular email address with the user's message using AWS SES (Simple Email Service). The Lambda implements a basic rate limiting via DynamoDB and header injection prevention.

## Flow

1. User fills out contact form and submits. Frontend sends form data payload. [TODO] Lambda should be RESTful (Express app wrapped around serverless-http) or regular (event-based)?
2. Lambda executes from now on.
3. Performs basic rate limiting as in a later section.
    - Rejects if above limit.
4. Validates payload.
    - Reject if invalid format.
5. Performs basic header injection prevention as described in a later section.
6. SES sends the email.
7. Lambda returns a successful response to the frontend.

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

Implement basic rate limiting using windowed intervals. Base the request counts upon the user's IP (via the request received).

[TODO] Discuss TTL.
[TODO] Create basic DB schema in `./db_schema.md` with reasoning.

## Basic Header Injection Prevention

[TODO] Necessary with AWS SES non-raw send?

## Email Body Format

[TODO] Any tips on format / other info to include?

```
{message}

From:
{name}
{user email}
{user IP}
```

## Code Requirements

- Language: Typescript
- Handles errors gracefully. The user/frontend should never see any unhandled, raw error that's potentially compromising.
- Maintainability above all: comments, variable names, general syntax should favor long-term code comprehension especially by others who've never seen the code  before.
- Log at key events: rate limit pass/reject (and stats), validation pass/reject (log relevant payload details upon reject), injection prevention pass/reject (log relevant message details upon reject), SES success/failure, overall success/failure. Future debugging should be possible just from looking at the logs rather than having to modify the code with print statements.
    - Basic structure: log message (mandatory) and JSON body (if needed).
    - Use log levels appropriately (info, warn, error).

[TODO] Ask any questions you have. Give any suggestions for optimization, accuracy, security. Polish the architecture.

[TODO] AFTER GENERATING CODE: Any important info to add to this spec for future devs?
