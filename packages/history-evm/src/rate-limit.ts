/**
 * Tiny token bucket: `rate` tokens per second, burst = ceil(rate). Callers
 * queue in arrival order, so N concurrent `acquire()`s drain at the rate
 * instead of racing. Uses only `Date.now` + `setTimeout` (fake-timer friendly).
 */
export class TokenBucket {
  private tokens: number
  private last: number
  private chain: Promise<void> = Promise.resolve()
  readonly rate: number
  readonly burst: number

  constructor(ratePerSecond: number, burst = Math.max(1, Math.ceil(ratePerSecond))) {
    if (!(ratePerSecond > 0)) throw new Error('TokenBucket: rate must be > 0')
    this.rate = ratePerSecond
    this.burst = burst
    this.tokens = burst
    this.last = Date.now()
  }

  /** Wait for `cost` tokens (default 1; clamped to the burst so one oversized call cannot wait forever). */
  acquire(cost = 1): Promise<void> {
    const n = Math.min(this.burst, Math.max(0, cost))
    const next = this.chain.then(() => this.take(n))
    this.chain = next.catch(() => undefined)
    return next
  }

  private refill(): void {
    const now = Date.now()
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate)
    this.last = now
  }

  private async take(n: number): Promise<void> {
    this.refill()
    if (this.tokens >= n) {
      this.tokens -= n
      return
    }
    const waitMs = Math.ceil(((n - this.tokens) / this.rate) * 1000)
    await sleep(waitMs)
    this.refill()
    this.tokens = Math.max(0, this.tokens - n)
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const buckets = new Map<string, TokenBucket>()

/**
 * One bucket per key for the whole process: every source built with the same
 * Etherscan key (or the same Blockscout host) shares it, so 25 chain sources
 * cannot multiply the per-key quota.
 */
export function sharedBucket(key: string, ratePerSecond: number): TokenBucket {
  let b = buckets.get(key)
  if (!b || b.rate !== ratePerSecond) {
    b = new TokenBucket(ratePerSecond)
    buckets.set(key, b)
  }
  return b
}

/** Tests only. */
export function resetSharedBuckets(): void {
  buckets.clear()
}
