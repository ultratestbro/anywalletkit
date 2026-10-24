#!/usr/bin/env node
// Read-only check against the real Ethereum Core market: proves the ABIs
// (struct decoding of getReserveData, oracle, gateway), the preset addresses
// and the quote path. No key, nothing is sent. RPC: AAVE_RPC or a public node.
import { createMockAccount } from '@anywalletkit/conformance'
import { AaveProtocolEvm } from '../dist/index.js'

const rpc = process.env.AAVE_RPC ?? 'https://ethereum-rpc.publicnode.com'
const chainId = Number(process.env.AAVE_CHAIN ?? 1)
const market = process.env.AAVE_MARKET ?? 'core'
// A read-only account: any address works for reads; a whale-ish one makes the position non-empty.
const who = process.env.AAVE_USER ?? '0x000000000000000000000000000000000000dEaD'
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7'

const account = createMockAccount({ chain: `eip155:${chainId}`, address: who }).toReadOnlyAccount()
const aave = new AaveProtocolEvm(account, { chainId, market, provider: rpc })

const m = await aave.getMarket()
console.log('market', m.name, { pool: m.pool, oracle: m.oracle, baseCurrencyUnit: String(m.baseCurrencyUnit), wrappedNative: m.wrappedNative })

const reserves = await aave.getReserves()
console.log(`reserves: ${reserves.length}`)
for (const r of reserves.slice(0, 40)) {
  console.log(`  ${r.symbol.padEnd(10)} supply ${r.supplyApy.toFixed(2).padStart(6)}%  borrow ${r.borrowApy.toFixed(2).padStart(6)}%  ltv ${(r.ltv * 100).toFixed(0).padStart(3)}%  ${r.frozen ? 'FROZEN ' : ''}${r.paused ? 'PAUSED ' : ''}${r.borrowingEnabled ? '' : 'no-borrow '}cap ${r.supplyCap}`)
}

const usdt = reserves.find((r) => r.asset.toLowerCase() === USDT.toLowerCase()) ?? reserves[0]
console.log('price', usdt.symbol, String(await aave.getAssetPrice(usdt.asset)), '/ base unit', String(m.baseCurrencyUnit))
console.log('account', await aave.getUserAccountData())
const pos = await aave.getPosition()
console.log('position', { supplies: pos.supplies.map((s) => `${s.symbol}:${s.amount}${s.collateral ? ' (collateral)' : ''}`), borrows: pos.borrows.map((b) => `${b.symbol}:${b.amount}`) })

// A quote needs allowance / balance context; with a stranger's address the proof may refuse — that is still a decoded Aave answer.
try {
  const q = await aave.quoteSupply({ token: usdt.asset, amount: 10n ** BigInt(usdt.decimals) })
  console.log('quoteSupply', q)
} catch (e) {
  console.log('quoteSupply →', e.name, e.message)
}
console.log('ok')
