import '../src/buffer-global.js'
import { describe, expect, it } from 'vitest'
import { Address, Cell, loadMessage } from '@ton/core'
import {
  TONCONNECT_ERRORS, TONCONNECT_SIGN_DATA_MAX, TonConnectError, isTonConnectBase64, parseConnectRequest, parseSendTransaction, parseSignData,
  sameTonConnectAddress, tonAddressParts, tonConnectFriendlyAddress, tonConnectRawAddress,
} from '../src/tonconnect.js'
import { WalletManagerTon } from '../src/index.js'
import { fakeRpc } from './fake-rpc.js'

const HASH = Buffer.alloc(32, 0xab)
const ADDR = new Address(0, HASH)
const RAW = ADDR.toRawString()
const EQ = ADDR.toString({ bounceable: true, urlSafe: true })
const UQ = ADDR.toString({ bounceable: false, urlSafe: true })
const OTHER = `0:${'cd'.repeat(32)}`
const NOW = 1_760_000_000
const code = (fn: () => unknown) => { try { fn(); return 'ok' } catch (e) { return e instanceof TonConnectError ? e.code : `other:${String(e)}` } }
const send = (over: Record<string, unknown> = {}) => ({ valid_until: NOW + 60, from: UQ, messages: [{ address: EQ, amount: '1000000' }], ...over })

describe('TON Connect addresses (no @ton/core, no Buffer)', () => {
  it('raw, bounceable, non-bounceable, base64 and base64url forms → one raw form; checksums enforced', () => {
    for (const a of [RAW, RAW.toUpperCase().replace('0X', '0x'), EQ, UQ, ADDR.toString({ urlSafe: false }), ADDR.toString({ testOnly: true })]) expect(tonConnectRawAddress(a)).toBe(RAW)
    expect(tonConnectRawAddress(`-1:${'ab'.repeat(32)}`)).toBe(`-1:${'ab'.repeat(32)}`)
    expect(tonConnectRawAddress(new Address(-1, HASH).toString())).toBe(`-1:${'ab'.repeat(32)}`)
    expect(tonConnectRawAddress(EQ.slice(0, -1) + (EQ.endsWith('A') ? 'B' : 'A'))).toBeNull()
    for (const bad of ['EQC…', 'x', '', `1:${'ab'.repeat(32)}`, `0:${'ab'.repeat(31)}`, ` ${RAW}`, `+0:${'ab'.repeat(32)}`]) expect(tonConnectRawAddress(bad)).toBeNull()
    expect(sameTonConnectAddress(EQ, RAW)).toBe(true)
    expect(sameTonConnectAddress(UQ, OTHER)).toBe(false)
    expect(sameTonConnectAddress('x', 'x')).toBe(false)
    expect(tonAddressParts(UQ)).toEqual({ workChain: 0, hash: new Uint8Array(HASH) })
  })

  it('raw → user-friendly url-safe (UQ…, EQ… when bounceable, test-only flag)', () => {
    expect(tonConnectFriendlyAddress(RAW)).toBe(UQ)
    expect(tonConnectFriendlyAddress(EQ)).toBe(UQ)
    expect(tonConnectFriendlyAddress(RAW, { bounceable: true })).toBe(EQ)
    expect(tonConnectFriendlyAddress(RAW, { testOnly: true })).toBe(ADDR.toString({ bounceable: false, urlSafe: true, testOnly: true }))
    expect(tonConnectFriendlyAddress(`-1:${'ab'.repeat(32)}`)).toBe(new Address(-1, HASH).toString({ bounceable: false, urlSafe: true }))
    expect(tonConnectFriendlyAddress('nope')).toBeNull()
  })

  it('strict base64 for BoCs and binary payloads', () => {
    for (const ok of ['AQID', 'AQI=', 'AQ==', 'te6cckEB', 'a-_b']) expect(isTonConnectBase64(ok)).toBe(true)
    for (const no of ['', '!!', 'A', 'AQ===', 'A Q', 1]) expect(isTonConnectBase64(no)).toBe(false)
  })
})

describe('parseConnectRequest', () => {
  it('ton_addr required, ton_proof with a string payload, nothing else', () => {
    expect(parseConnectRequest({ manifestUrl: 'https://a.example/m.json', items: [{ name: 'ton_addr' }, { name: 'ton_proof', payload: 'n' }] })).toEqual({ manifestUrl: 'https://a.example/m.json', proofPayload: 'n' })
    expect(code(() => parseConnectRequest({ manifestUrl: 'https://a.example/m.json', items: [{ name: 'ton_proof', payload: 'n' }] }))).toBe(TONCONNECT_ERRORS.badRequest)
  })
})

