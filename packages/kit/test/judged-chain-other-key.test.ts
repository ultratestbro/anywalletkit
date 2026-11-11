import { describe, expect, it, vi } from 'vitest'
import { createMockAccount } from '@anywalletkit/conformance'
// wallet-evm is not a kit devDependency; its built dist is imported by path.
import { WalletManagerEvm } from '../../wallet-evm/dist/index.js'
import { PolicyViolationError, Wallet, applyPolicies, type Policies, type WriteIntent } from '../src/index.js'

// SDK-303 round 3: an account asked for under a key that is neither a chain id of its family nor its namespace (a
// registration key such as 'evm', 'sol', 'tonkey', 'zec', or another family's id) has its write read on its own
// chain, not on the key: `confirm` sees the account's chain id, and the chain's own reading of the write applies
// (an EVM transaction's ERC-20 recipient, a TON jetton's attached TON, a Zcash recipient that is not plain base58, a
// TRC-20 or NEP-141 transfer). Before, the key was the intent's chain, and the generic reading saw less of the write.
// These are the consumer-visible effects the changeset names as Breaking.

const outcome = (p: Promise<unknown>) => p.then(() => 'signed', (e: unknown) => (e instanceof PolicyViolationError ? e.policy : String(e)))
const seen = () => { const intents: WriteIntent[] = []; return { intents, confirm: vi.fn(async (i: WriteIntent) => { intents.push(i); return true }) } }

const SEED = 'test test test test test test test test test test test junk'
const SELF = '0x5555555555555555555555555555555555555555'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const R = '0x9999999999999999999999999999999999999999'
const pad = (h: string) => h.replace(/^0x/, '').toLowerCase().padStart(64, '0')
const ERC20_TO_R = { to: USDC, value: 0n, data: `0xa9059cbb${pad(R)}${pad('0x0f4240')}` }

