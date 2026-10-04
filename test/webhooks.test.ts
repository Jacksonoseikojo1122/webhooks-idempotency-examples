import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { after, before, describe, it } from 'node:test'
import { createApp } from '../src/app.js'
import { MemoryIdempotencyStore } from '../src/store.js'
import { paystackSignature, type WebhookEvent, type WebhookSecrets } from '../src/webhooks.js'

const PAYSTACK_SECRET = 'sk_test_example'
const FLW_HASH = 'flw_example_hash'

const silentLogger = { info: () => {}, error: () => {} }

interface Harness {
  baseUrl: string
  calls: WebhookEvent[]
  secrets: WebhookSecrets
  store: MemoryIdempotencyStore
  /** Delay applied inside the handler, used to hold an event in flight. */
  handlerDelayMs: number
  /** When set, the handler throws this many more times before succeeding. */
  failuresRemaining: number
  close(): Promise<void>
}

async function startServer(): Promise<Harness> {
  const store = new MemoryIdempotencyStore()
  const harness: Harness = {
    baseUrl: '',
    calls: [],
    secrets: { paystackSecret: PAYSTACK_SECRET, flwHash: FLW_HASH },
    store,
    handlerDelayMs: 0,
    failuresRemaining: 0,
    close: async () => {},
  }
  const app = createApp({
    store,
    logger: silentLogger,
    getSecrets: () => harness.secrets,
    handleEvent: async (event) => {
      if (harness.handlerDelayMs > 0) await new Promise((r) => setTimeout(r, harness.handlerDelayMs))
      if (harness.failuresRemaining > 0) {
        harness.failuresRemaining--
        throw new Error('simulated downstream failure')
      }
      harness.calls.push(event)
    },
  })
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const { port } = server.address() as AddressInfo
  harness.baseUrl = `http://127.0.0.1:${port}`
  harness.close = () =>
    new Promise<void>((resolve, reject) => {
      store.close()
      server.closeAllConnections()
      server.close((err) => (err ? reject(err) : resolve()))
    })
  return harness
}

let h: Harness

before(async () => {
  h = await startServer()
})

after(async () => {
  await h.close()
})

function resetHarness(): void {
  h.calls.length = 0
  h.secrets = { paystackSecret: PAYSTACK_SECRET, flwHash: FLW_HASH }
  h.handlerDelayMs = 0
  h.failuresRemaining = 0
}

let counter = 0
const uniqueRef = (prefix: string) => `${prefix}_${Date.now()}_${++counter}`

function postPaystack(body: string, signature = paystackSignature(body, PAYSTACK_SECRET)) {
  return fetch(`${h.baseUrl}/webhooks/paystack`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-paystack-signature': signature },
    body,
  })
}

function postFlutterwave(body: string, hash = FLW_HASH) {
  return fetch(`${h.baseUrl}/webhooks/flutterwave`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'verif-hash': hash },
    body,
  })
}

const paystackBody = (reference: string, id?: number) =>
  JSON.stringify({ event: 'charge.success', data: { ...(id === undefined ? {} : { id }), reference } })

