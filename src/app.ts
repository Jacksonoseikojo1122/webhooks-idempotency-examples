import express, { type ErrorRequestHandler, type Express } from 'express'
import { MemoryIdempotencyStore, type IdempotencyStore } from './store.js'
import { createWebhookRouter, type EventHandler, type Logger, type WebhookSecrets } from './webhooks.js'

export interface AppOptions {
  store?: IdempotencyStore
  handleEvent?: EventHandler
  getSecrets?: () => WebhookSecrets
  logger?: Logger
}

const consoleLogger: Logger = {
  info: (message, meta) => console.log(`[webhooks] ${message}`, meta ?? ''),
  error: (message, meta) => console.error(`[webhooks] ${message}`, meta ?? ''),
}

/**
 * Default business logic: log and acknowledge. Replace this with real work,
 * such as crediting a wallet, fulfilling an order or enqueueing a job.
 */
const logOnlyHandler =
  (logger: Logger): EventHandler =>
  async (event) => {
    logger.info('processing event', { provider: event.provider, type: event.type, id: event.id })
  }

const secretsFromEnv = (): WebhookSecrets => ({
  paystackSecret: process.env.PAYSTACK_SECRET,
  flwHash: process.env.FLW_HASH,
})

export function createApp(options: AppOptions = {}): Express {
  const logger = options.logger ?? consoleLogger
  const app = express()
  app.disable('x-powered-by')

  app.get('/', (_req, res) => {
    res.json({ ok: true, service: 'webhooks-idempotency-examples' })
  })

  app.use(
    '/webhooks',
    createWebhookRouter({
      store: options.store ?? new MemoryIdempotencyStore(),
      handleEvent: options.handleEvent ?? logOnlyHandler(logger),
      getSecrets: options.getSecrets ?? secretsFromEnv,
      logger,
    }),
  )

  // Body-parser errors (for example payload too large) carry a 4xx status;
  // anything else is an unexpected failure.
  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    const status: number =
      typeof err?.status === 'number' && err.status >= 400 && err.status < 600 ? err.status : 500
    if (status >= 500) {
      logger.error('unhandled error', { error: err instanceof Error ? err.message : String(err) })
    }
    res.status(status).json({ ok: false, error: status >= 500 ? 'Internal error' : 'Bad request' })
  }
  app.use(onError)

  return app
}
