#!/usr/bin/env node
// Read-only check of Savings crvUSD on Ethereum: the identity checks (EIP-1167 clone of the pinned
// VaultV3 3.0.4 implementation, its code hash, apiVersion, asset), the vault's state, the APY (API
// against the on-chain projection), a holder's position and a redeem proof from the holder; then
// the module's own calldata proven end to end for a dummy address that never held anything:
// eth_call with a state override gives it crvUSD and the vault allowance (deposit) or scrvUSD
// shares (redeem, withdraw). Nothing is signed or sent. RPC: CURVE_RPC; holder: CURVE_USER.
//
// An API figure outside the on-chain band prints a `WARN … (third-party state …)` line and the run
// still exits 0 (scripts/watch/canary.mjs reports it as warn): the module clamps it, which is the
// behaviour under test. A failed check, read or proof fails the run.
import { createMockAccount } from '@anywalletkit/conformance'
import { createPublicClient, encodeAbiParameters, encodeFunctionData, decodeFunctionResult, getAddress, http, keccak256, pad, toHex } from 'viem'
import { ScrvUsdProtocolEvm, SCRVUSD, VAULT_V3_ABI, ERC20_ABI } from '../dist/index.js'

const rpc = process.env.CURVE_RPC ?? 'https://ethereum-rpc.publicnode.com'
// A large scrvUSD holder (an EOA, 882 516 scrvUSD on 2026-11-05).
const holder = getAddress(process.env.CURVE_USER ?? '0xcbE72c8Dc34af0Dc8e7a70Df4C1Da0ef23FeCA8E')
const DUMMY = getAddress('0x00000000000000000000000000000000C0ffEE01')
const E18 = 10n ** 18n
const fmt = (x) => `${(Number(x / 10n ** 14n) / 1e4).toLocaleString('en-US')}`

const base = createPublicClient({ transport: http(rpc, { timeout: 30_000, retryCount: 3 }) })

console.log('--- scrvUSD', SCRVUSD.vault, 'on', rpc)
const p = new ScrvUsdProtocolEvm(createMockAccount({ chain: 'eip155:1', address: holder }).toReadOnlyAccount(), { provider: rpc })
await p.verify()
console.log('   identity ok: clone →', SCRVUSD.implementation, '· impl code hash', SCRVUSD.implementationCodeHash.slice(0, 18) + '…', '· apiVersion', SCRVUSD.apiVersion, '· asset crvUSD')
const v = await p.getVault()
console.log('  ', {
  block: String(v.block), totalAssets: fmt(v.totalAssets), totalSupply: fmt(v.totalSupply), totalIdle: fmt(v.totalIdle), totalDebt: String(v.totalDebt),
  pricePerShare: String(v.pricePerShare), isShutdown: v.isShutdown, profitMaxUnlockTime: String(v.profitMaxUnlockTime),
  fullProfitUnlockDate: new Date(Number(v.fullProfitUnlockDate) * 1000).toISOString(), roleManager: v.roleManager,
})
if (v.totalDebt > 0n) console.log('   WARN totalDebt > 0 (third-party state, not a module failure): the vault lends to strategies; deposits are refused (StrategiesInUse)')
if (v.isShutdown) console.log('   WARN vault is shut down (third-party state, not a module failure): deposits are refused (VaultShutdown)')

const apy = await p.getApyDetails()
console.log('   apy', { apy: apy.apy.toFixed(4), source: apy.source, chainApy: apy.chainApy.toFixed(4), apiApy: apy.apiApy?.toFixed(4) ?? null, block: String(apy.block) })
if (apy.source === 'api-clamped') console.log(`   WARN API APY ${apy.apiApy} outside the on-chain band around ${apy.chainApy.toFixed(4)} (third-party state, not a module failure): clamped`)
if (apy.source === 'chain' && apy.apiApy === null) console.log('   WARN Curve API unavailable (third-party state, not a module failure): on-chain APY only')

console.log('--- holder', holder)
const pos = await p.getPosition()
console.log('   position', { shares: fmt(pos.shares), assets: fmt(pos.assets), withdrawable: fmt(pos.withdrawable), redeemableShares: fmt(pos.redeemableShares) })
if (pos.shares > 0n) {
  const q = await p.quoteWithdraw({ amount: 'max' })
  console.log('   quoteWithdraw(max) proven from the holder:', { assetsOut: fmt(q.assetsOut), sharesIn: fmt(q.sharesIn), complete: q.complete, fee: String(q.fee) })
} else console.log('   (holder has no shares: redeem proof from the holder skipped)')

