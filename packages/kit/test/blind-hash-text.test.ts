import { describe, expect, it, vi } from 'vitest'
import { UserRejectedError } from '@anywalletkit/core'
import { createMockAccount } from '@anywalletkit/conformance'
// wallet-evm is not a kit devDependency; its built dist is imported by path (offline: no provider, chainId fixed).
import { WalletManagerEvm } from '../../wallet-evm/dist/index.js'
import { evmMessageBytes, utf8Bytes } from '../src/message-bytes.js'
import { PolicyViolationError, Wallet, applyPolicies, type WriteIntent } from '../src/index.js'

// SDK-303 (extension audit E55, second half): `sign()` flagged 32 bytes only as a Uint8Array or a `0x` + 64-hex
// string. A string whose UTF-8 encoding is exactly 32 bytes was `kind: 'message'` — and wallet-evm signs exactly
// those 32 bytes behind the EIP-191 "\n32" prefix, which is what CoW Protocol's `ethsign` verifies. A site grinds free
// order fields until the digest is valid UTF-8 and sends it decoded. It is now a blind hash like the other forms
// (`blindHashForm: 'text'`): confirm sees it as a danger screen, an allowlist refuses it.

const SEED = 'test test test test test test test test test test test junk'
const CHAIN = 'eip155:1'
const TREASURY = '0x1111111111111111111111111111111111111111'
const DIGEST = '0x52eae78642b0ca3226e8a77062bebe97d7e69c10b2c882118503357d84e4e66f'
const HEX29 = DIGEST.slice(2, 31)
const enc = (s: string) => new TextEncoder().encode(s)
const bytes = (hex: string) => Uint8Array.from(hex.slice(2).match(/../g)!, (b) => Number.parseInt(b, 16))
const siwe = `swap.example wants you to sign in with your Ethereum account:\n0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266\n\nSign in to Swap\n\nURI: https://swap.example/login\nVersion: 1\nChain ID: 1\nNonce: k9Qz1bX2pL7m\nIssued At: 2026-11-11T10:00:00Z`

/** Strings whose UTF-8 encoding — what the account signs — is exactly 32 bytes. */
const TEXT32: Array<[string, string]> = [
  ['ASCII', 'Login nonce: 0123456789abcdefghi'],
  ['two-byte letters (16 characters)', 'é'.repeat(16)],
  ['four-byte emoji (16 UTF-16 units)', '🦊'.repeat(8)],
  ['mixed widths', `${'ж'.repeat(10)}€€${'a'.repeat(6)}`],
  ['a leading BOM (3 bytes + 29)', `﻿${'a'.repeat(29)}`],
  ['a lone surrogate (U+FFFD, 3 bytes + 29)', `\uD83E${'a'.repeat(29)}`],
  ['0x + 30 hex (signed as 32 characters of text)', DIGEST.slice(0, 32)],
  ['hex-looking but not hex: 0x + 29 hex + z', `0x${HEX29}z`],
  ['hex-looking with a leading space: " 0x" + 29 hex', ` 0x${HEX29}`],
  ['0X + 30 hex', `0X${DIGEST.slice(2, 32)}`],
]
/** Strings that are not 32 signed bytes and not the hex form: messages, as before. */
const NORMAL: Array<[string, string]> = [
  ['31 ASCII bytes', 'a'.repeat(31)],
  ['33 ASCII bytes', 'a'.repeat(33)],
  ['31 bytes of two-byte letters + 1', `${'é'.repeat(15)}a`],
  ['33 bytes of two-byte letters + 1', `${'é'.repeat(16)}a`],
  ['32 UTF-16 units but 33 bytes', `é${'a'.repeat(31)}`],
  ['a BOM + 32 ASCII (35 bytes)', `﻿${'a'.repeat(32)}`],
  ['0X + 64 hex (66 text bytes)', `0X${DIGEST.slice(2)}`],
  ['0x + 63 hex (65 text bytes)', DIGEST.slice(0, 65)],
  ['0x + 65 hex (67 text bytes)', `${DIGEST}a`],
  ['0x + 64 hex with a space inside (67 text bytes)', `${DIGEST.slice(0, 34)} ${DIGEST.slice(34)}`],
  ['Sign-In with Ethereum', siwe],
]

const mock = () => createMockAccount({ chain: CHAIN, address: '0x5555555555555555555555555555555555555555' })
const seen = (answer = true) => { const intents: WriteIntent[] = []; return { intents, confirm: vi.fn(async (i: WriteIntent) => { intents.push(i); return answer }) } }

