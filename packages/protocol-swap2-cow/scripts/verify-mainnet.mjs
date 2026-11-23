#!/usr/bin/env node
// PUBLIC MAINNET (Base). Without --send it only quotes. `--send <case>` places one small, capped order from the test
// wallet and follows it to the end: eth-flow (native ETH → USDC), permit (USDC → WETH, the permit pre-hook, no gas),
// approve (WETH → USDC, one exact approval), cancel (USDC → WETH at the quoted price, cancelled off-chain at once).
// The signer phrase comes from COW_ENV_FILE (TEST_WALLET_MNEMONIC=...) and is never printed.
import {readFile, writeFile} from 'node:fs/promises'
import {createPublicClient, http, parseAbi, formatUnits} from 'viem'
import {WalletManagerEvm} from '../../wallet-evm/dist/index.js'
import {CowSwap2Protocol} from '../dist/index.js'

const CHAIN = 'eip155:8453', CHAIN_ID = 8453
const RPC = process.env.RPC_8453 ?? 'https://mainnet.base.org'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', WETH = '0x4200000000000000000000000000000000000006'
// Hard caps per case (base units of what is sold).
const CAP = {eth: 300_000_000_000_000n /* 0.0003 ETH */, usdc: 1_000_000n /* 1 USDC */, weth: 300_000_000_000_000n}
const REPORT = new URL('../mainnet-report.json', import.meta.url)

const check = (ok, msg) => { if (!ok) throw new Error(msg) }
async function phrase() {
  const file = process.env.COW_ENV_FILE
  check(file, 'set COW_ENV_FILE')
  const line = (await readFile(file, 'utf8')).split('\n').map((l) => /^TEST_WALLET_MNEMONIC=(.*)$/.exec(l.trim())).find(Boolean)
  const value = line?.[1].replace(/^(["'])(.*)\1$/, '$2').trim()
  check(value && value.split(/\s+/).length >= 12, 'TEST_WALLET_MNEMONIC missing')
  return value
}

const client = createPublicClient({transport: http(RPC)})
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)'])
async function balances(address) {
  const [eth, usdc, weth] = await Promise.all([
    client.getBalance({address}),
    client.readContract({address: USDC, abi: ERC20, functionName: 'balanceOf', args: [address]}),
    client.readContract({address: WETH, abi: ERC20, functionName: 'balanceOf', args: [address]}),
  ])
  return {eth, usdc, weth}
}
const show = (b) => `ETH ${formatUnits(b.eth, 18)}, USDC ${formatUnits(b.usdc, 6)}, WETH ${formatUnits(b.weth, 18)}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function follow(swaps, id, label, timeoutMs = 6 * 60_000) {
  const started = Date.now()
  let last
  while (Date.now() - started < timeoutMs) {
    last = await swaps.getSwap2Status(id).catch((e) => ({status: 'error', error: e.message}))
    const state = last.status ?? last.state
    console.log(`  ${label} ${Math.round((Date.now() - started) / 1000)}s: ${JSON.stringify(last, (_, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 220)}`)
    if (state && !['pending', 'error'].includes(state)) return last
    await sleep(10_000)
  }
  return last
}

const args = process.argv.slice(2)
const send = args[0] === '--send' ? args[1] : null
const manager = new WalletManagerEvm(await phrase(), {provider: RPC, chainId: CHAIN_ID})
const account = await manager.getAccount(0)
const me = await account.getAddress()
const swaps = new CowSwap2Protocol(account, {fromChain: CHAIN, enabled: true, enabledChains: [CHAIN_ID], rpcUrls: {[CHAIN_ID]: [RPC]}})
const before = await balances(me)
console.log(`account ${me} on Base: ${show(before)}`)

const amountFor = {
  'eth-flow': () => { const a = before.eth > 400_000_000_000_000n ? 200_000_000_000_000n : before.eth / 3n; return a < CAP.eth ? a : CAP.eth },
  permit: () => { const a = before.usdc / 2n; return a < CAP.usdc ? a : CAP.usdc },
  approve: () => (before.weth < CAP.weth ? before.weth : CAP.weth),
  cancel: () => { const a = before.usdc / 2n; return a < CAP.usdc ? a : CAP.usdc },
}
const pairs = {'eth-flow': ['ETH', 'USDC'], permit: ['USDC', 'WETH'], approve: ['WETH', 'USDC'], cancel: ['USDC', 'WETH']}

if (!send) {
  for (const [name, [from, to]] of Object.entries(pairs)) {
    const amount = amountFor[name]()
    if (amount <= 0n) { console.log(`${name}: nothing to sell`); continue }
    const q = await swaps.quoteSwap2({fromToken: from, toToken: to, toChain: CHAIN_ID, fromTokenAmount: amount, recipient: me}).catch((e) => ({error: e.message}))
    console.log(`${name}: ${from} ${amount} → ${to}`, q.error ?? `${q.toTokenAmount} (min ${q.toTokenAmountMin}), fees ${JSON.stringify(q.fees ?? [], (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`)
  }
  manager.dispose?.()
  process.exit(0)
}

check(pairs[send], `unknown case ${send}`)
const [from, to] = pairs[send]
const amount = amountFor[send]()
check(amount > 0n, `${send}: nothing to sell`)
const entry = {case: send, at: new Date().toISOString(), chain: CHAIN, account: me, from, to, amountIn: amount.toString(), before: Object.fromEntries(Object.entries(before).map(([k, v]) => [k, v.toString()]))}
const plans = []
swaps.on?.('phase', (p) => console.log('  phase', JSON.stringify(p)))
const q = await swaps.quoteSwap2({fromToken: from, toToken: to, toChain: CHAIN_ID, fromTokenAmount: amount, recipient: me})
console.log(`quote: ${amount} ${from} → ${q.toTokenAmount} ${to} (min ${q.toTokenAmountMin})`)
const options = {fromToken: from, toToken: to, toChain: CHAIN_ID, fromTokenAmount: amount, ...(send === 'cancel' ? {minAmountOut: q.toTokenAmount} : {})}
const result = await swaps.swap2(options)
entry.id = result.id
entry.result = JSON.parse(JSON.stringify(result, (_, v) => (typeof v === 'bigint' ? v.toString() : v)))
console.log('placed', JSON.stringify(entry.result))
if (send === 'cancel') {
  const cancelled = await swaps.cancelSwap2(result.id, account)
  entry.cancel = cancelled
  console.log('cancel', JSON.stringify(cancelled))
}
const final = await follow(swaps, result.id, send)
entry.status = JSON.parse(JSON.stringify(final ?? null, (_, v) => (typeof v === 'bigint' ? v.toString() : v)))
await sleep(5_000)
const after = await balances(me)
entry.after = Object.fromEntries(Object.entries(after).map(([k, v]) => [k, v.toString()]))
console.log(`after: ${show(after)}`)
const report = await readFile(REPORT, 'utf8').then(JSON.parse).catch(() => ({kind: 'public-mainnet-funded', limitations: ['Small capped orders from one test wallet on Base'], cases: []}))
report.cases.push(entry)
await writeFile(REPORT, JSON.stringify(report, null, 2) + '\n')
manager.dispose?.()
process.exit(0)
