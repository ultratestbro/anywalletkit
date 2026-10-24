import { NetworkError } from '@anywalletkit/core'
import type { TronConfig, TronFetch, TronProvider } from './types.js'

function httpTransport(base: string, headers: Record<string, string> | undefined): TronFetch {
  const root = base.replace(/\/+$/, '')
  return async (path, body) => {
    const res = await fetch(`${root}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new NetworkError(`${path}: HTTP ${res.status}`, { provider: root })
    return res.json()
  }
}

/** One transport, or a failover transport over the list. */
export function createClient(config: TronConfig): TronFetch | undefined {
  if (config.provider === undefined) return undefined
  const list = (Array.isArray(config.provider) ? config.provider : [config.provider]).map((p) =>
    typeof p === 'string' ? httpTransport(p, config.headers) : p,
  )
  if (list.length === 0) throw new Error("The 'provider' option cannot be set to an empty list.")
  if (list.length === 1) return list[0]!
  const attempts = list.length + (config.retries ?? 3)
  return async (path, body) => {
    let lastError: unknown
    for (let i = 0; i < attempts; i++) {
      try { return await list[i % list.length]!(path, body) } catch (e) { lastError = e }
    }
    throw new NetworkError(`All Tron providers failed for ${path}`, { cause: lastError })
  }
}

/** Full-node responses that carry an error body instead of a transaction. */
export function assertNoError(res: unknown, what: string): void {
  const r = res as { Error?: string; code?: string; message?: string; result?: { result?: boolean; code?: string; message?: string } }
  const hexMsg = (m: string | undefined) => (m && /^[0-9a-f]+$/i.test(m) ? Buffer_from_hex(m) : m)
  if (r?.Error) throw new Error(`${what}: ${r.Error}`)
  if (r?.result && typeof r.result === 'object' && r.result.result === false) throw new Error(`${what}: ${r.result.code ?? ''} ${hexMsg(r.result.message) ?? ''}`.trim())
  if (r?.code && r.code !== 'SUCCESS' && !('txID' in (r as object))) throw new Error(`${what}: ${r.code} ${hexMsg(r.message) ?? ''}`.trim())
}

function Buffer_from_hex(hex: string): string {
  try { return new TextDecoder().decode(Uint8Array.from(hex.match(/.{2}/g) ?? [], (b) => parseInt(b, 16))) } catch { return hex }
}
