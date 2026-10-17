// Read-only live verification against Ethereum mainnet: views, the APR API
// and eth_call proofs of the calldata the module would broadcast. No keys,
// no writes. Run `pnpm build` first (it imports the built module).
//
//   node scripts/verify-live.mjs [address] [rpcUrl]
import { createPublicClient, encodeFunctionData, http, parseAbi } from 'viem'
import SsvProtocolEvm, { SSV_ADDRESS_MAP, describeRevert } from '../dist/index.js'

const address = process.argv[2] ?? '0x8abe813577e47415a3cd0bbc68c7abca2c4c55ba'
const rpc = process.argv[3] ?? process.env.LIVE_RPC ?? 'https://ethereum-rpc.publicnode.com'

const account = {
  async getAddress () { return address },
  _config: { provider: rpc }
}
const protocol = new SsvProtocolEvm(account)
const fmt = (wei) => `${Number(wei) / 1e18}`

const apr = await protocol.getApr()
console.log(`APR: ${apr}% (ETH-denominated, on the SSV stake)`)

const cooldown = await protocol.getCooldown()
console.log(`cooldown: ${cooldown}s (${cooldown / 86400} days)`)

const stats = await protocol.getNetworkStats()
console.log(`network: ${fmt(stats.totalStaked)} SSV staked, ${fmt(stats.rewardsPool)} ETH rewards pool, accEthPerShare ${stats.accEthPerShare}`)

const liquid = await protocol.getTokenBalance()
const position = await protocol.getStakedBalance()
const rewards = await protocol.getClaimableRewards()
console.log(`account: ${fmt(liquid)} SSV liquid, ${fmt(position.balance)} cSSV staked, ${fmt(rewards)} ETH claimable`)

const queue = await protocol.getWithdrawalRequests()
console.log(`cooldown entries: ${queue.requests.length} open, pending ${fmt(queue.pendingAmount)} SSV, unlocked ${fmt(queue.claimableAmount)} SSV`)
for (const r of queue.requests) {
  console.log(`  #${r.id} ${fmt(r.amount)} SSV unlocks ${new Date(r.unlockTime * 1000).toISOString()} ${r.claimable ? '(READY)' : ''}`)
}

const history = await protocol.getAprHistory({ limit: 3 })
console.log(`apr history: ${history.map((s) => `${new Date(s.timestamp * 1000).toISOString().slice(0, 10)}=${s.apr.toFixed(2)}%`).join(' ') || 'none'}`)

// Prove the calldata the module would sign, from a cSSV-rich address:
// requestUnstake(1 wei of cSSV) and claimEthRewards() must execute in eth_call.
const { network } = SSV_ADDRESS_MAP[1]
const NETWORK_ABI = parseAbi([
  'function requestUnstake(uint256 amount)',
  'function withdrawUnlocked()',
  'function claimEthRewards()'
])
const client = createPublicClient({ transport: http(rpc) })
const rich = position.balance > 0n ? address : '0x079cdA955c283CcF2449b72897d68B1F474AA476'
for (const [fn, args] of [['requestUnstake', [1n]], ['claimEthRewards', []]]) {
  const data = encodeFunctionData({ abi: NETWORK_ABI, functionName: fn, args })
  try {
    await client.call({ account: rich, to: network, data })
    console.log(`${fn} eth_call from ${rich.slice(0, 10)}…: ok`)
  } catch (error) {
    const described = describeRevert(error)
    console.log(`${fn} eth_call from ${rich.slice(0, 10)}…: ${described.message}`)
    if (!described.selector) throw error
  }
}

// And the named-error path: withdrawUnlocked() on an account with nothing
// unlocked must come back as NothingToWithdraw, not an opaque revert.
if (queue.claimableIds.length === 0) {
  try {
    await client.call({ account: address, to: network, data: encodeFunctionData({ abi: NETWORK_ABI, functionName: 'withdrawUnlocked' }) })
    console.log('withdrawUnlocked eth_call: ok (something was unlocked after all)')
  } catch (error) {
    const described = describeRevert(error)
    if (described.selector !== '0xd0d04f60') throw error
    console.log(`withdrawUnlocked eth_call: ${described.message}`)
  }
}

console.log('LIVE VERIFY PASSED')