describe('Paystack webhooks', () => {
  it('accepts a correctly signed event and calls the handler', async () => {
    resetHarness()
    const ref = uniqueRef('ps')
    const res = await postPaystack(paystackBody(ref))
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true, duplicate: false })
    assert.equal(h.calls.length, 1)
    assert.equal(h.calls[0]?.provider, 'paystack')
    assert.equal(h.calls[0]?.type, 'charge.success')
    assert.equal(h.calls[0]?.id, ref)
  })

  it('prefers data.id over data.reference for the idempotency key', async () => {
    resetHarness()
    const res = await postPaystack(paystackBody(uniqueRef('ps'), 987654))
    assert.equal(res.status, 200)
    assert.equal(h.calls[0]?.id, '987654')
  })

  it('rejects a bad signature with 401 and does not call the handler', async () => {
    resetHarness()
    const body = paystackBody(uniqueRef('ps'))
    const res = await postPaystack(body, paystackSignature(body, 'wrong_secret'))
    assert.equal(res.status, 401)
    assert.equal(h.calls.length, 0)
  })

  it('rejects a missing signature header with 401', async () => {
    resetHarness()
    const res = await fetch(`${h.baseUrl}/webhooks/paystack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: paystackBody(uniqueRef('ps')),
    })
    assert.equal(res.status, 401)
    assert.equal(h.calls.length, 0)
  })

  it('rejects a body that was modified after signing with 401', async () => {
    resetHarness()
    const body = paystackBody(uniqueRef('ps'))
    const res = await postPaystack(body.replace('charge.success', 'charge.successX'), paystackSignature(body, PAYSTACK_SECRET))
    assert.equal(res.status, 401)
  })

  it('fails closed with 500 when PAYSTACK_SECRET is not configured', async () => {
    resetHarness()
    h.secrets = { flwHash: FLW_HASH }
    const body = paystackBody(uniqueRef('ps'))
    // Signed with an empty key: must not be accepted.
    const res = await postPaystack(body, paystackSignature(body, ''))
    assert.equal(res.status, 500)
    assert.equal(h.calls.length, 0)
  })

  it('returns 400 for malformed JSON with a valid signature', async () => {
    resetHarness()
    const res = await postPaystack('{"event":"charge.success",')
    assert.equal(res.status, 400)
    assert.deepEqual(await res.json(), { ok: false, error: 'Malformed JSON' })
    assert.equal(h.calls.length, 0)
  })

  it('returns 400 when the event has no id or reference', async () => {
    resetHarness()
    const res = await postPaystack(JSON.stringify({ event: 'charge.success', data: {} }))
    assert.equal(res.status, 400)
    assert.equal(h.calls.length, 0)
  })

  it('treats a repeated delivery as a duplicate and calls the handler once', async () => {
    resetHarness()
    const body = paystackBody(uniqueRef('ps'))
    const first = await postPaystack(body)
    const second = await postPaystack(body)
    assert.equal(first.status, 200)
    assert.deepEqual(await first.json(), { ok: true, duplicate: false })
    assert.equal(second.status, 200)
    assert.deepEqual(await second.json(), { ok: true, duplicate: true })
    assert.equal(h.calls.length, 1)
  })

  it('does not collapse distinct events into one key', async () => {
    resetHarness()
    await postPaystack(paystackBody(uniqueRef('ps')))
    await postPaystack(paystackBody(uniqueRef('ps')))
    assert.equal(h.calls.length, 2)
  })

  it('processes concurrent deliveries of the same event only once', async () => {
    resetHarness()
    h.handlerDelayMs = 100
    const body = paystackBody(uniqueRef('ps'))
    const responses = await Promise.all([postPaystack(body), postPaystack(body), postPaystack(body)])
    const statuses = responses.map((r) => r.status).sort()
    assert.deepEqual(statuses, [200, 409, 409])
    assert.equal(h.calls.length, 1)

    // Once processing has finished, a later retry is acknowledged as a duplicate.
    const retry = await postPaystack(body)
    assert.equal(retry.status, 200)
    assert.deepEqual(await retry.json(), { ok: true, duplicate: true })
    assert.equal(h.calls.length, 1)
  })

  it('does not mark an event as processed when the handler fails', async () => {
    resetHarness()
    h.failuresRemaining = 1
    const body = paystackBody(uniqueRef('ps'))
    const first = await postPaystack(body)
    assert.equal(first.status, 500)
    assert.equal(h.calls.length, 0)

    const retry = await postPaystack(body)
    assert.equal(retry.status, 200)
    assert.deepEqual(await retry.json(), { ok: true, duplicate: false })
    assert.equal(h.calls.length, 1)
  })
})

describe('Flutterwave webhooks', () => {
  const flwBody = (id: number | undefined, txRef?: string) =>
    JSON.stringify({
      event: 'charge.completed',
      data: { ...(id === undefined ? {} : { id }), ...(txRef === undefined ? {} : { tx_ref: txRef }), status: 'successful' },
    })

  it('accepts a request with the correct verif-hash', async () => {
    resetHarness()
    const res = await postFlutterwave(flwBody(counter++ + 1_000_000))
    assert.equal(res.status, 200)
    assert.equal(h.calls.length, 1)
    assert.equal(h.calls[0]?.provider, 'flutterwave')
  })

  it('falls back to data.tx_ref when data.id is absent', async () => {
    resetHarness()
    const txRef = uniqueRef('tx')
    const res = await postFlutterwave(flwBody(undefined, txRef))
    assert.equal(res.status, 200)
    assert.equal(h.calls[0]?.id, txRef)
  })

  it('rejects a wrong verif-hash with 401', async () => {
    resetHarness()
    const res = await postFlutterwave(flwBody(counter++ + 1_000_000), 'not_the_hash')
    assert.equal(res.status, 401)
    assert.equal(h.calls.length, 0)
  })

  it('fails closed with 500 when FLW_HASH is not configured', async () => {
    resetHarness()
    h.secrets = { paystackSecret: PAYSTACK_SECRET }
    const res = await postFlutterwave(flwBody(counter++ + 1_000_000), '')
    assert.equal(res.status, 500)
    assert.equal(h.calls.length, 0)
  })

  it('returns 400 for malformed JSON', async () => {
    resetHarness()
    const res = await postFlutterwave('not json')
    assert.equal(res.status, 400)
  })

  it('returns 400 when the event has no id or tx_ref', async () => {
    resetHarness()
    const res = await postFlutterwave(flwBody(undefined))
    assert.equal(res.status, 400)
    assert.equal(h.calls.length, 0)
  })

  it('treats a repeated delivery as a duplicate', async () => {
    resetHarness()
    const body = flwBody(counter++ + 1_000_000)
    await postFlutterwave(body)
    const second = await postFlutterwave(body)
    assert.equal(second.status, 200)
    assert.deepEqual(await second.json(), { ok: true, duplicate: true })
    assert.equal(h.calls.length, 1)
  })
})

describe('MemoryIdempotencyStore', () => {
  it('expires keys after the TTL and sweeps them', async () => {
    let now = 1_000
    const store = new MemoryIdempotencyStore({ ttlMs: 100, now: () => now })
    try {
      await store.mark('a')
      await store.mark('b')
      assert.equal(await store.has('a'), true)
      now += 100
      assert.equal(store.sweep(), 2)
      assert.equal(store.size, 0)
      assert.equal(await store.has('a'), false)
    } finally {
      store.close()
    }
  })
})
