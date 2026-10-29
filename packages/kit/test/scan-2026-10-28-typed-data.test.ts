import { describe, expect, it, vi } from 'vitest'
import { createMockAccount } from '@anywalletkit/conformance'
// wallet-evm is not a kit devDependency; its built dist is imported by path (offline: no provider, chainId fixed).
import { WalletManagerEvm } from '../../wallet-evm/dist/index.js'
import { PolicyViolationError, Wallet, applyPolicies, type Policies, type WriteIntent } from '../src/index.js'

// Scan 2026-10-28 F7: typed data other than Permit / Permit2 was `message: true` with no destinations, so the
// allow/block lists never looked at it. An EIP-3009 TransferWithAuthorization to an attacker came back signed
// under an allowlist that refused the same transfer as a send. Now EIP-3009, ERC-2771 ForwardRequest,
// MetaTransaction and the 1inch LOP Order are sends with their destinations; anything else unread has unknown
// destinations (refused by an allowlist, and by a blocklist without confirm); the verifying contract is checked
// against the blocklist.

const SEED = 'test test test test test test test test test test test junk'
const CHAIN = 'eip155:8453'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const TREASURY = '0x1111111111111111111111111111111111111111'
const ATTACKER = '0xa77ac3e5a77ac3e5a77ac3e5a77ac3e5a77ac3e5'
const SPENDER = '0x2222222222222222222222222222222222222222'
const LOP = '0x111111125421cA6dc452d289314280a0f8842A65'
const RESOLVER = '0x3333333333333333333333333333333333333333'
const FORWARDER = '0x4444444444444444444444444444444444444444'
const DOMAIN_TYPE = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }]

const word = (a: string) => a.slice(2).toLowerCase().padStart(64, '0')
const erc20TransferData = (to: string, amount: bigint) => `0xa9059cbb${word(to)}${amount.toString(16).padStart(64, '0')}`

function twa(from: string, to = ATTACKER, primaryType = 'TransferWithAuthorization') {
  return {
    domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC },
    primaryType,
    types: {
      EIP712Domain: DOMAIN_TYPE,
      [primaryType]: [
        { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
      ],
    },
    message: { from, to, value: 1_000_000_000_000n, validAfter: 0n, validBefore: 9_999_999_999n, nonce: `0x${'ab'.repeat(32)}` },
  }
}

async function evmAccount(policies: Policies) {
  const w = new Wallet(SEED, { policies })
  w.registerWallet(CHAIN, WalletManagerEvm as never, { chainId: 8453 })
  return (await w.getAccount(CHAIN)) as unknown as { getAddress(): Promise<string>; signTypedData(t: unknown): Promise<string>; signPermit(o: unknown): Promise<unknown>; transfer(o: unknown): Promise<unknown> }
}

const mock = () => Object.assign(createMockAccount({ chain: CHAIN, address: '0x5555555555555555555555555555555555555555' }), { signTypedData: async (_t: unknown) => '0xtyped' })
const seen = () => { const intents: WriteIntent[] = []; return { intents, confirm: vi.fn(async (i: WriteIntent) => { intents.push(i); return true }) } }

