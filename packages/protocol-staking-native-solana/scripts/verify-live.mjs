#!/usr/bin/env node
// Live check on Solana mainnet, nothing signed: reads, then every write planned for a real wallet
// and simulated by the wallet's own pipeline (`quoteSendTransaction` runs `simulateTransaction`
// with sigVerify off). A plan the Stake program would reject fails here.
//
//   node scripts/verify-live.mjs [address] [rpcUrl]      (or WALLET=… SOLANA_RPC=…)
//
// Defaults: a wallet that had stake accounts and SOL on 2026-10-26 (staker of ~900 accounts, so
// `discover` is exercised for real) and the public RPC. Writes the wallet cannot make are skipped.
import { WalletAccountReadOnlySolana } from '@anywalletkit/wallet-solana'
import { NativeStakingProtocolSolana } from '../dist/index.js'

const PUBLIC = 'https://api.mainnet-beta.solana.com'
const RPC = process.argv[3] ?? process.env.SOLANA_RPC ?? PUBLIC
const WALLET = process.argv[2] ?? process.env.WALLET ?? '8NDkBUK5TeK9a8wfzToa1phV2BTW5zA4DdXNvZKjHvWV'
const SOL = 1_000_000_000n
const fmt = (v) => `${Number(v) / 1e9} SOL`
const json = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))

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

const account = new WalletAccountReadOnlySolana(WALLET, { provider: RPC === PUBLIC ? RPC : [RPC, PUBLIC] })
const probe = new NativeStakingProtocolSolana(account, { validators: 'any', discover: true })
const top = (await probe.listValidators({ limit: 40 })).filter((v) => v.eligible).slice(0, 3)
const mine = await probe.getStakeAccounts()
const delegatedTo = [...new Set(mine.map((a) => a.validator).filter(Boolean))]
const validators = [...new Set([...top.map((v) => v.voteAccount), ...delegatedTo])]
console.log(`wallet ${WALLET}, ${mine.length} stake account(s); validators: ${validators.join(', ')}`)

const staking = new NativeStakingProtocolSolana(account, { validators, discover: true, maxCommission: 100 })

await step('getEpochInfo', async () => { const e = await staking.getEpochInfo(); return `epoch ${e.epoch}, ${(e.progress * 100).toFixed(1)} %, ends ${new Date(e.endsAt).toISOString()}` })
await step('getStakeParams', async () => { const p = await staking.getStakeParams(); return `rent ${p.rentExempt}, minimum delegation ${p.minimumDelegation}` })
await step('listValidators', async () => (await staking.listValidators()).map((v) => `${v.voteAccount.slice(0, 6)} ${v.commission} % apr ${v.apr?.toFixed(2)} ${v.eligible ? 'eligible' : v.refusals.join('/')}`).join('; '))
await step('getApr', async () => `${(await staking.getApr({ validator: top[0].voteAccount })).toFixed(2)} %`)
await step('getStakeAccounts', async () => {
  const list = await staking.getStakeAccounts()
  const by = {}
  for (const a of list) by[a.status] = (by[a.status] ?? 0) + 1
  return `${list.length}: ${json(by)}; first ${list.slice(0, 3).map((a) => `${a.address.slice(0, 6)} ${a.status} delegated ${fmt(a.delegated)} eff ${fmt(a.effective)} withdrawable ${fmt(a.withdrawable)}`).join('; ')}`
})
await step('getStakedBalance', async () => json(await staking.getStakedBalance()))
await step('getWithdrawalRequests', async () => { const w = await staking.getWithdrawalRequests(); return `${w.requests.length} request(s), pending ${fmt(w.pendingAmount)}, claimable ${fmt(w.claimableAmount)}` })
await step('getRewards (2 epochs)', async () => { const r = await staking.getRewards({ epochs: 2 }); return `total ${fmt(r.total)}; ${r.epochs.map((e) => ('error' in e ? `${e.epoch}: ${e.error}` : `${e.epoch}: ${fmt(e.amount)} over ${e.accounts.length} account(s)`)).join('; ')}` })
await step('getMaxStakeable', async () => fmt(await staking.getMaxStakeable()))

