// LI.FI's Solana routes other than Mayan (Relay, LayerSwap, NEAR Intents, LI.FI Intents) deposit to an order id, an
// address or a program whose recipient lives off chain or in data the device does not read. With `bridgeOut` the guard
// refused all of them (`bridge-missing`), which took those corridors away. The guard now reads a transaction as a Mayan
// route only when it runs one of Mayan's own programs (directly or through the CPI proxy) and keeps every Mayan check
// for those; any other bridge gets exactly what it got without `bridgeOut`: the program allowlist and the SOL / token
// ceilings, no recipient check. The recorded wires are the public li.quest answers of 2026-11-02.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  AccountRole, appendTransactionMessageInstructions, compileTransaction, createNoopSigner, createTransactionMessage, getAddressDecoder, getAddressEncoder,
  getBase64EncodedWireTransaction, getCompiledTransactionMessageDecoder, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
  type Address, type Instruction, type Transaction, type TransactionMessage,
} from '@solana/kit'
import { getTransferSolInstruction } from '@solana-program/system'
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token'
import {
  DEFAULT_PROGRAM_ALLOWLIST, LIFI_FEE_WALLET_ADDRESS, MAYAN_CPI_PROXY_PROGRAM_ADDRESS, UnsafeTransactionError, WSOL_MINT, WalletAccountReadOnlySolana,
  decodeWireTransaction, type BridgeOutExpectation, type SerializedExpectation, type SolanaRpc,
} from '../src/index.js'

const SOL = 1_000_000_000n
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const SYSTEM = '11111111111111111111111111111111'
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
const SWIFT_V2 = 'mayan34VedncxdK2XobtvWFDXQASUTBXhUVzt2kKgny'
const MCTP = 'dkpZqrxHFrhziEMQ931GLtfy11nFkCsfMftH9u6QwBU'
const FAST_MCTP = 'Gx9rivpS3YR8pBFwMuP6omYqVxunpLvLkNn7ubNyuZZ5'
const LIFI_INTENTS = 'LiFiRp8RM7nJUZyUYC9FPPpDr7sAy5XPfBN6ABzBgT7'
const FEE_ATA = '8jjWmLhYdqrtFMcEkiMDdqkEN85cvEFnNS4LFgNf5NRv'
const USDC_OUT: Record<string, string> = { 'eip155:8453': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'eip155:42161': '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' }

type State = { lamports: bigint; owner: string; data: Uint8Array } | null
const sys = (lamports: bigint): State => ({ lamports, owner: SYSTEM, data: new Uint8Array() })
function tokenAccount(mint: string, owner: string, amount: bigint): State {
  const data = new Uint8Array(165); data.set(getAddressEncoder().encode(mint as Address), 0); data.set(getAddressEncoder().encode(owner as Address), 32)
  new DataView(data.buffer).setBigUint64(64, amount, true); data[108] = 1
  return { lamports: 2_039_280n, owner: TOKEN_PROGRAM_ADDRESS, data }
}
const toRpc = (s: State) => (s ? { lamports: s.lamports, owner: s.owner, data: [Buffer.from(s.data).toString('base64'), 'base64'], executable: false, rentEpoch: 0n, space: BigInt(s.data.length) } : null)
function fakeRpc(pre: Record<string, State>, tables: Record<string, string[]> = {}, post: Record<string, State> = pre) {
  const h: Record<string, (...a: unknown[]) => unknown> = {
    getMultipleAccounts: (addrs, cfg) => ((cfg as { encoding?: string } | undefined)?.encoding === 'base64'
      ? { value: (addrs as string[]).map((a) => toRpc(pre[a] ?? null)) }
      : { value: (addrs as string[]).map((a) => ({ data: { parsed: { info: { addresses: tables[a] ?? [] }, type: 'lookupTable' }, program: 'address-lookup-table' }, owner: 'AddressLookupTab1e1111111111111111111111111', executable: false, lamports: 1n, rentEpoch: 0n, space: 0n })) }),
    simulateTransaction: (_w, cfg) => ({ value: { err: null, unitsConsumed: 1000n, logs: [], accounts: (cfg as { accounts: { addresses: string[] } }).accounts.addresses.map((a) => toRpc((a in post ? post[a] : pre[a]) ?? null)) } }),
    getFeeForMessage: () => ({ value: 5000n }),
  }
  return new Proxy({} as SolanaRpc, { get: (_t, m: string) => (...args: unknown[]) => ({ send: async () => { const f = h[m]; if (!f) throw new Error(`unmocked ${m}`); return f(...args) } }) })
}
const code = (p: Promise<unknown>) => p.then(() => 'pass', (e: unknown) => (e instanceof UnsafeTransactionError ? `${e.code}` : String(e)))

