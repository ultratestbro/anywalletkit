// Live verification against Solana mainnet, no keys and no writes: the pool
// decodes and matches the address map, the account's position and queue read,
// and the exact transactions the module would send — stake, instant exit,
// delayed exit, claim — pass `simulateTransaction` (signature checks off) as
// the given account. Pass a JitoSOL holder to exercise the exits; without
// arguments a known large holder is used.
//
//   node scripts/verify-live.mjs [address] [rpcUrl]
import { appendTransactionMessageInstructions, createTransactionMessage, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash } from '@solana/transaction-messages'
import { compileTransaction, getBase64EncodedWireTransaction } from '@solana/transactions'

import SplStakePoolProtocolSolana, { SPL_STAKE_POOL_ADDRESS_MAP } from '../index.js'

const address = process.argv[2] ?? '9hNaQ3crLjWihWa5BeQgSYfrPY3eoDmHJAX2sTWE8nUC'
const rpc = process.argv[3] ?? process.env.LIVE_RPC ?? 'https://api.mainnet-beta.solana.com'
const SOL = 10n ** 9n
const sol = (lamports) => `${Number(lamports) / 1e9}`

const account = { async getAddress () { return address } }
const protocol = new SplStakePoolProtocolSolana(account, { provider: [rpc, 'https://api.mainnet-beta.solana.com'] })

const pool = await protocol.getPoolData()
console.log(`pool ${protocol.pool.name}: epoch ${pool.epoch} updated=${pool.updated} tvl=${sol(pool.totalLamports)} SOL supply=${sol(pool.poolTokenSupply)} ${protocol.pool.symbol}`)
console.log(`rate: ${sol(pool.rate)} SOL/${protocol.pool.symbol} now, ${sol(pool.previousRate)} last epoch; reserve ${sol(pool.reserveLamports)} SOL (instant liquidity ${sol(pool.instantLiquidity)})`)
console.log(`fees: deposit ${pool.fees.solDepositPct}% instant ${pool.fees.solWithdrawalPct}% delayed ${pool.fees.stakeWithdrawalPct}% epoch ${pool.fees.epochPct}%; min delayed exit ${sol(pool.minimumStakeLamports)} SOL`)
if (pool.state.poolMint !== SPL_STAKE_POOL_ADDRESS_MAP.jito.mint) throw new Error('pool mint drifted from the address map')

console.log(`APY (on-chain estimate): ${(await protocol.getApr()).toFixed(2)}%`)

const position = await protocol.getStakedBalance()
console.log(`account: ${sol(position.balance)} ${protocol.pool.symbol} ≈ ${sol(position.total)} SOL, token account ${await protocol.getTokenAccount()}`)
const queue = await protocol.getWithdrawalRequests()
console.log(`delayed exits: ${queue.requests.length} (${sol(queue.pendingAmount)} SOL pending, ${sol(queue.claimableAmount)} SOL claimable)`)
for (const r of queue.requests) console.log(`  #${r.id} ${r.address} ${sol(r.amount)} SOL ${r.status}`)
const rewards = await protocol.getRewards({ limit: 20 })
console.log(rewards ? `rewards: entry rate ${sol(rewards.entryRate)}, earned ${sol(rewards.earned)} SOL on ${sol(rewards.deposited)} SOL deposited` : 'rewards: none in the last 20 transactions')

// ---- simulate what the module would send ----
const { value: blockhash } = await protocol._rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])
async function simulate (label, instructions, expectOk = true) {
  let m = createTransactionMessage({ version: 0 })
  m = setTransactionMessageFeePayer(address, m)
  m = setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash.blockhash, lastValidBlockHeight: BigInt(blockhash.lastValidBlockHeight) }, m)
  m = appendTransactionMessageInstructions(protocol._message(instructions).instructions, m)
  const wire = getBase64EncodedWireTransaction(compileTransaction(m))
  const { value } = await protocol._rpc('simulateTransaction', [wire, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' }])
  const ok = value.err === null
  console.log(`[${label}] ${ok ? 'OK' : 'FAILED'} units=${value.unitsConsumed} err=${JSON.stringify(value.err)}`)
  if (ok !== expectOk) {
    console.log((value.logs ?? []).slice(-8).join('\n'))
    throw new Error(`${label}: expected ${expectOk ? 'success' : 'failure'}`)
  }
}

// Sized to what the account holds: up to 0.1 SOL staked (0.01 SOL kept for fees), up to 0.05 tokens instant, 1 token delayed.
const native = await protocol.getNativeBalance()
const stakeLamports = native > SOL / 100n ? (native - SOL / 100n < SOL / 10n ? native - SOL / 100n : SOL / 10n) : 0n
if (stakeLamports > 0n) {
  const stake = await protocol._getStakeInstructions(stakeLamports)
  console.log(`stake ${sol(stakeLamports)} SOL → ${sol(stake.poolTokens)} ${protocol.pool.symbol}`)
  await simulate(`stake ${sol(stakeLamports)} SOL`, stake.instructions)
} else {
  console.log(`account holds ${sol(native)} SOL: stake not simulated`)
}

if (position.balance > 0n) {
  const instantTokens = position.balance < SOL / 20n ? position.balance : SOL / 20n
  const instant = await protocol._getUnstakeInstructions(instantTokens, 'instant')
  console.log(`instant ${sol(instantTokens)} ${protocol.pool.symbol} → ${sol(instant.lamportsOut)} SOL`)
  await simulate('instant exit', instant.instructions)
}
if (position.balance >= SOL) {
  const delayed = await protocol._getUnstakeInstructions(SOL, 'delayed')
  console.log(`delayed 1 ${protocol.pool.symbol} → ${sol(delayed.lamportsOut)} SOL into ${delayed.stakeAccount} from ${delayed.source.kind} ${delayed.source.account}`)
  await simulate('delayed exit', delayed.instructions)
  await protocol._getUnstakeInstructions(SOL / 10n, 'delayed').then(() => { throw new Error('sub-minimum delayed exit was not refused') }, (e) => console.log(`delayed 0.1 ${protocol.pool.symbol}: refused as expected — ${e.message.slice(0, 80)}…`))
} else {
  console.log(`account holds < 1 ${protocol.pool.symbol}: delayed exit not simulated`)
}
if (queue.claimableIds.length > 0) {
  const claim = await protocol._getClaimInstructions(queue.claimableIds)
  await simulate(`claim ${sol(claim.lamports)} SOL`, claim.instructions)
}

console.log('LIVE VERIFY PASSED')
