# Webhooks & Idempotency (Paystack/Flutterwave)
Express + TypeScript server showing signature verification and idempotent processing.

## Run
cp .env.example .env
npm i
npm run dev

## Test (Paystack example)
BODY='{"event":"charge.success","data":{"reference":"abc123"}}'
SIG=$(echo -n $BODY | openssl dgst -sha512 -hmac "$PAYSTACK_SECRET" | sed 's/^.* //')
curl -s -X POST http://localhost:3005/webhooks/paystack -H "x-paystack-signature: $SIG" -H "Content-Type: application/json" -d "$BODY"