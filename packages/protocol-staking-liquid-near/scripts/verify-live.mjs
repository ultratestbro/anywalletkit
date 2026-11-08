#!/usr/bin/env node
// Live, view-only checks against NEAR mainnet: both family contracts (pinned code hash, summary,
// pause flag, liquidity, fee), real holders' accounts, the price APR from the archival RPC, and every
// write planned through the module for real holders (quotes only: nothing is signed or sent).
//
//   pnpm build && node scripts/verify-live.mjs [rpcUrl] [archivalUrl]
import { NearRpcError } from '@anywalletkit/wallet-near'
import { LiquidStakingError, LiquidStakingProtocolNear, LIQUID_PRESETS, poolRequestId } from '../dist/index.js'

const RPC = process.argv[2] ?? 'https://free.rpc.fastnear.com'
const ARCHIVAL = process.argv[3] ?? 'https://archival-rpc.mainnet.fastnear.com'
const sleep = (ms) => new Promise((s) => setTimeout(s, ms))

const REUSE_MS = 30_000

/**
 * A JSON-RPC transport for the free endpoints, which take a burst of about 20 requests and then about
 * one a second. It backs off on HTTP 429 / 5xx (at most 10 s a try), and answers a request it made in
 * the last 30 s from that answer instead of resending it: every holder's quotes re-read the same
 * contract state, epoch and gas price, and without this a run sent ~280 requests and spent most of its
 * 5–6 minutes rate limited (the canary allows 300 s). 30 s old reads change nothing these checks test.
 */
const transport = (url) => {
  let id = 0
  const send = async (method, params) => {
    for (let i = 0; i < 12; i++) {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: String(++id), method, params }) })
      if (r.status === 429 || r.status >= 500) { await sleep(Math.min(800 * 2 ** i, 10_000)); continue }
      const j = await r.json()
      if (j.error) throw new NearRpcError(method, j.error)
      return j.result
    }
    throw new Error(`${method}: still rate limited`)
  }
  const recent = new Map()
  return (method, params) => {
    const key = `${method} ${JSON.stringify(params)}`
    const hit = recent.get(key)
    if (hit && Date.now() - hit.at < REUSE_MS) return hit.value.then((v) => structuredClone(v))
    const value = send(method, params)
    recent.set(key, { at: Date.now(), value })
    value.catch(() => { if (recent.get(key)?.value === value) recent.delete(key) }) // errors are asked again
    return value.then((v) => structuredClone(v))
  }
}
const provider = transport(RPC)
const archivalProvider = transport(ARCHIVAL)

/** A watch-only account: the module reads only `chain` and `getAddress()`. */
const watch = (accountId) => ({
  chain: 'near:mainnet', getAddress: async () => accountId,
  getBalance: async () => 0n, getTokenBalance: async () => 0n, quoteSendTransaction: async () => ({ fee: 0n }), quoteTransfer: async () => ({ fee: 0n }),
  getTransactionReceipt: async () => null, verify: async () => false,
})

const near = (y) => `${(Number(y / 10n ** 18n) / 1e6).toFixed(6)} NEAR`
const methods = (txs) => txs.map((t) => `${t.receiverId}: ${t.actions.map((a) => `${a.functionCall.methodName}(${JSON.stringify(a.functionCall.args)}, ${a.functionCall.gas / 10n ** 12n} Tgas, ${near(a.functionCall.deposit)})`).join(' + ')}`).join(' | ')
let failures = 0
const check = (ok, what) => { console.log(`${ok ? '  ok ' : '  FAIL'} ${what}`); if (!ok) failures++ }
const outcome = async (label, fn) => {
  try {
    const v = await fn()
    console.log(`  ${label}:`, v)
    return v
  } catch (e) {
    console.log(`  ${label}: refused ${e instanceof LiquidStakingError ? e.code : e?.name}: ${e?.message}`)
    return e
  }
}

// Real holders found on 2026-11-08 (fastnear indexer, recent transactions to each contract).
const HOLDERS = {
  linear: ['03661d82bd238db0e06c9711e92679da091085a7fdb671f3babbc592be336874', '8542ae4734220a8d88cb59e6128da54b70e41930327edea20d50ec29f740909b', '7d28ddc5546db4ca3bc688754f688b0eb66a2bf873753d79bac2675ac6be1a6b'],
  rnear: ['vchieu05.near', 'norbert263.tg', '59583199fc8d2b7207ad71f5213b3e7c917cbf07579d0e63fe1d7cebd9a2cd00'],
}

