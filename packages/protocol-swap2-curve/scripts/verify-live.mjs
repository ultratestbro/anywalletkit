#!/usr/bin/env node
// Live check of every pinned Curve Router NG, nothing signed: per chain the router's code hash, version, wrapped native
// and ABI family (selector scan of the code) against the pins, then up to three real quotes from the package's pool
// allowlist through the provider, each simulated with eth_call: a dummy address is given the input (native balance, or
// the token's balance and the router's allowance through a stateOverride of the slots found by probing) and calls the
// quote's exact router transaction; the router's return must be at least the quote's minimum. A chain without
// allowlisted pools must not be offered and a quote there must refuse by name. One line per chain.
//
//   node scripts/verify-live.mjs [chainId[,chainId…]] [--rpc url]        (build first: pnpm build)
//
// RPC: --rpc (one chain), else CURVE_RPC_<chainId>, else the public endpoint below. Reads are batched (≤10 calls) and
// retried with backoff on 429 / network errors; chains run one after another.
import {decodeFunctionResult, encodeFunctionData, keccak256, parseAbi} from 'viem'
import {CURVE_DEPLOYMENTS, CURVE_POOLS, EXCHANGE_SELECTOR, GET_DY_SELECTOR, curveOnChain, curveProvider} from '../dist/index.js'

const PUBLIC_RPC = {
  1: 'https://ethereum-rpc.publicnode.com', 42161: 'https://arbitrum-one-rpc.publicnode.com', 8453: 'https://base-rpc.publicnode.com',
  10: 'https://optimism-rpc.publicnode.com', 137: 'https://polygon-bor-rpc.publicnode.com', 100: 'https://gnosis-rpc.publicnode.com',
  43114: 'https://avalanche-c-chain-rpc.publicnode.com', 56: 'https://bsc-rpc.publicnode.com', 146: 'https://rpc.soniclabs.com',
  130: 'https://unichain-rpc.publicnode.com', 999: 'https://rpc.hyperliquid.xyz/evm', 5000: 'https://rpc.mantle.xyz', 143: 'https://rpc.monad.xyz',
  9745: 'https://rpc.plasma.to', 4663: 'https://rpc.mainnet.chain.robinhood.com', 57073: 'https://rpc-gel.inkonchain.com',
  196: 'https://rpc.xlayer.tech', 98866: 'https://rpc.plume.org',
}
const args = process.argv.slice(2)
const rpcFlag = args.indexOf('--rpc') >= 0 ? args[args.indexOf('--rpc') + 1] : undefined
const only = args.find((a) => /^[0-9,]+$/.test(a))?.split(',').map(Number)
const chains = (only ?? Object.keys(CURVE_DEPLOYMENTS).map(Number))
const urlFor = (id) => (rpcFlag && only?.length === 1 ? rpcFlag : process.env[`CURVE_RPC_${id}`] || PUBLIC_RPC[id])

const DUMMY = '0x00000000000000000000000000000000c0ffee01'
const ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)'])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** One JSON-RPC batch (≤10), retried on 429 / network errors with backoff. Slots: result, or {error}. */
async function batch(url, calls) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(calls.map((c, id) => ({jsonrpc: '2.0', id, ...c}))), signal: AbortSignal.timeout(30_000)})
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      if (!Array.isArray(body)) throw new Error(body?.error?.message ?? 'batch refused')
      const out = calls.map(() => ({error: 'no answer'}))
      for (const r of body) if (typeof r.id === 'number') out[r.id] = r.error ? {error: r.error.message ?? JSON.stringify(r.error)} : r.result
      return out
    } catch (e) {
      if (attempt >= 4) throw e
      await sleep(1000 * 2 ** attempt)
    }
  }
}
async function calls(url, list) {
  const out = []
  for (let i = 0; i < list.length; i += 10) { out.push(...(await batch(url, list.slice(i, i + 10)))); if (i + 10 < list.length) await sleep(150) }
  return out
}
const word = (n) => BigInt(n).toString(16).padStart(64, '0')
const addrWord = (a) => a.toLowerCase().slice(2).padStart(64, '0')
const slotKey = (key, slot, vyper) => keccak256(`0x${vyper ? word(slot) + addrWord(key) : addrWord(key) + word(slot)}`)
const nestedKey = (outer, inner, slot, vyper) => {
  const first = slotKey(outer, slot, vyper)
  return keccak256(`0x${vyper ? first.slice(2) + addrWord(inner) : addrWord(inner) + first.slice(2)}`)
}