describe('parseSendTransaction', () => {
  it('object or JSON string; network / from checked against the wallet; valid_until in seconds or ms', () => {
    const opts = { address: RAW, now: NOW }
    expect(parseSendTransaction(send(), opts)).toEqual({ validUntil: NOW + 60, from: UQ, messages: [{ address: EQ, amount: '1000000' }] })
    expect(parseSendTransaction(JSON.stringify(send({ network: '-239' })), opts).network).toBe('-239')
    expect(parseSendTransaction(send({ valid_until: (NOW + 60) * 1000 }), opts).validUntil).toBe(NOW + 60)
    expect(parseSendTransaction(send({ from: EQ }), { ...opts, address: UQ }).from).toBe(EQ)
    expect(parseSendTransaction(send({ network: '-3' }), { ...opts, network: '-3' }).network).toBe('-3')
    // the Reown TON reference allows a whole-number amount
    expect(parseSendTransaction(send({ messages: [{ address: EQ, amount: 5 }] }), opts).messages[0]!.amount).toBe('5')
  })

  it('refuses what the spec says to refuse (1) and what the wallet does not support (400)', () => {
    const opts = { address: RAW, now: NOW }
    for (const req of [
      send({ valid_until: NOW - 1 }), send({ valid_until: 'soon' }), send({ network: '-3' }), send({ from: OTHER }), send({ from: 'EQnope' }), send({ from: 5 }),
      send({ messages: [] }), send({ messages: Array.from({ length: 5 }, () => ({ address: EQ, amount: '1' })) }),
      send({ messages: [{ address: EQ, amount: 1.5 }] }), send({ messages: [{ address: EQ, amount: -1 }] }), send({ messages: [{ address: EQ, amount: '1e9' }] }), send({ messages: [{ amount: '1' }] }),
      send({ messages: [{ address: EQ, amount: '1', payload: 5 }] }), '{bad', '[1]', null,
    ]) expect(code(() => parseSendTransaction(req, opts)), JSON.stringify(req)).toBe(TONCONNECT_ERRORS.badRequest)
    expect(code(() => parseSendTransaction(send({ items: [{ type: 'ton', address: EQ, amount: '1' }] }), opts))).toBe(TONCONNECT_ERRORS.methodNotSupported)
    expect(code(() => parseSendTransaction(send({ messages: [{ address: EQ, amount: '1', extra_currency: { 100: '1' } }] }), opts))).toBe(TONCONNECT_ERRORS.methodNotSupported)
    expect(parseSendTransaction(send({ messages: [{ address: EQ, amount: '1', extra_currency: {} }] }), opts).messages).toHaveLength(1)
    expect(code(() => parseSendTransaction(send({ messages: Array.from({ length: 3 }, () => ({ address: EQ, amount: '1' })) }), { ...opts, maxMessages: 2 }))).toBe(TONCONNECT_ERRORS.badRequest)
  })
})

describe('parseSignData', () => {
  it('text / binary, object or JSON string; network and from checked', () => {
    expect(parseSignData({ type: 'text', text: 'hi', network: '-239', from: UQ }, { address: RAW })).toEqual({ type: 'text', text: 'hi' })
    expect(parseSignData(JSON.stringify({ type: 'binary', bytes: 'AQI=' }), { address: RAW })).toEqual({ type: 'binary', bytes: 'AQI=' })
  })
  it('refuses cell (400), testnet, foreign signers and malformed payloads (1)', () => {
    expect(code(() => parseSignData({ type: 'cell', schema: 'x', cell: 'te6' }, { address: RAW }))).toBe(TONCONNECT_ERRORS.methodNotSupported)
    for (const p of [
      { type: 'text', text: 'hi', network: '-3' }, { type: 'text', text: 'hi', from: OTHER }, { type: 'text', text: '' },
      { type: 'text', text: 'x'.repeat(TONCONNECT_SIGN_DATA_MAX + 1) }, { type: 'binary', bytes: '!!' }, { type: 'magic' }, '{bad', undefined,
    ]) expect(code(() => parseSignData(p, { address: RAW })), JSON.stringify(p)?.slice(0, 40)).toBe(TONCONNECT_ERRORS.badRequest)
  })
})

describe('sendTransaction returns the external message as broadcast', () => {
  it('boc is the exact BoC handed to sendBoc; the StateInit rides along only for an undeployed wallet', async () => {
    for (const state of ['active', 'uninitialized'] as const) {
      const rpc = fakeRpc({ getAddressInformation: () => ({ '@type': 'raw.fullAccountState', balance: '5000000000', state, code: '', data: '', last_transaction_id: { '@type': 'internal.transactionId', lt: '1', hash: 'AA==' }, sync_utime: 1 }) })
      const m = new WalletManagerTon('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', { tonClient: { url: 'https://toncenter.test/api/v2/jsonRPC' }, fetch: rpc.fetch, emulate: false })
      const a = await m.getAccount(0)
      const r = await a.sendTransaction({ to: EQ, value: 1_000_000n })
      expect(rpc.sent).toHaveLength(1)
      expect(r.boc).toBe(rpc.sent[0]!.toBoc().toString('base64'))
      const msg = loadMessage(Cell.fromBase64(r.boc).beginParse())
      expect(msg.body.hash().toString('hex')).toBe(r.hash)
      expect(!!msg.init).toBe(state === 'uninitialized')
      m.dispose()
    }
  })
})
