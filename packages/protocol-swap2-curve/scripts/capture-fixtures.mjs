#!/usr/bin/env node
// Captures one activity fixture per chain from mainnet, read-only: recent router `Exchange` logs → a transaction an EOA
// sent straight to the pinned router, paying itself → mapped to ChainTx the way history-evm's RPC path does
// (transfers from the receipt's Transfer logs; the receipt itself is not kept).
//
//   node scripts/capture-fixtures.mjs <chainId> <rpcUrl> <outDir> [windowBlocks] [windows]      (build first)
import {writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {buildTx, parseReceiptTransfers, txRowFromRpc} from '@anywalletkit/history-evm'
import {decodeAbiParameters} from 'viem'
import {CURVE_DEPLOYMENTS, EXCHANGE_TOPIC, ROUTER_SELECTORS} from '../dist/index.js'

const [chainArg, rpc, out, windowArg, windowsArg] = process.argv.slice(2)
const chainId = Number(chainArg)
const d = CURVE_DEPLOYMENTS[chainId]
if (!d || !rpc || !out) throw new Error('usage: capture-fixtures.mjs <chainId> <rpcUrl> <outDir> [windowBlocks] [windows]')
const WINDOW = BigInt(windowArg ?? 500)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function call(method, params) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(rpc, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params}), signal: AbortSignal.timeout(30_000)})
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      if (body.error) throw Object.assign(new Error(body.error.message), {rpc: true})
      return body.result
    } catch (e) {
      if (e.rpc || attempt >= 4) throw e
      await sleep(1000 * 2 ** attempt)
    }
  }
}
const hex = (n) => `0x${n.toString(16)}`
let to = BigInt(await call('eth_blockNumber', []))
for (let i = 0; i < Number(windowsArg ?? 40); i++) {
  const from = to - WINDOW + 1n
  const logs = await call('eth_getLogs', [{address: d.router, topics: [EXCHANGE_TOPIC[d.family]], fromBlock: hex(from), toBlock: hex(to)}]).catch(() => [])
  to = from - 1n
  for (const log of logs.reverse()) {
    if (log.topics[1] !== log.topics[2]) continue // the sender paid itself
    const tx = await call('eth_getTransactionByHash', [log.transactionHash])
    if (!tx || tx.to?.toLowerCase() !== d.router.toLowerCase() || !ROUTER_SELECTORS[d.family].has(tx.input.slice(0, 10))) continue
    if ((await call('eth_getCode', [tx.from, 'latest'])) !== '0x') continue // smart wallets aside
    const receipt = await call('eth_getTransactionReceipt', [log.transactionHash])
    const block = await call('eth_getBlockByNumber', [tx.blockNumber, false])
    const row = txRowFromRpc(tx, receipt, Number(BigInt(block.timestamp)))
    // A native output is an internal transfer the receipt does not show: rebuilt from the router's own Exchange log
    // (last route token = the native sentinel, out_amount to the receiver), as an explorer's internal-tx list has it.
    const types = d.family === 'ng5'
      ? [{type: 'address[11]'}, {type: 'uint256[5][5]'}, {type: 'address[5]'}, {type: 'uint256'}, {type: 'uint256'}]
      : [{type: 'address[11]'}, {type: 'uint256[4][5]'}, {type: 'uint256'}, {type: 'uint256'}]
    const ev = decodeAbiParameters(types, log.data)
    const route = ev[0]
    let k = 0
    while (k < 5 && route[2 * k + 1] !== '0x0000000000000000000000000000000000000000') k++
    const internal = route[2 * k].toLowerCase() === d.eth.toLowerCase()
      ? [{hash: tx.hash, block: row.block, time: row.time, from: d.router.toLowerCase(), to: `0x${log.topics[2].slice(-40)}`, value: ev[ev.length - 1], raw: {fromExchangeLog: true}}]
      : []
    const item = buildTx({chain: `eip155:${chainId}`, chainId, address: tx.from, source: 'etherscan'}, tx.hash, row, parseReceiptTransfers(receipt, row), internal)
    // Both legs visible.
    if (!item.transfers.some((t) => t.to.toLowerCase() === tx.from.toLowerCase()) || !item.transfers.some((t) => t.from.toLowerCase() === tx.from.toLowerCase())) continue
    delete item.raw
    const json = JSON.parse(JSON.stringify(item, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
    const fixture = {note: `Curve Router NG ${d.version} exchange (${tx.input.slice(0, 10)}) on ${d.label}, block ${BigInt(tx.blockNumber)} (public tx)`, own: [tx.from], tx: json, expect: {kind: 'swap', title: 'Swapped'}}
    const file = join(out, `${d.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${d.family}-exchange.json`)
    writeFileSync(file, JSON.stringify(fixture, null, 2) + '\n')
    console.log(file, tx.hash, tx.input.slice(0, 10), 'transfers', item.transfers.length)
    process.exit(0)
  }
  await sleep(200)
}
console.log('no matching transaction found')
process.exit(1)
