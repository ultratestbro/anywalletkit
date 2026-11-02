// Inside a bridge transaction the guard checked only where a Jupiter route's output lands, never its fee arguments: a
// route_v2 with platform_fee_bps and positive_slippage_bps at 10 000 passed ahead of a valid Mayan order, though the
// fee goes to an account the guard does not follow (protocol-swap2-jupiter refuses both itself). A Jupiter route in a
// bridge must now take no platform fee and no positive-slippage share; the v1 routes' u8 fee (their last byte) too.
// Its slippage is not capped: the bridge order's own minimums (bridgeOut terms) bind the price, and LI.FI's live Mayan
// routes swap at 100 bps under a 50-bps plan.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  AccountRole, appendTransactionMessageInstructions, compileTransaction, createNoopSigner, createTransactionMessage, getAddressEncoder,
  getBase64EncodedWireTransaction, getCompiledTransactionMessageDecoder, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
  type Address, type Instruction, type Transaction, type TransactionMessage,
} from '@solana/kit'
import { getTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token'
import { JUPITER_V6_PROGRAM_ADDRESS, UnsafeTransactionError, WalletManagerSolana, decodeWireTransaction, type SolanaRpc } from '../src/index.js'
import { bridgeOutRefusal, type RunInstruction } from '../src/serialized.js'

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const ADDR0 = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk' as Address
const STATE = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo' as Address
const VAULT = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin' as Address
const MY_USDC = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' as Address
const MY_MID = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS' as Address
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as Address
const SWIFT_V2 = 'mayan34VedncxdK2XobtvWFDXQASUTBXhUVzt2kKgny' as Address
const RECIPIENT = '0x3333333333333333333333333333333333333333'
const JUP = JUPITER_V6_PROGRAM_ADDRESS as Address
type State = { lamports: bigint; owner: string; data: Uint8Array } | null
const sys = (l: bigint): State => ({ lamports: l, owner: '11111111111111111111111111111111', data: new Uint8Array() })
const enc = (a: string) => getAddressEncoder().encode(a as Address)
function tokenAccount(mint: string, owner: string, amount: bigint): State {
  const data = new Uint8Array(165); data.set(enc(mint), 0); data.set(enc(owner), 32)
  new DataView(data.buffer).setBigUint64(64, amount, true); data[108] = 1
  return { lamports: 2_039_280n, owner: TOKEN_PROGRAM_ADDRESS, data }
}
const toRpc = (s: State) => (s ? { lamports: s.lamports, owner: s.owner, data: [Buffer.from(s.data).toString('base64'), 'base64'], executable: false, rentEpoch: 0n, space: BigInt(s.data.length) } : null)
function fakeRpc(pre: Record<string, State>) {
  const h: Record<string, (...a: unknown[]) => unknown> = {
    getMultipleAccounts: (addrs) => ({ value: (addrs as string[]).map((a) => toRpc(pre[a] ?? null)) }),
    simulateTransaction: (_w, cfg) => ({ value: { err: null, unitsConsumed: 1000n, logs: [], accounts: (cfg as { accounts: { addresses: string[] } }).accounts.addresses.map((a) => toRpc(pre[a] ?? null)) } }),
    getFeeForMessage: () => ({ value: 5000n }),
  }
  return new Proxy({} as SolanaRpc, { get: (_t, m: string) => (...args: unknown[]) => ({ send: async () => { const f = h[m]; if (!f) throw new Error(`unmocked ${m}`); return f(...args) } }) })
}
function wire(ixs: Instruction[]): string {
  const msg = pipe(createTransactionMessage({ version: 0 }), (x) => setTransactionMessageFeePayer(ADDR0, x),
    (x) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: '9sHcv6xwn9YkB8nxTUGKDwPwNnmqVp5oAXxU8Fdkm4J6' as never, lastValidBlockHeight: 100n }, x),
    (x) => appendTransactionMessageInstructions(ixs, x)) as TransactionMessage
  return getBase64EncodedWireTransaction(compileTransaction(msg as never) as Transaction)
}
const ro = (address: Address) => ({ address, role: AccountRole.READONLY })
const w = (address: Address) => ({ address, role: AccountRole.WRITABLE })

