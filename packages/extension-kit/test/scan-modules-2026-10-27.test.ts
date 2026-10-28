// Scan 2026-10-27 (modules), F5 (and F30 below): a page (or the RPC it added) could stall the service worker. `pageText` ran its URL
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
  Session,
  VAULT_MIN_SCRYPT,
  Vault,
  VaultError,
  isPageRequest,
  isRelayMethod,
  isRelayRequest,
  memoryAlarms,
  memoryApprovalWindow,
  memoryJsonStorage,
  memorySessionStorage,
  memoryVaultStorage,
  parseAddChainParams,
  toRelayError,
  type EvmNetwork,
  type PermissionsState,
  type SealedBox,
  type VaultEnvelopeV2,
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

// Scan 2026-10-27 (modules), F30: `changePassword` re-wraps the same DEK, so after a compromise whoever copied the DEK
// (a session, a passkey box, an old envelope) still opened every secret, including ones added later. `rotateVaultKey`
// replaces the DEK; `setSecret` refuses a retired one, so a stale session cannot seal under it.
describe('Vault.rotateVaultKey (scan 2026-10-27 modules, F30)', () => {
  const PW = 'correct horse battery'
  const enc = (t: string) => new TextEncoder().encode(t)
  const dec = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : null)
  const code = (p: Promise<unknown>) => p.then(() => 'resolved', (e: unknown) => (e instanceof VaultError ? e.code : `other:${String(e)}`))
  /** Open a box straight from the stored envelope with a raw DEK — what an attacker who copied the old DEK would do. */
  async function openRaw(dek: Uint8Array, box: SealedBox, id: string): Promise<string> {
    const key = await crypto.subtle.importKey('raw', Uint8Array.from(dek), 'AES-GCM', false, ['decrypt'])
    const b = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b(box.iv), additionalData: enc(`forgewallet-vault/secret/${id}`) }, key, b(box.data)))
  }

  it('a DEK copied before the rotation opens nothing afterwards — not the old secrets, not one added later', async () => {
    const storage = memoryVaultStorage()
    const vault = new Vault({ storage, scrypt: VAULT_MIN_SCRYPT })
    const created = await vault.create(PW)
    const stolen = Uint8Array.from(created)
    await vault.setSecret(created, 'seed', enc('abandon … about'))
    expect(await openRaw(stolen, (storage.envelope as VaultEnvelopeV2).secrets.seed!, 'seed')).toBe('abandon … about') // the copy works before

    const before = structuredClone(storage.envelope) as VaultEnvelopeV2
    const dek = await vault.rotateVaultKey(PW)
    expect(Array.from(dek)).not.toEqual(Array.from(stolen))
    await vault.setSecret(dek, 'imported', enc('private key added after the rotation'))
    const after = storage.envelope as VaultEnvelopeV2
    expect(after.kdf.salt).not.toBe(before.kdf.salt)
    expect(after.createdAt).toBe(before.createdAt)
    expect(after.rotatedAt).toBeTypeOf('number')
    await expect(openRaw(stolen, after.secrets.seed!, 'seed')).rejects.toThrow()
    await expect(openRaw(stolen, after.secrets.imported!, 'imported')).rejects.toThrow()
    expect(await code(vault.getSecret(stolen, 'imported'))).toBe('locked')
    expect(dec(await vault.getSecret(dek, 'seed'))).toBe('abandon … about')
    expect(dec(await vault.getSecret(dek, 'imported'))).toBe('private key added after the rotation')
    expect(Array.from(await vault.unlock(PW))).toEqual(Array.from(dek))
  })

  it('a stale session (still holding the retired DEK) cannot seal a new secret; the session takes the new DEK in place of the old', async () => {
    const storage = memoryVaultStorage()
    const vault = new Vault({ storage, scrypt: VAULT_MIN_SCRYPT })
    const sessionStorage = memorySessionStorage()
    const session = new Session({ storage: sessionStorage, alarms: memoryAlarms() })
    const first = await vault.create(PW)
    await vault.setSecret(first, 'seed', enc('words'))
    await session.unlock(first)
    const old = await session.getKey()
    const oldStored = JSON.stringify([...sessionStorage.data.values()])

    const rotated = await vault.rotateVaultKey(PW)
    expect(await code(vault.setSecret(old, 'late', enc('sealed under the retired key')))).toBe('locked')
    expect(Object.keys((storage.envelope as VaultEnvelopeV2).secrets)).toEqual(['seed'])
    await session.unlock(rotated)
    expect(JSON.stringify([...sessionStorage.data.values()])).not.toBe(oldStored)
    const now = await session.getKey()
    await vault.setSecret(now, 'late', enc('sealed under the new key'))
    expect(dec(await vault.getSecret(now, 'late'))).toBe('sealed under the new key')
  })

  it("setSecret refuses a key that is not the vault's (it sealed under any 32 bytes before)", async () => {
    const storage = memoryVaultStorage()
    const vault = new Vault({ storage, scrypt: VAULT_MIN_SCRYPT })
    const dek = await vault.create(PW)
    await vault.setSecret(crypto.getRandomValues(new Uint8Array(32)), 'first', enc('an empty vault cannot tell keys apart'))
    await vault.deleteSecret('first')
    await vault.setSecret(dek, 'seed', enc('words'))
    expect(await code(vault.setSecret(crypto.getRandomValues(new Uint8Array(32)), 'other', enc('x')))).toBe('locked')
    expect(Object.keys((storage.envelope as VaultEnvelopeV2).secrets)).toEqual(['seed'])
  })

  it('passkeys are dropped (they wrap the old DEK) and can be registered again; a wrong password changes nothing', async () => {
    const storage = memoryVaultStorage()
    const vault = new Vault({ storage, scrypt: VAULT_MIN_SCRYPT })
    const dek = await vault.create(PW)
    await vault.setSecret(dek, 'seed', enc('words'))
    const prf = crypto.getRandomValues(new Uint8Array(32))
    await vault.addPasskey(dek, { id: 'cred-1', prf: Uint8Array.from(prf), label: 'Touch ID', publicKey: 'AAAA', alg: -7 })

    const untouched = structuredClone(storage.envelope)
    expect(await code(vault.rotateVaultKey('not the password'))).toBe('wrong-password')
    expect(storage.envelope).toEqual(untouched)

    const next = await vault.rotateVaultKey(PW)
    expect(await vault.listPasskeys()).toEqual([])
    expect(await code(vault.unlockWithPasskey('cred-1', Uint8Array.from(prf)))).toBe('missing')
    await vault.addPasskey(next, { id: 'cred-1', prf: Uint8Array.from(prf), label: 'Touch ID' })
    expect(Array.from(await vault.unlockWithPasskey('cred-1', Uint8Array.from(prf)))).toEqual(Array.from(next))
  })
})

// The same host test for RPC URLs a site adds (F37's classifier): every IPv4 spelling, CGNAT, mapped IPv6.
describe('wallet_addEthereumChain keeps only public https RPCs (scan 2026-10-27 modules, F37)', () => {
  it('numeric, CGNAT, mapped-IPv6 and *.internal hosts are dropped; a public one stays', () => {
    for (const url of ['https://2130706433', 'https://127.1:8545', 'https://0x7f.0.0.1', 'https://100.64.0.1', 'https://[::ffff:127.0.0.1]', 'https://[::ffff:c0a8:101]', 'https://node.internal', 'https://user:pw@eth.example', 'http://eth.example']) {
      expect(parseAddChainParams({ chainId: '0x1', rpcUrls: [url] }), url).toMatchObject({ code: -32602 })
    }
    expect(parseAddChainParams({ chainId: '0x1', rpcUrls: ['https://2130706433', 'https://eth.example/v2'] })).toMatchObject({ rpcs: ['https://eth.example/v2'] })
  })
})
