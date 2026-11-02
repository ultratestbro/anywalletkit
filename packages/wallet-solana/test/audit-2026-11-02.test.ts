// A Solana-source bridge was held only to "SOL out ≤ input + allowance": nothing bound where the SOL went, so a provider
// transaction that paid the whole input to another wallet passed, and so did an allowlisted bridge program carrying a
// recipient of anyone's choosing. `expect.bridgeOut` now names the destination chain and recipient: every top-level
// instruction (Mayan's CPI proxy unwrapped) must be one the guard follows, and every Mayan order must pay the recipient.
// The recorded LI.FI transactions (fixtures/lifi-solana-2026-11-02.json) are public li.quest answers of 2026-11-02.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  AccountRole, appendTransactionMessageInstructions, compileTransaction, createNoopSigner, createTransactionMessage, getAddressDecoder, getAddressEncoder,
  getBase64EncodedWireTransaction, getCompiledTransactionMessageDecoder, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
  type Address, type Instruction, type Transaction, type TransactionMessage,
} from '@solana/kit'
import { getTransferSolInstruction } from '@solana-program/system'
import { getTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token'
import {
  LIFI_FEE_WALLET_ADDRESS, LIFI_TRACKING_PROGRAM_ADDRESS, MAYAN_CPI_PROXY_PROGRAM_ADDRESS, MAYAN_PROGRAM_ADDRESSES, WSOL_MINT, UnsafeTransactionError,
  WalletAccountReadOnlySolana, WalletManagerSolana, decodeWireTransaction, describeTransaction, type SolanaRpc,
} from '../src/index.js'

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const ADDR0 = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk' as Address
const ATTACKER = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS' as Address
const STATE = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo' as Address
const VAULT = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin' as Address
const MY_USDC = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' as Address
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as Address
const SWIFT_V2 = 'mayan34VedncxdK2XobtvWFDXQASUTBXhUVzt2kKgny' as Address
const BLOCKHASH = '9sHcv6xwn9YkB8nxTUGKDwPwNnmqVp5oAXxU8Fdkm4J6'
const RECIPIENT = '0x3333333333333333333333333333333333333333'
const SOL = 1_000_000_000n
const FEE = 5_000n
const AMOUNT_IN = 50_000_000n
const ALLOWANCE = 20_000_000n
const BRIDGE = { destChain: 'eip155:8453', recipient: RECIPIENT }

type State = { lamports: bigint; owner: string; data: Uint8Array } | null
const sys = (lamports: bigint): State => ({ lamports, owner: '11111111111111111111111111111111', data: new Uint8Array() })
const enc = (a: string) => getAddressEncoder().encode(a as Address)
function tokenAccount(mint: string, owner: string, amount: bigint): State {
  const data = new Uint8Array(165)
  data.set(enc(mint), 0); data.set(enc(owner), 32)
  new DataView(data.buffer).setBigUint64(64, amount, true)
  data[108] = 1 // initialized
  return { lamports: 2_039_280n, owner: TOKEN_PROGRAM_ADDRESS, data }
}
const toRpc = (s: State) => (s ? { lamports: s.lamports, owner: s.owner, data: [Buffer.from(s.data).toString('base64'), 'base64'], executable: false, rentEpoch: 0n, space: BigInt(s.data.length) } : null)
function fakeRpc(pre: Record<string, State>, post: Record<string, State> = pre, tables: Record<string, string[]> = {}) {
  const sent: string[] = []
  const h: Record<string, (...a: unknown[]) => unknown> = {
    getMultipleAccounts: (addrs, cfg) => ((cfg as { encoding?: string } | undefined)?.encoding === 'base64'
      ? { value: (addrs as string[]).map((a) => toRpc(pre[a] ?? null)) }
      : { value: (addrs as string[]).map((a) => ({ data: { parsed: { info: { addresses: tables[a] ?? [] }, type: 'lookupTable' }, program: 'address-lookup-table' }, owner: 'AddressLookupTab1e1111111111111111111111111', executable: false, lamports: 1n, rentEpoch: 0n, space: 0n })) }),
    simulateTransaction: (_w, cfg) => ({ value: { err: null, unitsConsumed: 1000n, logs: [], accounts: (cfg as { accounts: { addresses: string[] } }).accounts.addresses.map((a) => toRpc((a in post ? post[a] : pre[a]) ?? null)) } }),
    getFeeForMessage: () => ({ value: FEE }),
    sendTransaction: (w) => { sent.push(w as string); return 'B'.repeat(87) },
  }
  const rpc = new Proxy({} as SolanaRpc, { get: (_t, m: string) => (...args: unknown[]) => ({ send: async () => { const f = h[m]; if (!f) throw new Error(`unmocked ${m}`); return f(...args) } }) })
  return { rpc, sent }
}
function wire(ixs: Instruction[], payer: Address = ADDR0): string {
  const msg = pipe(createTransactionMessage({ version: 0 }), (x) => setTransactionMessageFeePayer(payer, x),
    (x) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: BLOCKHASH as never, lastValidBlockHeight: 100n }, x),
    (x) => appendTransactionMessageInstructions(ixs, x)) as TransactionMessage
  return getBase64EncodedWireTransaction(compileTransaction(msg as never) as Transaction)
}
const ro = (address: Address) => ({ address, role: AccountRole.READONLY })
const w = (address: Address) => ({ address, role: AccountRole.WRITABLE })
/** Mayan Swift `init_order` data (swap-sdk InitSwiftLayout): amount, nativeInput, feeSubmit, destAddress, destChain, … */
function swiftOrder(recipient: string, wormholeChain: number): Uint8Array {
  const d = new Uint8Array(198)
  d.set(Buffer.from('204c290c27a284db', 'hex'), 0)
  new DataView(d.buffer).setBigUint64(8, AMOUNT_IN, true)
  d.set(Buffer.from(recipient.slice(2).padStart(64, '0'), 'hex'), 25)
  new DataView(d.buffer).setUint16(57, wormholeChain, true)
  new DataView(d.buffer).setBigUint64(91, 8_955_000n, true) // amountOutMin
  return d
}
const order = (recipient = RECIPIENT, chain = 30): Instruction => ({
  programAddress: SWIFT_V2,
  // trader, relayer, state, stateAccount (the vault), relayerAccount, mint
  accounts: [{ address: ADDR0, role: AccountRole.WRITABLE_SIGNER }, { address: ADDR0, role: AccountRole.WRITABLE_SIGNER }, w(STATE), w(VAULT), w(MY_USDC), ro(USDC)],
  data: swiftOrder(recipient, chain),
})
const intoVault = (to: Address = VAULT): Instruction => getTransferCheckedInstruction({ source: MY_USDC, mint: USDC, destination: to, authority: createNoopSigner(ADDR0), amount: 9_000_000n, decimals: 6 })
const proxied = (ix: Instruction): Instruction => ({ programAddress: MAYAN_CPI_PROXY_PROGRAM_ADDRESS as Address, accounts: [ro(ix.programAddress), ...(ix.accounts ?? [])], data: ix.data ?? new Uint8Array() })

