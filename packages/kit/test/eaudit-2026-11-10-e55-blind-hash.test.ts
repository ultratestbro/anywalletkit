import { describe, expect, it, vi } from 'vitest'
import { createMockAccount } from '@anywalletkit/conformance'
// wallet-evm is not a kit devDependency; its built dist is imported by path (offline: no provider, chainId fixed).
import { WalletManagerEvm } from '../../wallet-evm/dist/index.js'
import { PolicyViolationError, Wallet, applyPolicies, type Policies, type WriteIntent } from '../src/index.js'

// Extension audit E55 (2026-11-10): CoW Protocol's `ethsign` scheme accepts personal_sign over the 32-byte EIP-712
// order digest ("\x19Ethereum Signed Message:\n32" || digest), and so do other verifiers of eth_sign-wrapped hashes
// (Safe owner signatures with v > 30…). A `sign` of exactly 32 bytes was `message: true` ("moves nothing"), so an
// allowlist or blocklist never looked at it. Now it is an opaque hash signature with unknown destinations.

const SEED = 'test test test test test test test test test test test junk'
const CHAIN = 'eip155:1'
const TREASURY = '0x1111111111111111111111111111111111111111'

// A real CoW order digest: GPv2Settlement domain on mainnet (name "Gnosis Protocol", version "v2", chainId 1,
// verifyingContract 0x9008D19f58AAbD9eD0D60971565AA8510560ab41 — domain separator 0xc078f884…8943) and the GPv2Order
// below, sell 1000 USDC for 1 wei of WETH to receiver 0x…bEEF (computed with viem hashTypedData).
const COW_ORDER = {
  sellToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', buyToken: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  receiver: '0x000000000000000000000000000000000000bEEF', sellAmount: 1_000_000_000n, buyAmount: 1n, validTo: 1_900_000_000,
  appData: `0x${'00'.repeat(32)}`, feeAmount: 0n, kind: 'sell', partiallyFillable: false, sellTokenBalance: 'erc20', buyTokenBalance: 'erc20',
}
const COW_DIGEST = '0x52eae78642b0ca3226e8a77062bebe97d7e69c10b2c882118503357d84e4e66f'
const bytes = (hex: string) => Uint8Array.from(hex.slice(2).match(/../g)!, (b) => Number.parseInt(b, 16))
void COW_ORDER

const mock = () => createMockAccount({ chain: CHAIN, address: '0x5555555555555555555555555555555555555555' })
const seen = () => { const intents: WriteIntent[] = []; return { intents, confirm: vi.fn(async (i: WriteIntent) => { intents.push(i); return true }) } }

describe('E55: a sign() of a 32-byte hash is an opaque signature that may move value', () => {
  it('confirm sees it as unreadable (kind typedData, blindHash, destinations unknown), raw bytes and 0x-hex alike', async () => {
    const { intents, confirm } = seen()
    const g = applyPolicies(mock(), { confirm })
    await g.sign(bytes(COW_DIGEST))
    await g.sign(COW_DIGEST)
    for (const i of intents) expect(i).toMatchObject({ method: 'sign', kind: 'typedData', message: false, blindHash: true, destinations: [], destinationUnknown: true })
  })

  it('an allowlist refuses it, a blocklist without confirm refuses it; plain text and 33 bytes are still messages', async () => {
    const allow = applyPolicies(mock(), { allowlist: { [CHAIN]: [TREASURY] } })
    await expect(allow.sign(bytes(COW_DIGEST))).rejects.toThrow(PolicyViolationError)
    await expect(allow.sign(COW_DIGEST)).rejects.toThrow(/allowlist/)
    expect(await allow.sign('Sign in to example.com')).toMatch(/^0x/)
    expect(await allow.sign(bytes(`${COW_DIGEST}00`))).toMatch(/^0x/)
    await expect(applyPolicies(mock(), { blocklist: { [CHAIN]: [TREASURY] } }).sign(bytes(COW_DIGEST))).rejects.toThrow(/blocklist/)
    const { intents, confirm } = seen()
    await applyPolicies(mock(), { confirm }).sign('hello')
    expect(intents[0]).toMatchObject({ kind: 'message', message: true })
  })

  it('real wallet-evm (offline): the CoW digest is refused under an allowlist', async () => {
    const policies: Policies = { allowlist: { [CHAIN]: [TREASURY] } }
    const w = new Wallet(SEED, { policies })
    w.registerWallet(CHAIN, WalletManagerEvm as never, { chainId: 1 })
    const acc = (await w.getAccount(CHAIN)) as unknown as { sign(m: string | Uint8Array): Promise<string> }
    await expect(acc.sign(bytes(COW_DIGEST))).rejects.toThrow(/allowlist/)
    expect(await acc.sign('hello')).toMatch(/^0x[0-9a-f]{130}$/i)
  })
})
