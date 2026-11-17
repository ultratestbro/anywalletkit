import { lookupTableAddresses, normalizeTransaction, decodeNormalized, type DecodeOptions, type LookupTables, type TransactionInput } from './decode.js'
import { defaultRegistry } from './defaults.js'
import { fetchLookupTables, simulateNormalized, type Commitment, type PreviewRpc } from './simulate.js'
import type { PreviewWarning, TransactionPreview } from './types.js'

export interface DescribeOptions extends DecodeOptions {
  /** An RPC (`createSolanaRpc(url)`): resolves lookup tables and simulates. Without it the preview is decoded offline only. */
  readonly rpc?: PreviewRpc | undefined
  /** Simulate when an RPC is given. Default true. */
  readonly simulate?: boolean | undefined
  readonly commitment?: Commitment | undefined
  readonly abortSignal?: AbortSignal | undefined
}

/**
 * What a transaction will do, before it is signed: every instruction decoded (lookup tables read through `rpc` when
 * they were not passed), and — with an `rpc` — a simulation with the signer's SOL and token balance changes and the
 * inner instructions the programs would run. A failed simulation is reported, not thrown; only transport errors throw.
 *
 * ```ts
 * const preview = await describeTransaction(base64Tx, { rpc: createSolanaRpc(url), signer: wallet.address })
 * ```
 */
export async function describeTransaction(input: TransactionInput, options: DescribeOptions = {}): Promise<TransactionPreview> {
  const registry = options.registry ?? defaultRegistry
  let tables: LookupTables = options.lookupTables ?? {}
  if (options.rpc) {
    const missing = lookupTableAddresses(input).filter((t) => !tables[t])
    if (missing.length) {
      const fetched = await fetchLookupTables(options.rpc, missing, { ...(options.commitment ? { commitment: options.commitment } : {}), ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}) })
      tables = { ...tables, ...fetched }
    }
  }
  const n = normalizeTransaction(input, tables)
  const decoded = decodeNormalized(n, { ...options, registry })
  if (!options.rpc || options.simulate === false) return { ...decoded, simulation: null }

  const warnings: PreviewWarning[] = [...decoded.warnings]
  if (!n.transaction) {
    warnings.push({ code: 'simulation-unavailable', message: 'Not simulated: the message has no fee payer or no lifetime yet.' })
    return { ...decoded, warnings, simulation: null }
  }
  const simulation = await simulateNormalized(options.rpc, n, {
    signer: options.signer ?? null, registry,
    ...(options.commitment ? { commitment: options.commitment } : {}), ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
  })
  if (!simulation.ok) warnings.push({ code: 'simulation-failed', message: `The simulation failed: ${JSON.stringify(simulation.error, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}.` })
  if (simulation.balances === null) warnings.push({ code: 'balances-unavailable', message: 'The RPC returned no pre/post balances: balance changes are unknown.' })
  return { ...decoded, warnings, simulation }
}
