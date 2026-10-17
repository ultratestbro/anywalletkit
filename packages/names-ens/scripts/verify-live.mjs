// Live check against Ethereum mainnet (public RPC): forward, L2 record, reverse, avatar, CCIP-Read subname.
import { ensResolver } from '../dist/index.js'
const rpcUrl = process.env.ETH_RPC_URL || 'https://ethereum-rpc.publicnode.com'
const r = ensResolver({ rpcUrl })
const show = async (label, fn) => {
  try { console.log(label, JSON.stringify(await fn())) } catch (e) { console.log(label, 'ERR', e.code ?? '', e.message) }
}
await show('vitalik.eth @ mainnet   ', () => r.resolve('vitalik.eth', 'eip155:1'))
await show('vitalik.eth @ base      ', () => r.resolve('vitalik.eth', 'eip155:8453'))
await show('reverse vitalik         ', () => r.reverse('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', 'eip155:1'))
await show('avatar vitalik.eth      ', () => r.avatar('vitalik.eth'))
await show('nick.eth @ mainnet      ', () => r.resolve('nick.eth', 'eip155:1'))
await show('offchain: jesse.base.eth', () => r.resolve('jesse.base.eth', 'eip155:8453'))
await show('reverse jesse @ base    ', () => r.reverse('0x849151d7D0bF1F34b70d5caD5149D28CC2308bf1', 'eip155:8453'))
await show('unregistered            ', () => r.resolve('nobody-owns-this-7f3a9c.eth', 'eip155:1'))
await show('lookalike pаypal.eth    ', () => r.resolve('pаypal.eth', 'eip155:1'))
await show('bad name                ', () => r.resolve('bad..eth', 'eip155:1'))
