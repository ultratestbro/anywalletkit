import { describe, expect, it } from 'vitest'
import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { Buffer } from 'buffer'
import { Address, Cell, contractAddress, loadStateInit } from '@ton/core'
import { v5r1Address, WalletAccountReadOnlyTon } from '@anywalletkit/wallet-ton'
import { peerHost, tonProofAuthentication, tonProposalChains, tonSessionNamespace, tonSessionProperties, TON_WC_METHODS } from '../src/index.js'
import { tonAccount } from './helpers.js'

const te = new TextEncoder()
const cat = (...p: Uint8Array[]) => Uint8Array.from(p.flatMap((x) => [...x]))
const u32 = (n: number, le: boolean) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, le); return b }
const u64le = (n: number) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b }

/** @tonconnect/sdk 5.0.0 WalletConnectProvider.connect: optionalNamespaces.ton and, with ton_proof, a CAIP-122 authentication request. */
const stonfiProposal = (proof?: string, domain = 'app.ston.fi') => ({
  id: 1,
  params: {
    proposer: { metadata: { name: 'STON.fi', url: 'https://app.ston.fi', icons: [] } },
    requiredNamespaces: {},
    optionalNamespaces: { ton: { chains: ['ton:-239', 'ton:-3'], methods: ['ton_sendMessage', 'ton_signData'], events: [] } },
    ...(proof !== undefined ? { requests: { authentication: [{ domain, chains: ['ton:-239'], nonce: '', type: 'caip122', aud: 'ton_proof', version: '1', iat: '2020-01-01T00:00:00.000Z', statement: proof }] } } : {}),
  },
})

describe('session namespace', () => {
  it("approves the account's network with its user-friendly address (the dApp splits CAIP-10 on two colons)", async () => {
    const { account, manager } = await tonAccount()
    const ns = tonSessionNamespace(account, { chains: ['ton:-239', 'ton:-3'] })!
    expect(ns).toEqual({ chains: ['ton:-239'], methods: [...TON_WC_METHODS], events: [], accounts: [`ton:-239:${account.address}`] })
    expect(account.address).toMatch(/^UQ/)
    // @tonconnect/sdk: `const [, network, address] = account.split(':', 3)`
    const [, network, address] = ns.accounts[0]!.split(':', 3)
    expect(network).toBe('-239')
    expect(Address.parse(address!).toRawString()).toBe(v5r1Address(account.publicKey).toRawString())
    manager.dispose()
  })

  it('a raw address is carried as the friendly form; testnet accounts as test-only', async () => {
    const { account, manager } = await tonAccount()
    const raw = { chain: 'ton:-239', address: Address.parse(account.address).toRawString(), publicKey: account.publicKey }
    expect(tonSessionNamespace(raw)!.accounts).toEqual([`ton:-239:${account.address}`])
    const test = new WalletAccountReadOnlyTon(account.publicKey, { network: 'testnet' })
    const ns = tonSessionNamespace(test, { chains: ['ton:-3'] })!
    expect(ns.chains).toEqual(['ton:-3'])
    expect(Address.parseFriendly(ns.accounts[0]!.split(':', 3)[2]!).isTestOnly).toBe(true)
    manager.dispose()
  })

  it('leaves TON out when the proposal asks only for another network', async () => {
    const { account, manager } = await tonAccount()
    expect(tonSessionNamespace(account, { chains: ['ton:-3'] })).toBeUndefined()
    expect(tonSessionNamespace(account, { chains: [] })).toBeDefined()
    expect(tonSessionNamespace(account, { chains: ['ton'] })).toBeDefined()
    expect(() => tonSessionNamespace({ chain: 'eip155:1', address: '0x0', publicKey: new Uint8Array(32) })).toThrow(/Not a TON account/)
    manager.dispose()
  })

  it('reads the TON chains of a proposal in both namespace forms', () => {
    expect(tonProposalChains(stonfiProposal())).toEqual({ required: [], optional: ['ton:-239', 'ton:-3'] })
    expect(tonProposalChains({ requiredNamespaces: { 'ton:-3': {}, eip155: { chains: ['eip155:1'] } }, optionalNamespaces: { ton: { methods: ['ton_signData'] } } })).toEqual({ required: ['ton:-3'], optional: ['ton'] })
  })
})