type Live = { name: string; tool: string; sender: string; recipient: string; destChain: string; sourceToken: string; amountIn: string; wire: string }
const live = (JSON.parse(readFileSync(new URL('./fixtures/lifi-solana-2026-11-02.json', import.meta.url), 'utf8')) as { quotes: Live[] }).quotes
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

/** The guard the engine's expectation maps to (serializedGuardFromExecution), with or without its bridgeOut. */
function guardFor(q: Live, bridgeOut: BridgeOutExpectation | undefined): SerializedExpectation {
  const native = q.sourceToken === SYSTEM
  return { maxLamportsOut: (native ? BigInt(q.amountIn) : 0n) + 20_000_000n, ...(native ? {} : { maxTokenOut: { mint: q.sourceToken, amount: BigInt(q.amountIn) } }), ...(bridgeOut ? { bridgeOut } : {}) }
}
async function run(q: Live, bridgeOut: BridgeOutExpectation | undefined, extra: { programAllowlist?: readonly string[] } = {}, wire = q.wire) {
  const state: Record<string, State> = {
    [q.sender]: sys(100n * SOL), umiAsegEDQeKMAfqPhqNxxYDsXo8fuhQy7HHE7viKud: tokenAccount(WSOL_MINT, q.sender, 0n),
    FzbcyEZ9m8xjtergWgWDq7mfPoHEbboBF791B6cTpzbq: tokenAccount(USDC, q.sender, 10n ** 12n), [FEE_ATA]: tokenAccount(USDC, LIFI_FEE_WALLET_ADDRESS, 0n),
  }
  const a = new WalletAccountReadOnlySolana(q.sender, { provider: fakeRpc(state, tablesFor(q)) })
  return code(a.checkSerialized(wire, { ...extra, expect: guardFor(q, bridgeOut) }))
}
const terms = (q: Live): BridgeOutExpectation => ({ destChain: q.destChain, recipient: q.recipient, destToken: USDC_OUT[q.destChain]!, minAmountOut: 1n, destDecimals: 6, slippageBps: 50 })

