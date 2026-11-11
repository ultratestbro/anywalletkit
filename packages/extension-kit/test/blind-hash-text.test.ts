import { describe, expect, it } from 'vitest'
import { bytesToHex, verifyMessage, type Hex } from 'viem'
import { WalletManagerEvm } from '@anywalletkit/wallet-evm'
import { ApprovalQueue, DEFAULT_NETWORKS, classifySignRequest, createSignHandler, memoryApprovalWindow, type EvmNetwork, type EvmSigner, type SignApproval } from '../src/index.js'
import { personalSignBytes, personalSignInput, utf8Bytes } from '../src/personal-sign.js'

// SDK-303 (extension audit E55, second half): the 32-byte rule read only the hex form. A personal_sign whose text is
// valid UTF-8 of exactly 32 bytes was a normal message sheet — and the wallet signed exactly those 32 bytes behind
// the EIP-191 "\n32" prefix, which is what CoW Protocol's `ethsign` verifies. A site grinds free order fields (appData,
// validTo) until the EIP-712 digest is valid UTF-8 (~1 in 1.5e8) and sends it decoded. Such a message now reaches the
// sheet marked `blindHash` / `blindHashForm: 'text'` (a danger screen), with or without the wallet's opt-in.

const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const ME = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
const ETH = DEFAULT_NETWORKS[0]!
const SITE = 'https://swap.example'
const DIGEST = '0x52eae78642b0ca3226e8a77062bebe97d7e69c10b2c882118503357d84e4e66f'
const HEX29 = DIGEST.slice(2, 31)
const enc = (s: string) => new TextEncoder().encode(s)
const classify = (msg: string, allowBlindHash?: boolean) => classifySignRequest({ network: ETH, method: 'personal_sign', params: [msg, ME], accounts: [ME], origin: SITE, ...(allowBlindHash !== undefined ? { allowBlindHash } : {}) })
const siwe = `swap.example wants you to sign in with your Ethereum account:\n${ME}\n\nSign in to Swap\n\nURI: https://swap.example/login\nVersion: 1\nChain ID: 1\nNonce: k9Qz1bX2pL7m\nIssued At: 2026-11-11T10:00:00Z`

/** Text forms whose signed bytes are exactly 32. */
const TEXT32: Array<[string, string]> = [
  ['ASCII', 'Login nonce: 0123456789abcdefghi'],
  ['two-byte letters (16 characters)', 'é'.repeat(16)],
  ['four-byte emoji (16 UTF-16 units)', '🦊'.repeat(8)],
  ['mixed widths', `${'ж'.repeat(10)}€€${'a'.repeat(6)}`],
  ['a leading BOM (3 bytes + 29)', `﻿${'a'.repeat(29)}`],
  ['a lone surrogate (U+FFFD, 3 bytes + 29)', `\uD83E${'a'.repeat(29)}`],
  ['hex-looking but not hex: 0x + 29 hex + z', `0x${HEX29}z`],
  ['hex-looking with a leading space: " 0x" + 29 hex', ` 0x${HEX29}`],
  ['0X + 30 hex (upper-case prefix is text)', `0X${DIGEST.slice(2, 32)}`],
]
/** Messages that are not 32 signed bytes: a normal sheet, as before. */
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
  ['0x + 64 hex with a leading space (67 text bytes)', ` ${DIGEST}`],
  ['0x + 64 hex with a space inside (67 text bytes)', `${DIGEST.slice(0, 34)} ${DIGEST.slice(34)}`],
  ['0x + 30 hex (15 bytes)', DIGEST.slice(0, 32)],
  ['Sign-In with Ethereum', siwe],
]

