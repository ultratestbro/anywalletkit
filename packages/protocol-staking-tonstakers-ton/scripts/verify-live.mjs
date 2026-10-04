// Read-only live verification against TON mainnet: pool data through the
// get-method, the account's jetton wallet and tsTON balance, APY, bills,
// earnings, and the exact messages the module would send. No keys, no writes.
//
//   node scripts/verify-live.mjs [address] [toncenterJsonRpcUrl]
import TonstakersProtocolTon, { TONSTAKERS_ADDRESS_MAP } from '../index.js'

const address = process.argv[2] ?? 'UQCbXJ1-Hd_CyyAt3TNgircduNIn5QH5dj1_LBNz__y4fQaq'
const rpc = process.argv[3] ?? process.env.LIVE_RPC ?? 'https://ton.access.orbs.network/1/mainnet/toncenter-api-v2/jsonRPC'

const account = { async getAddress () { return address } }
const protocol = new TonstakersProtocolTon(account, { tonClient: [{ url: rpc }, { url: 'https://toncenter.com/api/v2/jsonRPC' }] })
const gram = (nano) => `${Number(nano) / 1e9}`

const pool = await protocol.getPoolData()
console.log(`pool: halted=${pool.halted} depositsOpen=${pool.depositsOpen} tvl=${gram(pool.totalBalance)} GRAM supply=${gram(pool.supply)} tsTON`)
console.log(`rate: ${gram(pool.rate)} GRAM/tsTON now, ${gram(pool.projectedRate)} after the round; minter ${pool.jettonMinter?.toString()} payout ${pool.withdrawalPayout?.toString()}`)
if (pool.jettonMinter?.toString() !== TONSTAKERS_ADDRESS_MAP['-239'].jetton) throw new Error('jetton minter drifted from the address map')

const liquidity = await protocol.getInstantLiquidity()
console.log(`instant liquidity: ${gram(liquidity)} GRAM`)

const apy = await protocol.getApr()
console.log(`APY: ${apy}%`)

const wallet = await protocol.getJettonWallet()
const position = await protocol.getStakedBalance()
console.log(`account: jetton wallet ${wallet.toString()}, ${gram(position.balance)} tsTON ≈ ${gram(position.total)} GRAM`)

const bills = await protocol.getWithdrawalRequests()
console.log(`bills: ${bills.requests.length} open, ${gram(bills.pendingAmount)} tsTON pending`)
for (const b of bills.requests) console.log(`  #${b.id} ${gram(b.amount)} tsTON, round ends ${new Date(b.roundEnd * 1000).toISOString()}`)

const rewards = await protocol.getRewards()
console.log(rewards ? `rewards: entry rate ${gram(rewards.entryRate)}, earned ${gram(rewards.earned)} GRAM on ${gram(rewards.deposited)} GRAM deposited` : 'rewards: none')

// The messages the module would sign (no send): stake 1 GRAM, exits in all modes.
const stakeTx = await protocol._getStakeTransaction(10n ** 9n)
console.log(`stake tx: to ${stakeTx.to} value ${gram(stakeTx.value)} body ${stakeTx.body.toBoc().toString('base64')}`)
for (const mode of ['standard', 'instant', 'bestRate']) {
  const tx = await protocol._getUnstakeTransaction(10n ** 8n, mode)
  console.log(`unstake(${mode}) tx: to ${tx.to} value ${gram(tx.value)} body bits ${tx.body.bits.length}`)
}

console.log('LIVE VERIFY PASSED')
