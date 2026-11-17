/**
 * The network part: lookup tables read from an RPC, `simulateTransaction`, and balance changes computed from
 * pre/post balances — the same computation for a simulation and for a confirmed transaction's meta, which is how
 * the fixture suite checks it against what explorers show.
 */
import {
  address, getBase58Encoder, getBase64EncodedWireTransaction, getBase64Encoder,
  type Base64EncodedWireTransaction, type Rpc, type SolanaRpcApi,
} from '@solana/kit'
import { getAddressLookupTableDecoder } from '@solana-program/address-lookup-table'
import { decodeInstruction, rawInstruction, type LookupTables, type NormalizedTransaction } from './decode.js'
import { ADDRESS_LOOKUP_TABLE_PROGRAM } from './decoders/official.js'
import type { DecoderRegistry } from './registry.js'
import type { BalanceChanges, DecodedInstruction, MessageAccount, PreviewValue, SimulationPreview, SolBalanceChange, TokenBalanceChange } from './types.js'
import { toPreviewValue } from './values.js'

/** The RPC methods this package calls. Any `@solana/kit` RPC (`createSolanaRpc(url)`) fits. */
export type PreviewRpc = Rpc<Pick<SolanaRpcApi, 'getMultipleAccounts' | 'simulateTransaction'>>

export type Commitment = 'processed' | 'confirmed' | 'finalized'

/**
 * Read address lookup tables. A table that does not exist, is not owned by the Address Lookup Table program or
 * does not decode is left out (its accounts then stay unresolved and the preview says so).
 */
export async function fetchLookupTables(rpc: PreviewRpc, addresses: readonly string[], options: { commitment?: Commitment; abortSignal?: AbortSignal } = {}): Promise<LookupTables> {
  const unique = [...new Set(addresses)]
  if (!unique.length) return {}
  const decoder = getAddressLookupTableDecoder()
  const out: Record<string, readonly string[]> = {}
  for (let i = 0; i < unique.length; i += 100) {
    const batch = unique.slice(i, i + 100)
    const { value } = await rpc.getMultipleAccounts(batch.map((a) => address(a)), { encoding: 'base64', commitment: options.commitment ?? 'confirmed' })
      .send(options.abortSignal ? { abortSignal: options.abortSignal } : undefined)
    value.forEach((account, j) => {
      if (!account || account.owner !== ADDRESS_LOOKUP_TABLE_PROGRAM) return
      try {
        const table = decoder.decode(getBase64Encoder().encode(account.data[0]))
        out[batch[j]!] = table.addresses.map((a) => a as string)
      } catch {
        /* not a lookup table */
      }
    })
  }
  return out
}

/** Pre/post balances as an RPC reports them (simulateTransaction, or getTransaction's meta). */
export interface BalanceSnapshot {
  readonly preBalances: readonly (bigint | number)[] | null | undefined
  readonly postBalances: readonly (bigint | number)[] | null | undefined
  readonly preTokenBalances: readonly RpcTokenBalance[] | null | undefined
  readonly postTokenBalances: readonly RpcTokenBalance[] | null | undefined
}

export interface RpcTokenBalance {
  readonly accountIndex: number
  readonly mint: string
  readonly owner?: string | undefined
  readonly programId?: string | undefined
  readonly uiTokenAmount: { readonly amount: string; readonly decimals: number }
}

/**
 * Balance changes from pre/post balances. `accountKeys` is the message's account list in order (static keys, then
 * the lookups' writable, then readonly addresses — what `loadedAddresses` lists). A token account that exists on one
 * side only (created or closed) counts from or to zero. Returns `null` when the balances are missing.
 */
export function computeBalanceChanges(accountKeys: readonly (string | null)[], snapshot: BalanceSnapshot, signer?: string | null): BalanceChanges | null {
  const { preBalances, postBalances } = snapshot
  if (!preBalances || !postBalances) return null
  const sol: SolBalanceChange[] = []
  for (let i = 0; i < Math.min(preBalances.length, postBalances.length, accountKeys.length); i++) {
    const key = accountKeys[i]
    if (!key) continue
    const pre = BigInt(preBalances[i]!)
    const post = BigInt(postBalances[i]!)
    if (pre !== post) sol.push({ account: key, pre, post, delta: post - pre })
  }
  const byAccount = new Map<number, { pre?: RpcTokenBalance; post?: RpcTokenBalance }>()
  for (const b of snapshot.preTokenBalances ?? []) byAccount.set(b.accountIndex, { ...byAccount.get(b.accountIndex), pre: b })
  for (const b of snapshot.postTokenBalances ?? []) byAccount.set(b.accountIndex, { ...byAccount.get(b.accountIndex), post: b })
  const tokens: TokenBalanceChange[] = []
  for (const [index, { pre, post }] of [...byAccount.entries()].sort((a, b) => a[0] - b[0])) {
    const key = accountKeys[index]
    const ref = post ?? pre!
    if (!key) continue
    const before = pre ? BigInt(pre.uiTokenAmount.amount) : 0n
    const after = post ? BigInt(post.uiTokenAmount.amount) : 0n
    if (before === after && pre && post) continue
    tokens.push({
      account: key, mint: ref.mint, owner: ref.owner ?? null, tokenProgram: ref.programId ?? null, decimals: ref.uiTokenAmount.decimals,
      pre: before, post: after, delta: after - before,
    })
  }
  let mine: BalanceChanges['signer'] = null
  if (signer) {
    const at = accountKeys.indexOf(signer)
    const solDelta = at >= 0 && at < preBalances.length && at < postBalances.length ? BigInt(postBalances[at]!) - BigInt(preBalances[at]!) : 0n
    const perMint = new Map<string, { decimals: number; delta: bigint }>()
    for (const t of tokens) {
      if (t.owner !== signer) continue
      const prev = perMint.get(t.mint)
      perMint.set(t.mint, { decimals: t.decimals, delta: (prev?.delta ?? 0n) + t.delta })
    }
    mine = { address: signer, sol: solDelta, tokens: [...perMint.entries()].filter(([, v]) => v.delta !== 0n).map(([mint, v]) => ({ mint, ...v })) }
  }
  return { sol, tokens, signer: mine }
}

