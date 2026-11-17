/**
 * The checks `examples/hermes-smoke` runs inside the Hermes VM, shared with Node: each case decodes a saved mainnet
 * fixture (or synthetic bytes) and runs `computeBalanceChanges`, then renders the result as one canonical string.
 * `hermes-snapshot.test.ts` pins Node's strings in `hermes-expected.json`; the smoke compares Hermes's strings to
 * the same file. The package API is passed in, so the smoke exercises the built package and Node the source.
 */
import createMintExtensions from './fixtures/token-2022/create-mint-extensions.json'
import transferCheckedWithFee from './fixtures/token-2022/transfer-checked-with-fee.json'
import rentReclaim from './fixtures/token-2022/rent-reclaim.json'
import v0Tables from './fixtures/messages/v0-lookup-tables.json'
import memoV2 from './fixtures/memo/memo-v2.json'
import unwrapLamports from './fixtures/token/unwrap-lamports.json'
import type * as Api from '../src/index.js'

type Fixture = { wire: string; lookupTables: Record<string, (string | null)[]>; meta: { preBalances: Array<string | number>; postBalances: Array<string | number>; preTokenBalances: unknown[]; postTokenBalances: unknown[]; loadedAddresses: { writable: string[]; readonly: string[] } } }

/** One string per value: bigints marked with `n`, Uint8Arrays as their bytes, key order as produced. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? `${v.toString()}n` : v instanceof Uint8Array ? Array.from(v) : v))
}

function balances(api: typeof Api, f: Fixture) {
  const d = api.decodeTransaction(f.wire)
  const keys = [...d.accounts.filter((a) => a.lookupTable === undefined).map((a) => a.address), ...f.meta.loadedAddresses.writable, ...f.meta.loadedAddresses.readonly]
  return api.computeBalanceChanges(keys, {
    preBalances: f.meta.preBalances.map((b) => BigInt(b)), postBalances: f.meta.postBalances.map((b) => BigInt(b)),
    preTokenBalances: f.meta.preTokenBalances as never, postTokenBalances: f.meta.postTokenBalances as never,
  }, d.feePayer)
}

/** Case name → canonical result. */
export function hermesCases(api: typeof Api): Record<string, string> {
  const out: Record<string, string> = {}
  const fixtures: Array<[string, Fixture]> = [
    ['legacy Token-2022 mint with extensions', createMintExtensions as Fixture],
    ['legacy Token-2022 TransferCheckedWithFee', transferCheckedWithFee as Fixture],
    ['v1 rent reclaim (config + 16 instructions)', rentReclaim as Fixture],
    ['v0 with lookup tables', v0Tables as Fixture],
    ['v0 swap + UnwrapLamports', unwrapLamports as Fixture],
    ['memo v2', memoV2 as Fixture],
  ]
  for (const [name, f] of fixtures) {
    out[`decode: ${name}`] = canonical(api.decodeTransaction(f.wire, { lookupTables: f.lookupTables as Api.LookupTables }))
    out[`balances: ${name}`] = canonical(balances(api, f))
  }
  // v0 without its tables: unresolved warning, null addresses.
  out['decode: v0 without tables'] = canonical(api.decodeTransaction(v0Tables.wire))
  // Amounts past 2^53 and 2^64 stay exact: an unlimited Approve (u64::MAX) and balances above 2^64.
  const approve = new Uint8Array(9)
  approve[0] = 4
  approve.fill(0xff, 1)
  const owner = { address: 'Fi11er1111111111111111111111111111111111111', signer: true, writable: false }
  const ix = api.decodeInstruction({ programAddress: api.TOKEN_PROGRAM, accounts: [{ ...owner, signer: false, writable: true }, { ...owner, signer: false }, owner], data: approve }, 0)
  out['decode: Approve u64::MAX'] = canonical([ix.name, ix.args, ix.args.amount === api.MAX_U64])
  const big = (1n << 70n) + 12_345n
  out['balances: above 2^64'] = canonical(api.computeBalanceChanges(['Fi11er1111111111111111111111111111111111111'], {
    preBalances: [big], postBalances: [big - (1n << 60n)],
    preTokenBalances: [{ accountIndex: 0, mint: 'So11111111111111111111111111111111111111112', owner: 'Fi11er1111111111111111111111111111111111111', uiTokenAmount: { amount: big.toString(), decimals: 9 } }],
    postTokenBalances: [],
  }, 'Fi11er1111111111111111111111111111111111111'))
  return out
}