describe('session properties', () => {
  it('golden: ton_getStateInit is the StateInit v5r1Address derives, ton_getPublicKey the key in hex', async () => {
    const { account, manager } = await tonAccount()
    const props = tonSessionProperties(account)
    expect(props.ton_getPublicKey).toBe(Buffer.from(account.publicKey).toString('hex'))
    expect(props.ton_getPublicKey).toMatch(/^[0-9a-f]{64}$/)
    const init = loadStateInit(Cell.fromBase64(props.ton_getStateInit).beginParse())
    expect(contractAddress(0, init).toRawString()).toBe(v5r1Address(account.publicKey).toRawString())
    expect(contractAddress(0, init).toString({ bounceable: false })).toBe(account.address)
    // a read-only account (public key only) gives the same properties: no key read at connect
    expect(tonSessionProperties(new WalletAccountReadOnlyTon(account.publicKey))).toEqual(props)
    manager.dispose()
  })

  it('testnet: the StateInit carries the testnet wallet id and derives the testnet address', async () => {
    const { account, manager } = await tonAccount()
    const test = new WalletAccountReadOnlyTon(account.publicKey, { network: 'testnet' })
    const props = tonSessionProperties(test)
    const init = loadStateInit(Cell.fromBase64(props.ton_getStateInit).beginParse())
    expect(contractAddress(0, init).toRawString()).toBe(Address.parse(test.address).toRawString())
    expect(props.ton_getStateInit).not.toBe(tonSessionProperties(account).ton_getStateInit)
    manager.dispose()
  })

  it('refuses an address that is not the default V5R1 wallet of the key', async () => {
    const { account, manager } = await tonAccount()
    const other = new WalletAccountReadOnlyTon(account.publicKey, { walletId: { subwalletNumber: 1 } })
    expect(() => tonSessionProperties(other)).toThrow(/standard V5R1/)
    expect(() => tonSessionProperties({ ...account, chain: 'ton:-239', address: account.address, publicKey: new Uint8Array(31) })).toThrow(/32-byte/)
    manager.dispose()
  })
})

describe('ton_proof at connect', () => {
  it('signs the proof for the peer domain (not the domain written in the request) with the wallet clock', async () => {
    const { account, manager } = await tonAccount()
    const ts = 1_760_000_000
    const auth = await tonProofAuthentication(account, stonfiProposal('nonce-123', 'evil.example'), { now: () => ts })
    expect(auth).toHaveLength(1)
    const c = auth![0]!
    expect(c.p).toMatchObject({ domain: 'app.ston.fi', aud: 'ton_proof', statement: 'nonce-123', iat: new Date(ts * 1000).toISOString() })
    // what @tonconnect/sdk buildTonProof reads back
    expect(Math.floor(new Date(c.p.iat).getTime() / 1000)).toBe(ts)
    // golden: the ton_proof digest built by hand (docs.ton.org ton-connect/sign)
    const a = Address.parse(account.address)
    const domain = te.encode('app.ston.fi')
    const inner = cat(te.encode('ton-proof-item-v2/'), new Uint8Array(4), a.hash, u32(domain.length, true), domain, u64le(ts), te.encode('nonce-123'))
    const digest = sha256(cat(new Uint8Array([0xff, 0xff]), te.encode('ton-connect'), sha256(inner)))
    expect(ed25519.verify(new Uint8Array(Buffer.from(c.s.s, 'base64')), digest, account.publicKey)).toBe(true)
    manager.dispose()
  })

  it('no proof asked → nothing signed; peerDomain overrides the metadata; unknown domain refused', async () => {
    const { account, manager } = await tonAccount()
    expect(await tonProofAuthentication(account, stonfiProposal())).toBeUndefined()
    const auth = await tonProofAuthentication(account, stonfiProposal('p'), { peerDomain: 'verified.example' })
    expect(auth![0]!.p.domain).toBe('verified.example')
    const noUrl = { params: { proposer: { metadata: { name: 'x' } }, requests: { authentication: [{ aud: 'ton_proof', statement: 'p' }] } } }
    await expect(tonProofAuthentication(account, noUrl)).rejects.toMatchObject({ code: 1 })
    manager.dispose()
  })

  it('a read-only account signs through withSigner only after it is asked, and only as itself', async () => {
    const { account, manager } = await tonAccount()
    const ro = account.toReadOnlyAccount() as WalletAccountReadOnlyTon
    await expect(tonProofAuthentication(ro, stonfiProposal('p'))).rejects.toThrow(/cannot sign/)
    let opened = 0
    const auth = await tonProofAuthentication(ro, stonfiProposal('p'), { withSigner: async (run) => { opened++; return run(account) } })
    expect(opened).toBe(1)
    expect(auth![0]!.s.s).toMatch(/^[A-Za-z0-9+/]+=*$/)
    const { account: other, manager: m2 } = await tonAccount({}, 1)
    await expect(tonProofAuthentication(ro, stonfiProposal('p'), { withSigner: (run) => run(other) })).rejects.toThrow(/not the account/)
    manager.dispose(); m2.dispose()
  })
})

describe('peerHost', () => {
  it('host of http(s) URLs only, lowercase, no port or credentials', () => {
    expect(peerHost('https://app.ston.fi')).toBe('app.ston.fi')
    expect(peerHost('https://App.Ston.FI:8443/swap?x=1')).toBe('app.ston.fi')
    expect(peerHost('https://user:pw@app.example/x')).toBe('app.example')
    expect(peerHost('http://localhost:3000')).toBe('localhost')
    expect(peerHost('javascript:alert(1)')).toBeUndefined()
    expect(peerHost('ftp://x.example')).toBeUndefined()
    expect(peerHost(undefined)).toBeUndefined()
  })
})
