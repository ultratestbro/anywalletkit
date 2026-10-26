#!/usr/bin/env node
// Captures activity fixtures from mainnet: recent staking events → their transactions → those sent
// straight to the precompile by an EOA, one per delegator selector, mapped to ChainTx exactly as
// history-evm's RPC path does (receipt kept in raw).
//
//   node scripts/capture-fixtures.mjs <rpcUrl> <outDir>
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildTx, txRowFromRpc } from '@anywalletkit/history-evm'
import { createPublicClient, http, toEventSelector } from 'viem'
import { SELECTORS, STAKING_PRECOMPILE, TOPICS } from '../dist/index.js'

const [rpc, out] = process.argv.slice(2)
const client = createPublicClient({ transport: http(rpc, { timeout: 30_000, retryCount: 3 }) })
const raw = (method, params) => client.request({ method, params })
const want = new Map(Object.entries(SELECTORS).map(([fn, sel]) => [sel, fn]))
const got = new Map()
const seen = new Set()
// Only the delegator events (every block also emits ValidatorRewarded from a system call).
const topics = [[TOPICS.Delegate, TOPICS.Undelegate, TOPICS.Withdraw, toEventSelector('ClaimRewards(uint64,address,uint256,uint64)')]]
let to = await client.getBlockNumber()
for (let i = 0; i < 400 && got.size < want.size; i++) {
  if (i % 50 === 0) console.error(`window ${i}, found ${[...got.keys()].join(',') || 'none'}`)
  const from = to - 599n
  const logs = await raw('eth_getLogs', [{ address: STAKING_PRECOMPILE, topics, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }]).catch(() => [])
  to = from - 1n
  for (const hash of [...new Set(logs.map((l) => l.transactionHash))]) {
    if (got.size >= want.size) break
    if (seen.has(hash)) continue
    seen.add(hash)
    const tx = await raw('eth_getTransactionByHash', [hash])
    if (!tx || tx.to?.toLowerCase() !== STAKING_PRECOMPILE) continue
    const fn = want.get(tx.input.slice(0, 10))
    if (!fn || got.has(fn)) continue
    if (await client.getCode({ address: tx.from })) continue // smart wallets aside
    const receipt = await raw('eth_getTransactionReceipt', [hash])
    const block = await raw('eth_getBlockByNumber', [tx.blockNumber, false])
    got.set(fn, { tx, receipt, time: Number(BigInt(block.timestamp)) })
  }
}
const kinds = { delegate: ['stake', 'Staked MON'], undelegate: ['unstake', 'Requested unstake'], withdraw: ['claim', 'Withdrew unstaked MON'], compound: ['stake', 'Compounded'], claimRewards: ['claim', 'Claimed staking rewards'] }
for (const [fn, { tx, receipt, time }] of got) {
  const row = txRowFromRpc(tx, receipt, time)
  const item = buildTx({ chain: 'eip155:143', chainId: 143, address: tx.from, source: 'etherscan' }, tx.hash, row, [], [])
  const json = JSON.parse(JSON.stringify(item, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
  const [kind, title] = kinds[fn]
  const fixture = { note: `${fn} sent straight to the staking precompile (Monad mainnet, block ${BigInt(tx.blockNumber)})`, own: [tx.from], tx: json, expect: { kind, title } }
  writeFileSync(join(out, `${fn}.json`), JSON.stringify(fixture, null, 2) + '\n')
  console.log(fn, tx.hash, 'logs', receipt.logs.length, 'topics', receipt.logs.map((l) => l.topics[0].slice(0, 10)).join(','))
}
console.log('missing:', [...want.values()].filter((fn) => !got.has(fn)).join(', ') || 'none')