describe('SDK-303: an EVM sign() of a string whose UTF-8 is 32 bytes', () => {
  it('the test vectors are what their names say', () => {
    for (const [name, m] of TEXT32) expect(enc(m).length, name).toBe(32)
    for (const [name, m] of NORMAL) expect(enc(m).length, name).not.toBe(32)
  })

  it.each(TEXT32)('%s: confirm sees a blind hash (text form), destinations unknown; signed when confirmed', async (_name, m) => {
    const { intents, confirm } = seen()
    expect(await applyPolicies(mock(), { confirm }).sign(m)).toMatch(/^0x/)
    expect(intents[0]).toMatchObject({ method: 'sign', kind: 'typedData', message: false, blindHash: true, blindHashForm: 'text', destinations: [], destinationUnknown: true, raw: m })
  })

  it.each(NORMAL)('%s: still a plain message', async (_name, m) => {
    const { intents, confirm } = seen()
    await applyPolicies(mock(), { confirm }).sign(m)
    expect(intents[0]).toMatchObject({ kind: 'message', message: true })
    expect(intents[0]).not.toHaveProperty('blindHash')
    expect(intents[0]).not.toHaveProperty('blindHashForm')
  })

  it('not refused by default: no policies sign it, confirm decides (false → UserRejectedError)', async () => {
    const m = 'é'.repeat(16)
    expect(await applyPolicies(mock(), {}).sign(m)).toMatch(/^0x/)
    await expect(applyPolicies(mock(), { confirm: async () => false }).sign(m)).rejects.toBeInstanceOf(UserRejectedError)
    // A fee cap alone does not touch it (off-chain signatures are not capped).
    expect(await applyPolicies(mock(), { maxFee: { [CHAIN]: 1n } }).sign(m)).toMatch(/^0x/)
  })

  it('without confirm the lists refuse it: an allowlist (allowlist), a blocklist (blocklist)', async () => {
    for (const m of [TEXT32[0]![1], TEXT32[1]![1]]) {
      const account = mock()
      await expect(applyPolicies(account, { allowlist: { [CHAIN]: [TREASURY] } }).sign(m)).rejects.toMatchObject({ name: 'PolicyViolationError', policy: 'allowlist' })
      await expect(applyPolicies(account, { blocklist: { [CHAIN]: [TREASURY] } }).sign(m)).rejects.toMatchObject({ name: 'PolicyViolationError', policy: 'blocklist' })
      expect(account.calls.filter((c) => c.method === 'sign')).toEqual([])
    }
    // A 31- or 33-byte text is a message: the lists skip it.
    expect(await applyPolicies(mock(), { allowlist: { [CHAIN]: [TREASURY] } }).sign('a'.repeat(33))).toMatch(/^0x/)
  })

  it('with confirm, under an allowlist or a blocklist, confirm decides: it sees the blind hash (text form) as a danger screen would', async () => {
    for (const lists of [{ allowlist: { [CHAIN]: [TREASURY] } }, { blocklist: { [CHAIN]: [TREASURY] } }, { allowlist: { eip155: [TREASURY] }, blocklist: { [CHAIN]: [TREASURY] } }]) {
      for (const m of [TEXT32[0]![1], TEXT32[1]![1]]) {
        const { intents, confirm } = seen()
        const account = mock()
        expect(await applyPolicies(account, { ...lists, confirm }).sign(m)).toMatch(/^0x/)
        expect(intents).toHaveLength(1)
        expect(intents[0]).toMatchObject({ kind: 'typedData', message: false, blindHash: true, blindHashForm: 'text', destinations: [], destinationUnknown: true, raw: m })
        expect(account.calls.filter((c) => c.method === 'sign')).toHaveLength(1)
        // Rejected on the danger screen: nothing is signed.
        const declined = mock()
        await expect(applyPolicies(declined, { ...lists, confirm: async () => false }).sign(m)).rejects.toBeInstanceOf(UserRejectedError)
        expect(declined.calls.filter((c) => c.method === 'sign')).toEqual([])
      }
    }
  })

  it('under an allowlist the hex and bytes forms are refused even with confirm, which never sees them', async () => {
    for (const m of [DIGEST, ` ${DIGEST}\n`, bytes(DIGEST)]) {
      const confirm = vi.fn(async () => true)
      const account = mock()
      await expect(applyPolicies(account, { allowlist: { [CHAIN]: [TREASURY] }, confirm }).sign(m)).rejects.toMatchObject({ name: 'PolicyViolationError', policy: 'allowlist' })
      expect(confirm).not.toHaveBeenCalled()
      expect(account.calls.filter((c) => c.method === 'sign')).toEqual([])
    }
  })

  it('the hex and bytes forms are unchanged, now with their form named', async () => {
    const { intents, confirm } = seen()
    const g = applyPolicies(mock(), { confirm })
    await g.sign(DIGEST)
    await g.sign(` ${DIGEST}\n`)
    await g.sign(bytes(DIGEST))
    expect(intents.map((i) => i.blindHashForm)).toEqual(['hex', 'hex', 'bytes'])
    for (const i of intents) expect(i).toMatchObject({ kind: 'typedData', message: false, blindHash: true, destinations: [], destinationUnknown: true })
    await g.sign(new Uint8Array(31))
    await g.sign(new Uint8Array(33))
    expect(intents.slice(3).map((i) => i.kind)).toEqual(['message', 'message'])
    await expect(applyPolicies(mock(), { allowlist: { [CHAIN]: [TREASURY] } }).sign(DIGEST)).rejects.toThrow(/allowlist/)
    await expect(applyPolicies(mock(), { allowlist: { [CHAIN]: [TREASURY] } }).sign(bytes(DIGEST))).rejects.toThrow(/allowlist/)
  })

  it('only EVM: other chains keep their own rules for sign()', async () => {
    const { intents, confirm } = seen()
    await applyPolicies(createMockAccount({ chain: 'tron:0x2b6653dc', address: 'TXYZ' }), { confirm }).sign('é'.repeat(16))
    expect(intents[0]).toMatchObject({ kind: 'message', message: true })
  })

  it('utf8Bytes writes what TextEncoder writes (surrogate pairs, lone surrogates, BOM, every width)', () => {
    const samples = ['', 'a', 'é', '€', '🦊', '﻿', '\uD83E', '\uDD8A', '\uDD8A\uD83E', 'a\uD83Eb', '🦊\uD83E', '߿ࠀ￿', ...TEXT32.map(([, m]) => m), ...NORMAL.map(([, m]) => m)]
    for (const s of samples) expect(Array.from(utf8Bytes(s)), JSON.stringify(s)).toEqual(Array.from(enc(s)))
  })
})

