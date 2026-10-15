// Read-only live verification against Ethereum mainnet: views, REST endpoints
// and a stake-calldata simulation via eth_call. No keys, no writes.
//
//   node scripts/verify-live.mjs [address] [rpcUrl]
import LidoProtocolEvm from '../dist/index.js'

const address = process.argv[2] ?? '0x8abe813577e47415a3cd0bbc68c7abca2c4c55ba'
const rpc = process.argv[3] ?? process.env.LIVE_RPC ?? 'https://ethereum-rpc.publicnode.com'

const account = {
  async getAddress () { return address },
  _config: { provider: rpc }
}
const protocol = new LidoProtocolEvm(account)

const fmt = (wei) => `${Number(wei) / 1e18}`

const apr = await protocol.getApr()
console.log(`APR (7d SMA): ${apr}%`)

const position = await protocol.getStakedBalance()
console.log(`stETH: ${fmt(position.balance)}  wstETH: ${fmt(position.wrappedBalance)}  rate: ${fmt(position.rate)}  total: ${fmt(position.total)} stETH`)

const queue = await protocol.getWithdrawalRequests()
console.log(`queue: ${queue.requests.length} open, pending ${fmt(queue.pendingAmount)} stETH, claimable ${fmt(queue.claimableAmount)} ETH (ids: ${queue.claimableIds.join(',') || 'none'})`)

if (queue.requests.length > 0) {
  const eta = await protocol.getWithdrawalEta(queue.requests.map((r) => r.id))
  console.log(`eta: ${[...eta.entries()].map(([id, s]) => `#${id}~${Math.ceil(s / 3600)}h`).join(' ') || 'all finalized'}`)
}

const rewards = await protocol.getRewards()
console.log(rewards ? `rewards: ${fmt(rewards.totalRewards)} stETH lifetime, avg APR ${rewards.averageApr}%` : 'rewards: endpoint returned nothing')

const history = await protocol.getRewardHistory({ limit: 3 })
console.log(`reward history: ${history.length} events${history[0] ? `, latest ${fmt(history[0].reward)} stETH @ ${new Date(history[0].timestamp * 1000).toISOString()}` : ''}`)

// Prove the stake transaction the module would broadcast actually executes:
// eth_call it from an ETH-rich address (the beacon deposit contract).
// (`_provider` is the module's viem public client; `call` takes `account` and answers `{ data }`.)
const tx = await protocol._getStakeTransaction(10n ** 15n)
const { data: out } = await protocol._provider.call({ ...tx, account: '0x00000000219ab540356cBB839Cbe05303d7705Fa' })
console.log(`stake eth_call: ok, shares=${BigInt(out)}`)

console.log('LIVE VERIFY PASSED')
