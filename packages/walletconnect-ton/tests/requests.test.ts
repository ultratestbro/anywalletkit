import { describe, expect, it, vi } from 'vitest'
import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { Buffer } from 'buffer'
import { Address, beginCell, Cell, loadMessage, storeStateInit } from '@ton/core'
import { externalSigner } from '@anywalletkit/core'
import { applyPolicies } from '@anywalletkit/kit'
import { WalletAccountTon, WalletAccountReadOnlyTon, v5r1StateInit, type TonConfig } from '@anywalletkit/wallet-ton'
import { handleTonRequest, tonConnectTransactions, type TonRequestReview, type TonRpcResponse, type TonWithSigner, type WcSessionLike } from '../src/index.js'
import { fakeTon, now, tonAccount } from './helpers.js'

const te = new TextEncoder()
const cat = (...p: Uint8Array[]) => Uint8Array.from(p.flatMap((x) => [...x]))
const u32be = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, false); return b }
const u64be = (n: number) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), false); return b }

const KEY = new Uint8Array(32).fill(0x24)
const PUB = ed25519.getPublicKey(KEY)
const OTHER = Address.parseRaw(`0:${'cd'.repeat(32)}`).toString({ bounceable: false })
const DEST = Address.parseRaw(`0:${'ab'.repeat(32)}`).toString({ bounceable: true })
const COMMENT = beginCell().storeUint(0, 32).storeStringTail('hi').endCell().toBoc().toString('base64')

/** A wallet-ton account whose key signs through a counter: exactly what was signed, how many times. */
function counted(config: TonConfig) {
  const signed: Array<{ context?: string | undefined }> = []
  const signer = externalSigner({ curve: 'ed25519', publicKey: PUB, sign: async (payload, opts) => { signed.push({ context: (opts as { context?: string } | undefined)?.context }); return ed25519.sign(payload, KEY) } })
  return { account: new WalletAccountTon(signer, PUB, 'external', config), signed }
}

const sessionFor = (address: string, url = 'https://app.ston.fi'): WcSessionLike => ({
  topic: 't1', peer: { metadata: { name: 'STON.fi', url } },
  namespaces: { ton: { chains: ['ton:-239'], methods: ['ton_sendMessage', 'ton_signData'], events: [], accounts: [`ton:-239:${address}`] } },
})

/** What @tonconnect/sdk 5.x WalletConnectProvider.sendRequest sends: params[0] minus `network`, as an object, to chain `ton:${network}`. */
const sendReq = (from: string, over: Record<string, unknown> = {}, chainId = 'ton:-239', id = 7) => ({
  id, topic: 't1', params: { chainId, request: { method: 'ton_sendMessage', params: { valid_until: now() + 300, from, messages: [{ address: DEST, amount: '10000000', payload: COMMENT }], ...over } } },
})
const signReq = (params: unknown, id = 8) => ({ id, topic: 't1', params: { chainId: 'ton:-239', request: { method: 'ton_signData', params } } })

const yes = async () => true
const errorOf = (r: TonRpcResponse) => ('error' in r ? r.error : undefined)