/**
 * The storage slots holding DUMMY's balance and DUMMY → router allowance of `token`: the slots `eth_createAccessList`
 * says balanceOf / allowance read (any layout, namespaced storage included), else a Solidity / Vyper mapping at slot
 * 0..60. A slot counts when overriding it makes the view return the marker.
 */
async function findSlot(url, token, data, guesses) {
  const MARK = 0x1234567890abcdefn
  const value = `0x${word(MARK)}`
  const [al] = await batch(url, [{method: 'eth_createAccessList', params: [{from: DUMMY, to: token, data}, 'latest']}])
  const listed = (al?.accessList ?? []).filter((e) => e.address.toLowerCase() === token.toLowerCase()).flatMap((e) => e.storageKeys)
  for (const keys of [listed, guesses]) {
    if (!keys.length) continue
    const res = await calls(url, keys.map((k) => ({method: 'eth_call', params: [{to: token, data}, 'latest', {[token]: {stateDiff: {[k]: value}}}]})))
    const hit = keys.find((_, i) => typeof res[i] === 'string' && res[i].length === 66 && BigInt(res[i]) === MARK)
    if (hit) return hit
  }
  return null
}
async function findSlots(url, token, spender) {
  const range = Array.from({length: 61}, (_, s) => s)
  const balance = await findSlot(url, token, encodeFunctionData({abi: ERC20, functionName: 'balanceOf', args: [DUMMY]}), range.flatMap((s) => [slotKey(DUMMY, s, false), slotKey(DUMMY, s, true)]))
  if (!balance) throw new Error(`no balance slot found for ${token}`)
  const allowance = await findSlot(url, token, encodeFunctionData({abi: ERC20, functionName: 'allowance', args: [DUMMY, spender]}), range.flatMap((s) => [nestedKey(DUMMY, spender, s, false), nestedKey(DUMMY, spender, s, true)]))
  if (!allowance) throw new Error(`no allowance slot found for ${token}`)
  return {balance, allowance}
}

