# DynamoDB Schema — Rate Limiting

Supports the fixed-window rate limiting described in [`spec.md`](./spec.md). One item exists per (source IP, window) pair.

## Table: `SendEmailRateLimit`

| Attribute      | Type         | Description                                                                           |
| -------------- | ------------ | ------------------------------------------------------------------------------------- |
| `sourceIp`     | String (PK)  | The requester's IP address, as received by the Lambda Function URL.                   |
| `windowStart`  | Number (SK)  | Epoch seconds marking the start of the fixed window this item belongs to. See below.  |
| `requestCount` | Number       | Number of requests counted in this window so far. Compared against the env var limit. |
| `expiresAt`    | Number (TTL) | Epoch seconds after which DynamoDB's TTL sweep may delete this item. See "TTL" below. |

**Partition key:** `sourceIp`
**Sort key:** `windowStart`

### Why IP + windowStart as a composite key (not a single combined string key)

Using `sourceIp` as the partition key and `windowStart` as the sort key (rather than collapsing them into one string key like `${ip}#${windowStart}`) keeps the two concerns distinct, at no extra cost: DynamoDB already requires a composite primary key to be two separate attributes, and this shape leaves the door open to query the sort key range for a given IP later (e.g. for debugging "show me this IP's recent windows") without introducing a GSI. There is no current use case that queries across windows for an IP, but the composite key costs nothing over a synthetic combined string.

### `windowStart` calculation

```
windowStart = floor(nowEpochSeconds / RATE_LIMIT_WINDOW_SECONDS) * RATE_LIMIT_WINDOW_SECONDS
```

Every request within the same window bucket maps to the same `windowStart` value, so they all read/write the same item. A new window simply produces a new item — there is no "rollover" logic.

## Read/write pattern

On every request, issue a single atomic `UpdateItem`:

- **Key:** `{ sourceIp, windowStart }` (computed as above)
- **Update expression:** `ADD requestCount :inc SET expiresAt = if_not_exists(expiresAt, :expiresAt)`
- **Condition expression:** `attribute_not_exists(requestCount) OR requestCount < :limit`

If the condition fails, DynamoDB throws `ConditionalCheckFailedException` — treat this as "rate limit exceeded" and reject the request. This performs the check and increment in one round trip, avoiding a read-then-write race between concurrent invocations for the same IP.

`:limit` comes from the rate limit env var. `:inc` is always `1`.

## TTL

`expiresAt` is registered as the table's native TTL attribute (DynamoDB expects a Number in epoch seconds).

```
expiresAt = windowStart + RATE_LIMIT_WINDOW_SECONDS + RATE_LIMIT_TTL_SECONDS
```

TTL is deliberately a separate env var from the window duration:

- `RATE_LIMIT_WINDOW_SECONDS` / the limit govern the rate-limiting _decision_ — whether a request is accepted or rejected right now.
- `RATE_LIMIT_TTL_SECONDS` governs _storage cleanup_ — how long a closed window's item is kept around after it stops mattering for rate limiting, e.g. for debugging/audit ("was this IP actually being throttled at 3am?").

Because TTL is added on top of the window duration, an item is never eligible for deletion before its window has fully closed.

Note DynamoDB's TTL deletion is a background sweep and is not instantaneous — items are typically removed within 48 hours of `expiresAt`, not exactly at that timestamp. This is fine here since TTL is purely a cost/hygiene mechanism, not something the rate-limiting logic depends on for correctness.

## Accepted tradeoff

Fixed-window counting allows up to 2x the configured limit if traffic straddles a window boundary (e.g. a burst at the end of window N followed by another burst at the start of window N+1). This is an accepted tradeoff for simplicity, per [`spec.md`](./spec.md).
