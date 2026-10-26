#!/usr/bin/env node
// Live check on Monad, nothing signed: reads through the precompile, then every write planned for
// real delegators and simulated twice — by the module (`eth_call` as the wallet) and by the wallet
// itself (`quoteSendTransaction` → estimateGas). A plan the precompile would reject fails here.
//
//   node scripts/verify-live.mjs [rpcUrl] [chainId]          (or MONAD_RPC=… MONAD_CHAIN=…)
//
// Defaults: Monad mainnet's public RPC. Delegators are found from recent Delegate / Undelegate
// events, so the script needs no fixed addresses; steps the found wallets cannot make are skipped.
import { WalletAccountReadOnlyEvm } from '@anywalletkit/wallet-evm'
import { createPublicClient, http, parseAbi, formatUnits } from 'viem'
import { NativeStakingProtocolMonad, STAKING_PRECOMPILE, unpackWithdrawalId } from '../dist/index.js'

const RPC = process.argv[2] ?? process.env.MONAD_RPC ?? 'https://rpc.monad.xyz'
const CHAIN = Number(process.argv[3] ?? process.env.MONAD_CHAIN ?? 143)
const MON = 10n ** 18n
const fmt = (wei) => `${formatUnits(wei, 18)} MON`
const json = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))

let failures = 0
async function step(name, run) {
  try {
    const out = await run()
    console.log(`ok   ${name}${out === undefined ? '' : ` — ${out}`}`)
    return true
  } catch (e) {
    failures++
    console.log(`FAIL ${name} — ${e?.message ?? e}`)
    return false
  }
}
async function refused(name, pattern, run) {
  await step(name, async () => {
    try { await run() } catch (e) { if (pattern.test(e.message)) return 'refused as expected'; throw e }
    throw new Error('was not refused')
  })
}

const client = createPublicClient({ transport: http(RPC, { timeout: 30_000, retryCount: 3 }) })
const events = parseAbi([
  'event Delegate(uint64 indexed validatorId, address indexed delegator, uint256 amount, uint64 activationEpoch)',
  'event Undelegate(uint64 indexed validatorId, address indexed delegator, uint8 withdrawId, uint256 amount, uint64 activationEpoch)',
])
async function recentDelegators(want = 12) {
  const found = new Map()
  let to = await client.getBlockNumber()
  for (let i = 0; i < 120 && found.size < want; i++) {
    const from = to - 99n
    const logs = await client.getContractEvents({ address: STAKING_PRECOMPILE, abi: events, fromBlock: from, toBlock: to }).catch(() => [])
    for (const l of logs) if (!found.has(l.args.delegator)) found.set(l.args.delegator, l.args.validatorId)
    to = from - 1n
  }
  return [...found.entries()]
}

const probeAccount = new WalletAccountReadOnlyEvm('0x000000000000000000000000000000000000dEaD', { provider: RPC, chainId: CHAIN })
const any = new NativeStakingProtocolMonad(probeAccount, { validators: 'any', maxCommission: 100 })
await step('getEpoch', async () => json(await any.getEpoch()))
await step('getNetworkStats', async () => { const s = await any.getNetworkStats(); return `${s.consensusValidators} validators, ${fmt(s.totalConsensusStake)} staked, block ${s.blockTimeMs.toFixed(0)} ms, APR ${s.apr.toFixed(2)} % before commission` })
const top = await any.listValidators({ limit: 5 })
await step('listValidators (any, top 5)', async () => top.map((v) => `#${v.id} ${v.commission}% apr ${v.apr?.toFixed(2)} ${v.eligible ? 'eligible' : v.refusals.join('/')}`).join('; '))