/** route_v2 (disc, in_amount, quoted_out_amount, slippage_bps, platform_fee_bps, positive_slippage_bps, empty route plan). */
function routeV2(slippage: number, platformFee: number, positiveSlippage: number): Uint8Array {
  const d = new Uint8Array(8 + 8 + 8 + 2 + 2 + 2 + 4); const v = new DataView(d.buffer)
  d.set(Buffer.from('bb64facc31c4af14', 'hex'), 0)
  v.setBigUint64(8, 9_000_000n, true); v.setBigUint64(16, 9_000_000n, true)
  v.setUint16(24, slippage, true); v.setUint16(26, platformFee, true); v.setUint16(28, positiveSlippage, true)
  return d
}
/** v1 route (disc, empty route plan, in_amount, quoted_out_amount, slippage_bps, u8 platform_fee_bps). */
function routeV1(platformFee: number): Uint8Array {
  const d = new Uint8Array(8 + 4 + 8 + 8 + 2 + 1)
  d.set(Buffer.from('e517cb977ae3ad2a', 'hex'), 0)
  d[d.length - 1] = platformFee
  return d
}
const jupiter = (data: Uint8Array): Instruction => ({ programAddress: JUP, accounts: [
  { address: ADDR0, role: AccountRole.READONLY_SIGNER }, w(MY_USDC), w(MY_MID), ro(USDC), ro(USDC), ro(TOKEN_PROGRAM_ADDRESS), ro(TOKEN_PROGRAM_ADDRESS), ro(JUP),
], data })
/** v1 `route` accounts: token program, authority, source, user destination, optional destination (none), mint, platform fee account (none). */
const jupiterV1 = (data: Uint8Array): Instruction => ({ programAddress: JUP, accounts: [
  ro(TOKEN_PROGRAM_ADDRESS), { address: ADDR0, role: AccountRole.READONLY_SIGNER }, w(MY_USDC), w(MY_MID), ro(JUP), ro(USDC), ro(JUP),
], data })
function swift(): Instruction {
  const d = new Uint8Array(198); const v = new DataView(d.buffer)
  d.set(Buffer.from('204c290c27a284db', 'hex'), 0)
  v.setBigUint64(8, 1n, true)
  d.set(Buffer.from(RECIPIENT.slice(2).padStart(64, '0'), 'hex'), 25); v.setUint16(57, 30, true)
  v.setBigUint64(91, 1n, true)
  return { programAddress: SWIFT_V2, accounts: [{ address: ADDR0, role: AccountRole.WRITABLE_SIGNER }, { address: ADDR0, role: AccountRole.WRITABLE_SIGNER }, w(STATE), w(VAULT), w(MY_MID), ro(USDC)], data: d }
}
async function check(jup: Instruction) {
  const intoVault = getTransferCheckedInstruction({ source: MY_MID, mint: USDC, destination: VAULT, authority: createNoopSigner(ADDR0), amount: 1n, decimals: 6 })
  const pre = { [ADDR0]: sys(10n ** 9n), [MY_USDC]: tokenAccount(USDC, ADDR0, 100_000_000n), [MY_MID]: tokenAccount(USDC, ADDR0, 0n), [VAULT]: tokenAccount(USDC, STATE, 0n) }
  const a = await new WalletManagerSolana(SEED, { provider: fakeRpc(pre) }).getAccount(0)
  const guard = { expect: { maxLamportsOut: 20_000_000n, maxTokenOut: { mint: USDC, amount: 9_000_000n }, bridgeOut: { destChain: 'eip155:8453', recipient: RECIPIENT, destToken: '0x0000000000000000000000000000000000000000', minAmountOut: 1n, destDecimals: 6 } } }
  return a.checkSerialized(wire([jup, intoVault, swift()]), guard).then(() => 'pass', (e: unknown) => (e instanceof UnsafeTransactionError ? `${e.code}` : String(e)))
}

