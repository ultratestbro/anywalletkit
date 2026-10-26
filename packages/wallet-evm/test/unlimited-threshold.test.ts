import { describe, expect, it } from 'vitest'
import { encodeFunctionData, maxUint256 } from 'viem'
import { ERC20_ABI, describeTransaction, isUnlimitedAmount } from '../src/index.js'

// Audit 2026-10-25 round 3 (M6 / L13 follow-up): "unlimited" was maxUint256 or ≥ 2^255, so an
// approve(EVIL, 2^255 − 1) — or Permit2's uint160 max — described as a bounded approval. The SDK-wide
// threshold is type(uint128).max (core's UNLIMITED_ALLOWANCE).
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const EVIL = '0x000000000000000000000000000000000000bEEF'

describe('wallet-evm unlimited threshold', () => {
  it('2^128 − 1 and above are unlimited, below is not', () => {
    for (const a of [maxUint256, 2n ** 255n, 2n ** 255n - 1n, 2n ** 160n - 1n, 2n ** 128n - 1n]) expect(isUnlimitedAmount(a), String(a)).toBe(true)
    for (const a of [2n ** 128n - 2n, 10n ** 30n, 0n]) expect(isUnlimitedAmount(a), String(a)).toBe(false)
  })
  it('approve(EVIL, 2^255 − 1) is described as an unlimited approval', () => {
    const d = describeTransaction({ to: USDC, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [EVIL, 2n ** 255n - 1n] }) })
    expect(d.warnings.map((w) => w.code)).toContain('approve-unlimited')
  })
})