async function account(pre: Record<string, State>) {
  const f = fakeRpc(pre)
  return { a: await new WalletManagerSolana(SEED, { provider: f.rpc }).getAccount(0), f }
}
const usdcPre = () => ({ [ADDR0]: sys(SOL), [MY_USDC]: tokenAccount(USDC, ADDR0, 100_000_000n), [VAULT]: tokenAccount(USDC, STATE, 0n), [ATTACKER]: sys(0n) })
const usdcGuard = (bridgeOut: object = BRIDGE) => ({ expect: { maxLamportsOut: ALLOWANCE, maxTokenOut: { mint: USDC, amount: 9_000_000n }, bridgeOut } as never })

describe('audit 2026-11-02: a bridge out of Solana must deliver to the reviewed recipient', () => {
  it('a plain SOL transfer of the whole input to another wallet is refused once the guard knows it is a bridge', async () => {
    const theft = wire([getTransferSolInstruction({ source: createNoopSigner(ADDR0), destination: ATTACKER, amount: AMOUNT_IN })])
    const { a, f } = await account({ [ADDR0]: sys(SOL), [ATTACKER]: sys(0n) })
    await expect(a.sendSerialized(theft, { expect: { maxLamportsOut: AMOUNT_IN + ALLOWANCE, bridgeOut: BRIDGE } })).rejects.toMatchObject({ code: 'bridge-missing' })
    // With a genuine order in front of it, the transfer itself is named.
    const withOrder = wire([intoVault(), order(), getTransferSolInstruction({ source: createNoopSigner(ADDR0), destination: ATTACKER, amount: AMOUNT_IN })])
    const { a: b } = await account(usdcPre())
    await expect(b.sendSerialized(withOrder, { expect: { maxLamportsOut: AMOUNT_IN + ALLOWANCE, maxTokenOut: { mint: USDC, amount: 9_000_000n }, bridgeOut: BRIDGE } })).rejects.toMatchObject({ code: 'bridge-payee', details: [ATTACKER] })
    expect(f.sent).toHaveLength(0)
  })

  it('an allowlisted Mayan program with opaque data is refused; a Swift order paying someone else, or another chain, is refused', async () => {
    const opaque: Instruction = { programAddress: MAYAN_PROGRAM_ADDRESSES[0] as Address, accounts: [{ address: ADDR0, role: AccountRole.WRITABLE_SIGNER }, w(ATTACKER)], data: new Uint8Array([0xde, 0xad, ...new Uint8Array(32).fill(0x66)]) }
    const track: Instruction = { programAddress: LIFI_TRACKING_PROGRAM_ADDRESS as Address, accounts: [], data: new Uint8Array([1]) }
    const { a } = await account(usdcPre())
    await expect(a.sendSerialized(wire([track, opaque]), { expect: { maxLamportsOut: AMOUNT_IN + ALLOWANCE, bridgeOut: BRIDGE } })).rejects.toMatchObject({ code: 'bridge-missing' })
    await expect(a.sendSerialized(wire([track, intoVault(), order(), opaque]), usdcGuard())).rejects.toMatchObject({ code: 'bridge-instruction' })
    await expect(a.sendSerialized(wire([intoVault(), order(`0x${'66'.repeat(20)}`)]), usdcGuard())).rejects.toMatchObject({ code: 'bridge-recipient' })
    await expect(a.sendSerialized(wire([intoVault(), order(RECIPIENT, 23)]), usdcGuard())).rejects.toMatchObject({ code: 'bridge-recipient' })
    // The input may go into the order's vault only, not into another token account.
    await expect(a.sendSerialized(wire([intoVault(ATTACKER), order()]), usdcGuard())).rejects.toMatchObject({ code: 'bridge-payee' })
  })

  it('a Swift order paying the recipient passes, directly and through the CPI proxy; the proxy no longer hides a transfer', async () => {
    const { a, f } = await account(usdcPre())
    await expect(a.sendSerialized(wire([intoVault(), order()]), usdcGuard())).resolves.toMatchObject({ hash: 'B'.repeat(87) })
    await expect(a.sendSerialized(wire([proxied(intoVault()), proxied(order())]), usdcGuard())).resolves.toMatchObject({ hash: 'B'.repeat(87) })
    expect(f.sent).toHaveLength(2)
    const hidden = wire([proxied(getTransferSolInstruction({ source: createNoopSigner(ADDR0), destination: ATTACKER, amount: AMOUNT_IN })), intoVault(), order()])
    expect(describeTransaction(decodeWireTransaction(hidden), { account: ADDR0 }).items[0]).toMatchObject({ type: 'sol-transfer', to: ATTACKER, lamports: AMOUNT_IN })
    await expect(a.sendSerialized(hidden, usdcGuard())).rejects.toMatchObject({ code: 'bridge-payee', details: [ATTACKER] })
    // A program allowlist that leaves the proxy out refuses it even though it runs an allowlisted program.
    await expect(a.sendSerialized(wire([proxied(intoVault()), order()]), { ...usdcGuard(), programAllowlist: [TOKEN_PROGRAM_ADDRESS, SWIFT_V2] })).rejects.toMatchObject({ code: 'unknown-program' })
  })

  it('a fee to LI.FI\'s fee wallet passes up to the bound; a larger one is refused', async () => {
    const fee = (amount: bigint) => getTransferCheckedInstruction({ source: MY_USDC, mint: USDC, destination: FEE_ATA, authority: createNoopSigner(ADDR0), amount, decimals: 6 })
    const pre = { ...usdcPre(), [FEE_ATA]: tokenAccount(USDC, LIFI_FEE_WALLET_ADDRESS, 0n) }
    const { a } = await account(pre)
    await expect(a.sendSerialized(wire([fee(22_500n), intoVault(), order()]), { expect: { maxLamportsOut: ALLOWANCE, maxTokenOut: { mint: USDC, amount: 9_022_500n }, bridgeOut: BRIDGE } })).resolves.toBeDefined()
    await expect(a.sendSerialized(wire([fee(1_000_000n), intoVault(), order()]), { expect: { maxLamportsOut: ALLOWANCE, maxTokenOut: { mint: USDC, amount: 10_000_000n }, bridgeOut: BRIDGE } })).rejects.toMatchObject({ code: 'bridge-fee' })
    // Another wallet named as the fee wallet is just another wallet.
    await expect(a.sendSerialized(wire([fee(22_500n), intoVault(), order()]), { expect: { maxLamportsOut: ALLOWANCE, maxTokenOut: { mint: USDC, amount: 9_022_500n }, bridgeOut: { ...BRIDGE, feeWallets: [ATTACKER] } } })).rejects.toMatchObject({ code: 'bridge-payee' })
  })

  it('a guard without bridgeOut behaves as before (same-chain swaps, staking, lending)', async () => {
    const { a } = await account({ [ADDR0]: sys(SOL), [ATTACKER]: sys(0n) })
    const transfer = wire([getTransferSolInstruction({ source: createNoopSigner(ADDR0), destination: ATTACKER, amount: 1n })])
    await expect(a.sendSerialized(transfer, { expect: { maxLamportsOut: AMOUNT_IN } })).resolves.toBeDefined()
    await expect(a.checkSerialized(transfer, { expect: { maxLamportsOut: 1n, bridgeOut: { destChain: 'eip155:8453' } as never } })).rejects.toMatchObject({ code: 'invalid-expectation' })
  })
})
const FEE_ATA = '8jjWmLhYdqrtFMcEkiMDdqkEN85cvEFnNS4LFgNf5NRv' as Address

