#!/usr/bin/env node
// Captures the fixtures from NEAR mainnet, view calls only:
//
//  - fixtures/activity/*.json: real staking-pool transactions mapped to ChainTx exactly as
//    wallet-near's history does when it refines a transaction over RPC (mapRpcTxStatus on an
//    EXPERIMENTAL_tx_status result, block and time from the fastnear transaction index);
//  - fixtures/rpc/mainnet.json: the view answers the fake node replays (validators trimmed to a
//    sample, epoch blocks, gas price, pool accounts, pool views, a delegator in unbonding).
//
//   node scripts/capture-fixtures.mjs [activity|rpc|all]
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mapRpcTxStatus } from '@anywalletkit/wallet-near'

const RPC = process.env.NEAR_RPC ?? 'https://free.rpc.fastnear.com'
const ARCHIVAL = process.env.NEAR_ARCHIVAL_RPC ?? 'https://archival-rpc.mainnet.fastnear.com'
const TX_INDEX = 'https://tx.main.fastnear.com/v0/transactions'
const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')
const what = process.argv[2] ?? 'all'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function post(url, body) {
  for (let i = 0; ; i++) {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (res.status === 429 && i < 6) { await sleep(1000 * 2 ** i); continue }
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
    return res.json()
  }
}
/** The whole JSON-RPC envelope: fixtures keep errors as the node sent them. */
const rpcRaw = (method, params, url = RPC) => post(url, { jsonrpc: '2.0', id: 'fx', method, params })
async function rpc(method, params, url = RPC) {
  const r = await rpcRaw(method, params, url)
  if (r.error) throw new Error(`${method}: ${JSON.stringify(r.error).slice(0, 200)}`)
  return r.result
}
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
const json = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2) + '\n'
const write = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, json(value)); console.log('wrote', file) }

// ── Activity ─────────────────────────────────────────────────────────────────

const POOL = 'astro-stakers.poolv1.near'
const ACTIVITY = [
  { file: 'deposit_and_stake.json', hash: '7uR19g2FuXwJurdxTac1FyddFR9bBX2wJQ5kiPXEgfnu', note: `deposit_and_stake into ${POOL} from an implicit account`, expect: { kind: 'stake', title: 'Staked NEAR', counterparty: POOL }, out: true },
  { file: 'unstake.json', hash: 'GNh8yWFVfEEEiwsNuU8TQAXF2pSz5y6LFWUQZHNDQTeH', note: `unstake(amount) from ${POOL}`, expect: { kind: 'unstake', title: 'Requested unstake', counterparty: POOL } },
  { file: 'unstake_all.json', hash: 'Gmgn8kZKr6iMgzeNg3qtS3JSAJmN4aG7NuuaKwr7xjWe', note: `unstake_all from ${POOL}`, expect: { kind: 'unstake', title: 'Requested unstake', counterparty: POOL } },
  { file: 'withdraw_all.json', hash: 'E875nHCW4CLLfxFHXmse2uFxyrSHqxxpJEuMU49pdtL4', note: `withdraw_all from ${POOL} (the NEAR comes back in a receipt the pool sends)`, expect: { kind: 'claim', title: 'Withdrew unstaked NEAR', counterparty: POOL }, in: true },
]
const NEGATIVES = [
  { file: 'wnear-ft-transfer-call.json', hash: '5aiSMuLCRbDxAox6vHtrUoZB2VEHE5RpoSb1D2adByF6', note: 'wNEAR ft_transfer_call on wrap.near: a token transfer, not staking' },
  { file: 'ping-by-operator.json', hash: 'EaenxrpWoiZAZTFYdkdkb5GRmbrYc8oDeRqWhUPHL6wA', note: `ping on ${POOL} by its operator: not a delegator method` },
  { file: 'intents-ft-withdraw.json', hash: '9W9kZdQvZKNuRC468pcF73AV9UQVPHmzPAwh2sxXceck', note: 'ft_withdraw on intents.near: not a staking pool' },
  { file: 'lst-pool-withdraw.json', hash: 'AVMsfdCBvJLC6CzzeWrMBbJWYmbAYZntX7L5VApMA8pj', note: 'withdraw on lst-pool.near: in the validator set, but not a factory pool' },
  { file: 'deposit-seen-by-pool.json', hash: '7uR19g2FuXwJurdxTac1FyddFR9bBX2wJQ5kiPXEgfnu', note: `a delegator's deposit_and_stake seen from ${POOL}'s own history: someone else's call`, own: POOL },
]

/** Drops the Merkle proofs: large and irrelevant to describing the transaction. */
function trimRpc(r) {
  const out = structuredClone(r)
  delete out.transaction_outcome?.proof
  for (const o of out.receipts_outcome ?? []) delete o.proof
  return out
}