/** The wire form a simulation sends: the compiled transaction, or the message compiled with all-empty signatures. */
function wireOf(n: NormalizedTransaction): Base64EncodedWireTransaction {
  if (n.transaction) return getBase64EncodedWireTransaction(n.transaction)
  throw new Error('tx-preview-solana: a transaction message needs a fee payer and a lifetime to be simulated — set both, or pass the compiled transaction')
}

/**
 * Inner instructions as `simulateTransaction` returns them: always in the RPC's jsonParsed form — `parsed` for the
 * programs the RPC knows (System, Token…), `{programId, accounts, data}` (base58) for the others. Older RPCs send
 * the compiled form (`programIdIndex`, account indices).
 */
type RpcInnerInstruction =
  | { programIdIndex: number; accounts: readonly number[]; data: string }
  | { programId: string; accounts: readonly string[]; data: string }
  | { programId: string; program?: string; parsed: unknown }
interface RpcInner { index: number; instructions: readonly RpcInnerInstruction[] }

const pascal = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

function decodeInner(ix: RpcInnerInstruction, j: number, accounts: readonly MessageAccount[], registry: DecoderRegistry): DecodedInstruction {
  const bytes = (data: string): Uint8Array => { try { return new Uint8Array(getBase58Encoder().encode(data)) } catch { return new Uint8Array() } }
  if ('programIdIndex' in ix) return decodeInstruction(rawInstruction(accounts, ix.programIdIndex, ix.accounts, bytes(ix.data)), j, registry)
  const role = (address: string) => accounts.find((a) => a.address === address)
  if ('parsed' in ix) {
    // The RPC decoded it and dropped the raw bytes: its reading is shown as such (`parsedByRpc`).
    const parsed = ix.parsed as { type?: unknown; info?: unknown } | string
    const name = typeof parsed === 'object' && parsed && typeof parsed.type === 'string' ? pascal(parsed.type) : null
    const info = typeof parsed === 'object' && parsed ? toPreviewValue(parsed.info) : toPreviewValue(parsed)
    return {
      index: j, programAddress: ix.programId, programName: registry.get(ix.programId)?.programName ?? ix.program ?? null, name, decoded: name !== null,
      args: info !== null && typeof info === 'object' && !Array.isArray(info) ? (info as Record<string, PreviewValue>) : { value: info }, accounts: [], data: '', parsedByRpc: true,
    }
  }
  return decodeInstruction({
    programAddress: ix.programId,
    accounts: ix.accounts.map((address) => { const a = role(address); return { address, signer: a?.signer ?? false, writable: a?.writable ?? false } }),
    data: bytes(ix.data),
  }, j, registry)
}

/**
 * Simulate through `rpc` (signatures not verified, blockhash replaced, inner instructions on) and read what it would
 * do. The message's lookup-table accounts come back in `loadedAddresses`; they complete the account list the balance
 * changes and inner instructions refer to. Throws only for transport errors: an on-chain failure is `ok: false`.
 */
export async function simulateNormalized(
  rpc: PreviewRpc,
  n: NormalizedTransaction,
  options: { signer?: string | null | undefined; registry: DecoderRegistry; commitment?: Commitment | undefined; abortSignal?: AbortSignal | undefined },
): Promise<SimulationPreview> {
  const wire = wireOf(n)
  const { value } = await rpc.simulateTransaction(wire, {
    encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, innerInstructions: true, commitment: options.commitment ?? 'confirmed',
  } as never).send(options.abortSignal ? { abortSignal: options.abortSignal } : undefined)
  const v = value as unknown as {
    err: unknown; logs: string[] | null; unitsConsumed?: bigint; fee?: bigint | number | null
    loadedAddresses?: { writable: readonly string[]; readonly: readonly string[] } | null
    innerInstructions?: readonly RpcInner[] | null
  } & BalanceSnapshot
  // Static keys, then the loaded writable, then the loaded readonly addresses: the RPC's own resolution of the lookups,
  // used only when it accounts for every lookup entry (some RPCs answer with empty lists).
  const statics = n.accounts.filter((a) => a.lookupTable === undefined)
  const lookupCount = n.accounts.length - statics.length
  const loaded = v.loadedAddresses
  const accounts: MessageAccount[] = loaded && lookupCount > 0 && loaded.writable.length + loaded.readonly.length === lookupCount
    ? [
        ...statics,
        ...loaded.writable.map((address) => ({ address, signer: false, writable: true })),
        ...loaded.readonly.map((address) => ({ address, signer: false, writable: false })),
      ]
    : [...n.accounts]
  const keys = accounts.map((a) => a.address)
  const inner = (v.innerInstructions ?? []).map((group) => ({
    index: group.index,
    instructions: group.instructions.map((ix, j) => decodeInner(ix, j, accounts, options.registry)),
  }))
  return {
    ok: v.err === null || v.err === undefined,
    error: v.err === null || v.err === undefined ? null : (toPreviewValue(v.err) as PreviewValue),
    logs: v.logs ?? [],
    unitsConsumed: v.unitsConsumed === undefined ? null : BigInt(v.unitsConsumed),
    fee: v.fee === null || v.fee === undefined ? null : BigInt(v.fee),
    balances: computeBalanceChanges(keys, v, options.signer ?? n.feePayer),
    innerInstructions: inner,
  }
}
