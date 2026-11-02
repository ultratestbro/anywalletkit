// The live LI.FI fixtures prove the Mayan destination ids for Ethereum, BSC, Arbitrum and Base only; a wrong id for any
// other chain the guard maps would refuse that corridor at signing time, after the quote was shown. Every mapped
// chain is pinned here to Mayan's own tables (swap-sdk 15.3.0 `evmChainIdMap` for the Wormhole ids Swift and MCTP
// orders carry, `getCCTPDomain` for the CCTP domains of Fast MCTP), with the neighbouring ids refused.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { bridgeOutRefusal, type RunInstruction } from '../src/serialized.js'

const WALLET = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'
const STATE = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo'
const SWIFT_V2 = 'mayan34VedncxdK2XobtvWFDXQASUTBXhUVzt2kKgny'
const MCTP = 'dkpZqrxHFrhziEMQ931GLtfy11nFkCsfMftH9u6QwBU'
const FAST_MCTP = 'Gx9rivpS3YR8pBFwMuP6omYqVxunpLvLkNn7ubNyuZZ5'
const RECIPIENT = '0x3333333333333333333333333333333333333333'

// swap-sdk 15.3.0 (npm @mayanfinance/swap-sdk): evmChainIdMap (EVM chain id → Wormhole id) and getCCTPDomain.
const WORMHOLE: Record<number, number> = { 1: 2, 56: 4, 137: 5, 43114: 6, 42161: 23, 10: 24, 8453: 30, 130: 44, 59144: 38, 146: 52, 999: 47, 143: 48 }
const CCTP: Record<number, number> = { 1: 0, 43114: 1, 10: 2, 42161: 3, 8453: 6, 137: 7, 130: 10, 59144: 11, 146: 13, 999: 19, 143: 15 }

function order(program: string, disc: string, length: number, chainAt: number, chain: number, wide: boolean, extra: (v: DataView) => void): RunInstruction {
  const d = new Uint8Array(length); const v = new DataView(d.buffer)
  d.set(Buffer.from(disc, 'hex'), 0)
  d.set(Buffer.from('00'.repeat(12) + RECIPIENT.slice(2), 'hex'), program === SWIFT_V2 ? 25 : 8)
  if (wide) v.setUint32(chainAt, chain, true); else v.setUint16(chainAt, chain, true)
  extra(v)
  return { program, accounts: [WALLET, STATE, STATE, STATE], data: d }
}
const swift = (wh: number) => order(SWIFT_V2, '204c290c27a284db', 198, 57, wh, false, (v) => { v.setBigUint64(8, 1_000_000n, true); v.setBigUint64(91, 1n, true) })
const mctp = (wh: number) => order(MCTP, '3635a7a4fa097b45', 107, 72, wh, false, (v) => v.setBigUint64(40, 1_000_000n, true))
const fast = (domain: number) => order(FAST_MCTP, 'a766806a7976ba4c', 124, 72, domain, true, (v) => v.setBigUint64(40, 1_000_000n, true))
const ctx = { wallet: WALLET, tokenAccountOwner: () => undefined, maxLamportsOut: 1_000_000_000n }
// Circle's native USDC on each CCTP chain (protocol-swap2-cctp CCTP_DOMAINS): what a plain MCTP / Fast MCTP bridge delivers.
const USDC: Record<number, string> = Object.fromEntries([...readFileSync(new URL('../../protocol-swap2-cctp/src/config.ts', import.meta.url), 'utf8')
  .matchAll(/d\((\d+), \d+, "[^"]+", "(0x[0-9a-fA-F]{40})"\)/g)].map((m) => [Number(m[1]), m[2]!]))
// Swift orders name the native coin, the plain bridges USDC; a minimum of 1 base unit.
const run = (destChain: string, ix: RunInstruction) => bridgeOutRefusal([ix], [{ type: 'program-call' } as never], {
  destChain, recipient: RECIPIENT, destToken: ix.program === SWIFT_V2 ? '0x0000000000000000000000000000000000000000' : USDC[Number(destChain.slice(7))] ?? `0x${'00'.repeat(20)}`, minAmountOut: 1n, destDecimals: 6,
}, ctx)?.code

describe('audit 2026-11-02 r2: every Mayan destination the guard maps matches Mayan\'s own ids', () => {
  it.each(Object.entries(WORMHOLE))('eip155:%s → Wormhole %s (Swift, MCTP)', (evm, wh) => {
    const chain = `eip155:${evm}`
    expect(run(chain, swift(wh))).toBeUndefined()
    // A plain MCTP bridge rides CCTP: BSC has no CCTP domain and no Circle USDC to deliver.
    expect(run(chain, mctp(wh))).toBe(evm === '56' ? 'bridge-token' : undefined)
    for (const other of [wh - 1, wh + 1, 0]) expect(run(chain, swift(other))).toBe('bridge-recipient')
  })

  it.each(Object.entries(CCTP))('eip155:%s → CCTP domain %s (Fast MCTP)', (evm, domain) => {
    const chain = `eip155:${evm}`
    expect(run(chain, fast(domain))).toBeUndefined()
    for (const other of [domain + 1, 5 /* Solana */, 0xffffffff]) if (other !== domain) expect(run(chain, fast(other))).toBe('bridge-recipient')
  })

  it('BSC has no CCTP domain, and an unmapped chain refuses every order', () => {
    for (const d of [0, 4, 6]) expect(run('eip155:56', fast(d))).toBe('bridge-recipient')
    for (const wh of [0, 2, 30, 36]) expect(run('eip155:324', swift(wh))).toBe('bridge-recipient')
  })
})