describe('ton_sendMessage', () => {
  it('reviews, signs once, broadcasts and answers with the external message as broadcast', async () => {
    const ton = fakeTon()
    const { account, signed } = counted(ton.config)
    const reviews: TonRequestReview[] = []
    const raw = Address.parse(account.address).toRawString()
    const r = await handleTonRequest(account, sendReq(raw), { session: sessionFor(account.address), review: (x) => { reviews.push(x); return true } })
    expect(r).toMatchObject({ id: 7, jsonrpc: '2.0' })
    expect('result' in r && typeof r.result).toBe('string')
    expect(ton.sent).toHaveLength(1)
    expect((r as { result: string }).result).toBe(ton.sent[0]!.toBoc().toString('base64'))
    expect(signed).toEqual([{ context: 'ton-external' }])
    expect(reviews).toHaveLength(1)
    const review = reviews[0]!
    expect(review.method).toBe('ton_sendMessage')
    if (review.method !== 'ton_sendMessage') throw new Error('unreachable')
    expect(review.peerDomain).toBe('app.ston.fi')
    expect(review.transactions).toEqual([{ to: DEST, value: 10_000_000n, bodyBoc: COMMENT }])
    expect(review.description?.items).toHaveLength(1)
    expect(typeof review.simulate).toBe('function')
    // the external carries no StateInit for a deployed wallet
    expect(loadMessage(ton.sent[0]!.beginParse()).init).toBeFalsy()
  })

  it('attaches the StateInit only while the wallet is not deployed', async () => {
    const ton = fakeTon({ state: 'uninitialized' })
    const { account } = counted(ton.config)
    const r = await handleTonRequest(account, sendReq(account.address), { review: yes })
    const msg = loadMessage(Cell.fromBase64((r as { result: string }).result).beginParse())
    expect(beginCell().store(storeStateInit(msg.init!)).endCell().hash()).toEqual(beginCell().store(storeStateInit(v5r1StateInit(PUB))).endCell().hash())
  })

  it("takes the Reown spec's [params] form and a JSON string", async () => {
    const ton = fakeTon()
    const { account } = counted(ton.config)
    const req = sendReq(account.address)
    const arr = { ...req, params: { ...req.params, request: { ...req.params.request, params: [req.params.request.params] } } }
    expect('result' in (await handleTonRequest(account, arr, { review: yes }))).toBe(true)
    const str = { ...req, params: { ...req.params, request: { ...req.params.request, params: [JSON.stringify(req.params.request.params)] } } }
    expect('result' in (await handleTonRequest(account, str, { review: yes }))).toBe(true)
    expect(ton.sent).toHaveLength(2)
  })

  it('refusals before review: expired, wrong network, foreign from, too many / no messages, malformed — nothing signed', async () => {
    const ton = fakeTon()
    const { account, signed } = counted(ton.config)
    const review = vi.fn(yes)
    const a = account.address
    const cases: Array<[string, ReturnType<typeof sendReq>]> = [
      ['expired', sendReq(a, { valid_until: now() - 1 })],
      ['expired (ms)', sendReq(a, { valid_until: (now() - 10) * 1000 })],
      ['testnet chain', sendReq(a, {}, 'ton:-3')],
      ['network in params', sendReq(a, { network: '-3' })],
      ['foreign from', sendReq(a, { from: OTHER })],
      ['malformed from', sendReq(a, { from: 'EQnope' })],
      ['5 messages', sendReq(a, { messages: Array.from({ length: 5 }, () => ({ address: DEST, amount: '1' })) })],
      ['no messages', sendReq(a, { messages: [] })],
      ['bad address', sendReq(a, { messages: [{ address: 'EQC…', amount: '1' }] })],
      ['bad checksum', sendReq(a, { messages: [{ address: DEST.slice(0, -1) + (DEST.endsWith('A') ? 'B' : 'A'), amount: '1' }] })],
      ['amount fraction number', sendReq(a, { messages: [{ address: DEST, amount: 1.5 }] })],
      ['amount fraction', sendReq(a, { messages: [{ address: DEST, amount: '1.5' }] })],
      ['payload not base64', sendReq(a, { messages: [{ address: DEST, amount: '1', payload: '!!!!' }] })],
      ['payload not a BoC', sendReq(a, { messages: [{ address: DEST, amount: '1', payload: 'AAAA' }] })],
      ['stateInit not a StateInit', sendReq(a, { messages: [{ address: DEST, amount: '1', stateInit: COMMENT }] })],
    ]
    for (const [what, req] of cases) {
      const e = errorOf(await handleTonRequest(account, req, { session: sessionFor(a), review }))
      expect(e, what).toMatchObject({ code: 1 })
      // @tonconnect/sdk maps this prefix to BAD_REQUEST (it ignores the code)
      expect(e!.message, what).toMatch(/^TonValidationError: /)
      expect(e!.message.toLowerCase(), what).not.toContain('reject')
    }
    expect(review).not.toHaveBeenCalled()
    expect(signed).toHaveLength(0)
    expect(ton.sent).toHaveLength(0)
  })

  it('not supported (400): structured items, extra currencies, zero-value messages, other methods', async () => {
    const ton = fakeTon()
    const { account } = counted(ton.config)
    const a = account.address
    for (const req of [
      sendReq(a, { messages: undefined, items: [{ type: 'ton', address: DEST, amount: '1' }] }),
      sendReq(a, { messages: [{ address: DEST, amount: '1', extra_currency: { 100: '1' } }] }),
      sendReq(a, { messages: [{ address: DEST, amount: '0' }] }),
      { id: 9, params: { chainId: 'ton:-239', request: { method: 'ton_getBalance', params: {} } } },
    ]) {
      expect(errorOf(await handleTonRequest(account, req, { review: yes }))).toMatchObject({ code: 400 })
    }
    expect(ton.sent).toHaveLength(0)
  })

  it("a session for another account or chain is refused", async () => {
    const ton = fakeTon()
    const { account } = counted(ton.config)
    expect(errorOf(await handleTonRequest(account, sendReq(account.address), { session: sessionFor(OTHER), review: yes }))).toMatchObject({ code: 1, message: expect.stringContaining('another TON account') })
    const noTon: WcSessionLike = { peer: { metadata: { url: 'https://app.ston.fi' } }, namespaces: { eip155: { accounts: ['eip155:1:0x0'] } } }
    expect(errorOf(await handleTonRequest(account, sendReq(account.address), { session: noTon, review: yes }))).toMatchObject({ code: 1 })
    expect(ton.sent).toHaveLength(0)
  })

  it('a decline is 300 with "reject" in the message (what the dApp side keys on); an aborted signal too', async () => {
    const ton = fakeTon()
    const { account, signed } = counted(ton.config)
    const no = errorOf(await handleTonRequest(account, sendReq(account.address), { review: async () => false }))
    expect(no).toMatchObject({ code: 300 })
    expect(no!.message.toLowerCase()).toContain('reject')
    const ctl = new AbortController()
    const late = errorOf(await handleTonRequest(account, sendReq(account.address), { signal: ctl.signal, review: async () => { ctl.abort(); return true } }))
    expect(late).toMatchObject({ code: 300 })
    expect(signed).toHaveLength(0)
    expect(ton.sent).toHaveLength(0)
  })

  it('valid_until is checked again after the review: a request that expired meanwhile is not signed', async () => {
    const ton = fakeTon()
    const { account, signed } = counted(ton.config)
    let t = now()
    const r = await handleTonRequest(account, sendReq(account.address, { valid_until: t + 30 }), { now: () => t, review: async () => { t += 60; return true } })
    expect(errorOf(r)).toMatchObject({ code: 1, message: expect.stringContaining('expired') })
    expect(signed).toHaveLength(0)
  })

  it('policies run once, on the one write: confirm sees it, a fee cap or a "no" stops it before the key', async () => {
    const ton = fakeTon()
    const { account, signed } = counted(ton.config)
    const confirm = vi.fn(async (_intent: unknown) => true)
    const guarded = applyPolicies(account, { confirm }, account.chain)
    const ok = await handleTonRequest(guarded, sendReq(account.address), { review: yes })
    expect('result' in ok).toBe(true)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls[0]![0]).toMatchObject({ method: 'sendTransaction', chain: 'ton:-239' })
    expect(signed).toHaveLength(1)

    const capped = applyPolicies(account, { maxFee: { 'ton:-239': 1n } }, account.chain)
    const fee = errorOf(await handleTonRequest(capped, sendReq(account.address), { review: yes }))
    expect(fee).toMatchObject({ code: 0 })
    expect(fee!.message).toMatch(/cap/)

    const declined = applyPolicies(account, { confirm: async () => false }, account.chain)
    expect(errorOf(await handleTonRequest(declined, sendReq(account.address), { review: yes }))).toMatchObject({ code: 300 })
    expect(signed).toHaveLength(1)
    expect(ton.sent).toHaveLength(1)
  })

  it('the account checks still hold: an amount above the balance is refused before signing', async () => {
    const ton = fakeTon({ balance: 1_000n })
    const { account, signed } = counted(ton.config)
    const e = errorOf(await handleTonRequest(account, sendReq(account.address), { review: yes }))
    expect(e).toMatchObject({ code: 0 })
    expect(e!.message).toMatch(/Insufficient TON balance/)
    expect(e!.message.toLowerCase()).not.toContain('reject')
    expect(signed).toHaveLength(0)
  })

  it('a node refusal is an error; nothing claims it was sent', async () => {
    const ton = fakeTon({ refuseSend: true })
    const { account } = counted(ton.config)
    const e = errorOf(await handleTonRequest(account, sendReq(account.address), { review: yes }))
    expect(e).toMatchObject({ code: 0 })
    expect(e!.message).toMatch(/cannot apply external message/)
  })

  it('a read-only account + withSigner: the key is opened only after a yes, and only as the session account', async () => {
    const ton = fakeTon()
    const { account } = counted(ton.config)
    const ro = new WalletAccountReadOnlyTon(PUB, ton.config)
    let opened = 0
    const withSigner: TonWithSigner = (run) => { opened++; return run(account) }
    expect(errorOf(await handleTonRequest(ro, sendReq(ro.address), { review: async () => false, withSigner }))).toMatchObject({ code: 300 })
    expect(opened).toBe(0)
    expect('result' in (await handleTonRequest(ro, sendReq(ro.address), { review: yes, withSigner }))).toBe(true)
    expect(opened).toBe(1)
    const { account: other, manager } = await tonAccount(ton.config, 3)
    expect(errorOf(await handleTonRequest(ro, sendReq(ro.address), { review: yes, withSigner: (run) => run(other) }))).toMatchObject({ code: 1 })
    expect(errorOf(await handleTonRequest(ro, sendReq(ro.address), { review: yes }))).toMatchObject({ code: 0, message: expect.stringContaining('cannot sign') })
    manager.dispose()
  })
})

