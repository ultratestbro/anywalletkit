#!/usr/bin/env node
// Live check on NEAR mainnet, nothing signed (view calls only): the epoch clock, the validator set
// and APRs, the pool allow-list verdicts on real pools (and foreign contracts), then positions and
// every write planned as real delegators found with `get_accounts` — including one in unbonding.
//
//   node scripts/verify-live.mjs [rpcUrl]        (or NEAR_RPC=…; NEAR_HISTORY=1 also dates unlocks via nearblocks)
//
// Every live read is a step: a failed read reports FAIL and the run goes on. The public RPC answers
// 429 under load; the transport below backs off and retries.
import { NetworkError } from '@anywalletkit/core'
import { NearRpcError, createNearHistory } from '@anywalletkit/wallet-near'
import { NativeStakingProtocolNear, factoryOf } from '../dist/index.js'

const RPC = process.argv[2] ?? process.env.NEAR_RPC ?? 'https://free.rpc.fastnear.com'
const NEAR = 10n ** 24n
const POOL = 'astro-stakers.poolv1.near'
const fmt = (y) => `${(y / NEAR).toString()}.${(y % NEAR).toString().padStart(24, '0').slice(0, 4)} NEAR`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let requests = 0
/** JSON-RPC transport with backoff on 429 / 5xx, counting requests. */
const transport = async (method, params) => {
  for (let i = 0; ; i++) {
    requests++
    const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'v', method, params }) })
    if ((res.status === 429 || res.status >= 500) && i < 6) { await sleep(500 * 2 ** i); continue }
    if (!res.ok) throw new NetworkError(`${method}: HTTP ${res.status}`, { provider: RPC })
    const json = await res.json()
    if (json.error) throw new NearRpcError(method, json.error)
    return json.result
  }
}
/** The modules read only `chain` and `getAddress()`: a watch account for any public account id. */
const watch = (accountId) => ({
  chain: 'near:mainnet',
  getAddress: async () => accountId,
  getBalance: async () => 0n,
  getTokenBalance: async () => 0n,
  quoteSendTransaction: async () => ({ fee: 0n }),
  quoteTransfer: async () => ({ fee: 0n }),
  getTransactionReceipt: async () => undefined,
  verify: async () => false,
})

let failures = 0
async function step(name, run) {
  try {
    const out = await run()
    console.log(`ok   ${name}${out === undefined ? '' : ` — ${out}`}`)
  } catch (e) {
    failures++
    console.log(`FAIL ${name} — ${e?.message ?? e}`)
  }
}
async function value(name, run, show) {
  let out
  await step(name, async () => { out = await run(); return show?.(out) })
  return out
}
/**
 * A real delegator may hold too little spare NEAR to buy the prepaid gas upfront: then the module
 * refuses exactly where the node would (InsufficientFundsError), and that is the expected answer.
 */
async function orUpfrontShort(run) {
  try { return await run() } catch (e) {
    if (e?.name === 'InsufficientFundsError') return `refused: InsufficientFundsError (needs ${fmt(BigInt(e.required))} upfront, has ${fmt(BigInt(e.available))}: the node would refuse it too)`
    throw e
  }
}

