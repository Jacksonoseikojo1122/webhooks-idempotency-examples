import crypto from 'node:crypto'
import express, { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import type { IdempotencyStore } from './store.js'

export type Provider = 'paystack' | 'flutterwave'

/** A verified, schema-checked webhook event handed to business logic. */
export interface WebhookEvent {
  provider: Provider
  /** Provider event type, e.g. `charge.success` (Paystack) or `charge.completed` (Flutterwave). */
  type: string
  /** Provider identifier for the underlying object (transaction id, or reference as a fallback). */
  id: string
  /** The full parsed JSON body as sent by the provider. */
  payload: unknown
}

/**
 * Business-logic seam. Called at most once per idempotency key while the key is
 * remembered by the store. Throw to signal failure: the event is NOT marked as
 * processed, the provider receives a 500, and its retry will be processed again.
 */
export type EventHandler = (event: WebhookEvent) => Promise<void>

export interface WebhookSecrets {
  paystackSecret?: string | undefined
  flwHash?: string | undefined
}

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
}

export interface WebhookRouterOptions {
  store: IdempotencyStore
  handleEvent: EventHandler
  /** Read on every request so secrets can be rotated without a restart. */
  getSecrets: () => WebhookSecrets
  logger: Logger
}

const eventId = z.union([z.string().min(1), z.number()])

const paystackSchema = z.object({
  event: z.string().min(1),
  data: z.object({ id: eventId.optional(), reference: z.string().min(1).optional() }),
})

const flutterwaveSchema = z.object({
  event: z.string().min(1),
  data: z.object({ id: eventId.optional(), tx_ref: z.string().min(1).optional() }),
})

/** Constant-time string comparison. A length mismatch returns early, which reveals only the length. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

/** Paystack signs the raw request body with HMAC-SHA512 keyed by the secret key, hex encoded. */
export function paystackSignature(rawBody: Buffer | string, secret: string): string {
  return crypto.createHmac('sha512', secret).update(rawBody).digest('hex')
}

type Verified = { ok: true } | { ok: false; status: number; error: string }
type Extracted = { ok: true; type: string; id: string } | { ok: false; error: string }

interface ProviderSpec {
  provider: Provider
  verify(req: Request, rawBody: Buffer, secrets: WebhookSecrets, logger: Logger): Verified
  extract(payload: unknown): Extracted
}

const misconfigured: Verified = { ok: false, status: 500, error: 'Webhook receiver misconfigured' }
const badSignature: Verified = { ok: false, status: 401, error: 'Invalid signature' }

const paystack: ProviderSpec = {
  provider: 'paystack',
  verify(req, rawBody, secrets, logger) {
    const secret = secrets.paystackSecret
    if (!secret) {
      logger.error('PAYSTACK_SECRET is not set; refusing to accept Paystack webhooks')
      return misconfigured
    }
    const signature = req.get('x-paystack-signature') ?? ''
    return safeEqual(paystackSignature(rawBody, secret), signature) ? { ok: true } : badSignature
  },
  extract(payload) {
    const parsed = paystackSchema.safeParse(payload)
    if (!parsed.success) return { ok: false, error: 'Unexpected Paystack event shape' }
    const id = parsed.data.data.id ?? parsed.data.data.reference
    if (id === undefined) return { ok: false, error: 'Paystack event has no data.id or data.reference' }
    return { ok: true, type: parsed.data.event, id: String(id) }
  },
}

const flutterwave: ProviderSpec = {
  provider: 'flutterwave',
  verify(req, _rawBody, secrets, logger) {
    const expected = secrets.flwHash
    if (!expected) {
      logger.error('FLW_HASH is not set; refusing to accept Flutterwave webhooks')
      return misconfigured
    }
    const provided = req.get('verif-hash') ?? ''
    return safeEqual(expected, provided) ? { ok: true } : badSignature
  },
  extract(payload) {
    const parsed = flutterwaveSchema.safeParse(payload)
    if (!parsed.success) return { ok: false, error: 'Unexpected Flutterwave event shape' }
    const id = parsed.data.data.id ?? parsed.data.data.tx_ref
    if (id === undefined) return { ok: false, error: 'Flutterwave event has no data.id or data.tx_ref' }
    return { ok: true, type: parsed.data.event, id: String(id) }
  },
}

export function createWebhookRouter(options: WebhookRouterOptions): Router {
  const { store, handleEvent, getSecrets, logger } = options

  // Keys currently being processed by this process. The check-and-add below is
  // synchronous, so two concurrent deliveries of the same event cannot both
  // get through. Across multiple instances this must become an atomic claim in
  // a shared store (for example Redis SET NX with a short lock TTL).
  const inFlight = new Set<string>()

  const router = Router()
  // Signatures are computed over the exact bytes received, so the body is kept
  // raw. `type: () => true` accepts any Content-Type.
  router.use(express.raw({ type: () => true, limit: '1mb' }))

  const handle =
    (spec: ProviderSpec) =>
    async (req: Request, res: Response): Promise<void> => {
      const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)

      const verified = spec.verify(req, rawBody, getSecrets(), logger)
      if (!verified.ok) {
        res.status(verified.status).json({ ok: false, error: verified.error })
        return
      }

      let payload: unknown
      try {
        payload = JSON.parse(rawBody.toString('utf8'))
      } catch {
        res.status(400).json({ ok: false, error: 'Malformed JSON' })
        return
      }

      const extracted = spec.extract(payload)
      if (!extracted.ok) {
        res.status(400).json({ ok: false, error: extracted.error })
        return
      }

      const key = `${spec.provider}:${extracted.type}:${extracted.id}`

      if (inFlight.has(key)) {
        // Another delivery of this event is being processed right now. A non-2xx
        // makes the provider retry later, which is correct whether the first
        // attempt succeeds (the retry becomes a duplicate) or fails (the retry
        // processes it).
        res.status(409).json({ ok: false, error: 'Event is already being processed' })
        return
      }
      inFlight.add(key)

      try {
        if (await store.has(key)) {
          logger.info('duplicate webhook ignored', { key })
          res.status(200).json({ ok: true, duplicate: true })
          return
        }

        try {
          await handleEvent({ provider: spec.provider, type: extracted.type, id: extracted.id, payload })
        } catch (err) {
          logger.error('webhook handler failed; event not marked as processed', {
            key,
            error: err instanceof Error ? err.message : String(err),
          })
          res.status(500).json({ ok: false, error: 'Processing failed' })
          return
        }

        // Mark only after the handler succeeded, so failed attempts are retried.
        await store.mark(key)
        res.status(200).json({ ok: true, duplicate: false })
      } finally {
        inFlight.delete(key)
      }
    }

  router.post('/paystack', handle(paystack))
  router.post('/flutterwave', handle(flutterwave))
  return router
}
