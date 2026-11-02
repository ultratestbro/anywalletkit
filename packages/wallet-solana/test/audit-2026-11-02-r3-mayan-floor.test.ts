// The reviewed minimum swap2 hands the guard (`bridgeOut.minAmountOut`) is the quote's minimum, already at the plan's
// slippage. The guard took that slippage off it a second time, so a Mayan order could pay up to 0.5 % (at the default
// 50 bps) under the minimum the user reviewed. An order's own minimum must now reach the reviewed one, less 1 bp of
// rounding only. Every recorded LI.FI Mayan order carries LI.FI's minimum itself and passes.
import { describe, expect, it } from 'vitest'
import { live, reviewedTerms, run, type Live } from './helpers/lifi-live.js'

const mayan = live.filter((q) => q.tool.startsWith('mayan'))
const reviewed = (q: Live, slippageBps = 50) => ({ destChain: q.destChain, recipient: q.recipient, ...reviewedTerms(q), slippageBps })
/** The wire with the u64 at `at` of the first instruction whose data starts with `disc` scaled by `num / den`. */
function scaled(q: Live, disc: string, at: number, num: bigint, den: bigint): string {
  const bytes = Buffer.from(q.wire, 'base64')
  const i = bytes.indexOf(Buffer.from(disc, 'hex'))
  expect(i).toBeGreaterThan(0)
  bytes.writeBigUInt64LE(bytes.readBigUInt64LE(i + at) * num / den, i + at)
  return bytes.toString('base64')
}

describe('audit 2026-11-02 r3: a Mayan order\'s minimum is held to the reviewed one without a second slippage allowance', () => {
  it('every recorded Mayan route passes at the plan\'s 50 bps and at 300 bps', async () => {
    expect(mayan).toHaveLength(10)
    for (const q of mayan) for (const bps of [50, 300]) expect([q.name, bps, await run(q, reviewed(q, bps))]).toEqual([q.name, bps, 'pass'])
  })

  it('a Swift order 0.4 % under the reviewed minimum is refused at 50 bps; 1 bp under is rounding and passes', async () => {
    const q = mayan.find((k) => k.name === 'sol-base-usdc-mayan')!
    expect(await run(q, reviewed(q), {}, scaled(q, '204c290c27a284db', 91, 9_960n, 10_000n))).toBe('bridge-min')
    expect(await run(q, reviewed(q, 300), {}, scaled(q, '204c290c27a284db', 91, 9_960n, 10_000n))).toBe('bridge-min')
    expect(await run(q, reviewed(q), {}, scaled(q, '204c290c27a284db', 91, 99_995n, 100_000n))).toBe('pass')
  })

  it('a plain MCTP bridge that delivers 0.4 % under the reviewed minimum after its fees is refused', async () => {
    const q = mayan.find((k) => k.name === 'usdc-base-usdc-mayanMCTP')!
    const { minAmountOut } = reviewedTerms(q)
    // amountInMin@40 less feeRedeem@56 and feeSolana@64 is what arrives: set feeRedeem so that lands 0.4 % (then 1 bp) under.
    const at = (under: bigint) => {
      const bytes = Buffer.from(q.wire, 'base64')
      const i = bytes.indexOf(Buffer.from('3635a7a4fa097b45', 'hex'))
      bytes.writeBigUInt64LE(bytes.readBigUInt64LE(i + 40) - bytes.readBigUInt64LE(i + 64) - (minAmountOut * (10_000n - under)) / 10_000n, i + 56)
      return bytes.toString('base64')
    }
    expect(await run(q, reviewed(q), {}, at(40n))).toBe('bridge-min')
    expect(await run(q, reviewed(q), {}, at(1n))).toBe('pass')
  })
})
