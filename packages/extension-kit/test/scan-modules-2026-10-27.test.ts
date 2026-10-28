// Scan 2026-10-27 (modules), F5: a page (or the RPC it added) could stall the service worker. `pageText` ran its URL
// regex — unbounded scheme, every word boundary a start — over the whole message before cutting it to 300 characters,
// so a long run of scheme characters ("a.a.a…") cost quadratic time; and the relay passed any string as a method,
// which the router echoed into its refusal. Now the text is cut to 1 KB before the regex, the scheme is bounded, and a
// method must look like one.
import { describe, expect, it } from 'vitest'
import {
  ApprovalQueue,
  NetworksTable,
  PAGE_TARGET,
  PermissionStore,
  RELAY_ERRORS,
  RELAY_METHOD_MAX,
  RequestRouter,
  RouterError,
  isPageRequest,
  isRelayMethod,
  isRelayRequest,
  memoryApprovalWindow,
  memoryJsonStorage,
  toRelayError,
  type EvmNetwork,
  type PermissionsState,
} from '../src/index.js'

const KEY = 'sk_live_9f8e7d6c5b4a'
const URL_WITH_KEY = `https://eth-mainnet.example-rpc.io/v2/${KEY}`
/** A node's error object (the bare `{code, message}` a fetch transport throws), its message chosen by whoever runs the node. */
const nodeError = (message: string) => ({ code: -32000, message })
const timed = <T>(fn: () => T): { value: T; ms: number } => {
  const t0 = performance.now()
  const value = fn()
  return { value, ms: performance.now() - t0 }
}

function router() {
  let seq = 0
  return new RequestRouter({
    permissions: new PermissionStore(memoryJsonStorage<PermissionsState>()),
    networks: new NetworksTable(memoryJsonStorage<EvmNetwork[]>()),
    approvals: new ApprovalQueue(memoryApprovalWindow(), () => `req-${++seq}`),
    rpc: async () => null,
    accounts: async () => [],
    emit: () => {},
  })
}
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e)

describe('pageText is bounded before its regex (scan 2026-10-27 modules, F5)', () => {
  it('64 KB of scheme characters from a node: well under 100 ms (was a quadratic scan of the whole message)', () => {
    const { value, ms } = timed(() => toRelayError(nodeError('a.'.repeat(32_768))))
    expect(ms).toBeLessThan(100)
    expect(value.code).toBe(-32000)
    expect(value.message.length).toBeLessThanOrEqual(300)
  })

  it('1 MB messages of every hostile shape: well under 100 ms each, and still at most 300 characters', () => {
    for (const text of ['a.'.repeat(500_000), 'a'.repeat(1_000_000), 'a://'.repeat(250_000), `${'x'.repeat(999_000)}\n${URL_WITH_KEY}`]) {
      for (const e of [nodeError(text), new RouterError(RELAY_ERRORS.invalidParams, text)]) {
        const { value, ms } = timed(() => toRelayError(e))
        expect(ms).toBeLessThan(100)
        expect(value.message.length).toBeLessThanOrEqual(300)
        expect(value.message).not.toContain(KEY)
      }
    }
  })

  it('URLs are still taken out: a keyed RPC URL, one glued to a long word, one cut by the window', () => {
    expect(toRelayError(nodeError(`insufficient funds (see ${URL_WITH_KEY})`)).message).toBe('insufficient funds (see [url])')
    const glued = toRelayError(nodeError(`${'w'.repeat(40)}${URL_WITH_KEY} failed`)).message
    expect(glued).not.toContain(KEY)
    expect(glued).toMatch(/\[url\] failed$/)
    // The window ends inside the URL: whatever is left of it is still a URL, and goes.
    const cut = toRelayError(nodeError(`${'z '.repeat(500)}${URL_WITH_KEY}`)).message
    expect(cut).not.toContain('sk_live')
  })
})

describe('the relay carries only method names (scan 2026-10-27 modules, F5)', () => {
  const page = { target: PAGE_TARGET.toContent, id: 'r1', chain: 'eip155', method: 'eth_chainId' }
  const relay = { kind: 'request', id: 'r1', origin: 'https://app.example', chain: 'eip155', method: 'eth_chainId' }

  it('a megabyte "method", one with spaces, dots, colons or a URL, and one over the limit are dropped at both hops', () => {
    for (const method of ['x'.repeat(1_000_000), 'eth_foo bar', 'standard:connect', 'eth.call', `eth_x https://evil.example/${KEY}`, 'm'.repeat(RELAY_METHOD_MAX + 1), '', 42, null]) {
      expect(isPageRequest({ ...page, method })).toBe(false)
      expect(isRelayRequest({ ...relay, method })).toBe(false)
    }
  })

  it('every method the shipped providers send still passes', () => {
    for (const method of ['eth_sendTransaction', 'eth_signTypedData_v4', 'wallet_switchEthereumChain', 'personal_sign', 'net_version', 'connect', 'signAndSendTransaction',
      'restoreConnection', 'sendTransaction', 'signData', 'tron_requestAccounts', 'tron_signMessageV2', 'getAddresses', 'wallet_connect', 'signAndSendTransactions', 'verifyOwner', 'm'.repeat(RELAY_METHOD_MAX)]) {
      expect(isRelayMethod(method)).toBe(true)
      expect(isPageRequest({ ...page, method })).toBe(true)
      expect(isRelayRequest({ ...relay, method })).toBe(true)
    }
  })

  it('the router refuses a malformed method with -32600 and does not echo it; a real unknown method is still named', async () => {
    const r = router()
    for (const method of ['x'.repeat(5_000), `eth_foo. Your wallet is locked — unlock at https://evil.example/${KEY}`]) {
      const e = await refusal(r.handle('https://app.example', 'eip155', method, []))
      expect(e).toBeInstanceOf(RouterError)
      expect((e as RouterError).code).toBe(RELAY_ERRORS.invalidRequest)
      expect((e as RouterError).message).toBe('The request has no valid method name.')
    }
    const unknown = await refusal(r.handle('https://app.example', 'eip155', 'wallet_watchAsset', []))
    expect((unknown as RouterError).code).toBe(RELAY_ERRORS.unsupportedMethod)
    expect((unknown as RouterError).message).toBe('This wallet does not support wallet_watchAsset.')
  })
})
