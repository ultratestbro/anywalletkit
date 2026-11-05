#!/usr/bin/env node
// Captures activity fixtures from Ethereum, read-only: each hash's transaction, receipt and block,
// mapped to ChainTx exactly as history-evm's RPC path does (Transfer logs from the receipt), with
// crvUSD / scrvUSD symbols filled in. The expectation is what the module answers, printed for review.
//
//   node scripts/capture-fixtures.mjs <rpcUrl> <outDir> <name>=<hash> [<name>=<hash> …]
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildTx, parseReceiptTransfers, txRowFromRpc } from '@anywalletkit/history-evm'
import { createPublicClient, http } from 'viem'
import { describeCurveLendingActivity, SCRVUSD } from '../dist/index.js'

const [rpc, out, ...pairs] = process.argv.slice(2)
if (!rpc || !out || pairs.length === 0) throw new Error('usage: capture-fixtures.mjs <rpcUrl> <outDir> <name>=<hash> …')
const client = createPublicClient({ transport: http(rpc, { timeout: 30_000, retryCount: 3 }) })
const raw = (method, params) => client.request({ method, params })
const META = { [SCRVUSD.asset.toLowerCase()]: { symbol: 'crvUSD', decimals: 18 }, [SCRVUSD.vault.toLowerCase()]: { symbol: 'scrvUSD', decimals: 18 } }

for (const pair of pairs) {
  const [name, hash] = pair.split('=')
  const tx = await raw('eth_getTransactionByHash', [hash])
  const receipt = await raw('eth_getTransactionReceipt', [hash])
  const block = await raw('eth_getBlockByNumber', [tx.blockNumber, false])
  const row = txRowFromRpc(tx, receipt, Number(BigInt(block.timestamp)))
  const tokens = parseReceiptTransfers(receipt, row).map((t) => ({ ...t, ...(META[t.token.toLowerCase()] ?? {}) }))
  const item = buildTx({ chain: 'eip155:1', chainId: 1, address: tx.from, source: 'etherscan' }, tx.hash, row, tokens, [])
  const json = JSON.parse(JSON.stringify(item, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
  delete json.raw
  const own = [tx.from]
  const described = describeCurveLendingActivity({ ...item }, { own: new Set([tx.from, tx.from.toLowerCase()]) })
  const expect = described
    ? { kind: described.kind, title: described.title, ...(described.assetsIn.length ? { assetsIn: described.assetsIn.map((a) => ({ token: a.token, amount: String(a.amount) })) } : {}), ...(described.assetsOut.length ? { assetsOut: described.assetsOut.map((a) => ({ token: a.token, amount: String(a.amount) })) } : {}), counterparty: described.counterparty }
    : null
  const fixture = { note: `${name}: Ethereum block ${BigInt(tx.blockNumber)}, etherscan.io/tx/${hash.slice(0, 10)}…`, own, tx: json, expect }
  writeFileSync(join(out, `${name}.json`), JSON.stringify(fixture, null, 2) + '\n')
  console.log(name, hash, 'selector', tx.input.slice(0, 10), 'transfers', tokens.length, '→', expect?.kind, expect?.title)
}