const delegators = await recentDelegators()
console.log(`found ${delegators.length} recent delegators`)
const eoa = []
for (const [who, val] of delegators) {
  const [code, balance] = await Promise.all([client.getCode({ address: who }), client.getBalance({ address: who })])
  if (!code) eoa.push({ who, val, balance })
}
const rich = eoa.find((d) => d.balance > 20n * MON)
const cheap = top.find((v) => v.eligible && v.commission <= 10) ?? top.find((v) => v.eligible)
if (rich) {
  const acct = new WalletAccountReadOnlyEvm(rich.who, { provider: RPC, chainId: CHAIN })
  const listed = new NativeStakingProtocolMonad(acct, { validators: [{ id: cheap.id, name: 'cheap' }, rich.val], defaultValidator: cheap.id, maxCommission: 100 })
  console.log(`wallet ${rich.who} (${fmt(rich.balance)}), validators #${cheap.id} and #${rich.val}`)
  await step('listPositions', async () => (await listed.listPositions()).map((p) => `#${p.validatorId} active ${fmt(p.active)} activating ${fmt(p.activating + p.activatingNext)} rewards ${fmt(p.unclaimedRewards)}`).join('; ') || 'none')
  await step('getStakedBalance', async () => json(await listed.getStakedBalance()))
  await step('getApr (default validator)', async () => `${(await listed.getApr()).toFixed(2)} %`)
  await step('getMaxStakeable', async () => fmt(await listed.getMaxStakeable()))
  await step('quoteStake 1 MON (delegate, simulated)', async () => { const q = await listed.quoteStake({ amount: MON }); return `fee ${q.fee}, validator #${q.validator.id}, active from epoch ${q.activatesAtEpoch}` })
  const pos = (await listed.listPositions()).find((p) => p.active > MON)
  if (pos) {
    await step(`nextWithdrawId #${pos.validatorId}`, async () => String(await listed.nextWithdrawId(pos.validatorId)))
    await step(`quoteRequestWithdrawal 1 MON from #${pos.validatorId} (undelegate, simulated)`, async () => { const q = await listed.quoteRequestWithdrawal({ amount: MON, validator: pos.validatorId }); return `fee ${q.fee}, slot ${q.withdrawId}, id ${q.id}, claimable from epoch ${q.withdrawableAtEpoch}` })
    await refused('refuses unstaking more than the active stake', /Only .* is active/, () => listed.quoteRequestWithdrawal({ amount: pos.active + pos.activating + 1n, validator: pos.validatorId }))
    if (pos.unclaimedRewards > 0n) {
      await step(`quoteClaimRewards #${pos.validatorId} (simulated)`, async () => { const q = await listed.quoteClaimRewards({ validator: pos.validatorId }); return `fee ${q.fee}, ${fmt(q.amount)}` })
      if (pos.validator.eligible) await step(`quoteCompound #${pos.validatorId} (simulated)`, async () => { const q = await listed.quoteCompound({ validator: pos.validatorId }); return `fee ${q.fee}, ${fmt(q.amount)} active from ${q.activatesAtEpoch}` })
    }
  } else console.log('skip unstake / rewards quotes: no active stake above 1 MON')
  await refused('refuses a validator outside the list', /not-listed/, () => listed.quoteStake({ amount: MON, validator: top.find((v) => v.id !== cheap.id && v.id !== rich.val).id }))
  await refused('refuses below 1 gwei', /1 gwei/, () => listed.quoteStake({ amount: 10n ** 8n }))
  await refused('refuses dipping under the 10 MON reserve', /reserve balance/, () => listed.quoteStake({ amount: rich.balance - 5n * MON }))
  const strict = new NativeStakingProtocolMonad(acct, { validators: [cheap.id], maxCommission: Math.max(0, cheap.commission - 1) })
  if (cheap.commission > 0) await refused('refuses a commission above the cap', /commission .* > /, () => strict.quoteStake({ amount: MON }))
} else console.log('skip wallet checks: no funded EOA among recent delegators')

// Withdrawals: a wallet with pending requests (from Undelegate events).
const withPending = eoa.find((d) => d.balance > 0n)
for (const d of [withPending].filter(Boolean)) {
  const acct = new WalletAccountReadOnlyEvm(d.who, { provider: RPC, chainId: CHAIN })
  const p = new NativeStakingProtocolMonad(acct, { validators: 'any', maxWithdrawId: 31 })
  await step(`getWithdrawalRequests ${d.who.slice(0, 8)} (slots 0..31)`, async () => {
    const w = await p.getWithdrawalRequests()
    return `${w.requests.length} pending (${fmt(w.pendingAmount)}), claimable ${fmt(w.claimableAmount)} ${json(w.requests.slice(0, 3).map((r) => ({ v: r.validatorId, slot: r.withdrawId, opens: r.withdrawableAtEpoch })))}`
  })
  const w = await p.getWithdrawalRequests().catch(() => null)
  if (w?.claimableIds.length) await step('quoteClaimWithdrawals (withdraw, simulated)', async () => { const q = await p.quoteClaimWithdrawals({ ids: w.claimableIds.slice(0, 2) }); return `fee ${q.fee}, ${fmt(q.amount)} from ${q.claims.length}` })
  const notReady = w?.requests.find((r) => !r.claimable)
  if (notReady) await refused('refuses claiming a withdrawal that is not open yet', /opens at epoch/, () => p.quoteClaimWithdrawals({ ids: [notReady.id] }))
  if (notReady) console.log(`  (pending request ${json(unpackWithdrawalId(notReady.id))})`)
}

console.log(failures ? `\n${failures} failure(s)` : '\nall live checks passed')
process.exit(failures ? 1 : 0)