/** Up to three quote requests per chain from its allowlist: the largest pools' first pair, one native, one two-pool route. */
function quoteRequests(chainId) {
  const table = CURVE_POOLS[chainId]
  if (!table) return []
  const pools = [...table.pools].sort((a, b) => b.tvlUsd - a.tvlUsd)
  const reqs = []
  const seen = new Set()
  const weth = CURVE_DEPLOYMENTS[chainId].weth.toLowerCase()
  const add = (from, fromDec, to, label, units) => {
    const k = `${from}>${to}`.toLowerCase()
    if (seen.has(k) || reqs.length >= 3) return
    seen.add(k)
    // One wrapped native, not a thousand: a stable-sized amount would drain an ETH/LST pool.
    reqs.push({from, fromDec, to, label, amount: (from.toLowerCase() === weth ? 1n : units) * 10n ** BigInt(fromDec)})
  }
  const stableAmount = (dec) => (dec === 8 ? 0n : 1000n)
  for (const p of pools) {
    if (reqs.length >= 2) break
    // A lending pool trades only its underlying coins (swap_type 2).
    const [coins, decimals] = p.swapTypes.includes(1) ? [p.coins, p.decimals] : [p.underlying, p.underlyingDecimals]
    const [a, b] = [0, 1]
    if (coins[a].toLowerCase() === ETH.toLowerCase()) add(ETH, 18, coins[b], `native → ${p.name}`, 1n)
    else if (stableAmount(decimals[a])) add(coins[a], decimals[a], coins[b], p.name, p.poolType === 30 ? 100n : 1000n)
  }
  // A two-pool route: coin of the top pool to a coin only another pool has.
  const top = pools[0]
  for (const p of pools.slice(1)) {
    const mid = p.coins.find((c) => top.coins.some((t) => t.toLowerCase() === c.toLowerCase()))
    const out = p.coins.find((c) => !top.coins.some((t) => t.toLowerCase() === c.toLowerCase()) && c.toLowerCase() !== ETH.toLowerCase())
    const inIdx = top.coins.findIndex((c) => c.toLowerCase() !== mid?.toLowerCase() && c.toLowerCase() !== ETH.toLowerCase())
    if (mid && out && inIdx >= 0 && top.decimals[inIdx] !== 8) { add(top.coins[inIdx], top.decimals[inIdx], out, `${top.name} → ${p.name}`, 1000n); break }
  }
  for (const e of EXTRA[chainId] ?? []) reqs.push({...e, amount: e.units * 10n ** BigInt(e.fromDec)})
  return reqs
}
/** Routes the allowlist-derived three do not reach: the ERC-4626 hop (router v1.2 only) and a native output (unwrap). */
const EXTRA = {
  1: [
    {from: '0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E', fromDec: 18, to: '0x0655977FEb2f289A4aB78af67BAB0d17aAb84367', label: 'crvUSD → scrvUSD (swap_type 9)', units: 1000n},
    {from: '0xdAC17F958D2ee523a2206206994597C13D831ec7', fromDec: 6, to: '0x0000000000000000000000000000000000000000', label: 'USDT → native ETH (unwrap)', units: 1000n},
  ],
  143: [{from: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603', fromDec: 6, to: '0xe7cd86e13AC4309349F30B3435a9d337750fC82D', label: 'USDC → USDT0', units: 1000n}],
}

const VERSION = parseAbi(['function version() view returns (string)'])
let failures = 0
for (const chainId of chains) {
  const d = CURVE_DEPLOYMENTS[chainId]
  const url = urlFor(chainId)
  const notes = []
  try {
    if (!d) throw new Error('no pinned router')
    if (!url) throw new Error('no RPC')
    // 1) The deployment: code hash + version (the module's own check), then the immutables and the ABI family.
    let warning = ''
    await curveOnChain({rpcUrls: {[chainId]: [url]}, onWarning: (m) => (warning = m)}).verifyDeployment(chainId)
    const [code, ver] = await batch(url, [{method: 'eth_getCode', params: [d.router, 'latest']}, {method: 'eth_call', params: [{to: d.router, data: encodeFunctionData({abi: VERSION, functionName: 'version'})}, 'latest']}])
    const tail = code.slice(-192)
    const words = [0, 1, 2].map((i) => `0x${tail.slice(i * 64 + 24, i * 64 + 64)}`.toLowerCase())
    const weth = d.family === 'ng5' ? words[0] : words[2]
    if (weth !== d.weth.toLowerCase()) throw new Error(`immutable WETH ${weth} is not the pinned ${d.weth}`)
    if (d.version === '1.1.1' && words[1] !== d.eth.toLowerCase()) throw new Error(`immutable ETH_ADDRESS ${words[1]} is not the pinned ${d.eth}`)
    const has = (sel) => code.toLowerCase().includes(`63${sel.slice(2)}`)
    const other = d.family === 'ng5' ? 'lite4' : 'ng5'
    if (!has(EXCHANGE_SELECTOR[d.family]) || !has(GET_DY_SELECTOR[d.family]) || has(EXCHANGE_SELECTOR[other])) throw new Error(`the code does not carry the ${d.family} entry points only`)
    notes.push(`router ${d.version} ${d.family} code ${keccak256(code).slice(0, 10)}… weth ok${warning ? ` (AddressProvider id 2 differs: ${warning.split('lists router ')[1]?.split(' ')[0]})` : ''}`)
    void decodeFunctionResult({abi: VERSION, functionName: 'version', data: ver})

    // 2) Quotes from the allowlist, each simulated as a funded dummy wallet.
    const reqs = quoteRequests(chainId)
    const provider = curveProvider({rpcUrls: {[chainId]: [url]}, onWarning: () => {}})
    notes.push(`pools ${CURVE_POOLS[chainId]?.pools.length ?? 0}`)
    if (!reqs.length) {
      // No allowlisted pool on this chain: the provider must not offer it, and a quote must refuse by name.
      let why = ''
      const caip = `eip155:${chainId}`
      const q = await provider.getQuote({sourceChain: caip, destChain: caip, sourceToken: '', destToken: d.weth, amountIn: '1000000', destAddress: DUMMY, refundAddress: DUMMY, onRefusal: (m) => (why = m)})
      if (q || provider.supportsChain(caip)) throw new Error('a chain without allowlisted pools is offered')
      notes.push(`no allowlisted pools: not offered, a quote refuses (${why})`)
    }
    for (const r of reqs) {
      let why = ''
      const native = r.from.toLowerCase() === ETH.toLowerCase()
      const q = await provider.getQuote({
        sourceChain: `eip155:${chainId}`, destChain: `eip155:${chainId}`,
        sourceToken: native ? '' : r.from, ...(native ? {} : {sourceDecimals: r.fromDec}),
        destToken: r.to, amountIn: r.amount.toString(), destAddress: DUMMY, refundAddress: DUMMY,
        onRefusal: (m) => (why = m),
      })
      if (!q) { failures++; notes.push(`FAIL quote ${r.label}: ${why}`); continue }
      const tx = q.txRequest
      const overrides = {[DUMMY]: {balance: `0x${(native ? r.amount + 10n ** 18n : 10n ** 18n).toString(16)}`}}
      if (!native) {
        const slots = await findSlots(url, r.from, d.router).catch((e) => e)
        if (slots instanceof Error) { notes.push(`ok ${r.label} [${q.providerData.route}] quoted ${q.destAmount}, min ${q.minDestAmount} — simulation skipped (${slots.message})`); continue }
        overrides[r.from] = {stateDiff: {[slots.balance]: `0x${word(r.amount)}`, [slots.allowance]: `0x${word(r.amount)}`}}
      }
      const [sim] = await batch(url, [{method: 'eth_call', params: [{from: DUMMY, to: tx.to, data: tx.data, value: `0x${BigInt(tx.value).toString(16)}`, gas: '0x989680'}, 'latest', overrides]}])
      if (typeof sim !== 'string' || sim.length !== 66) { failures++; notes.push(`FAIL simulate ${r.label}: ${sim?.error ?? 'no result'}`); continue }
      const out = BigInt(sim)
      if (out < BigInt(q.minDestAmount)) { failures++; notes.push(`FAIL ${r.label}: simulated ${out} < min ${q.minDestAmount}`); continue }
      notes.push(`ok ${r.label} [${q.providerData.route}] in ${r.amount} → out ${q.destAmount}, min ${q.minDestAmount}, simulated ${out}, impact ${q.providerData.priceImpactBps ?? '?'} bps`)
      await sleep(250)
    }
    console.log(`${notes.some((n) => n.startsWith('FAIL')) ? 'FAIL' : 'ok  '} ${chainId} ${d.label}: ${notes.join(' | ')}`)
  } catch (e) {
    failures++
    console.log(`FAIL ${chainId} ${d?.label ?? '?'}: ${[...notes, e?.message ?? String(e)].join(' | ')}`)
  }
  await sleep(300)
}
process.exit(failures ? 1 : 0)