describe('tonConnectTransactions', () => {
  it('maps {address, amount, payload, stateInit} to {to, value, bodyBoc, stateInit} and never sets a send mode', () => {
    const init = beginCell().store(storeStateInit(v5r1StateInit(PUB))).endCell().toBoc().toString('base64')
    const txs = tonConnectTransactions([{ address: DEST, amount: '5', payload: COMMENT, stateInit: init }, { address: `0:${'ab'.repeat(32)}`, amount: '1' }])
    expect(txs).toEqual([{ to: DEST, value: 5n, bodyBoc: COMMENT, stateInit: init }, { to: `0:${'ab'.repeat(32)}`, value: 1n }])
    for (const t of txs) expect(t).not.toHaveProperty('sendMode')
  })
})

describe('ton_signData', () => {
  const digest = (raw: string, domain: string, ts: number, prefix: 'txt' | 'bin', payload: Uint8Array) => {
    const a = Address.parseRaw(raw)
    const d = te.encode(domain)
    return sha256(cat(new Uint8Array([0xff, 0xff]), te.encode('ton-connect/sign-data/'), new Uint8Array(4), a.hash, u32be(d.length), d, u64be(ts), te.encode(prefix), u32be(payload.length), payload))
  }

  it('golden: text and binary signatures verify against the TON Connect digest bound to the peer domain', async () => {
    const { account, manager } = await tonAccount()
    const ts = 1_760_000_123
    const session = sessionFor(account.address)
    const text = await handleTonRequest(account, signReq({ type: 'text', text: 'Log in to STON.fi', from: Address.parse(account.address).toRawString() }), { session, now: () => ts, review: yes })
    const t = (text as { result: { signature: string; address: string; timestamp: number; domain: string; payload: unknown } }).result
    expect(t).toMatchObject({ address: Address.parse(account.address).toRawString(), timestamp: ts, domain: 'app.ston.fi', payload: { type: 'text', text: 'Log in to STON.fi' }, publicKey: Buffer.from(account.publicKey).toString('hex') })
    expect(ed25519.verify(new Uint8Array(Buffer.from(t.signature, 'base64')), digest(t.address, 'app.ston.fi', ts, 'txt', te.encode('Log in to STON.fi')), account.publicKey)).toBe(true)

    const bin = await handleTonRequest(account, signReq([{ type: 'binary', bytes: 'AQID' }]), { session, now: () => ts, review: yes })
    const b = (bin as { result: { signature: string; address: string } }).result
    expect(ed25519.verify(new Uint8Array(Buffer.from(b.signature, 'base64')), digest(b.address, 'app.ston.fi', ts, 'bin', Uint8Array.of(1, 2, 3)), account.publicKey)).toBe(true)
    manager.dispose()
  })

  it('the domain comes from the session peer, never from the request body', async () => {
    const { account, manager } = await tonAccount()
    const reviews: TonRequestReview[] = []
    const r = await handleTonRequest(account, signReq({ type: 'text', text: 'hi', domain: 'evil.example' }), { session: sessionFor(account.address, 'https://app.ston.fi/swap'), review: (x) => { reviews.push(x); return true } })
    expect((r as { result: { domain: string } }).result.domain).toBe('app.ston.fi')
    expect(reviews[0]).toMatchObject({ method: 'ton_signData', peerDomain: 'app.ston.fi' })
    const over = await handleTonRequest(account, signReq({ type: 'text', text: 'hi' }), { session: sessionFor(account.address), peerDomain: 'verified.example', review: yes })
    expect((over as { result: { domain: string } }).result.domain).toBe('verified.example')
    manager.dispose()
  })

  it('refuses cell (400), an unknown domain, a foreign from, another network, empty and malformed payloads (1)', async () => {
    const { account, manager } = await tonAccount()
    const session = sessionFor(account.address)
    const review = vi.fn(yes)
    expect(errorOf(await handleTonRequest(account, signReq({ type: 'cell', schema: 'x', cell: 'te6' }), { session, review }))).toMatchObject({ code: 400, message: expect.stringContaining('cell') })
    expect(errorOf(await handleTonRequest(account, signReq({ type: 'text', text: 'x' }), { review }))).toMatchObject({ code: 1, message: expect.stringContaining('domain') })
    for (const p of [{ type: 'text', text: 'x', from: OTHER }, { type: 'text', text: 'x', network: '-3' }, { type: 'text', text: '' }, { type: 'binary', bytes: '!!' }, { type: 'magic' }, '{bad', undefined]) {
      expect(errorOf(await handleTonRequest(account, signReq(p), { session, review })), JSON.stringify(p)).toMatchObject({ code: 1 })
    }
    expect(review).not.toHaveBeenCalled()
    expect(errorOf(await handleTonRequest(account, signReq({ type: 'text', text: 'x' }), { session, review: async () => false }))).toMatchObject({ code: 300 })
    manager.dispose()
  })
})
