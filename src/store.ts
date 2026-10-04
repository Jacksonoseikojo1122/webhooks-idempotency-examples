/**
 * Records which webhook events have already been processed.
 *
 * The interface is async so a networked store can be dropped in without
 * changing callers. With Redis, `mark` maps to `SET key 1 NX EX <ttlSeconds>`
 * and `has` to `EXISTS key`. A shared store is required as soon as more than
 * one instance of the service receives webhooks; the in-memory store below only
 * deduplicates within a single process.
 */
export interface IdempotencyStore {
  has(key: string): Promise<boolean>
  mark(key: string, ttlMs?: number): Promise<void>
}

export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000

export interface MemoryStoreOptions {
  ttlMs?: number
  sweepIntervalMs?: number
  now?: () => number
}

/**
 * In-memory TTL store. Expired keys are dropped lazily on read and by a
 * periodic sweep, so memory is bounded by the number of distinct events seen
 * within one TTL window. The sweep timer is unref'd so it never keeps the
 * process alive.
 */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, number>()
  private readonly ttlMs: number
  private readonly now: () => number
  private readonly timer: NodeJS.Timeout

  constructor(options: MemoryStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.now = options.now ?? Date.now
    this.timer = setInterval(() => this.sweep(), options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS)
    this.timer.unref()
  }

  async has(key: string): Promise<boolean> {
    const expiresAt = this.entries.get(key)
    if (expiresAt === undefined) return false
    if (this.now() >= expiresAt) {
      this.entries.delete(key)
      return false
    }
    return true
  }

  async mark(key: string, ttlMs: number = this.ttlMs): Promise<void> {
    this.entries.set(key, this.now() + ttlMs)
  }

  /** Removes every expired entry and returns how many were removed. */
  sweep(): number {
    const now = this.now()
    let removed = 0
    for (const [key, expiresAt] of this.entries) {
      if (now >= expiresAt) {
        this.entries.delete(key)
        removed++
      }
    }
    return removed
  }

  get size(): number {
    return this.entries.size
  }

  close(): void {
    clearInterval(this.timer)
  }
}
