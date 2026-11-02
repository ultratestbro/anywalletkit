// A plain MCTP / Fast MCTP bridge names no output token: it delivers Circle's native USDC on the destination. The guard
// checked only that the reviewed token had 6 decimals, so a review of any other 6-decimal token (USDbC on Base, USDC.e
// on Arbitrum, USDT) let a USDC bridge stand in for it. The reviewed token must now be the destination chain's native
// USDC, the same address protocol-swap2-cctp burns and mints; a chain without one (BSC) has no plain bridge.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { bridgeOutRefusal, type RunInstruction } from '../src/serialized.js'

const WALLET = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'
const STATE = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo'
const MCTP = 'dkpZqrxHFrhziEMQ931GLtfy11nFkCsfMftH9u6QwBU'
const FAST_MCTP = 'Gx9rivpS3YR8pBFwMuP6omYqVxunpLvLkNn7ubNyuZZ5'
const RECIPIENT = '0x3333333333333333333333333333333333333333'
// swap-sdk 15.3.0 evmChainIdMap / getCCTPDomain, for the chains with a CCTP domain.
const IDS: Record<number, { wh: number; domain: number }> = {
  1: { wh: 2, domain: 0 }, 137: { wh: 5, domain: 7 }, 43114: { wh: 6, domain: 1 }, 42161: { wh: 23, domain: 3 }, 10: { wh: 24, domain: 2 }, 8453: { wh: 30, domain: 6 },
  130: { wh: 44, domain: 10 }, 59144: { wh: 38, domain: 11 }, 146: { wh: 52, domain: 13 }, 999: { wh: 47, domain: 19 }, 143: { wh: 48, domain: 15 },
}
const CCTP_USDC: Record<number, string> = Object.fromEntries([...readFileSync(new URL('../../protocol-swap2-cctp/src/config.ts', import.meta.url), 'utf8')
  .matchAll(/d\((\d+), \d+, "[^"]+", "(0x[0-9a-fA-F]{40})"\)/g)].map((m) => [Number(m[1]), m[2]!]))

function plain(program: string, chain: number): RunInstruction {
  const fast = program === FAST_MCTP
  const d = new Uint8Array(fast ? 124 : 107); const v = new DataView(d.buffer)
  d.set(Buffer.from(fast ? 'a766806a7976ba4c' : '3635a7a4fa097b45', 'hex'), 0)
  d.set(Buffer.from('00'.repeat(12) + RECIPIENT.slice(2), 'hex'), 8)
  v.setBigUint64(40, 9_000_000n, true)
  if (fast) v.setUint32(72, chain, true); else v.setUint16(72, chain, true)
  return { program, accounts: [WALLET, STATE, STATE, STATE], data: d }
}
const ctx = { wallet: WALLET, tokenAccountOwner: () => undefined, maxLamportsOut: 1_000_000_000n }
const run = (evm: number, ix: RunInstruction, destToken: string | undefined) =>
  bridgeOutRefusal([ix], [{ type: 'program-call' } as never], { destChain: `eip155:${evm}`, recipient: RECIPIENT, ...(destToken ? { destToken } : {}), minAmountOut: 8_955_000n, destDecimals: 6 }, ctx)?.code

describe('audit 2026-11-02 r3: a plain MCTP / Fast MCTP bridge is held to the destination chain\'s native USDC', () => {
  it('every CCTP chain the guard maps: Circle\'s USDC passes, in any letter case; another 6-decimal token or none is refused', () => {
    for (const evm of Object.keys(IDS)) expect(CCTP_USDC[Number(evm)]).toMatch(/^0x[0-9a-fA-F]{40}$/)
    for (const [evm, { wh, domain }] of Object.entries(IDS).map(([k, v]) => [Number(k), v] as const)) {
      const usdc = CCTP_USDC[evm]!
      expect([evm, run(evm, plain(MCTP, wh), usdc), run(evm, plain(FAST_MCTP, domain), usdc.toLowerCase())]).toEqual([evm, undefined, undefined])
      const other = `0x${'d9'.repeat(20)}`
      expect([evm, run(evm, plain(MCTP, wh), other), run(evm, plain(FAST_MCTP, domain), other), run(evm, plain(MCTP, wh), undefined)]).toEqual([evm, 'bridge-token', 'bridge-token', 'bridge-token'])
    }
  })

  it('the reported case: a reviewed USDbC (Base) or USDC.e (Arbitrum) does not accept a native-USDC bridge', () => {
    expect(run(8453, plain(MCTP, 30), '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA')).toBe('bridge-token')
    expect(run(42161, plain(FAST_MCTP, 3), '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8')).toBe('bridge-token')
    // BSC has no CCTP domain and no native USDC: no plain bridge delivers there.
    expect(run(56, plain(MCTP, 4), `0x${'55'.repeat(20)}`)).toBe('bridge-token')
  })
})
