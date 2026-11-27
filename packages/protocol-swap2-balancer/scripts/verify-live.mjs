#!/usr/bin/env node
// Live check of the Balancer v2 chains this module serves, nothing signed (eth_call, eth_blockNumber and the Balancer
// API's SOR query only). Per chain of BALANCER_V2_CHAINS:
// - eth_chainId is the chain, and the Vault's WETH() is the pinned wrapped native (what the provider's check reads);
// - block numbers (QuoteParams.blockNumber, 0.4.0): on every endpoint, an eth_call at head − 2 must answer that block's
//   own number (NUMBER run as init code) and one at head + 100,000 must be refused — a node that ignores the tag
//   answers both from its head; an endpoint that ignores or refuses a block number is a FAIL;
// - 0.1 of the native coin → USDC through the provider at head − 1 (`blockNumber`): a quote must name that block. It
//   must quote on Ethereum and Base; elsewhere the SOR having no route is reported, not a FAIL.
// Every chain is a step: an unreachable chain is a FAIL with a "Reason:" line, and the run exits 1 naming every chain
// that is not ok. RPC_<chainId>=url[,url] in the environment replaces the public RPCs below; URLs are never printed.
//
//   node scripts/verify-live.mjs [chainId …]        (build first: pnpm build)
import { decodeFunctionResult, encodeFunctionData, getAddress, parseAbi, toHex } from 'viem'
import { ccAsset, ccAssetByToken } from '@anywalletkit/swap2-assets'
import { BALANCER_V2_CHAINS, BALANCER_V2_VAULT, balancerProvider } from '../dist/index.js'

const PUBLIC = {
  1: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'],
  10: ['https://optimism-rpc.publicnode.com', 'https://mainnet.optimism.io'],
  100: ['https://gnosis-rpc.publicnode.com'],
  137: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon.drpc.org'],
  146: ['https://rpc.soniclabs.com'],
  8453: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'],
  9745: ['https://rpc.plasma.to'],
  42161: ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc'],
  43114: ['https://avalanche-c-chain-rpc.publicnode.com', 'https://api.avax.network/ext/bc/C/rpc'],
}
const MUST_QUOTE = new Set([1, 8453])
const ACTOR = '0x1111111111111111111111111111111111111111'
const NUMBER_INITCODE = '0x4360005260206000f3' // NUMBER PUSH1 0 MSTORE PUSH1 32 PUSH1 0 RETURN, run as init code
const ARB_SYS = '0x0000000000000000000000000000000000000064'
const ARB_BLOCK_NUMBER = '0xa3b1b31d' // arbBlockNumber(): a Nitro chain's own block (its NUMBER is the parent chain's)
const WETH_ABI = parseAbi(['function WETH() view returns (address)'])

const urlsOf = (id) => (process.env[`RPC_${id}`] ? process.env[`RPC_${id}`].split(',').map((u) => u.trim()).filter(Boolean) : PUBLIC[id] ?? [])
/** Every spelling of every endpoint this run may use, longest first. */
const SPELLINGS = (() => {
  const out = new Set()
  const add = (s) => s && s.length >= 6 && out.add(s)
  for (const raw of [...Object.values(PUBLIC).flat(), ...Object.keys(process.env).filter((k) => /^RPC_\d+$/.test(k)).flatMap((k) => process.env[k].split(','))]) {
    const u = raw.trim()
    const bare = u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^\/\//, '')
    add(u)
    add(bare)
    try {
      const p = new URL(u.includes('://') ? u : `https://${bare}`)
      add(`${p.host}${p.pathname}${p.search}`)
      if (p.pathname.length > 1 || p.search) add(`${p.pathname}${p.search}`)
    } catch {}
  }
  return [...out].sort((a, b) => b.length - a.length)
})()
const redact = (s) => {
  let t = String(s)
  for (const u of SPELLINGS) if (t.includes(u)) t = t.split(u).join('<url>')
  return t.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>').slice(0, 200)
}

/** One call on one endpoint: its JSON-RPC body (an error status carrying a JSON-RPC error counts as that answer). */
async function callOne(url, method, params) {
  let res
  try {
    res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15_000) })
  } catch (e) {
    if (method === 'eth_call') return { error: { message: `no answer within 15 s (${redact(e?.message ?? e)})` } }
    throw e
  }
  let body
  try { body = JSON.parse(await res.text()) } catch { throw new Error(`HTTP ${res.status}, not JSON`) }
  if (!res.ok && !(body && typeof body === 'object' && 'error' in body)) throw new Error(`HTTP ${res.status}`)
  if (!body || typeof body !== 'object' || (!('result' in body) && !('error' in body))) throw new Error('an answer with neither result nor error')
  return body
}
/** The first endpoint's answer that is not a transport failure. */
async function call(urls, method, params) {
  let last
  for (const url of urls) {
    try { return await callOne(url, method, params) } catch (e) { last = e }
  }
  throw new Error(`no RPC answered ${method} (${redact(last?.message ?? last)})`)
}
async function blockAt(url, tag, how) {
  let last
  for (const k of how.kind ? [how.kind] : ['arbsys', 'init']) {
    const r = await callOne(url, 'eth_call', [k === 'arbsys' ? { to: ARB_SYS, data: ARB_BLOCK_NUMBER } : { data: NUMBER_INITCODE }, tag])
    if (r.error === undefined && typeof r.result === 'string' && /^0x[0-9a-fA-F]{64}$/.test(r.result)) { how.kind = k; return { n: BigInt(r.result) } }
    last = redact(r.error?.message ?? `result ${JSON.stringify(r.result)}`)
  }
  return { error: last }
}