describe('SDK-303: real wallet-evm (offline)', () => {
  const setup = async () => {
    const { intents, confirm } = seen()
    const w = new Wallet(SEED, { policies: { confirm } })
    w.registerWallet(CHAIN, WalletManagerEvm as never, { chainId: 1 })
    const guarded = (await w.getAccount(CHAIN)) as unknown as { sign(m: string | Uint8Array): Promise<string> }
    const plain = await new WalletManagerEvm(SEED, { chainId: 1 }).getAccount(0)
    return { intents, guarded, plain }
  }

  it('invariant: the bytes the policies measured are the bytes wallet-evm signs, for every case', async () => {
    const { intents, guarded, plain } = await setup()
    const cases: Array<[string, string | Uint8Array]> = [...TEXT32, ...NORMAL, ['32 raw bytes', bytes(DIGEST)], ['31 raw bytes', new Uint8Array(31)], ['33 raw bytes', new Uint8Array(33).fill(7)]]
    for (const [name, m] of cases) {
      const measured = evmMessageBytes(m)!
      const signature = await guarded.sign(m)
      // ECDSA here is deterministic (RFC 6979): the same signature means the same signed bytes.
      expect(signature, name).toBe(await plain.sign(measured))
      expect(intents.at(-1)!.blindHash === true, name).toBe(measured.length === 32)
    }
  })

  it('the hex form is flagged by its shape: wallet-evm signs its 66 characters, another signer may decode them', async () => {
    const { intents, guarded, plain } = await setup()
    expect(await guarded.sign(DIGEST)).toBe(await plain.sign(utf8Bytes(DIGEST)))
    expect(intents[0]).toMatchObject({ blindHash: true, blindHashForm: 'hex' })
  })

  it('a digest ground to valid UTF-8, sent as text, is the same signature as its 32 raw bytes — and flagged', async () => {
    const { intents, guarded, plain } = await setup()
    const ground = `0x${'c3a9'.repeat(16)}` // valid UTF-8: "é" × 16
    expect(await guarded.sign('é'.repeat(16))).toBe(await plain.sign(bytes(ground)))
    expect(intents[0]).toMatchObject({ blindHash: true, blindHashForm: 'text' })
  })
})
