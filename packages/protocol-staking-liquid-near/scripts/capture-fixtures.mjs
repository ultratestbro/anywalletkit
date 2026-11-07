#!/usr/bin/env node
// Captures activity fixtures from mainnet: each transaction below is read with EXPERIMENTAL_tx_status
// from an archival RPC (read-only), mapped to ChainTx exactly as wallet-near's history does
// (mapRpcTxStatus, outcome kept in raw.rpc), dated from its block and written as a conformance fixture.
//
//   node scripts/capture-fixtures.mjs [outDir] [archivalRpcUrl]
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mapRpcTxStatus } from '@anywalletkit/wallet-near'

const out = process.argv[2] ?? new URL('../fixtures/activity/', import.meta.url).pathname
const RPC = process.argv[3] ?? 'https://archival-rpc.mainnet.fastnear.com'
const sleep = (ms) => new Promise((s) => setTimeout(s, ms))

async function rpc(method, params) {
  for (let i = 0; i < 10; i++) {
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'f', method, params }) })
    if (r.status === 429 || r.status >= 500) { await sleep(1500 * (i + 1)); continue }
    const j = await r.json()
    if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 200)}`)
    return j.result
  }
  throw new Error(`${method}: rate limited`)
}

// [file, hash, signer, note, expect, own?]. `own` defaults to the signer.
const LINEAR = 'linear-protocol.near'
const RNEAR = 'lst.rhealab.near'
const FIXTURES = [
  ['rnear-deposit_and_stake.json', 'CuKCxV5AhyDMjbDAvf9iQ8fFCtrAVLRGeDuyV1KhufT9', 'd906490203031e3ae4ea6e3cb7b2ecbd5403c4b18d78cb6f5f8b503ae25cc75c',
    'rNEAR deposit_and_stake of 1.64 NEAR by an implicit account, no storage_deposit (block 223520125)',
    { kind: 'stake', title: 'Staked NEAR for rNEAR', assetsOut: [{ token: null, amount: '1639910570742824242408482' }], assetsIn: [{ token: RNEAR, amount: '1534909765973083758154606' }], counterparty: RNEAR }],
  ['rnear-deposit_and_stake-then-ft_transfer_call.json', 'CX5xcJTqM8LYtmCzsaoR3uFbGTMtBxSENJKYAk7TxnR4', '59583199fc8d2b7207ad71f5213b3e7c917cbf07579d0e63fe1d7cebd9a2cd00',
    'rNEAR deposit_and_stake of 25 NEAR, the minted rNEAR forwarded with ft_transfer_call in the same transaction (block 223498196)',
    { kind: 'stake', title: 'Staked NEAR for rNEAR', assetsOut: [{ token: null, amount: '25000000000000000000000000' }], counterparty: RNEAR }],
  ['rnear-unstake_all.json', '8uZ8QqWHWTmyrwznYsnATyzHk9cfPaxv75kPus4EaRzW', 'vchieu05.near',
    'rNEAR unstake_all of ~4002.7 NEAR; unlock epoch 4950 (block 223512832)',
    { kind: 'unstake', title: 'Requested unstake', assetsOut: [{ token: RNEAR, amount: '3746416480622344374169020801' }], counterparty: RNEAR }],
  ['rnear-withdraw_all.json', 'HFQpERXuaJHN69oHbRHm4CFytPSXabQ2r6sHjEqEHZu6', 'vchieu05.near',
    'rNEAR withdraw_all paying ~4003.7 NEAR (amount from the contract\'s withdraw event) (block 223493860)',
    { kind: 'claim', title: 'Withdrew unstaked NEAR', assetsIn: [{ token: null, amount: '4003709998720749762441081712' }], counterparty: RNEAR }],
  ['rnear-withdraw.json', '6NcW8joYqW1ywHi6QmVmLUux5RHKyhcL5CBY1gdgGvcQ', 'vitya_003.tg',
    'rNEAR withdraw(amount) of 0.252 NEAR (block 223500845)',
    { kind: 'claim', title: 'Withdrew unstaked NEAR', assetsIn: [{ token: null, amount: '251912489159409884200922' }], counterparty: RNEAR }],
  ['linear-unstake.json', 'AZRwkZ5jnLvuUDuE33CgYQiT9UecmCS9bmdmVps6FoEz', '03661d82bd238db0e06c9711e92679da091085a7fdb671f3babbc592be336874',
    'LiNEAR unstake(amount) of the whole position; unlock epoch 4951 (block 223521297)',
    { kind: 'unstake', title: 'Requested unstake', assetsOut: [{ token: LINEAR, amount: '230700000000000000000000' }], counterparty: LINEAR }],
  ['linear-withdraw_all.json', 'An45DDJGZTuYeEAMNke2owrGsKUDbgrpc4BPDkh6C8tR', 'c0977503827a59ae7c422b4b1627cbecd0985bd09788b7d09740100c06891d3c',
    'LiNEAR withdraw_all of 0.808 NEAR (amount from the contract\'s withdraw event) (block 223500851)',
    { kind: 'claim', title: 'Withdrew unstaked NEAR', assetsIn: [{ token: null, amount: '808384430210821134393176' }], counterparty: LINEAR }],
  ['linear-deposit_and_stake.json', 'DsVYhQLZacpTuiMmMGQEP9J75DNkYVniFh5cGDBzvdwq', '7d28ddc5546db4ca3bc688754f688b0eb66a2bf873753d79bac2675ac6be1a6b',
    'LiNEAR deposit_and_stake of 0.266 NEAR by an implicit account a 1Click delivery had created 47 blocks earlier; not registered before (storage_balance_of null at 223342240), no storage_deposit (block 223342253)',
    { kind: 'stake', title: 'Staked NEAR for LINEAR', assetsOut: [{ token: null, amount: '266000000000000000000000' }], assetsIn: [{ token: LINEAR, amount: '186021941537769983327646' }], counterparty: LINEAR }],
  ['linear-unstake_all.json', '6UYCRh1GXqwYzMYMPumRC8FQ7PwZ1D4V6NS2syQpMrMu', 'c0977503827a59ae7c422b4b1627cbecd0985bd09788b7d09740100c06891d3c',
    'LiNEAR unstake_all (block 223317749)',
    { kind: 'unstake', title: 'Requested unstake', assetsOut: [{ token: LINEAR, amount: '565346750874690157118197' }], counterparty: LINEAR }],
  // Negatives: describeActivity must return null.
  ['negatives/metapool-deposit_and_stake.json', '7h3pYJyyiFdcrNVcayub45egzehaEEGzUAfjErHRzmWQ', '7d28ddc5546db4ca3bc688754f688b0eb66a2bf873753d79bac2675ac6be1a6b', 'Meta Pool deposit_and_stake (another contract family, same method name)', { kind: 'contract' }],
  ['negatives/rnear-ft_transfer_call.json', 'GzvfcGwbAPGrZajUtvUKFbj2KjQDTAubtsard3nXaTQc', 'mrholigan.tg', 'rNEAR ft_transfer_call (a token transfer, not staking)', { kind: 'contract' }],
  ['negatives/rnear-storage_deposit.json', 'J2bHNARowkq5GP6VqpuKUKVZSJFTUDso7LNP4mypRVXw', 'chef_23.tg', 'a lone rNEAR storage_deposit', { kind: 'contract' }],
  ['negatives/linear-ft_transfer_call.json', 'CkdKoGsK3R7MT5uPtbgmtcEoT4BRxio3ypXWtyfzQKAc', 'keepsilence.near', 'LiNEAR ft_transfer_call (a token transfer, not staking)', { kind: 'contract' }],
  ['negatives/rnear-epoch_update_rewards-bot.json', '8wdm8w2exzstxtDZFGGkJkybCBma2qiTPefdjZ62fKft', 'watcher07.ref-watchdog.near', 'rNEAR epoch_update_rewards sent by the operator bot, seen from a holder\'s wallet', { kind: 'contract' }, ['vchieu05.near']],
  ...JSON.parse(process.env.EXTRA_FIXTURES ?? '[]'),
]

mkdirSync(join(out, 'negatives'), { recursive: true })
for (const [file, hash, signer, note, expect, own] of FIXTURES) {
  const r = await rpc('EXPERIMENTAL_tx_status', { tx_hash: hash, sender_account_id: signer, wait_until: 'NONE' })
  const block = await rpc('block', { block_id: r.transaction_outcome.block_hash })
  const tx = mapRpcTxStatus('near:mainnet', signer, r)
  tx.time = Math.floor(Number(BigInt(block.header.timestamp_nanosec) / 1_000_000_000n))
  tx.block = BigInt(block.header.height)
  delete tx.raw.rpc.receipts // the outcomes are kept; the receipt bodies only add size
  const json = JSON.parse(JSON.stringify(tx, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
  writeFileSync(join(out, file), JSON.stringify({ note, own: own ?? [signer], tx: json, expect }, null, 2) + '\n')
  console.log(file, hash.slice(0, 10), tx.call?.programs?.join('+'), 'transfers', tx.transfers.length)
  await sleep(400)
}
