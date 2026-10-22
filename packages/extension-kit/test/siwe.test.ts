import { describe, expect, it } from 'vitest'
import { classifySignRequest, describeSiwe, parseSiwe, DEFAULT_NETWORKS } from '../src/index.js'

const ME = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
const NOW = Date.parse('2026-10-20T12:00:00Z')
const msg = (o: Partial<{ domain: string; address: string; uri: string; chain: number; nonce: string; exp: string; nbf: string; statement: string }> = {}) =>
  `${o.domain ?? 'app.uniswap.org'} wants you to sign in with your Ethereum account:\n${o.address ?? ME}\n\n${o.statement ?? 'Sign in to Uniswap'}\n\nURI: ${o.uri ?? 'https://app.uniswap.org/login'}\nVersion: 1\nChain ID: ${o.chain ?? 1}\nNonce: ${o.nonce ?? 'k9Qz1bX2pL7m'}\nIssued At: 2026-10-20T11:59:00Z${o.exp ? `\nExpiration Time: ${o.exp}` : ''}${o.nbf ? `\nNot Before: ${o.nbf}` : ''}\nResources:\n- https://app.uniswap.org/terms`

describe('SIWE (EIP-4361) on personal_sign', () => {
  it('parses the message and finds nothing wrong when domain, account, chain and times agree', () => {
    const m = parseSiwe(msg())!
    expect(m).toMatchObject({ domain: 'app.uniswap.org', address: ME, statement: 'Sign in to Uniswap', uri: 'https://app.uniswap.org/login', version: '1', chainId: 1, nonce: 'k9Qz1bX2pL7m', resources: ['https://app.uniswap.org/terms'] })
    expect(describeSiwe(msg(), { origin: 'https://app.uniswap.org', account: ME, chainId: 1, now: NOW })!.problems).toEqual([])
    expect(parseSiwe('hello')).toBeNull()
    const noNonce = describeSiwe(msg().replace('Nonce: k9Qz1bX2pL7m\n', ''), { origin: 'https://app.uniswap.org', account: ME, chainId: 1, now: NOW })!
    expect(noNonce.malformed).toBe(true)
    expect(noNonce.problems[0]).toMatch(/malformed sign-in message.*Nonce/)
    expect(parseSiwe(msg().replace('Nonce: k9Qz1bX2pL7m\n', ''))).toBeNull()
  })

  it('statement-less messages are sign-ins too, in the ABNF (three newlines) and the two-newline form (scan F9)', () => {
    const ctx = { origin: 'https://evil.example', account: ME, chainId: 1, now: NOW }
    const fields = 'URI: https://app.victim.com/login\nVersion: 1\nChain ID: 1\nNonce: k9Qz1bX2pL7m\nIssued At: 2026-10-20T11:59:00Z'
    for (const text of [`app.victim.com wants you to sign in with your Ethereum account:\n${ME}\n\n\n${fields}`, `app.victim.com wants you to sign in with your Ethereum account:\n${ME}\n\n${fields}`]) {
      expect(parseSiwe(text)).toMatchObject({ domain: 'app.victim.com', address: ME, uri: 'https://app.victim.com/login', nonce: 'k9Qz1bX2pL7m' })
      expect(parseSiwe(text)!.statement).toBeUndefined()
      const info = describeSiwe(text, ctx)!
      expect(info.malformed).toBeUndefined()
      expect(info.problems.join(' | ')).toMatch(/names app\.victim\.com but the request comes from evil\.example/)
    }
    // A header with nothing parseable after it is still a sign-in: malformed, and the domain check still runs.
    const junk = describeSiwe('app.victim.com wants you to sign in with your Ethereum account:\nnot-an-address\nwhatever', ctx)!
    expect(junk.malformed).toBe(true)
    expect(junk.problems.join(' | ')).toMatch(/malformed.*address/)
    expect(junk.problems.join(' | ')).toMatch(/request comes from evil\.example/)
    // Not a SIWE header (no "Ethereum account" literal): plain message.
    expect(describeSiwe('app.victim.com wants you to sign in with your Solana account:\nabc', ctx)).toBeNull()
  })

  it('WalletConnect origins: no verifiable host → warn, unless Verify says VALID and the claimed URL is the SIWE domain (scan F10)', () => {
    const wc = 'wc:' + 'ab'.repeat(32)
    const base = { origin: wc, account: ME, chainId: 1, now: NOW }
    const via = (url: string, verify: 'VALID' | 'INVALID' | 'UNKNOWN') => ({ transport: 'walletconnect' as const, url, name: 'App', verify })
    const cannot = /cannot verify which site is asking; this sign-in for app\.uniswap\.org may be replayed there/
    expect(describeSiwe(msg(), base)!.problems.join(' | ')).toMatch(cannot)
    expect(describeSiwe(msg(), { ...base, via: via('https://app.uniswap.org', 'UNKNOWN') })!.problems.join(' | ')).toMatch(cannot)
    expect(describeSiwe(msg(), { ...base, via: via('https://app.uniswap.org', 'INVALID') })!.problems.join(' | ')).toMatch(cannot)
    expect(describeSiwe(msg(), { ...base, via: via('https://evil.example', 'VALID') })!.problems.join(' | ')).toMatch(cannot)
    expect(describeSiwe(msg(), { ...base, via: via('https://app.uniswap.org', 'VALID') })!.problems).toEqual([])
    // Verified host, but the message's URI points elsewhere: still caught.
    expect(describeSiwe(msg({ uri: 'https://evil.example/cb' }), { ...base, via: via('https://app.uniswap.org', 'VALID') })!.problems.join(' | ')).toMatch(/URI .* is not on app\.uniswap\.org/)
    // classifySignRequest carries the via through to the check.
    const info = classifySignRequest({ network: DEFAULT_NETWORKS[0]!, method: 'personal_sign', params: [msg(), ME], accounts: [ME], origin: wc, via: via('https://app.uniswap.org', 'VALID'), now: NOW })
    if ('code' in info || info.kind !== 'sign-message') throw new Error('unexpected')
    expect(info.siwe!.problems).toEqual([])
  })

  it('schemes count: http origins warn, a scheme mismatch warns, localhost is exempt (scan F20/F21)', () => {
    const p = (text: string, origin: string) => describeSiwe(text, { origin, account: ME, chainId: 1, now: NOW })!.problems.join(' | ')
    // http twin of the https site: insecure + the message (default https) does not match the page's scheme.
    expect(p(msg(), 'http://app.uniswap.org')).toMatch(/insecure page \(http:\/\/app\.uniswap\.org\)/)
    expect(p(msg(), 'http://app.uniswap.org')).toMatch(/is for https:\/\/app\.uniswap\.org but the request comes from http:\/\/app\.uniswap\.org/)
    // Explicit http scheme in the domain from the https site.
    expect(p(msg({ domain: 'http://app.uniswap.org' }), 'https://app.uniswap.org')).toMatch(/is for http:\/\/app\.uniswap\.org but the request comes from https/)
    expect(p(msg({ domain: 'https://app.uniswap.org' }), 'https://app.uniswap.org')).toBe('')
    // URI scheme.
    expect(p(msg({ uri: 'http://app.uniswap.org/login' }), 'https://app.uniswap.org')).toMatch(/URI http:\/\/app\.uniswap\.org\/login uses http:\/\//)
    // Dev servers on loopback / *.localhost: plain http is fine.
    for (const host of ['localhost:3000', '127.0.0.1:5173', '[::1]:8080', 'my-app.localhost']) {
      expect(p(msg({ domain: host, uri: `http://${host}/login` }), `http://${host}`)).toBe('')
    }
  })

  it('names each lie: another domain, another URI host, another account, another chain, expired, not yet valid, weak nonce', () => {
    const p = (text: string, origin = 'https://app.uniswap.org') => describeSiwe(text, { origin, account: ME, chainId: 1, now: NOW })!.problems.join(' | ')
    expect(p(msg(), 'https://app-uniswap.com')).toMatch(/names app\.uniswap\.org but the request comes from app-uniswap\.com/)
    expect(p(msg({ uri: 'https://evil.example/cb' }))).toMatch(/URI .* is not on app\.uniswap\.org/)
    expect(p(msg({ address: '0x1111111111111111111111111111111111111111' }))).toMatch(/not the account that would sign/)
    expect(p(msg({ chain: 8453 }))).toMatch(/chain 8453; this site is on chain 1/)
    expect(p(msg({ exp: '2026-10-20T11:00:00Z' }))).toMatch(/expired/)
    expect(p(msg({ nbf: '2026-10-21T00:00:00Z' }))).toMatch(/not valid yet/)
    expect(p(msg({ nonce: 'abc' }))).toMatch(/nonce/)
    expect(p(msg({ exp: '2026-10-21T00:00:00Z', nbf: '2026-10-20T00:00:00Z' }))).toBe('')
  })

  it('classifySignRequest attaches the SIWE info with the browser-recorded origin; without an origin nothing is claimed', () => {
    const network = DEFAULT_NETWORKS[0]!
    const info = classifySignRequest({ network, method: 'personal_sign', params: [msg(), ME], accounts: [ME], origin: 'https://evil.example', now: NOW })
    expect('code' in info).toBe(false)
    if ('code' in info || info.kind !== 'sign-message') throw new Error('unexpected')
    expect(info.siwe!.message.domain).toBe('app.uniswap.org')
    expect(info.siwe!.problems[0]).toMatch(/evil\.example/)
    const plain = classifySignRequest({ network, method: 'personal_sign', params: ['hello', ME], accounts: [ME], origin: 'https://x' })
    expect('code' in plain ? null : (plain as { siwe?: unknown }).siwe).toBeUndefined()
  })

  it('EIP-7702 delegations from a site are refused by name', () => {
    const network = DEFAULT_NETWORKS[0]!
    const base = { from: ME, to: ME, value: '0x0' }
    for (const tx of [{ ...base, authorizationList: [{ chainId: 1, address: ME, nonce: 0 }] }, { ...base, type: '0x4' }, { ...base, type: 4 }]) {
      const r = classifySignRequest({ network, method: 'eth_sendTransaction', params: [tx], accounts: [ME] })
      expect(r).toMatchObject({ code: 4200, message: expect.stringMatching(/7702/) })
    }
    expect('code' in classifySignRequest({ network, method: 'eth_sendTransaction', params: [{ ...base, authorizationList: [] }], accounts: [ME] })).toBe(false)
  })
})
