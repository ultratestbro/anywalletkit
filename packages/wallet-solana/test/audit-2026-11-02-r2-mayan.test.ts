// The bridgeOut guard read only the recipient, the destination chain and the trader of a Mayan order. Every other field
// that decides what the recipient actually gets was free: a Swift order could name the right recipient and still ask
// for a worthless token or a minimum of 0, give a referrer 2.55 % and set cancel / refund fees to the whole input, and an
// MCTP bridge could hand its whole amount to the redeemer as `feeRedeem`. Now every order must carry a non-zero minimum
// and fees within their caps, and with the engine's reviewed terms (destToken, minAmountOut, destDecimals, slippageBps)
// its output token and minimum must match the review. The recorded LI.FI answers of 2026-11-02 all still pass.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  AccountRole, appendTransactionMessageInstructions, compileTransaction, createNoopSigner, createTransactionMessage, getAddressDecoder, getAddressEncoder,
  getBase64EncodedWireTransaction, getCompiledTransactionMessageDecoder, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
  type Address, type Instruction, type Transaction, type TransactionMessage,
} from '@solana/kit'
import { getTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token'
import {
  LIFI_FEE_WALLET_ADDRESS, MAYAN_CPI_PROXY_PROGRAM_ADDRESS, MAYAN_REFERRER_FEE_MAX_BPS, MAYAN_RELAYER_FEE_MAX_BPS, UnsafeTransactionError, WSOL_MINT,
  WalletAccountReadOnlySolana, WalletManagerSolana, decodeWireTransaction, type BridgeOutExpectation, type SolanaRpc,
} from '../src/index.js'

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const ADDR0 = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk' as Address
const STATE = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo' as Address
const VAULT = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin' as Address
const MY_USDC = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' as Address
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as Address
const SWIFT_V2 = 'mayan34VedncxdK2XobtvWFDXQASUTBXhUVzt2kKgny' as Address
const MCTP = 'dkpZqrxHFrhziEMQ931GLtfy11nFkCsfMftH9u6QwBU' as Address
const FAST_MCTP = 'Gx9rivpS3YR8pBFwMuP6omYqVxunpLvLkNn7ubNyuZZ5'
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const RECIPIENT = '0x3333333333333333333333333333333333333333'
const SOL = 1_000_000_000n
const INPUT = 9_000_000n

type State = { lamports: bigint; owner: string; data: Uint8Array } | null
const sys = (lamports: bigint): State => ({ lamports, owner: '11111111111111111111111111111111', data: new Uint8Array() })
const enc = (a: string) => getAddressEncoder().encode(a as Address)
function tokenAccount(mint: string, owner: string, amount: bigint): State {
  const data = new Uint8Array(165); data.set(enc(mint), 0); data.set(enc(owner), 32)
  new DataView(data.buffer).setBigUint64(64, amount, true); data[108] = 1
  return { lamports: 2_039_280n, owner: TOKEN_PROGRAM_ADDRESS, data }
}
const toRpc = (s: State) => (s ? { lamports: s.lamports, owner: s.owner, data: [Buffer.from(s.data).toString('base64'), 'base64'], executable: false, rentEpoch: 0n, space: BigInt(s.data.length) } : null)
function fakeRpc(pre: Record<string, State>, tables: Record<string, string[]> = {}) {
  const h: Record<string, (...a: unknown[]) => unknown> = {
    getMultipleAccounts: (addrs, cfg) => ((cfg as { encoding?: string } | undefined)?.encoding === 'base64'
      ? { value: (addrs as string[]).map((a) => toRpc(pre[a] ?? null)) }
      : { value: (addrs as string[]).map((a) => ({ data: { parsed: { info: { addresses: tables[a] ?? [] }, type: 'lookupTable' }, program: 'address-lookup-table' }, owner: 'AddressLookupTab1e1111111111111111111111111', executable: false, lamports: 1n, rentEpoch: 0n, space: 0n })) }),
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
const code = (p: Promise<unknown>) => p.then(() => 'pass', (e: unknown) => (e instanceof UnsafeTransactionError ? `${e.code}` : String(e)))

// ── Synthetic orders ──────────────────────────────────────────────────────────────────────────────────────────────
const pad = (evm: string) => Buffer.from(evm.slice(2).toLowerCase().padStart(64, '0'), 'hex')
type Swift = { tokenOut?: string; amountOutMin?: bigint; feeSubmit?: bigint; feeCancel?: bigint; feeRefund?: bigint; feeRateRef?: number; feeRateMayan?: number }
function swift(o: Swift = {}): Instruction {
  const d = new Uint8Array(198); const v = new DataView(d.buffer)
  d.set(Buffer.from('204c290c27a284db', 'hex'), 0)
  v.setBigUint64(8, INPUT, true)
  v.setBigUint64(17, o.feeSubmit ?? 0n, true)
  d.set(pad(RECIPIENT), 25)
  v.setUint16(57, 30, true) // Base
  d.set(pad(o.tokenOut ?? BASE_USDC), 59)
  v.setBigUint64(91, o.amountOutMin ?? 8_955_000n, true)
  v.setBigUint64(107, o.feeCancel ?? 1_425n, true)
  v.setBigUint64(115, o.feeRefund ?? 16_305n, true)
  d[163] = o.feeRateRef ?? 0
  d[164] = o.feeRateMayan ?? 0
  return { programAddress: SWIFT_V2, accounts: [{ address: ADDR0, role: AccountRole.WRITABLE_SIGNER }, { address: ADDR0, role: AccountRole.WRITABLE_SIGNER }, w(STATE), w(VAULT), w(MY_USDC), ro(USDC)], data: d }
}
function mctpBridge(feeRedeem: bigint, feeSolana = 0n): Instruction {
  const d = new Uint8Array(107); const v = new DataView(d.buffer)
  d.set(Buffer.from('3635a7a4fa097b45', 'hex'), 0)
  d.set(pad(RECIPIENT), 8)
  v.setBigUint64(40, INPUT, true)
  v.setBigUint64(56, feeRedeem, true)
  v.setBigUint64(64, feeSolana, true)
  v.setUint16(72, 30, true)
  return { programAddress: MCTP, accounts: [{ address: ADDR0, role: AccountRole.WRITABLE_SIGNER }, w(STATE), w(VAULT), w(MY_USDC), ro(USDC)], data: d }
}
const intoVault = getTransferCheckedInstruction({ source: MY_USDC, mint: USDC, destination: VAULT, authority: createNoopSigner(ADDR0), amount: INPUT, decimals: 6 })
const pre = { [ADDR0]: sys(SOL), [MY_USDC]: tokenAccount(USDC, ADDR0, 100_000_000n), [VAULT]: tokenAccount(USDC, STATE, 0n) }
const REVIEWED: BridgeOutExpectation = { destChain: 'eip155:8453', recipient: RECIPIENT, destToken: BASE_USDC, minAmountOut: 8_955_000n, destDecimals: 6, slippageBps: 50 }
async function check(order: Instruction, bridgeOut: BridgeOutExpectation = REVIEWED) {
  const a = await new WalletManagerSolana(SEED, { provider: fakeRpc(pre) }).getAccount(0)
  return code(a.checkSerialized(wire([intoVault, order]), { expect: { maxLamportsOut: 20_000_000n, maxTokenOut: { mint: USDC, amount: INPUT }, bridgeOut } }))
}

describe('audit 2026-11-02 r2: a Mayan order must deliver what was reviewed', () => {
  it('the reported Swift order (attacker token, minimum 0, whole input as relayer fees, 255 bps referrer) is refused', async () => {
    const attack: Swift = { tokenOut: `0x${'66'.repeat(20)}`, amountOutMin: 0n, feeSubmit: INPUT, feeCancel: INPUT, feeRefund: INPUT, feeRateRef: 255 }
    expect(await check(swift(attack))).toBe('bridge-fee')
    // Each field on its own, with and without the reviewed terms.
    const bare: BridgeOutExpectation = { destChain: 'eip155:8453', recipient: RECIPIENT }
    expect(await check(swift({ feeRateRef: MAYAN_REFERRER_FEE_MAX_BPS + 1 }), bare)).toBe('bridge-fee')
    expect(await check(swift({ feeRateMayan: 255 }), bare)).toBe('bridge-fee')
    expect(await check(swift({ feeRefund: INPUT }), bare)).toBe('bridge-fee')
    expect(await check(swift({ feeCancel: (INPUT * BigInt(MAYAN_RELAYER_FEE_MAX_BPS)) / 10_000n + 1n, feeRefund: 0n }), bare)).toBe('bridge-fee')
    expect(await check(swift({ amountOutMin: 0n }))).toBe('bridge-min')
    expect(await check(swift({ tokenOut: `0x${'66'.repeat(20)}` }))).toBe('bridge-token')
    expect(await check(swift({ tokenOut: '0x0000000000000000000000000000000000000000' }))).toBe('bridge-token')
    // 0.5 % slippage + 1 bp of rounding under the reviewed minimum is the floor.
    expect(await check(swift({ amountOutMin: (8_955_000n * 9_949n) / 10_000n }))).toBe('pass')
    expect(await check(swift({ amountOutMin: (8_955_000n * 9_949n) / 10_000n - 1n }))).toBe('bridge-min')
    expect(await check(swift({ amountOutMin: 1n }))).toBe('bridge-min')
    // Fees within the caps and the reviewed token and minimum pass.
    expect(await check(swift({ feeRateRef: MAYAN_REFERRER_FEE_MAX_BPS, feeCancel: (INPUT * BigInt(MAYAN_RELAYER_FEE_MAX_BPS)) / 10_000n, feeRefund: 0n }))).toBe('pass')
    expect(await check(swift(), { ...REVIEWED, destToken: BASE_USDC.toLowerCase() })).toBe('pass')
  })

  it('the reported MCTP bridge paying its whole amount as feeRedeem is refused; a real one passes', async () => {
    const bare: BridgeOutExpectation = { destChain: 'eip155:8453', recipient: RECIPIENT }
    expect(await check(mctpBridge(INPUT), bare)).toBe('bridge-min')
    expect(await check(mctpBridge(INPUT))).toBe('bridge-min')
    // The bridged USDC less its fees must cover the reviewed minimum (slippage + 1 bp); feeSolana counts too.
    const fee = INPUT - (8_955_000n * 9_949n) / 10_000n
    expect(await check(mctpBridge(fee - 200n, 200n))).toBe('pass')
    expect(await check(mctpBridge(fee - 200n, 201n))).toBe('bridge-min')
    // A plain bridge delivers USDC only: a reviewed 18-decimal token is not what it pays.
    expect(await check(mctpBridge(10_000n), { ...REVIEWED, destToken: '0x0000000000000000000000000000000000000000', minAmountOut: 8_955_000n * 10n ** 12n, destDecimals: 18 })).toBe('bridge-token')
  })

  it('reviewed terms that do not parse are the caller\'s mistake', async () => {
    expect(await check(swift(), { ...REVIEWED, destDecimals: undefined } as never)).toBe('invalid-expectation')
    expect(await check(swift(), { ...REVIEWED, minAmountOut: '8955000' as never })).toBe('invalid-expectation')
    expect(await check(swift(), { ...REVIEWED, destToken: 'USDC' })).toBe('invalid-expectation')
    expect(await check(swift(), { ...REVIEWED, slippageBps: 10_000 })).toBe('invalid-expectation')
  })
})

// ── The live LI.FI transactions (same wires as protocol-swap2-lifi's fixtures-live-2026-11-02.json) ──────────────────
type Live = { name: string; tool: string; sender: string; recipient: string; destChain: string; sourceToken: string; amountIn: string; wire: string }
const live = (JSON.parse(readFileSync(new URL('./fixtures/lifi-solana-2026-11-02.json', import.meta.url), 'utf8')) as { quotes: Live[] }).quotes.filter((q) => q.tool.startsWith('mayan'))
type Answer = { name: string; response: { action: { toToken: { address: string } }; estimate: { toAmountMin: string } } }
const answers = new Map((JSON.parse(readFileSync(new URL('../../protocol-swap2-lifi/tests/fixtures-live-2026-11-02.json', import.meta.url), 'utf8')) as { corridors: Answer[] }).corridors.map((c) => [c.name, c.response]))
const SYSTEM = '11111111111111111111111111111111'
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
const placeholder = (seed: string) => getAddressDecoder().decode(createHash('sha256').update(seed).digest()) as string

/** The lookup tables were not recorded: fill the slots the guard needs from what each proxied instruction's data says it is. */
function tablesFor(q: Live): Record<string, string[]> {
  const m = getCompiledTransactionMessageDecoder().decode(decodeWireTransaction(q.wire).messageBytes) as unknown as { staticAccounts: string[]; instructions: { programAddressIndex: number; accountIndices?: number[]; data?: Uint8Array }[]; addressTableLookups?: { lookupTableAddress: string; writableIndexes: number[]; readonlyIndexes: number[] }[] }
  const slots: Array<{ table: string; index: number }> = []
  for (const l of m.addressTableLookups ?? []) for (const i of l.writableIndexes) slots.push({ table: l.lookupTableAddress, index: i })
  for (const l of m.addressTableLookups ?? []) for (const i of l.readonlyIndexes) slots.push({ table: l.lookupTableAddress, index: i })
  const set: Record<number, string> = {}
  const assume = (at: number | undefined, address: string) => { if (at !== undefined && at >= m.staticAccounts.length && set[at] === undefined) set[at] = address }
  for (const ix of m.instructions) {
    let program = m.staticAccounts[ix.programAddressIndex]
    let acc = ix.accountIndices ?? []
    const data = Buffer.from(ix.data ?? [])
    if (program === SYSTEM && data[0] === 2) assume(acc[1], LIFI_FEE_WALLET_ADDRESS)
    if (program !== MAYAN_CPI_PROXY_PROGRAM_ADDRESS) continue
    const target = acc[0]; acc = acc.slice(1)
    const disc = data.subarray(0, 8).toString('hex')
    if (data.length <= 1 && data[0] !== 0x11 && data[0] !== 0x09 && acc.length >= 6) { program = ATA; assume(acc[4], SYSTEM); assume(acc[5], TOKEN_PROGRAM_ADDRESS); assume(acc[3], q.sourceToken === SYSTEM ? USDC : q.sourceToken) }
    else if (data[0] === 2 && data.length === 12) program = SYSTEM
    else if ((data.length === 1 && (data[0] === 0x11 || data[0] === 0x09)) || (data[0] === 3 && data.length === 9)) program = TOKEN_PROGRAM_ADDRESS
    else if (disc === '204c290c27a284db') program = SWIFT_V2
    else if (disc === '3635a7a4fa097b45' || disc === 'ebfc2bb26990c1a5') program = MCTP
    else if (disc === 'a766806a7976ba4c' || disc === 'ae29789262daa919') program = FAST_MCTP
    else continue
    assume(target, program!)
  }
  const out: Record<string, string[]> = {}
  slots.forEach((s, k) => {
    const list = (out[s.table] ??= [])
    while (list.length <= s.index) list.push(placeholder(`${s.table}:${list.length}`))
    list[s.index] = set[m.staticAccounts.length + k] ?? list[s.index]!
  })
  return out
}
const FEE_ATA = '8jjWmLhYdqrtFMcEkiMDdqkEN85cvEFnNS4LFgNf5NRv'
/** The engine's reviewed terms for a recorded answer: its toToken, toAmountMin, the token's decimals and the plan's 50 bps. */
const reviewed = (q: Live): BridgeOutExpectation => {
  const r = answers.get(`w-${q.name}`)!
  const token = r.action.toToken.address
  return { destChain: q.destChain, recipient: q.recipient, destToken: token, minAmountOut: BigInt(r.estimate.toAmountMin), destDecimals: /^0x0+$/.test(token) ? 18 : 6, slippageBps: 50 }
}
async function run(q: Live, bridgeOut: BridgeOutExpectation = reviewed(q), wireB64 = q.wire) {
  const wsol = 'umiAsegEDQeKMAfqPhqNxxYDsXo8fuhQy7HHE7viKud'
  const myUsdc = 'FzbcyEZ9m8xjtergWgWDq7mfPoHEbboBF791B6cTpzbq'
  const state: Record<string, State> = { [q.sender]: sys(100n * SOL), [wsol]: tokenAccount(WSOL_MINT, q.sender, 0n), [myUsdc]: tokenAccount(USDC, q.sender, 10n ** 12n), [FEE_ATA]: tokenAccount(USDC, LIFI_FEE_WALLET_ADDRESS, 0n) }
  const a = new WalletAccountReadOnlySolana(q.sender, { provider: fakeRpc(state, tablesFor(q)) })
  const native = q.sourceToken === SYSTEM
  return code(a.checkSerialized(wireB64, { expect: { maxLamportsOut: (native ? BigInt(q.amountIn) : 0n) + 20_000_000n, ...(native ? {} : { maxTokenOut: { mint: q.sourceToken, amount: BigInt(q.amountIn) } }), bridgeOut } }))
}
/** The wire with `patch` applied to the bytes of its first instruction whose data starts with `disc`. */
function patched(q: Live, disc: string, patch: (data: Buffer) => void): string {
  const bytes = Buffer.from(q.wire, 'base64')
  const at = bytes.indexOf(Buffer.from(disc, 'hex'))
  expect(at).toBeGreaterThan(0)
  patch(bytes.subarray(at))
  return bytes.toString('base64')
}

describe('audit 2026-11-02 r2: the live LI.FI Mayan routes against their reviewed terms', () => {
  it('every recorded Mayan route (Swift, MCTP, Fast MCTP; SOL and USDC in; USDC, ETH and BNB out) passes at 50 bps', async () => {
    expect(live.length).toBe(10)
    for (const q of live) expect([q.name, await run(q)]).toEqual([q.name, 'pass'])
    // Without slippage room too: the orders carry LI.FI's minimum itself.
    for (const q of live) expect([q.name, await run(q, { ...reviewed(q), slippageBps: 0 })]).toEqual([q.name, 'pass'])
  })

  it('a live Swift order re-pointed at another token, a lower minimum or a referrer fee is refused', async () => {
    const q = live.find((k) => k.name === 'sol-base-usdc-mayan')!
    expect(await run(q, reviewed(q), patched(q, '204c290c27a284db', (d) => d.fill(0x66, 59 + 12, 91)))).toBe('bridge-token')
    expect(await run(q, reviewed(q), patched(q, '204c290c27a284db', (d) => d.writeBigUInt64LE(d.readBigUInt64LE(91) * 99n / 100n, 91)))).toBe('bridge-min')
    expect(await run(q, reviewed(q), patched(q, '204c290c27a284db', (d) => { d[163] = 100 }))).toBe('bridge-fee')
    expect(await run(q, { ...reviewed(q), minAmountOut: reviewed(q).minAmountOut! * 101n / 100n })).toBe('bridge-min')
    // An 18-decimal output is compared at Mayan's 8 decimals.
    const eth = live.find((k) => k.name === 'sol-eth-eth-deny')!
    expect(await run(eth, { ...reviewed(eth), destToken: BASE_USDC })).toBe('bridge-token')
    expect(await run(eth, { ...reviewed(eth), minAmountOut: reviewed(eth).minAmountOut! * 101n / 100n })).toBe('bridge-min')
  })

  it('a live MCTP / Fast MCTP bridge whose fees eat into the reviewed minimum is refused', async () => {
    const mctp = live.find((k) => k.name === 'sol-base-usdc-mayanMCTP')!
    expect(await run(mctp, reviewed(mctp), patched(mctp, '3635a7a4fa097b45', (d) => d.writeBigUInt64LE(d.readBigUInt64LE(56) + 500_000n, 56)))).toBe('bridge-min')
    expect(await run(mctp, reviewed(mctp), patched(mctp, '3635a7a4fa097b45', (d) => d.writeBigUInt64LE(d.readBigUInt64LE(40), 56)))).toBe('bridge-min')
    const fast = live.find((k) => k.name === 'usdc-base-usdc-mayanFastMCTP')!
    expect(await run(fast, reviewed(fast), patched(fast, 'a766806a7976ba4c', (d) => { d[108] = MAYAN_REFERRER_FEE_MAX_BPS + 1 }))).toBe('bridge-fee')
    expect(await run(fast, reviewed(fast), patched(fast, 'a766806a7976ba4c', (d) => d.writeBigUInt64LE(1_000_000n, 111)))).toBe('bridge-min')
  })
})