describe('audit 2026-11-02 r3: Solana bridges other than Mayan are checked as they were before bridgeOut', () => {
  const other = live.filter((q) => !q.tool.startsWith('mayan'))

  it('every recorded Relay, LayerSwap, NEAR Intents and LI.FI Intents wire gets the same answer with bridgeOut as without it', async () => {
    expect(other.map((q) => q.tool).sort()).toEqual(['layerswap', 'layerswap', 'lifiIntents', 'near', 'relaydepository', 'relaydepository'])
    const got: Record<string, [string, string]> = {}
    for (const q of other) got[q.name] = [await run(q, terms(q)), await run(q, undefined)]
    expect(got).toEqual({
      'sol-base-usdc-layerswap': ['pass', 'pass'], 'sol-base-usdc-relaydepository': ['pass', 'pass'], 'usdc-base-usdc-relaydepository': ['pass', 'pass'],
      'sol-base-usdc': ['pass', 'pass'], 'usdc-arb-usdc': ['pass', 'pass'],
      // LI.FI Intents calls a program outside the default allowlist, with or without bridgeOut; an app that allows it passes.
      'usdc-base-usdc-lifiIntents': ['unknown-program', 'unknown-program'],
    })
    const intents = other.find((q) => q.tool === 'lifiIntents')!
    const allow = { programAllowlist: [...DEFAULT_PROGRAM_ALLOWLIST, LIFI_INTENTS] }
    expect([await run(intents, terms(intents), allow), await run(intents, undefined, allow)]).toEqual(['pass', 'pass'])
  })

  it('they stay held to the SOL ceiling', async () => {
    const relay = other.find((q) => q.name === 'sol-base-usdc-relaydepository')!
    // The simulation shows the input leaving the wallet: within the ceiling it passes, under a lower one it is refused.
    const after = { [relay.sender]: sys(100n * SOL - BigInt(relay.amountIn) - 5_000n) }
    const a = new WalletAccountReadOnlySolana(relay.sender, { provider: fakeRpc({ [relay.sender]: sys(100n * SOL) }, tablesFor(relay), after) })
    expect(await code(a.checkSerialized(relay.wire, { expect: guardFor(relay, terms(relay)) }))).toBe('pass')
    const tight = { ...guardFor(relay, terms(relay)), maxLamportsOut: BigInt(relay.amountIn) / 2n }
    expect(await code(a.checkSerialized(relay.wire, { expect: tight }))).toBe(await code(a.checkSerialized(relay.wire, { expect: { ...guardFor(relay, undefined), maxLamportsOut: tight.maxLamportsOut } })))
    expect(await code(a.checkSerialized(relay.wire, { expect: tight }))).not.toBe('pass')
  })

  it('every recorded Mayan route still passes, and one re-pointed at another recipient or chain is still refused', async () => {
    const mayan = live.filter((q) => q.tool.startsWith('mayan'))
    expect(mayan).toHaveLength(10)
    for (const q of mayan) expect([q.name, await run(q, { destChain: q.destChain, recipient: q.recipient })]).toEqual([q.name, 'pass'])
    const q = mayan.find((k) => k.name === 'sol-base-usdc-mayan')!
    const bytes = Buffer.from(q.wire, 'base64')
    const at = bytes.indexOf(Buffer.from(q.recipient.slice(2), 'hex'))
    bytes.fill(0x66, at, at + 20)
    expect(await run(q, { destChain: q.destChain, recipient: q.recipient }, {}, bytes.toString('base64'))).toBe('bridge-recipient')
    expect(await run(q, { destChain: 'eip155:42161', recipient: q.recipient })).toBe('bridge-recipient')
  })

  it('a wire that runs a Mayan program or the CPI proxy is a Mayan route: without a readable order it is refused', async () => {
    const SENDER = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk' as Address
    const OTHER = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS' as Address
    const wire = (ixs: Instruction[]) => getBase64EncodedWireTransaction(compileTransaction(pipe(createTransactionMessage({ version: 0 }), (x) => setTransactionMessageFeePayer(SENDER, x),
      (x) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: '9sHcv6xwn9YkB8nxTUGKDwPwNnmqVp5oAXxU8Fdkm4J6' as never, lastValidBlockHeight: 100n }, x),
      (x) => appendTransactionMessageInstructions(ixs, x)) as TransactionMessage as never) as Transaction)
    const transfer = getTransferSolInstruction({ source: createNoopSigner(SENDER), destination: OTHER, amount: 50_000_000n })
    const proxied: Instruction = { programAddress: MAYAN_CPI_PROXY_PROGRAM_ADDRESS as Address, accounts: [{ address: transfer.programAddress, role: AccountRole.READONLY }, ...transfer.accounts!], data: transfer.data! }
    const legacyMayan: Instruction = { programAddress: 'FC4eXxkyrMPTjiYUpp4EAnkmwMbQyZ6NDCh1kfLn6vsf' as Address, accounts: [{ address: SENDER, role: AccountRole.WRITABLE_SIGNER }, { address: OTHER, role: AccountRole.WRITABLE }], data: new Uint8Array([0xde, 0xad]) }
    const a = new WalletAccountReadOnlySolana(SENDER, { provider: fakeRpc({ [SENDER]: sys(SOL), [OTHER]: sys(0n) }) })
    const expect_ = { maxLamportsOut: 70_000_000n, bridgeOut: { destChain: 'eip155:8453', recipient: `0x${'33'.repeat(20)}` } }
    expect(await code(a.checkSerialized(wire([proxied]), { expect: expect_ }))).toBe('bridge-missing')
    expect(await code(a.checkSerialized(wire([legacyMayan]), { expect: expect_ }))).toBe('bridge-missing')
    // The same plain transfer is another bridge's deposit: held to the SOL ceiling only, as without bridgeOut.
    expect(await code(a.checkSerialized(wire([transfer]), { expect: expect_ }))).toBe('pass')
    expect(await code(a.checkSerialized(wire([transfer]), { expect: { maxLamportsOut: 70_000_000n } }))).toBe('pass')
  })
})
