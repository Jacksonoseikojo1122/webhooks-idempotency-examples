# Webhooks and Idempotency: Paystack and Flutterwave

[![CI](https://github.com/Jacksonoseikojo1122/webhooks-idempotency-examples/actions/workflows/ci.yml/badge.svg)](https://github.com/Jacksonoseikojo1122/webhooks-idempotency-examples/actions/workflows/ci.yml)

Payment providers deliver webhooks at least once. They retry on timeouts and non-2xx responses, sometimes deliver the same event twice in parallel, and anyone who knows your URL can post a fake one. A receiver therefore has two jobs: verify that each request really came from the provider, and make sure each event changes your system exactly once, so a customer is never credited twice for one charge. This matters for any Ghanaian fintech or merchant taking card and mobile money (MoMo) payments through Paystack or Flutterwave. This repository is a small, tested Express + TypeScript reference receiver that does both.

## How it works

- **Authenticity first.** Paystack requests are checked with HMAC-SHA512 of the raw request body (`x-paystack-signature`). Flutterwave requests are checked against the dashboard secret hash (`verif-hash`). Both comparisons use `crypto.timingSafeEqual`.
- **Raw body preserved.** The webhook routes read the body as bytes, so the signature is computed over exactly what the provider sent.
- **Fails closed.** If `PAYSTACK_SECRET` or `FLW_HASH` is not set, that provider's endpoint returns `500` and logs the misconfiguration. It never verifies against an empty secret.
- **Strict input.** Malformed JSON returns `400`. The minimal event shape (`event`, plus an identifier) is validated with zod.
- **Real idempotency keys.** The key is `provider:event:id`, where `id` is Paystack `data.id` (falling back to `data.reference`) or Flutterwave `data.id` (falling back to `data.tx_ref`). An event with no identifier is rejected with `400` instead of being folded into a shared placeholder key.
- **Mark after success.** An event is recorded as processed only after the handler succeeds. If the handler throws, the response is `500` and the provider's retry is processed normally.
- **Concurrent duplicates.** An in-flight set ensures that two simultaneous deliveries of the same event do not both run the handler. The second gets `409`, so the provider retries later and then receives `200` with `duplicate: true`.
- **Bounded store.** Processed keys live in an in-memory TTL store (24 hours by default) behind an `IdempotencyStore` interface, with a periodic sweep of expired entries.

### Responses

| Situation | Status | Body |
| --- | --- | --- |
| New event processed | `200` | `{"ok":true,"duplicate":false}` |
| Already processed | `200` | `{"ok":true,"duplicate":true}` |
| Same event currently being processed | `409` | `{"ok":false,"error":"..."}` |
| Missing or invalid signature / hash | `401` | `{"ok":false,"error":"Invalid signature"}` |
| Malformed JSON, or no usable event id | `400` | `{"ok":false,"error":"..."}` |
| Secret not configured, or handler failed | `500` | `{"ok":false,"error":"..."}` |

Signature checks run before the body is parsed, so an unsigned request never reaches the JSON parser or the handler.

## Quickstart

Requires Node.js 20 or later.

```bash
cp .env.example .env   # then set PAYSTACK_SECRET and FLW_HASH
npm install
npm run dev            # tsx watch, http://localhost:3005
```

Production build:

```bash
npm run build
npm start
```

Business logic goes in the `handleEvent` function passed to `createApp()` (see `src/app.ts`). The default handler only logs the event.

## Testing

```bash
npm run typecheck
npm test
```

The test suite uses Node's built-in test runner (via `tsx`). It starts the app on an ephemeral port and exercises it over HTTP with `fetch`: valid and invalid signatures, missing secrets, malformed JSON, missing event ids, sequential and concurrent duplicate deliveries, handler failure followed by a retry, and TTL expiry in the store.

### Sending a signed request by hand

With the server running and `PAYSTACK_SECRET` set to the same value in your shell and in `.env`:

```bash
BODY='{"event":"charge.success","data":{"id":302961,"reference":"order_1001"}}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha512 -hmac "$PAYSTACK_SECRET" | sed 's/^.* //')

curl -s -X POST http://localhost:3005/webhooks/paystack \
  -H "Content-Type: application/json" \
  -H "x-paystack-signature: $SIG" \
  -d "$BODY"
# {"ok":true,"duplicate":false}
# Run the same curl again: {"ok":true,"duplicate":true}
```

Flutterwave sends your configured secret hash as a header:

```bash
curl -s -X POST http://localhost:3005/webhooks/flutterwave \
  -H "Content-Type: application/json" \
  -H "verif-hash: $FLW_HASH" \
  -d '{"event":"charge.completed","data":{"id":4975364,"tx_ref":"order_1002"}}'
```

## Project layout

```
src/
  app.ts        createApp(): Express app, dependency injection, error handler
  index.ts      Loads .env and starts the HTTP listener
  webhooks.ts   Signature verification, schema validation, idempotency flow
  store.ts      IdempotencyStore interface and in-memory TTL implementation
test/
  webhooks.test.ts   HTTP-level tests against an ephemeral server
.github/workflows/ci.yml   Typecheck, test and build on Node 20 and 22
```

## Production notes

This is a reference implementation. Before running it for real money, these are the next steps:

- **Shared store.** The in-memory store and in-flight set only deduplicate within one process. With more than one instance, implement `IdempotencyStore` on Redis (`SET key 1 NX EX <ttl>`) or a database unique constraint, and make the in-flight claim atomic in the same store.
- **Respond fast, then queue.** Providers time out slow receivers and retry. A production handler should persist the event (or enqueue a job) and return `200`, doing the heavy work asynchronously.
- **Replay window.** Neither provider's signature covers a timestamp, so a captured request can be replayed. The idempotency store blocks replays within its TTL; size the TTL to exceed the provider's retry window, and consider verifying the transaction with the provider's API before giving value.
- **Re-verify amounts.** Treat the webhook as a notification. Confirm status, amount and currency against your own order record and the provider's verify endpoint.
- **Logging and monitoring.** Swap the console logger for structured logs, include the idempotency key on every line, and alert on sustained `401`, `409` and `500` responses.
- **Source IP allow-listing** where the provider publishes its webhook IPs, as defence in depth.

## Author

Built by Jackson Kojo Osei — [LinkedIn](https://www.linkedin.com/in/jackson-kojo-osei-740846189)
