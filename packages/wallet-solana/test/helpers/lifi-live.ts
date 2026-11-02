// Shared by the r3 tests: the recorded LI.FI Solana wires (fixtures/lifi-solana-2026-11-02.json, public li.quest answers
// of 2026-11-02) run through checkSerialized against a fake RPC. Their lookup tables were not recorded: the slots the
// guard needs are filled from what each proxied instruction's data says it is.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { getAddressDecoder, getAddressEncoder, getCompiledTransactionMessageDecoder, type Address } from '@solana/kit'
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token'
import {
  LIFI_FEE_WALLET_ADDRESS, MAYAN_CPI_PROXY_PROGRAM_ADDRESS, UnsafeTransactionError, WSOL_MINT, WalletAccountReadOnlySolana,
  decodeWireTransaction, type BridgeOutExpectation, type SerializedExpectation, type SolanaRpc,
} from '../../src/index.js'

export const SOL = 1_000_000_000n
export const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
export const SYSTEM = '11111111111111111111111111111111'
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
export const SWIFT_V2 = 'mayan34VedncxdK2XobtvWFDXQASUTBXhUVzt2kKgny'
export const MCTP = 'dkpZqrxHFrhziEMQ931GLtfy11nFkCsfMftH9u6QwBU'
export const FAST_MCTP = 'Gx9rivpS3YR8pBFwMuP6omYqVxunpLvLkNn7ubNyuZZ5'
export const LIFI_INTENTS = 'LiFiRp8RM7nJUZyUYC9FPPpDr7sAy5XPfBN6ABzBgT7'
export const FEE_ATA = '8jjWmLhYdqrtFMcEkiMDdqkEN85cvEFnNS4LFgNf5NRv'
export const USDC_OUT: Record<string, string> = { 'eip155:8453': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'eip155:42161': '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' }

export type State = { lamports: bigint; owner: string; data: Uint8Array } | null
export const sys = (lamports: bigint): State => ({ lamports, owner: SYSTEM, data: new Uint8Array() })
export function tokenAccount(mint: string, owner: string, amount: bigint): State {
  const data = new Uint8Array(165); data.set(getAddressEncoder().encode(mint as Address), 0); data.set(getAddressEncoder().encode(owner as Address), 32)
  new DataView(data.buffer).setBigUint64(64, amount, true); data[108] = 1
  return { lamports: 2_039_280n, owner: TOKEN_PROGRAM_ADDRESS, data }
}
export const toRpc = (s: State) => (s ? { lamports: s.lamports, owner: s.owner, data: [Buffer.from(s.data).toString('base64'), 'base64'], executable: false, rentEpoch: 0n, space: BigInt(s.data.length) } : null)
export function fakeRpc(pre: Record<string, State>, tables: Record<string, string[]> = {}, post: Record<string, State> = pre) {
  const h: Record<string, (...a: unknown[]) => unknown> = {
    getMultipleAccounts: (addrs, cfg) => ((cfg as { encoding?: string } | undefined)?.encoding === 'base64'
      ? { value: (addrs as string[]).map((a) => toRpc(pre[a] ?? null)) }
      : { value: (addrs as string[]).map((a) => ({ data: { parsed: { info: { addresses: tables[a] ?? [] }, type: 'lookupTable' }, program: 'address-lookup-table' }, owner: 'AddressLookupTab1e1111111111111111111111111', executable: false, lamports: 1n, rentEpoch: 0n, space: 0n })) }),
    simulateTransaction: (_w, cfg) => ({ value: { err: null, unitsConsumed: 1000n, logs: [], accounts: (cfg as { accounts: { addresses: string[] } }).accounts.addresses.map((a) => toRpc((a in post ? post[a] : pre[a]) ?? null)) } }),
    getFeeForMessage: () => ({ value: 5000n }),
  }
  return new Proxy({} as SolanaRpc, { get: (_t, m: string) => (...args: unknown[]) => ({ send: async () => { const f = h[m]; if (!f) throw new Error(`unmocked ${m}`); return f(...args) } }) })
}
export const code = (p: Promise<unknown>) => p.then(() => 'pass', (e: unknown) => (e instanceof UnsafeTransactionError ? `${e.code}` : String(e)))

export type Live = { name: string; tool: string; sender: string; recipient: string; destChain: string; sourceToken: string; amountIn: string; wire: string }
export const live = (JSON.parse(readFileSync(new URL('../fixtures/lifi-solana-2026-11-02.json', import.meta.url), 'utf8')) as { quotes: Live[] }).quotes
export type Answer = { name: string; response: { action: { toToken: { address: string; decimals?: number } }; estimate: { toAmountMin: string } } }
export const answers = new Map((JSON.parse(readFileSync(new URL('../../../protocol-swap2-lifi/tests/fixtures-live-2026-11-02.json', import.meta.url), 'utf8')) as { corridors: Answer[] }).corridors.map((c) => [c.name, c.response]))
/** The engine's reviewed terms for a recorded answer: its toToken, toAmountMin and the token's decimals. */
export function reviewedTerms(q: Live): { destToken: string; minAmountOut: bigint; destDecimals: number } {
  const r = answers.get(`w-${q.name}`) ?? answers.get(q.name)!
  const token = r.action.toToken.address
  return { destToken: token, minAmountOut: BigInt(r.estimate.toAmountMin), destDecimals: /^0x0+$/.test(token) ? 18 : 6 }
}
export const placeholder = (seed: string) => getAddressDecoder().decode(createHash('sha256').update(seed).digest()) as string

/** The lookup tables were not recorded: fill the slots the guard needs from what each proxied instruction's data says it is. */
export function tablesFor(q: Live): Record<string, string[]> {
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

/** The guard the engine's expectation maps to (serializedGuardFromExecution), with or without its bridgeOut. */
export function guardFor(q: Live, bridgeOut: BridgeOutExpectation | undefined): SerializedExpectation {
  const native = q.sourceToken === SYSTEM
  return { maxLamportsOut: (native ? BigInt(q.amountIn) : 0n) + 20_000_000n, ...(native ? {} : { maxTokenOut: { mint: q.sourceToken, amount: BigInt(q.amountIn) } }), ...(bridgeOut ? { bridgeOut } : {}) }
}
export async function run(q: Live, bridgeOut: BridgeOutExpectation | undefined, extra: { programAllowlist?: readonly string[] } = {}, wire = q.wire) {
  const state: Record<string, State> = {
    [q.sender]: sys(100n * SOL), umiAsegEDQeKMAfqPhqNxxYDsXo8fuhQy7HHE7viKud: tokenAccount(WSOL_MINT, q.sender, 0n),
    FzbcyEZ9m8xjtergWgWDq7mfPoHEbboBF791B6cTpzbq: tokenAccount(USDC, q.sender, 10n ** 12n), [FEE_ATA]: tokenAccount(USDC, LIFI_FEE_WALLET_ADDRESS, 0n),
  }
  const a = new WalletAccountReadOnlySolana(q.sender, { provider: fakeRpc(state, tablesFor(q)) })
  return code(a.checkSerialized(wire, { ...extra, expect: guardFor(q, bridgeOut) }))
}
