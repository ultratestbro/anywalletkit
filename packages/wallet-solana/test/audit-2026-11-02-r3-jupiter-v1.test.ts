// A Jupiter v1 route (`route`, `shared_accounts_route`) carries its u8 platform_fee_bps after the variable-length route
// plan; the bridge guard read it as the data's last byte, so one trailing byte put a fee of 255 bps behind a "fee 0".
// Inside a bridge a v1 route is now refused outright: every recorded LI.FI Mayan route swaps with route_v2 /
// shared_accounts_route_v2, whose fee fields sit at fixed offsets. Outside a bridge nothing changes.
import { describe, expect, it } from 'vitest'
import { getCompiledTransactionMessageDecoder } from '@solana/kit'
import { JUPITER_V6_PROGRAM_ADDRESS, decodeWireTransaction } from '../src/index.js'
import { bridgeOutRefusal, type RunInstruction } from '../src/serialized.js'
import { live } from './helpers/lifi-live.js'

const WALLET = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'
const STATE = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo'
const MY_USDC = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
const MY_MID = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const SWIFT_V2 = 'mayan34VedncxdK2XobtvWFDXQASUTBXhUVzt2kKgny'
const RECIPIENT = '0x3333333333333333333333333333333333333333'
const JUP = JUPITER_V6_PROGRAM_ADDRESS

function swift(): RunInstruction {
  const d = new Uint8Array(198); const v = new DataView(d.buffer)
  d.set(Buffer.from('204c290c27a284db', 'hex'), 0)
  v.setBigUint64(8, 1_000_000n, true)
  d.set(Buffer.from('00'.repeat(12) + RECIPIENT.slice(2), 'hex'), 25); v.setUint16(57, 30, true)
  v.setBigUint64(91, 1n, true)
  return { program: SWIFT_V2, accounts: [WALLET, WALLET, STATE, STATE], data: d }
}
/** v1 `route`: disc, a route plan of one 1-byte step, in_amount, quoted_out_amount, slippage_bps, u8 platform_fee_bps, then `trailing`. */
function routeV1(disc: string, platformFee: number, trailing: number[] = []): Uint8Array {
  const d = new Uint8Array(8 + 4 + 1 + 8 + 8 + 2 + 1 + trailing.length)
  d.set(Buffer.from(disc, 'hex'), 0)
  d[8] = 1 // route plan length 1 (u32 LE), one step byte
  d[8 + 4 + 1 + 18] = platformFee
  d.set(trailing, d.length - trailing.length)
  return d
}
const ctx = { wallet: WALLET, tokenAccountOwner: (a: string) => (a === MY_MID ? WALLET : undefined), maxLamportsOut: 10n ** 9n }
const terms = { destChain: 'eip155:8453', recipient: RECIPIENT, destToken: '0x0000000000000000000000000000000000000000', minAmountOut: 1n, destDecimals: 6 }
const run = (jup: RunInstruction) => bridgeOutRefusal([jup, swift()], [{ type: 'program-call' } as never, { type: 'program-call' } as never], terms, ctx)?.code
// route: token program, authority, source, user destination, optional destination (none = Jupiter), mint, platform fee account.
const v1 = (data: Uint8Array): RunInstruction => ({ program: JUP, accounts: [TOKEN, WALLET, MY_USDC, MY_MID, JUP, USDC, JUP], data })
// shared_accounts_route: token program, program authority, user, source, program source, program destination, destination, …
const sharedV1 = (data: Uint8Array): RunInstruction => ({ program: JUP, accounts: [TOKEN, STATE, WALLET, MY_USDC, STATE, STATE, MY_MID, USDC, USDC], data })

describe('audit 2026-11-02 r3: a Jupiter v1 route has no place inside a bridge', () => {
  it('the reported v1 route (fee 255 bps behind one trailing zero byte) is refused, and so is every v1 route', () => {
    expect(run(v1(routeV1('e517cb977ae3ad2a', 255, [0])))).toBe('bridge-instruction')
    expect(run(v1(routeV1('e517cb977ae3ad2a', 0)))).toBe('bridge-instruction')
    expect(run(sharedV1(routeV1('c1209b3341d69c81', 0)))).toBe('bridge-instruction')
  })

  it('the recorded LI.FI Mayan routes use the v2 routes only, and they still pass', () => {
    const discs = new Set<string>()
    for (const q of live.filter((k) => k.tool.startsWith('mayan'))) {
      const m = getCompiledTransactionMessageDecoder().decode(decodeWireTransaction(q.wire).messageBytes) as unknown as { instructions: { data?: Uint8Array }[] }
      for (const ix of m.instructions) {
        const disc = Buffer.from(Uint8Array.from(ix.data ?? []).subarray(0, 8)).toString('hex')
        if (['bb64facc31c4af14', 'd19853937cfed8e9', 'e517cb977ae3ad2a', 'c1209b3341d69c81'].includes(disc)) discs.add(disc)
      }
    }
    expect([...discs].sort()).toEqual(['bb64facc31c4af14', 'd19853937cfed8e9'])
  })
})
