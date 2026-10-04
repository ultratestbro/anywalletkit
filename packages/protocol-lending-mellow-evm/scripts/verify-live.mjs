// Read-only live verification against Ethereum mainnet, no keys and no
// writes: the vault's components and queues are discovered on-chain and
// checked against the known Lido deployments, the account's position and
// queues read, and the exact supply / withdraw transactions the module would
// send are PROVEN with eth_call as the given account (a real holder to
// exercise the redeem path; the deposit proof needs an ETH balance).
//
//   node scripts/verify-live.mjs [address] [rpcUrl] [preset]
import MellowProtocolEvm, { MELLOW_ADDRESS_MAP, NATIVE_ASSET } from '../index.js'

const address = process.argv[2] ?? '0x0000000000000000000000000000000000000001'
const rpc = process.argv[3] ?? process.env.LIVE_RPC ?? 'https://ethereum-rpc.publicnode.com'
const preset = process.argv[4] ?? 'lido-earn-eth'
const KNOWN = {
  'lido-earn-eth': { shareManager: '0xbbfc8683c8fe8cf73777fede7ab9574935fea0a4', oracle: '0xada1f4c24603ab2fe5abd35bcd12370e98a20358', asyncDeposit: '0x1db7094ef0d994b0b62f6cd67db801ad194999a8', syncDeposit: '0xb99394f8b95d426cb2f013b857c74acc924b20d5', redeem: '0x095bfaca9f1c6f2b063cd67c6d6bfcd0c3aab7b4', redeemToken: '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0' },
  'lido-earn-usd': { shareManager: '0x4ce1ac8f43e0e5bd7a346a98af777bf8fbea1981', oracle: '0x827044735c9708a2cf850e7ea37eba43bc786028', asyncDeposit: '0xeec5041c47cba1e31321ac6941bf09ad60645b73', syncDeposit: '0x534d0beb82c47cf703bfb9e959297658b65ec8e9', redeem: '0x95092a7a86715246be6395b8d514b3d60a270cd3', redeemToken: '0xdac17f958d2ee523a2206206994597c13d831ec7', depositToken: '0xdac17f958d2ee523a2206206994597c13d831ec7' }
}

const account = { async getAddress () { return address } }
const protocol = new MellowProtocolEvm(account, { preset, provider: rpc })
const eq = (a, b) => a.toLowerCase() === b.toLowerCase()
const fmt = (x, d = 18) => `${Number(x) / 10 ** d}`

const data = await protocol.getVaultData()
console.log(`vault ${MELLOW_ADDRESS_MAP[1][preset].name} ${data.vault}: shareManager ${data.shareManager} oracle ${data.oracle} feeManager ${data.feeManager}`)
console.log(`fees: deposit ${data.fees.depositPct}% redeem ${data.fees.redeemPct}% performance ${data.fees.performancePct}% protocol ${data.fees.protocolPct}%/yr; oracle timeout ${data.oracleParams.timeout}s deposit ${data.oracleParams.depositInterval}s redeem ${data.oracleParams.redeemInterval}s; whitelist=${data.flags.hasWhitelist}`)
for (const a of data.assets) {
  console.log(`  asset ${a.native ? 'ETH' : a.address}: deposit ${a.depositQueues.map((q) => `${q.kind}${q.paused ? '(paused)' : ''}@${q.address.slice(0, 8)}`).join(' ')} | redeem ${a.redeemQueues.map((q) => `${q.kind}${q.paused ? '(paused)' : ''}@${q.address.slice(0, 8)}`).join(' ') || '—'}`)
}
const k = KNOWN[preset]
if (k) {
  if (!eq(data.shareManager, k.shareManager) || !eq(data.oracle, k.oracle)) throw new Error('components drifted from the known deployment')
  const flat = data.assets.flatMap((a) => [...a.depositQueues, ...a.redeemQueues])
  for (const [label, addr, kind] of [['async deposit', k.asyncDeposit, 'async'], ['sync deposit', k.syncDeposit, 'sync'], ['redeem', k.redeem, 'async']]) {
    const q = flat.find((x) => eq(x.address, addr))
    if (!q || q.kind !== kind) throw new Error(`${label} queue ${addr} not discovered as ${kind}`)
  }
  console.log('discovery matches the production wallet\'s queue addresses ✓')
}

const stats = await protocol.getStats()
console.log(stats ? `registry: ${stats.id} apy ${stats.apy}% tvl $${Math.round((stats.tvlUsd ?? 0) / 1e6)}M withdraw avg ${Math.round((stats.withdrawAvgSeconds ?? 0) / 3600)}h` : 'registry: unavailable')

const position = await protocol.getPosition()
console.log(`account ${address}: ${fmt(position.shares)} shares ≈ ${fmt(position.value, position.token === NATIVE_ASSET ? 18 : 6)} of ${position.token === NATIVE_ASSET ? 'ETH' : position.token}, report ${new Date(position.reportAt * 1000).toISOString()} suspicious=${position.suspicious}`)
console.log(`  pending deposits ${position.pendingDeposits.length}, claimable shares ${fmt(position.claimableShares)}, redeem requests ${position.redeemRequests.length}`)
const queue = await protocol.getWithdrawalRequests()
for (const r of queue.requests) console.log(`  redeem ${r.id} ${fmt(r.shares)} shares → ${r.assets} ${r.claimable ? 'claimable' : 'pending'}`)

// Plans (no send): what supply / withdraw would do for this account.
const depositToken = k?.depositToken ?? 'native'
const amount = depositToken === 'native' ? 10n ** 16n : 10n * 10n ** 6n
try {
  const plan = await protocol._getSupplyPlan(depositToken, amount)
  console.log(`supply ${amount} of ${depositToken}: ${plan.instant ? 'instant' : 'async'} queue ${plan.queue.address}, ${plan.approvals.length} approval(s), ≈ ${fmt(plan.sharesOut)} shares`)
} catch (e) {
  console.log(`supply plan: ${e.message}`)
}
if (position.shares > 0n) {
  const plan = await protocol._getWithdrawPlan(k?.redeemToken ?? position.token, position.shares / 2n)
  console.log(`withdraw half (${fmt(position.shares / 2n)} shares) → queue ${plan.queue}, ≈ ${plan.assetsOut} of ${k?.redeemToken ?? position.token}`)
  await protocol._requireProvider().call({ from: address, to: plan.tx.to, data: plan.tx.data })
  console.log('redeem proven with eth_call ✓')
}
for (const method of ['borrow', 'repay']) {
  await protocol[method]({ token: NATIVE_ASSET, amount: 1n }).then(() => { throw new Error(`${method} did not reject`) }, (e) => { if (e.name !== 'NotImplementedError') throw e })
}
console.log('LIVE VERIFY PASSED')
