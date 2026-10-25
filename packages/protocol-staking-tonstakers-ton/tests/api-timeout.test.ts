import { afterEach, expect, it, vi } from 'vitest'
import '../src/buffer-global.js'
import TonstakersProtocolTon from '../index.js'

// Audit 2026-10-25, finding 10: the module's REST reads had no timeout — an API that never
// answered hung the caller for good.

const OWNER = 'EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N'

/** Every fetch hangs until its signal aborts; AbortSignal.timeout(ms) is recorded and shortened to 50 ms. */
function hangingApis(): number[] {
  const asked: number[] = []
  const real = AbortSignal.timeout.bind(AbortSignal)
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => { asked.push(ms); return real(50) })
  vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
  }))
  return asked
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('a REST API that never answers fails or falls back within the timeout', { timeout: 5_000 }, async () => {
  const asked = hangingApis()
  const p = new TonstakersProtocolTon({ async getAddress() { return OWNER } } as never)
  await expect(p.getApr()).rejects.toThrow()
  expect(asked.length).toBeGreaterThan(0)
  expect(new Set(asked)).toEqual(new Set([15_000]))
})