describe('SDK-303: a personal_sign whose text is 32 UTF-8 bytes', () => {
  it('the test vectors are what their names say', () => {
    for (const [name, m] of TEXT32) expect(enc(m).length, name).toBe(32)
    for (const [name, m] of NORMAL.slice(0, 6)) expect(enc(m).length, name).not.toBe(32)
  })

  it.each(TEXT32)('%s: reaches the sheet marked blindHash / text — never refused, with or without the opt-in', (_name, m) => {
    for (const allow of [undefined, false, true]) {
      const info = classify(m, allow)
      expect(info).toMatchObject({ kind: 'sign-message', blindHash: true, blindHashForm: 'text', raw: m })
    }
  })

  it.each(NORMAL)('%s: a normal message sheet', (_name, m) => {
    for (const allow of [undefined, true]) {
      const info = classify(m, allow)
      expect(info).toMatchObject({ kind: 'sign-message', raw: m })
      expect(info).not.toHaveProperty('blindHash')
      expect(info).not.toHaveProperty('blindHashForm')
    }
  })

  it('SIWE is untouched: parsed, no blind hash flag', () => {
    expect(classify(siwe)).toMatchObject({ kind: 'sign-message', siwe: { message: { domain: 'swap.example' }, problems: [] } })
  })

  it('the hex form is unchanged: refused by default, a red sheet (blindHashForm hex) with the opt-in', () => {
    expect(classify(DIGEST)).toMatchObject({ code: 4200, message: expect.stringMatching(/32-byte hash/) })
    expect(classify(DIGEST, false)).toMatchObject({ code: 4200 })
    expect(classify(DIGEST, true)).toMatchObject({ kind: 'sign-message', blindHash: true, blindHashForm: 'hex', text: DIGEST, raw: DIGEST })
    // 32 bytes that decode to printable text keep the hex form (what the site sent), shown decoded.
    const hexOfText = bytesToHex(enc('Login nonce: 0123456789abcdefghi'))
    expect(classify(hexOfText)).toMatchObject({ code: 4200 })
    expect(classify(hexOfText, true)).toMatchObject({ blindHash: true, blindHashForm: 'hex', text: 'Login nonce: 0123456789abcdefghi' })
  })

  it('a digest ground to valid UTF-8 signs the same bytes in either form; only the hex form is refused by default', () => {
    // 0xc3a9 × 16 is valid UTF-8 ("é" × 16): the hex form and the text form are one signature.
    const hex = `0x${'c3a9'.repeat(16)}`
    expect(personalSignBytes(hex)).toEqual(personalSignBytes('é'.repeat(16)))
    expect(classify(hex)).toMatchObject({ code: 4200 })
    expect(classify('é'.repeat(16))).toMatchObject({ blindHash: true, blindHashForm: 'text' })
  })

  it('utf8Bytes writes what TextEncoder writes (surrogate pairs, lone surrogates, BOM, every width)', () => {
    const samples = ['', 'a', 'é', '€', '🦊', '﻿', '\uD83E', '\uDD8A', '\uDD8A\uD83E', 'a\uD83Eb', '🦊\uD83E', '߿ࠀ￿', ...TEXT32.map(([, m]) => m), ...NORMAL.map(([, m]) => m)]
    for (const s of samples) expect(Array.from(utf8Bytes(s)), JSON.stringify(s)).toEqual(Array.from(enc(s)))
  })
})

describe('SDK-303: createSignHandler', () => {
  const setup = (allowBlindHash?: () => boolean) => {
    const window = memoryApprovalWindow()
    const approvals = new ApprovalQueue(window, undefined, { openRate: false }) // dozens of sheets from one site
    const handed: Array<string | Uint8Array> = []
    const sign = createSignHandler({
      approvals, rpc: async () => { throw new Error('no rpc') },
      signerFor: async () => {
        const account = await new WalletManagerEvm(ABANDON, { chainId: 1 }).getAccount(0)
        const signer: EvmSigner = { signMessage: (m) => { handed.push(m); return account.sign(m) }, signTypedData: (t) => account.signTypedData(t), signTransaction: (tx) => account.signTransaction(tx) }
        return { signer, dispose: () => account.dispose() }
      },
      ...(allowBlindHash ? { allowBlindHash } : {}),
    })
    const run = async (m: string) => {
      const before = window.opened.length
      const p = sign({ origin: SITE, network: ETH as EvmNetwork, method: 'personal_sign', params: [m, ME], accounts: [ME] })
      for (let i = 0; i < 20 && window.opened.length === before; i++) await new Promise((r) => setTimeout(r, 0))
      const shown = window.opened[before]!
      approvals.resolve(shown.id, null)
      return { request: (shown.payload as SignApproval).request, signature: (await p) as Hex }
    }
    return { run, handed, window }
  }

  it('the text form opens the danger sheet without the opt-in (absent, or answering false)', async () => {
    for (const allow of [undefined, () => false]) {
      const { run } = setup(allow)
      for (const [, m] of TEXT32) expect((await run(m)).request).toMatchObject({ kind: 'sign-message', blindHash: true, blindHashForm: 'text' })
    }
  })

  it('invariant: the bytes the classifier measured are the bytes wallet-evm signs, for every case', async () => {
    const { run, handed } = setup(() => true)
    const cases = [...TEXT32, ...NORMAL, ['hex 0x + 64', DIGEST] as [string, string], ['hex 0x + 66', `${DIGEST}00`] as [string, string]]
    for (const [name, m] of cases) {
      const measured = personalSignBytes(m)
      const { request, signature } = await run(m)
      // The 32-byte decision is made on exactly these bytes…
      expect(request.kind === 'sign-message' && request.blindHash === true, name).toBe(measured.length === 32)
      // …the signer was handed what personal-sign.ts says it is handed…
      expect(handed.at(-1), name).toEqual(personalSignInput(m))
      // …and the signature is over exactly the measured bytes.
      expect(await verifyMessage({ address: ME, message: { raw: measured }, signature }), name).toBe(true)
    }
  })
})