// ── The live LI.FI transactions ────────────────────────────────────────────────────────────────────────────────────
// Their lookup-table contents were not recorded. The guard needs the programs behind the CPI proxy and the fee
// wallet, which this test fills in from what each instruction's data says it is (an ATA creation, a System transfer,
// a Mayan order, …) and, for the fee transfer whose destination sits in a table, LI.FI's fee wallet — the address the
// same routes pay as a static account on token sources. Every other table slot is a distinct placeholder.
type Live = { name: string; tool: string; sender: string; recipient: string; destChain: string; sourceToken: string; amountIn: string; wire: string }
const live = JSON.parse(readFileSync(new URL('./fixtures/lifi-solana-2026-11-02.json', import.meta.url), 'utf8')) as { quotes: Live[] }
const SYSTEM = '11111111111111111111111111111111'
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
const placeholder = (seed: string) => getAddressDecoder().decode(createHash('sha256').update(seed).digest()) as string

function tablesFor(q: Live): Record<string, string[]> {
  const tx = decodeWireTransaction(q.wire)
  const m = getCompiledTransactionMessageDecoder().decode(tx.messageBytes) as unknown as { staticAccounts: string[]; instructions: { programAddressIndex: number; accountIndices?: number[]; data?: Uint8Array }[]; addressTableLookups?: { lookupTableAddress: string; writableIndexes: number[]; readonlyIndexes: number[] }[] }
  const lookups = m.addressTableLookups ?? []
  const slots: Array<{ table: string; index: number }> = []
  for (const l of lookups) for (const i of l.writableIndexes) slots.push({ table: l.lookupTableAddress, index: i })
  for (const l of lookups) for (const i of l.readonlyIndexes) slots.push({ table: l.lookupTableAddress, index: i })
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
    else if (disc === '3635a7a4fa097b45' || disc === 'ebfc2bb26990c1a5') program = 'dkpZqrxHFrhziEMQ931GLtfy11nFkCsfMftH9u6QwBU'
    else if (disc === 'a766806a7976ba4c' || disc === 'ae29789262daa919') program = 'Gx9rivpS3YR8pBFwMuP6omYqVxunpLvLkNn7ubNyuZZ5'
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

describe('audit 2026-11-02: the live LI.FI routes out of Solana', () => {
  const run = async (q: Live) => {
    const wsol = 'umiAsegEDQeKMAfqPhqNxxYDsXo8fuhQy7HHE7viKud'
    const myUsdc = 'FzbcyEZ9m8xjtergWgWDq7mfPoHEbboBF791B6cTpzbq'
    const pre: Record<string, State> = { [q.sender]: sys(100n * SOL), [wsol]: tokenAccount(WSOL_MINT, q.sender, 0n), [myUsdc]: tokenAccount(USDC, q.sender, 10n ** 12n), [FEE_ATA]: tokenAccount(USDC, LIFI_FEE_WALLET_ADDRESS, 0n) }
    const f = fakeRpc(pre, pre, tablesFor(q))
    const a = new WalletAccountReadOnlySolana(q.sender, { provider: f.rpc })
    const native = q.sourceToken === SYSTEM
    const guard = { expect: { maxLamportsOut: (native ? BigInt(q.amountIn) : 0n) + ALLOWANCE, ...(native ? {} : { maxTokenOut: { mint: q.sourceToken, amount: BigInt(q.amountIn) } }), bridgeOut: { destChain: q.destChain, recipient: q.recipient } } }
    return a.checkSerialized(q.wire, guard).then(() => 'pass', (e: unknown) => (e instanceof UnsafeTransactionError ? `${e.code}` : String(e)))
  }

  it('every Mayan route (Swift, MCTP, Fast MCTP; SOL and USDC in) passes the bridge check', async () => {
    const mayan = live.quotes.filter((q) => q.tool.startsWith('mayan'))
    expect(mayan.length).toBeGreaterThanOrEqual(10)
    for (const q of mayan) expect([q.name, await run(q)]).toEqual([q.name, 'pass'])
  })

  it('the routes whose recipient lives in an off-chain order (NEAR Intents, LayerSwap, Relay) or in an unknown program are refused', async () => {
    const other = live.quotes.filter((q) => !q.tool.startsWith('mayan'))
    const got = Object.fromEntries(await Promise.all(other.map(async (q) => [q.name, await run(q)])))
    expect(got).toEqual({
      'sol-base-usdc-layerswap': 'bridge-missing', 'sol-base-usdc-relaydepository': 'bridge-missing', 'usdc-base-usdc-relaydepository': 'bridge-missing',
      'usdc-base-usdc-lifiIntents': 'unknown-program', 'sol-base-usdc': 'bridge-missing', 'usdc-arb-usdc': 'bridge-missing',
    })
  })

  it('a live Mayan route whose order is re-pointed at another recipient is refused', async () => {
    const q = live.quotes.find((k) => k.name === 'sol-base-usdc-mayan')!
    const bytes = Buffer.from(q.wire, 'base64')
    const at = bytes.indexOf(Buffer.from(RECIPIENT.slice(2), 'hex'))
    expect(at).toBeGreaterThan(0)
    bytes.fill(0x66, at, at + 20)
    expect(await run({ ...q, wire: bytes.toString('base64') })).toBe('bridge-recipient')
    expect(await run({ ...q, recipient: `0x${'66'.repeat(20)}` })).toBe('bridge-recipient')
    expect(await run({ ...q, destChain: 'eip155:42161' })).toBe('bridge-recipient')
  })
})