describe('SDK-303 round 3: a write under a key of no chain of the account\'s family is read on the account\'s chain', () => {
  it("EVM with a known chain under 'evm': confirm sees eip155:1 and the ERC-20 recipient; the lists judge it", async () => {
    const { intents, confirm } = seen()
    expect(await outcome(applyPolicies(createMockAccount({ chain: 'eip155:1', address: SELF }), { confirm }, 'evm').sendTransaction(ERC20_TO_R))).toBe('signed')
    expect(intents[0]).toMatchObject({ chain: 'eip155:1', kind: 'send', token: USDC, amount: 1_000_000n })
    expect(intents[0]!.destinations.map((d) => d.toLowerCase())).toEqual([USDC.toLowerCase(), R])
    const guarded = (p: Policies) => applyPolicies(createMockAccount({ chain: 'eip155:1', address: SELF }), p, 'evm')
    expect(await outcome(guarded({ allowlist: { eip155: [USDC] } }).sendTransaction(ERC20_TO_R))).toBe('allowlist')
    expect(await outcome(guarded({ blocklist: { eip155: [R] } }).sendTransaction(ERC20_TO_R))).toBe('blocklist')
    expect(await outcome(guarded({ allowlist: { eip155: [USDC, R] } }).sendTransaction(ERC20_TO_R))).toBe('signed')
  })

  it("real wallet-evm, registerWallet('evm', { chainId: 1 }) + getAccount('evm'): the same reading", async () => {
    const w = new Wallet(SEED, { policies: { allowlist: { eip155: [USDC] } } })
    w.registerWallet('evm', WalletManagerEvm as never, { chainId: 1 })
    const account = (await w.getAccount('evm')) as unknown as { signTransaction(tx: unknown): Promise<unknown> }
    const tx = { ...ERC20_TO_R, chainId: 1, nonce: 0, gasLimit: 60_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, type: 2 }
    expect(await outcome(account.signTransaction(tx))).toBe('allowlist')
  })

  it("EVM with a known chain under 'evm': approve({ token: USDC, amount: 0 }) is a revoke (it skips the allowlist)", async () => {
    const { intents, confirm } = seen()
    const approve = vi.fn(async () => ({ hash: '0xh', fee: 0n }))
    const account = { ...createMockAccount({ chain: 'eip155:1', address: SELF }), approve }
    const guarded = applyPolicies(account, { allowlist: { eip155: [R] }, confirm }, 'evm') as unknown as { approve(o: unknown): Promise<unknown> }
    expect(await outcome(guarded.approve({ token: USDC, spender: '0x7777777777777777777777777777777777777777', amount: 0n }))).toBe('signed')
    expect(intents[0]).toMatchObject({ chain: 'eip155:1', kind: 'revoke', token: USDC })
    expect(approve).toHaveBeenCalledTimes(1)
  })

  it("TON under 'tonkey': a jetton transfer carries its attached TON and the jetton is a destination", async () => {
    const SELF_TON = `0:${'11'.repeat(32)}`
    const TO = `0:${'aa'.repeat(32)}`
    const JETTON = `0:${'cc'.repeat(32)}`
    const transfer = { token: JETTON, recipient: TO, amount: 5n, attachedValue: 1_000_000_000n, forwardTonAmount: 1n }
    const { intents, confirm } = seen()
    expect(await outcome(applyPolicies(createMockAccount({ chain: 'ton:-239', address: SELF_TON }), { confirm }, 'tonkey').transfer(transfer as never))).toBe('signed')
    expect(intents[0]).toMatchObject({ chain: 'ton:-239', attachedValue: 1_000_000_000n, forwardTonAmount: 1n })
    expect(intents[0]!.destinations).toEqual([TO, JETTON])
    expect(await outcome(applyPolicies(createMockAccount({ chain: 'ton:-239', address: SELF_TON }), { blocklist: { ton: [JETTON] } }, 'tonkey').transfer(transfer as never))).toBe('blocklist')
  })

  it("Zcash under 'zec': a recipient padded with U+FEFF is unknown, so a blocklist without confirm refuses it", async () => {
    const padded = 't1Rv4exT7bqhZqi2j7xz8bUHDMxwosrjADU﻿'
    const { intents, confirm } = seen()
    await applyPolicies(createMockAccount({ chain: 'zcash:mainnet', address: 't1self' }), { confirm }, 'zec').transfer({ recipient: padded, amount: 5n })
    expect(intents[0]).toMatchObject({ chain: 'zcash:mainnet', destinationUnknown: true })
    expect(await outcome(applyPolicies(createMockAccount({ chain: 'zcash:mainnet', address: 't1self' }), { blocklist: { zcash: ['t1other'] } }, 'zec').transfer({ recipient: padded, amount: 5n }))).toBe('blocklist')
  })

  it("Tron under 'trx' and NEAR under 'nearkey': a token transfer through a contract names the token and its recipient", async () => {
    const R_TRON = `41${'9'.repeat(40)}`
    const trc20 = { contractAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', functionSelector: 'transfer(address,uint256)', parameters: [{ type: 'address', value: R_TRON }, { type: 'uint256', value: 5 }] }
    const tron = seen()
    await applyPolicies(createMockAccount({ chain: 'tron:0x2b6653dc', address: 'TSelf' }), { confirm: tron.confirm }, 'trx').sendTransaction(trc20 as never)
    expect(tron.intents[0]).toMatchObject({ chain: 'tron:0x2b6653dc', token: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', amount: 5n, destinations: ['TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', R_TRON] })
    expect(tron.intents[0]!.destinationUnknown).toBeFalsy()
    const ft = { receiverId: 'usdt.tether-token.near', actions: [{ functionCall: { methodName: 'ft_transfer', args: { receiver_id: 'bob.near', amount: '5' } } }] }
    const near = seen()
    await applyPolicies(createMockAccount({ chain: 'near:mainnet', address: 'self.near' }), { confirm: near.confirm }, 'nearkey').sendTransaction(ft as never)
    expect(near.intents[0]).toMatchObject({ chain: 'near:mainnet', token: 'usdt.tether-token.near', amount: 5n, destinations: ['usdt.tether-token.near', 'bob.near'] })
    expect(near.intents[0]!.destinationUnknown).toBeFalsy()
  })
})

// What concepts/policies.md ("Which chain's rules apply") says about an exact id of another chain of the family: an
// off-chain signature asked for under an exact id of the account's family does not make the account learn its chain,
// so the rules of another exact id reach it only when the account already reports that chain. A signature over 32 raw
// bytes is valid on every chain: whether every exact eip155 rule should judge a blind hash is an open owner decision.
describe("SDK-303 round 3: an exact id of another chain and an off-chain signature asked for under an id of the family", () => {
  const D = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 0x52) & 0xff)
  const HEX = `0x${Array.from(D, (b) => b.toString(16).padStart(2, '0')).join('')}`
  const FORMS: Array<[string, string | Uint8Array]> = [['bytes', D], ['hex', HEX], ['text', 'é'.repeat(16)]]
  const T = '0x1111111111111111111111111111111111111111'
  const provider = (chainId: string) => ({ request: vi.fn(async ({ method }: { method: string }) => { if (method === 'eth_chainId') return chainId; throw new Error(`${method}: not in this test`) }) })
  type Signing = { sign(m: string | Uint8Array): Promise<string>; signTransaction(tx: unknown): Promise<unknown>; chain: string }
  const open = async (config: object) => {
    const w = new Wallet(SEED, { policies: { allowlist: { 'eip155:1': [T] } } })
    w.registerWallet('eip155', WalletManagerEvm as never, config)
    return (await w.getAccount('eip155:137')) as unknown as Signing
  }

  it("the account does not report its chain yet (RPC on mainnet, asked for as eip155:137): the eip155:1 allowlist does not reach the blind hash; a transaction is refused (chain)", async () => {
    const account = await open({ provider: provider('0x1') })
    for (const [form, m] of FORMS) expect(await outcome(account.sign(m)), form).toBe('signed')
    const tx = { to: T, value: 1n, nonce: 0, gasLimit: 21_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, type: 2 }
    expect(await outcome(account.signTransaction(tx))).toBe('chain')
  })

  it('the account reports eip155:1 (chainId 1), asked for as eip155:137: the eip155:1 allowlist judges the blind hash', async () => {
    const account = await open({ chainId: 1 })
    expect(account.chain).toBe('eip155:1')
    for (const [form, m] of FORMS) expect(await outcome(account.sign(m)), form).toBe('allowlist')
  })
})