describe('audit 2026-11-02 r2: a Jupiter route inside a bridge takes no fee', () => {
  it('the reported route_v2 (slippage, platform fee and positive-slippage share all 10 000) is refused', async () => {
    expect(await check(jupiter(routeV2(10_000, 10_000, 10_000)))).toBe('bridge-fee')
    expect(await check(jupiter(routeV2(100, 1, 0)))).toBe('bridge-fee')
    expect(await check(jupiter(routeV2(100, 0, 1)))).toBe('bridge-fee')
    // Only the fees: the route's slippage is bounded by the bridge order's own minimum, not here.
    expect(await check(jupiter(routeV2(100, 0, 0)))).toBe('pass')
    expect(await check(jupiter(routeV2(10_000, 0, 0)))).toBe('pass')
  })

  it('a v1 route is held to its u8 platform fee; a route too short to read is refused', async () => {
    expect(await check(jupiterV1(routeV1(25)))).toBe('bridge-fee')
    expect(await check(jupiterV1(routeV1(0)))).toBe('pass')
    expect(await check(jupiter(routeV2(0, 0, 0).subarray(0, 20)))).toBe('bridge-instruction')
  })

  it('every Jupiter leg of the recorded LI.FI Mayan routes carries no fee; one with a platform fee is refused', () => {
    const live = (JSON.parse(readFileSync(new URL('./fixtures/lifi-solana-2026-11-02.json', import.meta.url), 'utf8')) as { quotes: { tool: string; wire: string }[] }).quotes
    const legs: Uint8Array[] = []
    for (const q of live.filter((k) => k.tool.startsWith('mayan'))) {
      const m = getCompiledTransactionMessageDecoder().decode(decodeWireTransaction(q.wire).messageBytes) as unknown as { instructions: { data?: Uint8Array }[] }
      for (const ix of m.instructions) {
        const data = Uint8Array.from(ix.data ?? [])
        if (['bb64facc31c4af14', 'd19853937cfed8e9'].includes(Buffer.from(data.subarray(0, 8)).toString('hex'))) legs.push(data)
      }
    }
    expect(legs.length).toBe(7)
    const order: RunInstruction = { program: SWIFT_V2, accounts: [ADDR0, ADDR0, STATE, VAULT], data: swift().data as Uint8Array }
    const ctx = { wallet: ADDR0 as string, tokenAccountOwner: (a: string) => (a === MY_MID ? ADDR0 : undefined), maxLamportsOut: 10n ** 9n }
    const run = (data: Uint8Array) => {
      const shared = data[1] === 0x98 // d19853937cfed8e9: output at account 5
      const accounts = shared ? [ADDR0, ADDR0, ADDR0, MY_USDC, MY_USDC, MY_MID, USDC, USDC] : [ADDR0, MY_USDC, MY_MID, USDC, USDC, TOKEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS, JUP]
      return bridgeOutRefusal([{ program: JUP, accounts, data }, order], [{ type: 'program-call' } as never, { type: 'program-call' } as never], { destChain: 'eip155:8453', recipient: RECIPIENT, destToken: '0x0000000000000000000000000000000000000000', minAmountOut: 1n, destDecimals: 6 }, ctx)?.code
    }
    for (const leg of legs) {
      expect(run(leg)).toBeUndefined()
      const at = leg[1] === 0x98 ? 9 : 8
      const feeTaking = Uint8Array.from(leg); new DataView(feeTaking.buffer).setUint16(at + 18, 20, true)
      expect(run(feeTaking)).toBe('bridge-fee')
    }
  })
})
