import { describe, expect, it } from 'vitest'
import { sha256 } from '@noble/hashes/sha2.js'
import { WalletManagerTon } from '@anywalletkit/wallet-ton'
import { ReviewDeclined, TONCONNECT_ERRORS, TonConnectError, parseConnectRequest, parseRawAddress, parseSendTransaction, parseSignData, proofDomain, tonConnectErrorCode, tonProofMessage, tonSignDataMessage } from '../src/index.js'

const RAW = '0:' + 'ab'.repeat(32)
const code = (fn: () => unknown) => { try { fn(); return 'ok' } catch (e) { return e instanceof TonConnectError ? e.code : `other:${String(e)}` } }

describe('TON Connect protocol mapping', () => {
  it('parses ConnectRequest items and refuses what it does not know', () => {
    expect(parseConnectRequest({ manifestUrl: 'https://app.example/tonconnect-manifest.json', items: [{ name: 'ton_addr' }] })).toEqual({ manifestUrl: 'https://app.example/tonconnect-manifest.json' })
    expect(parseConnectRequest({ manifestUrl: 'https://a.example/m.json', items: [{ name: 'ton_addr' }, { name: 'ton_proof', payload: 'nonce-1' }] })).toEqual({ manifestUrl: 'https://a.example/m.json', proofPayload: 'nonce-1' })
    expect(code(() => parseConnectRequest({ manifestUrl: 'http://a.example/m.json', items: [{ name: 'ton_addr' }] }))).toBe(TONCONNECT_ERRORS.badRequest)
    expect(code(() => parseConnectRequest({ manifestUrl: 'https://a.example/m.json', items: [] }))).toBe(TONCONNECT_ERRORS.badRequest)
    expect(code(() => parseConnectRequest({ manifestUrl: 'https://a.example/m.json', items: [{ name: 'ton_addr' }, { name: 'ton_proof' }] }))).toBe(TONCONNECT_ERRORS.badRequest)
    expect(code(() => parseConnectRequest({ manifestUrl: 'https://a.example/m.json', items: [{ name: 'ton_addr' }, { name: 'ton_pubkey' }] }))).toBe(TONCONNECT_ERRORS.badRequest)
  })

  it('parses sendTransaction (JSON string or object), caps messages, checks network and expiry', () => {
    const req = parseSendTransaction(JSON.stringify({ valid_until: Math.floor(Date.now() / 1000) + 300, network: '-239', messages: [{ address: 'EQC…', amount: '1000000000', payload: 'te6cc' }, { address: '0:' + '00'.repeat(32), amount: '1' }] }))
    expect(req.messages).toEqual([{ address: 'EQC…', amount: '1000000000', payload: 'te6cc' }, { address: '0:' + '00'.repeat(32), amount: '1' }])
    expect(req.network).toBe('-239')
    expect(code(() => parseSendTransaction('{nope'))).toBe(TONCONNECT_ERRORS.badRequest)
    expect(code(() => parseSendTransaction({ messages: [] }))).toBe(TONCONNECT_ERRORS.badRequest)
    expect(code(() => parseSendTransaction({ network: '-3', messages: [{ address: 'x', amount: '1' }] }))).toBe(TONCONNECT_ERRORS.badRequest)
    expect(code(() => parseSendTransaction({ messages: [{ address: 'x', amount: '1.5' }] }))).toBe(TONCONNECT_ERRORS.badRequest)
    expect(code(() => parseSendTransaction({ messages: Array.from({ length: 5 }, () => ({ address: 'x', amount: '1' })) }))).toBe(TONCONNECT_ERRORS.badRequest)
    expect(code(() => parseSendTransaction({ valid_until: 1, messages: [{ address: 'x', amount: '1' }] }))).toBe(TONCONNECT_ERRORS.badRequest)
  })

  it('parses signData text/binary and refuses cell by name (400)', () => {
    expect(parseSignData(JSON.stringify({ type: 'text', text: 'hello' }))).toEqual({ type: 'text', text: 'hello' })
    expect(parseSignData({ type: 'binary', bytes: 'AQID' })).toEqual({ type: 'binary', bytes: 'AQID' })
    expect(code(() => parseSignData({ type: 'cell', schema: 'x', cell: 'te6' }))).toBe(TONCONNECT_ERRORS.methodNotSupported)
    expect(code(() => parseSignData({ type: 'text' }))).toBe(TONCONNECT_ERRORS.badRequest)
  })

  it('ton_proof and signData messages follow the spec byte layout', () => {
    const address = parseRawAddress(RAW)
    expect(address.workchain).toBe(0)
    expect(address.hash).toHaveLength(32)
    const msg = tonProofMessage({ address, domain: 'app.example', timestamp: 1_700_000_000, payload: 'nonce' })
    // recompute by hand
    const te = new TextEncoder()
    const inner = new Uint8Array([...te.encode('ton-proof-item-v2/'), 0, 0, 0, 0, ...address.hash, 11, 0, 0, 0, ...te.encode('app.example'), ...new Uint8Array(new BigUint64Array([1_700_000_000n]).buffer), ...te.encode('nonce')])
    const expected = sha256(new Uint8Array([0xff, 0xff, ...te.encode('ton-connect'), ...sha256(inner)]))
    expect(Array.from(msg)).toEqual(Array.from(expected))
    expect(msg).toHaveLength(32)
    const sd = tonSignDataMessage({ address, domain: 'app.example', timestamp: 1_700_000_000, payload: { type: 'text', text: 'hi' } })
    const inner2 = new Uint8Array([0xff, 0xff, ...te.encode('ton-connect/sign-data/'), 0, 0, 0, 0, ...address.hash, 0, 0, 0, 11, ...te.encode('app.example'), 0, 0, 0, 0, 0x65, 0x53, 0xf1, 0x00, ...te.encode('txt'), 0, 0, 0, 2, ...te.encode('hi')])
    expect(Array.from(sd)).toEqual(Array.from(sha256(inner2)))
    expect(code(() => parseRawAddress('EQCfriendly'))).toBe(TONCONNECT_ERRORS.unknown)
    expect(proofDomain('https://app.example:8443/path')).toBe('app.example:8443')
  })

  it('a wallet-ton account signs exactly these digests with signTonProof / signTonConnectData (audit round 3, H1)', async () => {
    const m = new WalletManagerTon('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about')
    const a = await m.getAccount(0)
    const hex = (b64: string) => Array.from(atob(b64), (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
    const text = await a.signTonConnectData({ domain: 'app.example', timestamp: 1_700_000_000, payload: { type: 'text', text: 'hi' } })
    const address = parseRawAddress(text.address)
    expect(await a.verify(tonSignDataMessage({ address, domain: 'app.example', timestamp: 1_700_000_000, payload: { type: 'text', text: 'hi' } }), hex(text.signature))).toBe(true)
    const bin = await a.signTonConnectData({ domain: 'app.example', timestamp: 1_700_000_000, payload: { type: 'binary', bytes: 'AQID' } })
    expect(await a.verify(tonSignDataMessage({ address, domain: 'app.example', timestamp: 1_700_000_000, payload: { type: 'binary', bytes: 'AQID' } }), hex(bin.signature))).toBe(true)
    const digest = tonProofMessage({ address, domain: 'app.example', timestamp: 1_700_000_000, payload: 'nonce' })
    const proof = await a.signTonProof({ domain: 'app.example', timestamp: 1_700_000_000, payload: 'nonce' })
    expect(await a.verify(digest, hex(proof.signature))).toBe(true)
    // the digest itself is refused by sign(): 32 raw bytes could be a transfer's cell hash
    await expect(a.sign(digest)).rejects.toMatchObject({ name: 'MessageIsTransactionError' })
    m.dispose()
  })

  it('maps relay errors to TON Connect codes', () => {
    expect(tonConnectErrorCode(new ReviewDeclined())).toBe(300)
    expect(tonConnectErrorCode({ code: 4100 })).toBe(100)
    expect(tonConnectErrorCode({ code: 4200 })).toBe(400)
    expect(tonConnectErrorCode({ code: -32602 })).toBe(1)
    expect(tonConnectErrorCode(new Error('x'))).toBe(0)
    expect(tonConnectErrorCode(new TonConnectError(2, 'm'))).toBe(2)
  })
})