const failed = []
const all = Object.keys(BALANCER_V2_CHAINS).map(Number).sort((a, b) => a - b)
const chains = process.argv.length > 2 ? process.argv.slice(2).map(Number) : all
for (const id of chains) {
  const urls = urlsOf(id)
  const problems = []
  const notes = []
  try {
    if (!BALANCER_V2_CHAINS[id]) throw new Error('not a chain of BALANCER_V2_CHAINS')
    if (!urls.length) throw new Error(`no RPC (set RPC_${id})`)
    const cid = await call(urls, 'eth_chainId', [])
    if (Number(cid.result) !== id) throw new Error(`the RPC serves chain ${Number(cid.result)}, not ${id}`)
    const w = await call(urls, 'eth_call', [{ to: BALANCER_V2_VAULT, data: encodeFunctionData({ abi: WETH_ABI, functionName: 'WETH' }) }, 'latest'])
    const weth = w.error === undefined ? getAddress(decodeFunctionResult({ abi: WETH_ABI, functionName: 'WETH', data: w.result })) : null
    if (weth !== getAddress(BALANCER_V2_CHAINS[id].weth)) problems.push(`the Vault's WETH() is ${weth ?? redact(w.error?.message)}, pinned ${BALANCER_V2_CHAINS[id].weth}`)
    else notes.push('Vault WETH() ok')

    // Block numbers, on every endpoint.
    const seen = []
    let head
    for (const [i, url] of urls.entries()) {
      let h
      try { h = BigInt((await callOne(url, 'eth_blockNumber', [])).result) } catch (e) { seen.push(`endpoint ${i + 1} unreachable (${redact(e?.message ?? e)})`); continue }
      head ??= h
      const how = {}
      let past = await blockAt(url, toHex(h - 2n), how)
      if (past.error !== undefined) { await new Promise((r) => setTimeout(r, 1500)); past = await blockAt(url, toHex(h - 2n), how) }
      const future = past.error === undefined ? await blockAt(url, toHex(h + 100_000n), how) : undefined
      const honoured = past.error === undefined && past.n === h - 2n && future?.error !== undefined
      const verdict = honoured ? 'takes a block number' : past.error !== undefined ? `refused a call at head − 2 (${past.error})` : `ignores the block number (head − 2 answered ${past.n}, head + 100,000 ${future?.error === undefined ? `answered ${future?.n}` : 'refused'})`
      seen.push(`endpoint ${i + 1} ${verdict}`)
      if (!honoured) problems.push(`QuoteParams.blockNumber: endpoint ${i + 1} ${verdict}`)
    }
    if (head === undefined) problems.push(`QuoteParams.blockNumber: no endpoint answered (${seen.join('; ')})`)
    notes.push(`blockNumber: ${seen.join('; ')}`)

    // A quote at head − 1 names that block.
    const caip = `eip155:${id}`
    const native = ccAssetByToken(caip, '')?.symbol
    const usdc = ccAsset(caip, 'USDC')?.contract
    if (head !== undefined && native && usdc) {
      const block = (head - 1n).toString()
      const heard = []
      const q = await balancerProvider({ rpcUrls: { [id]: urls } }).getQuote({ sourceChain: caip, destChain: caip, sourceToken: native, destToken: usdc, amountIn: (10n ** 17n).toString(), destAddress: ACTOR, refundAddress: ACTOR, dry: true, blockNumber: block, onRefusal: (t, i) => heard.push(`${t}${i?.reason ? ` [${i.reason}]` : ''}`) })
      if (q && q.blockNumber !== block) problems.push(`0.1 ${native} → USDC at block ${block}: the quote names ${q.blockNumber ?? 'no block'}`)
      else if (q) notes.push(`0.1 ${native} → USDC at block ${block}: ${q.destAmount}, Quote.blockNumber ${q.blockNumber}`)
      else if (MUST_QUOTE.has(id) || /stale_node|served by the node/.test(heard.join(' '))) problems.push(`0.1 ${native} → USDC at block ${block}: ${redact(heard.join('; ') || 'no quote and no reason')}`)
      else notes.push(`0.1 ${native} → USDC at block ${block}: ${redact(heard.join('; ') || 'no quote')}`)
    } else if (head !== undefined) notes.push('no catalog USDC or native coin: no quote')
  } catch (e) {
    problems.push(redact(e?.message ?? e))
  }
  if (problems.length === 0) console.log(`ok   chain ${id} — ${notes.join('; ')}`)
  else {
    failed.push(id)
    console.log(`FAIL chain ${id} — ${notes.join('; ')}`)
    for (const p of problems) console.log(`  Reason: ${p}`)
  }
}
if (failed.length) {
  console.log(`\n${failed.length} chain(s) failed`)
  console.log(`Reason: FAIL on ${failed.join(', ')}`)
  process.exit(1)
}
console.log(`\nall ${chains.length} chains: the Vault pinned, block numbers taken, quotes at a block name it`)