async function captureActivity() {
  const hashes = [...new Set([...ACTIVITY, ...NEGATIVES].map((f) => f.hash))]
  const index = new Map((await post(TX_INDEX, { tx_hashes: hashes })).transactions.map((t) => [t.transaction.hash, t]))
  for (const [list, dir] of [[ACTIVITY, 'activity'], [NEGATIVES, 'activity/negatives']]) {
    for (const f of list) {
      const t = index.get(f.hash)
      if (!t) throw new Error(`${f.hash} not in the transaction index`)
      const signer = t.transaction.signer_id
      const status = await rpc('EXPERIMENTAL_tx_status', { tx_hash: f.hash, sender_account_id: signer, wait_until: 'NONE' }, ARCHIVAL)
      const chain = 'near:mainnet'
      const address = f.own ?? signer
      const base = {
        chain, hash: f.hash, time: Math.floor(Number(t.execution_outcome.block_timestamp) / 1e9), status: 'confirmed', address, from: signer,
        to: t.transaction.receiver_id, nativeValue: 0n, transfers: [], raw: { receipts: [], ft: [] }, block: BigInt(t.execution_outcome.block_height),
      }
      const tx = mapRpcTxStatus(chain, address, trimRpc(status), base)
      const expect = { ...(f.expect ?? { kind: 'stake' }) }
      if (f.out) expect.assetsOut = tx.transfers.filter((x) => x.token === null && x.from === signer).map((x) => ({ token: null, amount: x.amount }))
      if (f.in) {
        const paid = status.receipts.filter((r) => r.predecessor_id === t.transaction.receiver_id && r.receiver_id === signer)
          .flatMap((r) => r.receipt?.Action?.actions ?? []).reduce((s, a) => s + BigInt(a.Transfer?.deposit ?? 0), 0n)
        expect.assetsIn = [{ token: null, amount: paid }]
      }
      const fixture = { note: `${f.note} (mainnet block ${t.execution_outcome.block_height})`, own: [address], tx, ...(dir === 'activity' ? { expect } : { expect: { kind: 'stake' } }) }
      write(join(root, dir, f.file), fixture)
      await sleep(300)
    }
  }
}

// ── RPC answers for the fake node ───────────────────────────────────────────

/** Validators kept in the trimmed set: real pools of every kind the tests need, plus the top of the set. */
const KEEP = ['astro-stakers.poolv1.near', 'figment.poolv1.near', 'aurora.pool.near', 'lst-pool.near', 'zavodil.poolv1.near', 'epic.poolv1.near']
const VIEWS = ['astro-stakers.poolv1.near', 'figment.poolv1.near', 'aurora.pool.near', 'zavodil.poolv1.near', 'lst-pool.near', 'meta-pool.near']
const DELEGATOR = { pool: 'astro-stakers.poolv1.near', account: 'nima.near' }

async function captureRpc() {
  const v = await rpc('validators', [null])
  const byStake = [...v.current_validators].sort((a, b) => (BigInt(b.stake) > BigInt(a.stake) ? 1 : -1)).slice(0, 8).map((x) => x.account_id)
  const keep = new Set([...KEEP, ...byStake])
  const trimmed = {
    epoch_height: v.epoch_height,
    epoch_start_height: v.epoch_start_height,
    current_validators: v.current_validators.filter((x) => keep.has(x.account_id)).map(({ num_produced_chunks_per_shard, num_expected_chunks_per_shard, num_produced_endorsements_per_shard, num_expected_endorsements_per_shard, shards_endorsed, ...rest }) => rest),
    next_validators: v.next_validators.filter((x) => keep.has(x.account_id)),
    validator_reward_paid_prev_epoch: Object.fromEntries(Object.entries(v.validator_reward_paid_prev_epoch).filter(([id]) => keep.has(id) || id === 'treasury.near')),
    // Whole-network figures the tests compare against (computed here from the untrimmed answer).
    _network: (() => {
      let rewards = 0n, stake = 0n
      for (const c of v.current_validators) {
        const r = v.validator_reward_paid_prev_epoch[c.account_id]
        if (r === undefined || c.account_id === 'treasury.near') continue
        rewards += BigInt(r)
        stake += BigInt(c.stake)
      }
      return { validators: v.current_validators.length, next: v.next_validators.length, rewardEntries: Object.keys(v.validator_reward_paid_prev_epoch).length, rewards: rewards.toString(), stake: stake.toString() }
    })(),
  }
  const header = (b) => ({ height: b.header.height, timestamp: b.header.timestamp, timestamp_nanosec: b.header.timestamp_nanosec, epoch_id: b.header.epoch_id, hash: b.header.hash })
  const final = header(await rpc('block', { finality: 'final' }))
  const start = header(await rpc('block', { block_id: v.epoch_start_height }))
  const prev = header(await rpc('block', { block_id: v.epoch_start_height - 43_200 }))
  const gas = await rpc('gas_price', [null])
  const accounts = {}
  for (const id of [...VIEWS, DELEGATOR.account]) accounts[id] = (await rpcRaw('query', { request_type: 'view_account', finality: 'final', account_id: id }))
  const calls = {}
  for (const id of VIEWS) {
    for (const method of ['is_staking_paused', 'get_reward_fee_fraction']) calls[`${id} ${method}`] = await rpcRaw('query', { request_type: 'call_function', finality: 'final', account_id: id, method_name: method, args_base64: b64({}) })
    await sleep(200)
  }
  calls[`${DELEGATOR.pool} get_account ${DELEGATOR.account}`] = await rpcRaw('query', { request_type: 'call_function', finality: 'final', account_id: DELEGATOR.pool, method_name: 'get_account', args_base64: b64({ account_id: DELEGATOR.account }) })
  const decoded = Object.fromEntries(Object.entries(calls).map(([k, r]) => [k, r.result?.result ? JSON.parse(Buffer.from(r.result.result).toString()) : (r.result?.error ?? r.error)]))
  write(join(root, 'rpc', 'mainnet.json'), { capturedAt: new Date().toISOString(), rpc: RPC, validators: trimmed, blocks: { final, start, prev }, gasPrice: gas.gas_price, accounts, calls: decoded })
}

if (what === 'activity' || what === 'all') await captureActivity()
if (what === 'rpc' || what === 'all') await captureRpc()
