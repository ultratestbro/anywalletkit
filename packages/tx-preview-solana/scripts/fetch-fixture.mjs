#!/usr/bin/env node
// Save a confirmed mainnet transaction as a test fixture: the wire bytes (base64), the lookup tables it used and the
// meta an explorer shows (fee, pre/post SOL and token balances, loaded addresses, inner instructions, error).
// Usage: SOLANA_RPC_URL=… node scripts/fetch-fixture.mjs <signature> <tests/fixtures/<group>/<name>.json> [note]
import { createSolanaRpc } from '@solana/kit'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const [signature, out, ...note] = process.argv.slice(2)
if (!signature || !out) { console.error('usage: fetch-fixture.mjs <signature> <out.json> [note]'); process.exit(2) }
const url = process.env.SOLANA_RPC_URL
if (!url) { console.error('SOLANA_RPC_URL is not set'); process.exit(2) }
const rpc = createSolanaRpc(url)
const tx = await rpc.getTransaction(signature, { encoding: 'base64', maxSupportedTransactionVersion: 1, commitment: 'finalized' }).send()
if (!tx) { console.error(`not found: ${signature}`); process.exit(1) }
const parsed = await rpc.getTransaction(signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'finalized' }).send()
const m = tx.meta
const lookups = parsed.transaction.message.addressTableLookups ?? []
const fixture = {
  signature, slot: tx.slot, blockTime: tx.blockTime, version: tx.version, note: note.join(' ') || undefined,
  wire: tx.transaction[0],
  // Each referenced table's entries at the indices the transaction used, rebuilt from loadedAddresses (the table may
  // have been extended or closed since): enough to decode this transaction offline.
  lookupTables: (() => {
    const tables = {}
    let w = 0, r = 0
    for (const l of lookups) { tables[l.accountKey] ??= [] }
    for (const l of lookups) for (const i of l.writableIndexes) tables[l.accountKey][i] = m.loadedAddresses.writable[w++]
    for (const l of lookups) for (const i of l.readonlyIndexes) tables[l.accountKey][i] = m.loadedAddresses.readonly[r++]
    return tables
  })(),
  meta: {
    err: m.err, fee: m.fee, computeUnitsConsumed: m.computeUnitsConsumed,
    preBalances: m.preBalances, postBalances: m.postBalances,
    preTokenBalances: m.preTokenBalances, postTokenBalances: m.postTokenBalances,
    loadedAddresses: m.loadedAddresses ?? { writable: [], readonly: [] },
    innerInstructions: parsed.meta.innerInstructions,
    logMessages: m.logMessages,
  },
}
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify(fixture, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n')
console.log(`saved ${signature} (v${tx.version}, slot ${tx.slot}) → ${out}`)