// ---- the module's calldata for an address that never held anything, under a state override ----
// Vyper storage: crvUSD `allowance` HashMap at slot 0, `balanceOf` at slot 1; VaultV3 `balance_of` at
// slot 18 (keys hashed slot-first). Found by probing on 2026-11-05; checked below before use.
const word = (n) => pad(toHex(n))
const slotOf = (slot, k) => keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }], [slot, k]))
const nested = (slot, k1, k2) => keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'address' }], [slotOf(slot, k1), k2]))
const FUND = 1_000n * E18
// Every eth_call below runs at one block: profit unlocks every second, so a preview read in one
// block and the proof in the next differ by a few wei and the equality checks would flake.
const pinned = toHex(await base.getBlockNumber())
const preview = decodeFunctionResult({ abi: VAULT_V3_ABI, functionName: 'previewDeposit', data: (await base.request({ method: 'eth_call', params: [{ to: SCRVUSD.vault, data: encodeFunctionData({ abi: VAULT_V3_ABI, functionName: 'previewDeposit', args: [FUND] }) }, pinned] })) })
const override = {
  [SCRVUSD.asset]: { stateDiff: { [slotOf(1n, DUMMY)]: word(FUND), [nested(0n, DUMMY, SCRVUSD.vault)]: word(FUND) } },
  [SCRVUSD.vault]: { stateDiff: { [slotOf(18n, DUMMY)]: word(preview) } },
}
/** The read RPC with every eth_call run against the override, at the pinned block. */
const overridden = {
  request: async ({ method, params }) => {
    if (method === 'eth_call') {
      const [tx] = params
      return base.request({ method, params: [tx, pinned, override] })
    }
    return base.request({ method, params })
  },
}
const call = async (to, abi, functionName, args, from) => {
  const data = encodeFunctionData({ abi, functionName, args })
  const raw = await overridden.request({ method: 'eth_call', params: [{ to, data, ...(from ? { from } : {}) }, 'latest'] })
  return decodeFunctionResult({ abi, functionName, data: raw })
}
const [bal, allowance, shares] = await Promise.all([
  call(SCRVUSD.asset, ERC20_ABI, 'balanceOf', [DUMMY]), call(SCRVUSD.asset, ERC20_ABI, 'allowance', [DUMMY, SCRVUSD.vault]), call(SCRVUSD.vault, VAULT_V3_ABI, 'balanceOf', [DUMMY]),
])
if (bal !== FUND || allowance !== FUND || shares !== preview) throw new Error(`state override did not take (storage layout changed?): balance ${bal}, allowance ${allowance}, shares ${shares}`)

console.log('--- dummy', DUMMY, '(state override: 1 000 crvUSD + allowance, then', fmt(preview), 'scrvUSD)')
const d = new ScrvUsdProtocolEvm(createMockAccount({ chain: 'eip155:1', address: DUMMY }).toReadOnlyAccount(), { provider: overridden, api: null })
const plan = await d.planSupply({ amount: FUND })
if (plan.approvals.length !== 0) throw new Error('the overridden allowance should make the approval unnecessary')
const qs = await d.quoteSupply({ amount: FUND })
const minted = decodeFunctionResult({ abi: VAULT_V3_ABI, functionName: 'deposit', data: await overridden.request({ method: 'eth_call', params: [{ from: DUMMY, to: plan.tx.to, data: plan.tx.data }, 'latest'] }) })
console.log('   deposit(1 000 crvUSD) proven:', { sharesOut: fmt(qs.sharesOut), minted: fmt(minted), calldata: plan.tx.data.slice(0, 10) })
if (minted !== qs.sharesOut) throw new Error(`deposit minted ${minted} shares, previewDeposit said ${qs.sharesOut}`)

const wp = await d.planWithdraw({ amount: 'max' })
const qw = await d.quoteWithdraw({ amount: 'max' })
const paid = decodeFunctionResult({ abi: VAULT_V3_ABI, functionName: 'redeem', data: await overridden.request({ method: 'eth_call', params: [{ from: DUMMY, to: wp.tx.to, data: wp.tx.data }, 'latest'] }) })
console.log('   redeem(every share, max_loss 0) proven:', { assetsOut: fmt(qw.assetsOut), paid: fmt(paid), complete: qw.complete, calldata: wp.tx.data.slice(0, 10) })
if (paid !== qw.assetsOut || !qw.complete) throw new Error(`redeem paid ${paid}, previewRedeem said ${qw.assetsOut}`)
if (FUND - paid > 2n) throw new Error(`deposit → redeem lost ${FUND - paid} base units (more than the two round-downs)`)

const qp = await d.quoteWithdraw({ amount: 100n * E18 })
console.log('   withdraw(100 crvUSD, max_loss 0) proven:', { sharesIn: fmt(qp.sharesIn), complete: qp.complete })
console.log('ok')