// Writes, simulated.
if ((await staking.getMaxStakeable()) < SOL) console.log('skip quoteStake: the wallet holds less than 1 SOL + rent + reserve')
else await step('quoteStake 1 SOL (create + initialize + delegate, simulated)', async () => {
  const q = await staking.quoteStake({ amount: SOL, validator: top[0].voteAccount })
  return `fee ${q.fee}, account ${q.stakeAccount} (${q.seed}), total ${fmt(q.total)}, active from epoch ${q.readyEpoch}`
})
const accounts = await staking.getStakeAccounts().catch((e) => { failures++; console.log(`FAIL getStakeAccounts — ${e.message}`); return [] })
const active = accounts.filter((a) => a.kind === 'delegated' && a.deactivationEpoch === null && a.canManage && a.owned)
if (active.length) {
  const a = active.sort((x, y) => (y.delegated > x.delegated ? 1 : -1))[0]
  await step(`quoteRequestWithdrawal whole ${a.address.slice(0, 6)} (deactivate, simulated)`, async () => {
    const q = await staking.quoteRequestWithdrawal({ amount: a.delegated, account: a.address })
    return `fee ${q.fee}, steps ${json(q.steps)}, claimable from epoch ${q.readyEpoch}`
  })
  if (a.delegated >= 2n * SOL + 1n) {
    await step(`quoteRequestWithdrawal 1 SOL of ${a.address.slice(0, 6)} (split + deactivate, simulated)`, async () => {
      const q = await staking.quoteRequestWithdrawal({ amount: SOL, account: a.address })
      return `fee ${q.fee}, steps ${json(q.steps)}`
    })
  }
  const pair = active.find((b) => b !== a && b.validator === a.validator && b.status === 'active' && a.status === 'active')
  if (pair) await step('quoteMerge (two active, same validator, simulated)', async () => `fee ${(await staking.quoteMerge({ destination: a.address, source: pair.address })).fee}`)
} else console.log('skip unstake quotes: no delegated account')
const cooling = accounts.find((a) => a.status === 'deactivating' && a.canManage && a.deactivationEpoch === (accounts.length ? a.deactivationEpoch : null))
const epochNow = (await staking.getEpochInfo()).epoch
const undo = accounts.find((a) => a.status === 'deactivating' && a.canManage && a.owned && a.deactivationEpoch === epochNow)
if (undo) await step(`quoteDelegate reactivate ${undo.address.slice(0, 6)} (undo this epoch's unstake, simulated)`, async () => { const q = await staking.quoteDelegate({ account: undo.address }); return `mode ${q.mode}, fee ${q.fee}` })
else if (cooling) console.log('skip reactivate: the cooling account was deactivated in an earlier epoch')
const claimable = accounts.filter((a) => a.withdrawable === a.lamports && a.canWithdraw)
if (claimable.length) {
  await step('quoteClaimWithdrawals (withdraw, simulated)', async () => { const q = await staking.quoteClaimWithdrawals(); return `fee ${q.fee}, ${fmt(q.amount)} from ${q.accounts.length}` })
  await step('quoteClaimWithdrawals one account by id (simulated)', async () => { const q = await staking.quoteClaimWithdrawals({ ids: [claimable[0].id] }); return `fee ${q.fee}, ${fmt(q.amount)}` })
} else console.log('skip claim quotes: nothing the wallet can withdraw')
const idle = accounts.filter((a) => a.status === 'inactive' && a.canManage && a.owned)
const re = idle.find((a) => a.lamports - 1_666_240n >= SOL)
if (re) await step('quoteDelegate an inactive account (simulated)', async () => `fee ${(await staking.quoteDelegate({ account: re.address, validator: top[0].voteAccount })).fee}`)
else console.log('skip delegate quote: no inactive account with ≥ 1 SOL the wallet manages')
const two = idle.filter((a) => a.withdrawer === idle[0]?.withdrawer && a.staker === idle[0]?.staker)
if (two.length >= 2) await step('quoteMerge two inactive accounts (simulated)', async () => `fee ${(await staking.quoteMerge({ destination: two[0].address, source: two[1].address })).fee}`)
else console.log('skip merge quote: fewer than two inactive accounts')

// Refusals that must happen before anything is built.
const managedOnly = accounts.find((a) => a.kind === 'delegated' && a.canManage && !a.owned && a.deactivationEpoch === null)
if (managedOnly) await step('refuses to unstake an account the wallet only manages', async () => {
  try { await staking.quoteRequestWithdrawal({ amount: managedOnly.delegated, account: managedOnly.address }) } catch (e) { if (/not the wallet's/.test(e.message)) return 'refused'; throw e }
  throw new Error('was not refused')
})
await step('refuses a validator outside the list', async () => {
  const outsider = (await probe.listValidators({ limit: 80 })).find((v) => !validators.includes(v.voteAccount))
  try { await staking.quoteStake({ amount: SOL, validator: outsider.voteAccount }) } catch (e) { if (/not-listed/.test(e.message)) return 'refused'; throw e }
  throw new Error('was not refused')
})
await step('refuses below the minimum delegation', async () => {
  try { await staking.quoteStake({ amount: SOL - 1n, validator: top[0].voteAccount }) } catch (e) { if (/minimum delegation/.test(e.message)) return 'refused'; throw e }
  throw new Error('was not refused')
})

console.log(failures ? `\n${failures} failure(s)` : '\nall live checks passed')
process.exit(failures ? 1 : 0)