describe('F7: EIP-3009 transfer authorisations are judged like transfers (real wallet-evm, offline)', () => {
  it('allowlist {TREASURY}: a TransferWithAuthorization to ATTACKER is refused, as the transfer is', async () => {
    const acc = await evmAccount({ allowlist: { [CHAIN]: [TREASURY] } })
    const from = await acc.getAddress()
    await expect(acc.transfer({ recipient: ATTACKER, amount: 1n })).rejects.toThrow(/allowlist/)
    await expect(acc.signTypedData(twa(from))).rejects.toThrow(PolicyViolationError)
    await expect(acc.signTypedData(twa(from))).rejects.toThrow(/allowlist/)
    await expect(acc.signTypedData(twa(from, ATTACKER, 'ReceiveWithAuthorization'))).rejects.toThrow(/allowlist/)
    expect(await acc.signTypedData(twa(from, TREASURY))).toMatch(/^0x[0-9a-f]{130}$/i)
  })

  it('blocklist {ATTACKER}, no confirm: refused', async () => {
    const acc = await evmAccount({ blocklist: { [CHAIN]: [ATTACKER] } })
    await expect(acc.signTypedData(twa(await acc.getAddress()))).rejects.toThrow(/blocklist/)
  })

  it('confirm sees the recipient, the token and the amount', async () => {
    const { intents, confirm } = seen()
    const acc = await evmAccount({ blocklist: { [CHAIN]: [SPENDER] }, confirm })
    await acc.signTypedData(twa(await acc.getAddress()))
    expect(intents[0]).toMatchObject({ method: 'signTypedData', kind: 'send', message: false, to: ATTACKER, destinations: [ATTACKER], destinationUnknown: false, token: USDC, amount: 1_000_000_000_000n, verifyingContract: USDC })
  })

  it('wallet-evm signPermit still passes an allowlist that holds the spender', async () => {
    const acc = await evmAccount({ allowlist: { [CHAIN]: [SPENDER] } })
    // Offline: getPermitInfo needs the token's RPC, so the call fails after the policies, not in them.
    await expect(acc.signPermit({ token: USDC, spender: SPENDER, value: 1n, deadline: 1n })).rejects.not.toThrow(PolicyViolationError)
  })
})