async function refused(name, code, run) {
  await step(name, async () => {
    try { await run() } catch (e) { if (e?.code === code || e?.name === code) return `refused: ${e.code ?? e.name}${e.refusals ? ` [${e.refusals.join(', ')}]` : ''}`; throw e }
    throw new Error('was not refused')
  })
}
const view = async (contract, method, args = {}) => {
  const r = await transport('query', { request_type: 'call_function', finality: 'final', account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') })
  if (r.error) throw new Error(r.error)
  return JSON.parse(Buffer.from(r.result).toString())
}

const any = new NativeStakingProtocolNear(watch('nima.near'), { pools: 'any', provider: transport, discover: 'fastnear' })

const epoch = await value('getEpoch', () => any.getEpoch(), (e) => `epoch ${e.height}, block ${e.block}, ${e.blocksLeft} heights left, measured ${(e.epochMs / 3.6e6).toFixed(2)} h, ends ${new Date(e.endsAt).toISOString()}`)
if (epoch && (epoch.epochMs < 6 * 3.6e6 || epoch.epochMs > 8 * 3.6e6)) await step('epoch duration is ~6.9 h', async () => { throw new Error(`${epoch.epochMs} ms`) })
await value('getNetworkStats', () => any.getNetworkStats(), (s) => `${s.validators} validators, ${fmt(s.totalStake)} staked, ${s.epochsPerYear.toFixed(1)} epochs/yr, gross APR ${s.apr.toFixed(3)} % (expected ≈ 5 %)`)
const fresh = new NativeStakingProtocolNear(watch('nima.near'), { pools: 'any', provider: transport, discover: false })
const before = requests
const pools = await value('listPools (one validators call)', () => fresh.listPools(), (ps) => `${ps.length} factory pools; top: ${ps.slice(0, 3).map((p) => `${p.id} gross ${p.grossApr?.toFixed(2)} %`).join(', ')}`)
await step('listPools made exactly one RPC call', async () => { if (requests - before !== 1) throw new Error(`${requests - before} calls`); return `${requests - before}` })
await step('listPools keeps only factory pools', async () => { const bad = pools?.filter((p) => factoryOf(p.id, 'mainnet') === null) ?? []; if (bad.length) throw new Error(bad.map((p) => p.id).join(', ')); return 'yes (lst-pool.near and other foreign validators dropped)' })

for (const [id, expect] of [[POOL, 'eligible'], ['figment.poolv1.near', 'eligible'], ['aurora.pool.near', 'fee-above-max'], ['intear.pool.near', 'eligible'], ['nope-xyz-404.poolv1.near', 'not-found']]) {
  await step(`getPool ${id} → ${expect}`, async () => {
    const p = await any.getPool(id)
    const verdict = p.eligible ? 'eligible' : p.refusals.join('/')
    if (!verdict.includes(expect)) throw new Error(`got ${verdict}`)
    return `${verdict}; code ${p.codeHash?.slice(0, 8) ?? '-'} known ${p.codeHashKnown}, fee ${p.feePercent ?? '-'} %${p.nextFee ? ` (next ${p.nextFee.numerator}/${p.nextFee.denominator})` : ''}, paused ${p.paused}, stake ${fmt(p.stake)}, uptime ${p.uptime?.toFixed(1) ?? '-'} %, APR ${p.apr?.toFixed(2) ?? '-'} % (${p.aprSource})`
  })
}
for (const id of ['lst-pool.near', 'meta-pool.near']) {
  await step(`getPool ${id} → not-factory-pool with zero RPC calls`, async () => {
    const n = requests
    const p = await any.getPool(id)
    if (!p.refusals.includes('not-factory-pool')) throw new Error(p.refusals.join('/'))
    if (requests !== n) throw new Error(`${requests - n} RPC calls`)
    return p.refusals.join('/')
  })
}
await step('getApr astro-stakers (1 % fee) ≈ 5.0 %, figment (10 %) ≈ 4.5 %', async () => `${(await any.getApr({ pool: POOL })).toFixed(2)} %, ${(await any.getApr({ pool: 'figment.poolv1.near' })).toFixed(2)} %`)

// Real delegators of astro-stakers.
const delegators = (await value(`get_accounts on ${POOL}`, async () => {
  const total = await view(POOL, 'get_number_of_accounts')
  const out = []
  for (let from = 0; from < Math.min(total, 1200) && out.length < 400; from += 200) out.push(...(await view(POOL, 'get_accounts', { from_index: from, limit: 200 })))
  return out
}, (a) => `${a.length} read`)) ?? []
const named = (d) => !/^[0-9a-f]{64}$/.test(d.account_id) && !d.account_id.endsWith('.lockup.near')

// nima.near: unbonding.
const nima = new NativeStakingProtocolNear(watch('nima.near'), { pools: [POOL], provider: transport, discover: 'fastnear' })
const positions = await value('nima.near listPositions (fastnear discovery)', () => nima.listPositions(), (ps) => ps.map((p) => `${p.pool}: staked ${fmt(p.staked)}, unstaked ${fmt(p.unstaked)}, can_withdraw ${p.canWithdraw}, unlock ${p.unlock ? `${p.unlock.source} epochs ${p.unlock.earliestEpoch}–${p.unlock.latestEpoch} (${new Date(p.unlock.earliestAt).toISOString()}…)` : '-'}, warnings ${p.warnings.join(',') || 'none'}`).join('; ') || 'none')
const locked = positions?.find((p) => p.unstaked > 0n && !p.canWithdraw)
await value('nima.near getWithdrawalRequests', () => nima.getWithdrawalRequests(), (w) => `${w.requests.length} request(s), pending ${fmt(w.pendingAmount)}, claimable ${fmt(w.claimableAmount)}, ids ${w.requests.map((r) => r.id).join(',')}`)
if (locked) await refused('nima.near quoteClaimWithdrawals → not withdrawable yet', 'nothing-to-claim', () => nima.quoteClaimWithdrawals())
if (process.env.NEAR_HISTORY) {
  const dated = new NativeStakingProtocolNear(watch('nima.near'), { pools: [POOL], provider: transport, discover: false, history: createNearHistory({}) })
  await value('nima.near unlock dated by history (nearblocks)', () => dated.listPositions(), (ps) => ps.map((p) => `${p.pool}: ${p.unlock ? `${p.unlock.source} epoch ${p.unlock.epoch ?? '-'} at ${p.unlock.at ? new Date(p.unlock.at).toISOString() : '-'}` : 'no unlock'}`).join('; '))
}

// A staker with a spare balance: every planned write, quoted as that account.
const rich = await value('a named delegator with > 2 NEAR spare and > 1 NEAR staked', async () => {
  for (const d of delegators.filter((x) => named(x) && BigInt(x.staked_balance) > NEAR)) {
    const acct = await transport('query', { request_type: 'view_account', finality: 'final', account_id: d.account_id }).catch(() => null)
    if (acct && BigInt(acct.amount) - BigInt(acct.locked) - BigInt(acct.storage_usage) * 10n ** 19n > 3n * NEAR) return d
  }
  throw new Error('none found')
}, (d) => d.account_id)
if (rich) {
  const p = new NativeStakingProtocolNear(watch(rich.account_id), { pools: [POOL, 'figment.poolv1.near', 'aurora.pool.near'], defaultPool: POOL, provider: transport, discover: false })
  await step('getMaxStakeable', async () => fmt(await p.getMaxStakeable()))
  await step('quoteStake 1 NEAR (deposit_and_stake)', async () => {
    const q = await p.quoteStake({ amount: NEAR })
    // The node buys all prepaid gas upfront at min_gas_purchase_price (10^9 since protocol 88).
    if (q.upfront < 50n * 10n ** 12n * 10n ** 9n) throw new Error(`upfront ${q.upfront} is below 50 Tgas × 10^9`)
    if (q.reserve < q.upfront - 10n ** 22n) throw new Error(`reserve ${q.reserve} cannot pay a later unstake`)
    return `fee ≤ ${fmt(q.fee)}, upfront ${fmt(q.upfront)}, reserve ${fmt(q.reserve)}, ${q.pool.id} APR ${q.apr?.toFixed(2)} %, max ${fmt(q.maxStakeable)}, tx ${JSON.stringify(q.transactions, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`
  })
  await step('quoteRequestWithdrawal all (unstake_all, + withdraw_all first when unlocked)', async () => {
    const q = await p.quoteRequestWithdrawal({ amount: 'all' })
    return `${fmt(q.amount)}, methods ${q.transactions[0].actions.map((a) => a.functionCall.methodName).join('+')}, withdrawsFirst ${q.withdrawsFirst} yocto (pool unstaked ${rich.unstaked_balance}), resetsTimer ${q.resetsTimer}, unlock epochs ${q.unlock.earliestEpoch}–${q.unlock.latestEpoch} (${new Date(q.unlock.earliestAt).toISOString()} – ${new Date(q.unlock.latestAt).toISOString()}), warnings ${q.warnings.map((w) => w.code).join(',') || 'none'}`
  })
  await step('quoteRequestWithdrawal 1 NEAR (unstake with a decimal-string amount)', async () => {
    const q = await p.quoteRequestWithdrawal({ amount: NEAR })
    return JSON.stringify(q.transactions[0].actions.at(-1).functionCall.args)
  })
  await refused('refuses unstaking more than staked', 'exceeds-staked', () => p.quoteRequestWithdrawal({ amount: BigInt(rich.staked_balance) + NEAR }))
  await refused('refuses aurora.pool.near (99 % fee)', 'pool-not-allowed', () => p.quoteStake({ amount: NEAR, pool: 'aurora.pool.near' }))
  await refused('refuses a stake below 0.001 NEAR', 'below-minimum', () => p.quoteStake({ amount: 10n ** 20n }))
  await refused('refuses a stake above the spare balance', 'InsufficientFundsError', () => p.quoteStake({ amount: 10n ** 9n * NEAR }))
  const anyPool = new NativeStakingProtocolNear(watch(rich.account_id), { pools: 'any', provider: transport, discover: false })
  await refused('refuses lst-pool.near even with pools: any', 'pool-not-allowed', () => anyPool.quoteStake({ amount: NEAR, pool: 'lst-pool.near' }))
}
const ready = delegators.find((d) => BigInt(d.unstaked_balance) > 10n ** 21n && d.can_withdraw)
if (ready) {
  const p = new NativeStakingProtocolNear(watch(ready.account_id), { pools: [POOL], provider: transport, discover: false })
  await step(`quoteClaimWithdrawals for ${ready.account_id} (withdraw_all)`, () => orUpfrontShort(async () => { const q = await p.quoteClaimWithdrawals(); return `${fmt(q.amount)} from ${q.claims.map((c) => c.pool).join(',')}, fee ≤ ${fmt(q.fee)}, upfront ${fmt(q.upfront)}` }))
} else console.log('skip claim quote: no delegator with a withdrawable balance in the first accounts')
// An unlocked balance waiting next to stake: the unstake must take it out first, in the same transaction.
const both = delegators.find((d) => BigInt(d.unstaked_balance) > 10n ** 21n && d.can_withdraw && BigInt(d.staked_balance) > NEAR)
if (both) {
  const p = new NativeStakingProtocolNear(watch(both.account_id), { pools: [POOL], provider: transport, discover: false })
  await step(`quoteRequestWithdrawal 1 NEAR for ${both.account_id} → [withdraw_all, unstake]`, () => orUpfrontShort(async () => {
    const q = await p.quoteRequestWithdrawal({ amount: NEAR })
    const methods = q.transactions[0].actions.map((a) => a.functionCall.methodName).join('+')
    if (methods !== 'withdraw_all+unstake') throw new Error(`methods ${methods}`)
    return `${methods}, withdrawsFirst ${fmt(q.withdrawsFirst)}, fee ≤ ${fmt(q.fee)}, upfront ${fmt(q.upfront)}`
  }))
} else console.log('skip withdraw-first check: no delegator with both stake and an unlocked balance in the first accounts')
const unbonding = delegators.find((d) => BigInt(d.unstaked_balance) > 10n ** 21n && !d.can_withdraw && BigInt(d.staked_balance) > NEAR)
if (unbonding) {
  const p = new NativeStakingProtocolNear(watch(unbonding.account_id), { pools: [POOL], provider: transport, discover: false })
  await refused(`quoteRequestWithdrawal 1 NEAR for ${unbonding.account_id} → refused: it would restart the unbonding timer`, 'timer-reset-refused', () => p.quoteRequestWithdrawal({ amount: NEAR }))
  await step(`… and with allowTimerReset → resetsTimer`, () => orUpfrontShort(async () => {
    const q = await p.quoteRequestWithdrawal({ amount: NEAR, allowTimerReset: true })
    if (!q.resetsTimer || q.transactions[0].actions.length !== 1) throw new Error(JSON.stringify(q.warnings))
    return q.warnings.map((w) => w.message).join(' ')
  }))
}

console.log(`\n${requests} RPC requests`)
console.log(failures ? `${failures} failure(s)` : 'all live checks passed')
process.exit(failures ? 1 : 0)
