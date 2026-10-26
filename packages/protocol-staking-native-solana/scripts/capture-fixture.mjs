#!/usr/bin/env node
// Turns a mainnet transaction into an activity fixture, through the same mapper the Solana history
// source uses (so `call`, `transfers` and `raw` look exactly like what the wallet feeds the module).
// `raw.tx` is trimmed to the top-level parsed instructions, the only part the module reads.
//
//   SOLANA_RPC=… node scripts/capture-fixture.mjs <signature> <wallet> <file> <kind> "<title>" "<note>"
import { writeFileSync } from 'node:fs'
import { mapHistoryTransaction } from '@anywalletkit/wallet-solana'

const [sig, wallet, file, kind, title, note] = process.argv.slice(2)
const RPC = process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com'
const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }] }) })
const tx = (await res.json()).result
if (!tx) throw new Error(`transaction ${sig} not found`)
const row = { signature: sig, slot: tx.slot, err: tx.meta.err, blockTime: tx.blockTime }
const mapped = mapHistoryTransaction('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', wallet, row, tx)
mapped.raw = { tx: { transaction: { message: { instructions: tx.transaction.message.instructions } } } }
const out = JSON.parse(JSON.stringify(mapped, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
const fixture = { note, own: [wallet], tx: out, expect: { kind, title } }
writeFileSync(file, JSON.stringify(fixture, null, 2) + '\n')
console.log(file, out.call?.to, out.transfers.length, 'transfers')