// The testnet pin: linear-protocol.testnet (rNEAR has no testnet contract).
{
  const testnet = LIQUID_PRESETS.linear.contracts.testnet
  const r = await transport('https://test.rpc.fastnear.com')('query', { request_type: 'view_account', finality: 'final', account_id: testnet.contract })
  console.log(`\n== ${testnet.contract} (testnet)`)
  check(r.code_hash === testnet.codeHashes[0], `live code hash ${r.code_hash} is the pin`)
}

for (const pool of ['linear', 'rnear']) {
  const preset = LIQUID_PRESETS[pool].contracts.mainnet
  console.log(`\n== ${preset.contract}`)
  const p = new LiquidStakingProtocolNear(watch(HOLDERS[pool][0]), { pool, provider, archivalProvider })
  const info = await p.getPoolInfo()
  console.log(`  price ${near(info.price)} per token, staked ${near(info.totalStaked)}, validators ${info.validators}, liquidity ${near(info.liquidity)}, fee ${info.feeBps / 100} %`)
  check(info.codeHashKnown && info.codeHash === preset.codeHashes[0], `live code hash ${info.codeHash} is the pin`)
  check(info.paused === false, 'is_paused is false')
  check(info.pausedFeatures.length === 0, `no feature paused (pa_all_paused${pool === 'linear' ? ': no such method' : ''})`)
  check(info.decimals === 24 && info.price > 10n ** 24n, 'price above 1 NEAR per token, 24 decimals')
  check(info.price === (info.totalStaked * 10n ** 24n) / info.totalShares, 'ft_price = total staked / total shares (rounded down)')
  const epoch = await p.getEpoch()
  console.log(`  epoch ${epoch.height}, ${(epoch.epochMs / 3.6e6).toFixed(2)} h measured, ends ${new Date(epoch.endsAt).toISOString()}`)
  check(epoch.epochMs > 6 * 3.6e6 && epoch.epochMs < 8 * 3.6e6, 'epoch lasts 6–8 h')
  const apr = await p.getApr()
  console.log(`  APR over ${p.aprWindowEpochs} epochs: ${apr.toFixed(2)} %`)
  check(apr > 2 && apr < 8, 'APR between 2 and 8 %')

  for (const holder of HOLDERS[pool]) {
    console.log(`  -- ${holder}`)
    const h = new LiquidStakingProtocolNear(watch(holder), { pool, provider, archivalProvider, apr: () => apr })
    const d = await h.getAccountDetails()
    console.log(`  details: ${d.shares} token units (${near(d.value)}), unstaked ${near(d.unstaked)}, unlock epoch ${d.unlockEpoch}, can_withdraw ${d.canWithdraw}, registered ${d.registered}`)
    const view = await h.getWithdrawalRequests()
    for (const r of view.requests) {
      check(r.id === poolRequestId(preset.contract), 'request id = poolRequestId(contract)')
      console.log(`  request: ${near(r.amount)} claimable ${r.claimable} awaitingLiquidity ${r.awaitingLiquidity} unlock ${r.unlock ? `epoch ${r.unlock.epoch} ≈ ${new Date(r.unlock.at).toISOString()}` : 'now'}`)
    }
    const unstake = await outcome('unstake all', async () => {
      const q = await h.quoteRequestWithdrawal({ amount: 'all' })
      return `${methods(q.transactions)}; fee ≤ ${near(q.fee)}; warnings ${q.warnings.map((w) => w.code).join(', ')}; earliest epoch ${q.unlock.earliestEpoch}`
    })
    if (d.shares === 0n) check(unstake instanceof LiquidStakingError && unstake.code === 'nothing-staked', "no tokens: unstake refused with 'nothing-staked'")
    const claim = await outcome('claim', async () => {
      const q = await h.quoteClaimWithdrawals()
      return `${methods(q.transactions)}; ${near(q.amount)}; fee ≤ ${near(q.fee)}`
    })
    if (d.unstaked > 1_000_000n && !d.canWithdraw) check(claim instanceof LiquidStakingError && claim.code === 'not-withdrawable', "unbonding: claim refused with 'not-withdrawable' and its epoch")
    await outcome('stake 0.1 NEAR', async () => {
      const q = await h.quoteStake({ amount: 10n ** 23n })
      return `${methods(q.transactions)}; ${q.shares} token units; storage fee ${near(q.storageFee)}; fee ≤ ${near(q.fee)}`
    })
  }
}

console.log(failures === 0 ? '\nall live checks passed' : `\n${failures} live check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