describe('F7: other typed data that moves value', () => {
  it('ERC-2771 ForwardRequest: the call it makes, and whom its calldata pays', async () => {
    const req = (to: string, data: string) => ({
      domain: { name: 'Forwarder', version: '1', chainId: 8453, verifyingContract: FORWARDER },
      primaryType: 'ForwardRequest',
      types: { ForwardRequest: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'gas', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint48' }, { name: 'data', type: 'bytes' }] },
      message: { from: '0x5555555555555555555555555555555555555555', to, value: 0, gas: 100000, nonce: 0, deadline: 9999999999, data },
    })
    const g = applyPolicies(mock(), { allowlist: { [CHAIN]: [USDC, TREASURY] } })
    await expect(g.signTypedData(req(USDC, erc20TransferData(ATTACKER, 5n)))).rejects.toThrow(/Destination 0xa77a.* is not on the/)
    expect(await g.signTypedData(req(USDC, erc20TransferData(TREASURY, 5n)))).toBe('0xtyped')
    const { intents, confirm } = seen()
    await applyPolicies(mock(), { confirm }).signTypedData(req(USDC, erc20TransferData(ATTACKER, 5n)))
    expect(intents[0]).toMatchObject({ kind: 'send', to: USDC, token: USDC, amount: 5n, destinationUnknown: false })
    expect(intents[0]!.destinations.map((d) => d.toLowerCase())).toEqual([USDC.toLowerCase(), ATTACKER])
  })

  it('MetaTransaction: the verifying contract runs functionSignature', async () => {
    const meta = {
      domain: { name: 'Token', version: '1', verifyingContract: USDC, salt: `0x${'00'.repeat(31)}89` },
      primaryType: 'MetaTransaction',
      types: { MetaTransaction: [{ name: 'nonce', type: 'uint256' }, { name: 'from', type: 'address' }, { name: 'functionSignature', type: 'bytes' }] },
      message: { nonce: 0, from: '0x5555555555555555555555555555555555555555', functionSignature: erc20TransferData(ATTACKER, 7n) },
    }
    await expect(applyPolicies(mock(), { allowlist: { [CHAIN]: [USDC, TREASURY] } }).signTypedData(meta)).rejects.toThrow(/allowlist/)
    await expect(applyPolicies(mock(), { blocklist: { [CHAIN]: [ATTACKER] } }).signTypedData(meta)).rejects.toThrow(/blocklist/)
  })

  it('the Omniston / 1inch LOP Order: the settlement contract and a receiver other than the maker', async () => {
    const maker = '0x5555555555555555555555555555555555555555'
    const order = (receiver: string) => ({
      domain: { name: '1inch Limit Order Protocol', version: '4', chainId: 8453, verifyingContract: LOP },
      primaryType: 'Order',
      types: { Order: [['salt', 'uint256'], ['maker', 'address'], ['receiver', 'address'], ['makerAsset', 'address'], ['takerAsset', 'address'], ['makingAmount', 'uint256'], ['takingAmount', 'uint256'], ['makerTraits', 'uint256']].map(([name, type]) => ({ name, type })) },
      message: { salt: '1', maker, receiver, makerAsset: USDC, takerAsset: TREASURY, makingAmount: '1000000', takingAmount: '999', makerTraits: '0' },
    })
    const { intents, confirm } = seen()
    expect(await applyPolicies(mock(), { allowlist: { [CHAIN]: [LOP, RESOLVER] }, blocklist: { [CHAIN]: [ATTACKER] }, confirm }).signTypedData(order(RESOLVER))).toBe('0xtyped')
    expect(intents[0]).toMatchObject({ kind: 'send', to: LOP, destinations: [LOP, RESOLVER], destinationUnknown: false, token: USDC, amount: 1_000_000n })
    expect(await applyPolicies(mock(), { allowlist: { [CHAIN]: [LOP] } }).signTypedData(order('0x0000000000000000000000000000000000000000'))).toBe('0xtyped')
    expect(await applyPolicies(mock(), { blocklist: { [CHAIN]: [ATTACKER] } }).signTypedData(order(RESOLVER))).toBe('0xtyped')
    await expect(applyPolicies(mock(), { blocklist: { [CHAIN]: [ATTACKER] } }).signTypedData(order(ATTACKER))).rejects.toThrow(/blocklist/)
    await expect(applyPolicies(mock(), { allowlist: { [CHAIN]: [LOP] } }).signTypedData(order(ATTACKER))).rejects.toThrow(/allowlist/)
  })
})

describe('F7: typed data the policies cannot read', () => {
  const vote = { domain: { name: 'snapshot', version: '0.1.4', verifyingContract: TREASURY }, primaryType: 'Vote', types: { Vote: [{ name: 'proposal', type: 'string' }, { name: 'choice', type: 'uint32' }] }, message: { proposal: 'p', choice: 1 } }
  it('is refused under an allowlist and under a blocklist without confirm', async () => {
    await expect(applyPolicies(mock(), { allowlist: { [CHAIN]: [TREASURY] } }).signTypedData(vote)).rejects.toThrow(/allowlist/)
    await expect(applyPolicies(mock(), { blocklist: { [CHAIN]: [ATTACKER] } }).signTypedData(vote)).rejects.toThrow(/Cannot tell every destination/)
  })
  it('goes to confirm with destinationUnknown under a blocklist with confirm, and is signed with no lists', async () => {
    const { intents, confirm } = seen()
    expect(await applyPolicies(mock(), { blocklist: { [CHAIN]: [ATTACKER] }, confirm }).signTypedData(vote)).toBe('0xtyped')
    expect(intents[0]).toMatchObject({ kind: 'typedData', message: false, to: TREASURY, destinations: [], destinationUnknown: true })
    expect(await applyPolicies(mock(), {}).signTypedData(vote)).toBe('0xtyped')
  })
  it('a blocklisted verifying contract is refused, for a permit too', async () => {
    await expect(applyPolicies(mock(), { blocklist: { [CHAIN]: [TREASURY] }, confirm: async () => true }).signTypedData(vote)).rejects.toThrow(/Verifying contract .* blocklist/)
    const permit = { domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC }, primaryType: 'Permit', types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] }, message: { owner: TREASURY, spender: SPENDER, value: '5', nonce: 0, deadline: '1800000000' } }
    expect(await applyPolicies(mock(), { allowlist: { [CHAIN]: [SPENDER] } }).signTypedData(permit)).toBe('0xtyped')
    await expect(applyPolicies(mock(), { blocklist: { [CHAIN]: [USDC] } }).signTypedData(permit)).rejects.toThrow(/Verifying contract .* blocklist/)
  })
  it('plain messages (SIWE) are untouched by the lists', async () => {
    const acc = Object.assign(mock(), { sign: async () => '0xsig' })
    expect(await applyPolicies(acc, { allowlist: { [CHAIN]: [TREASURY] }, blocklist: { [CHAIN]: [ATTACKER] } }).sign('example.org wants you to sign in with your Ethereum account')).toBe('0xsig')
  })
})
