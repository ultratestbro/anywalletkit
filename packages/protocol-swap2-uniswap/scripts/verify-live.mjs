#!/usr/bin/env node
// Live check of every pin this module ships, v3 and v4, against the chains. Read-only: nothing is signed or sent
// (eth_call / eth_estimateGas with state overrides, eth_getCode; dummy addresses only).
//
//   node scripts/verify-live.mjs [chainId …]        (pnpm --filter @anywalletkit/protocol-swap2-uniswap verify:live)
//
// For each chain of UNISWAP_V3 ∪ UNISWAP_V4 (UNISWAP-V4-RESEARCH §5.8):
// - eth_chainId is the chain.
// - v3 (pinned chains): the factory has code; SwapRouter02 and QuoterV2 report the pinned factory and WETH9 (0x0 where
//   `nativeWrap: false`) — what the provider's deployment check reads.
// - v4 (pinned chains): PoolManager, V4Quoter, StateView, Universal Router, SwapProxy and Permit2 have code;
//   `poolManager()` of the router, the quoter and the StateView is the pinned PoolManager; the router's, the
//   SwapProxy's and Permit2's code hash to the pinned codehashes (Permit2's differs per chain: no flow calls it, the
//   pin is compared so drift is reported); the shipped pool list (if any) names the pinned PoolManager and
//   StateView. Then the build probe: a native single-pool swap encoded in the UR 2.1.x layout with an unreachable
//   `minHopPriceX36`, `eth_call`ed with a balance override, must revert `V4TooLittleReceivedPerHopSingle` — the router
//   reads the layout this module writes (a 2.0 router would read other words); each URL is tried until one returns
//   revert data, and when none does the probe did not run — a FAIL. And one V4Quoter canary on a known pool, gas ≠ 0.
//   A chain pinned `quotable: false` (HyperEVM) has neither: it is reported, never enabled; a quotable chain without a
//   CANARY entry is a FAIL.
// - the gas bounds the provider holds every chain to: the per-transaction cap (`eth_estimateGas` of an endless loop, a
//   code override, names the highest gasLimit the node lets a transaction have — "gas required exceeds allowance
//   (16777216)"; where KNOWN_TX_GAS_CAP lists the chain the two must agree; where it does not, a 2^24 or 2^25 allowance
//   below the block's is a cap the table misses) and the block's own reserve (an OP-stack L1-info deposit must be covered
//   by KNOWN_BLOCK_GAS_RESERVE, and a listed chain must still open its blocks with one).
// - corridors, through the built provider with v4 "all" and maxPriceImpactBps 500 (cp0x's setting): Monad 1 / 100 /
//   62,000 MON → AUSD (a v4 quote under the limit, or the refusal — never a quote at or above it; 1 MON must quote),
//   100 and 2,000 AUSD → MON and 700 / 20,000 USDC → AUSD (token input: v3, or v4 through the SwapProxy; the 2,000 and
//   20,000 ones cross candidates that need more quoter gas than Monad's 30M per-transaction cap, which must be ranked
//   out, never refuse the quote — LIVE-1); Unichain 1 ETH → USDC; Base 1,000 USDC → ETH (token input, native output)
//   and 1,000 USDC → USDT on v4 alone (a provider without the v3 table, so the SwapProxy flow is exercised whichever
//   venue pays more). Any refusal but the impact gate's is a FAIL. Each quote is checked by the shipped pins
//   (`uniswapPins.verifyQuote`), and the Monad 62,000 MON and 700 USDC corridors are also run in remote mode
//   (createSwap2Handler + uniswapRemoteProvider, which declares `ownGasEstimate`). The corridors name no sender (dummy
//   actor only), so a SwapProxy quote here carries `simulated: "none"`: the approve + swap simulation needs a funded
//   account.
// Every chain is a step: an unreachable chain, or an answer in another shape, is a FAIL with a "Reason:" line, and the
// run exits 1 with a final "Reason:" line naming every chain that is not ok. RPC_<chainId>=url[,url] in the environment
// replaces the public RPCs below; URLs are never printed.
//
// src/impact.ts is imported as TypeScript (Node ≥ 22.18 strips types); build the workspace first (`pnpm -s --filter
// "@anywalletkit/protocol-swap2-uniswap..." run build`).
import { decodeAbiParameters, encodeAbiParameters, encodeFunctionData, getAddress, keccak256, parseAbi, toHex } from 'viem'
import { UNISWAP_V3, UNISWAP_V4, uniswapPins, uniswapRemoteProvider } from '../dist/index.js'
import { uniswapProvider } from '../dist/provider.js'
import { UNISWAP_V4_POOLS } from '../dist/v4pools.js'
import { UR_ABI, V4_EXACT_IN_SINGLE_ABI, V4_QUOTER_ABI, V4_SETTLE_ABI, V4_SWAP_INPUT_ABI, V4_TAKE_ABI, decodeV4Revert, v4RevertChain } from '../dist/v4.js'
import { KNOWN_BLOCK_GAS_RESERVE, KNOWN_TX_GAS_CAP } from '../src/impact.ts'
import { createSwap2Handler } from '@anywalletkit/protocol-swap2-core/server'

const PUBLIC = {
  1: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'],
  10: ['https://optimism-rpc.publicnode.com', 'https://mainnet.optimism.io'],
  56: ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org'],
  130: ['https://mainnet.unichain.org', 'https://unichain-rpc.publicnode.com'],
  137: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon.drpc.org'],
  143: ['https://rpc.monad.xyz', 'https://rpc2.monad.xyz'],
  196: ['https://rpc.xlayer.tech', 'https://xlayerrpc.okx.com'],
  324: ['https://mainnet.era.zksync.io', 'https://zksync.drpc.org'],
  480: ['https://worldchain-mainnet.g.alchemy.com/public', 'https://worldchain-mainnet.gateway.tenderly.co'],
  999: ['https://rpc.hyperliquid.xyz/evm'],
  4326: ['https://mainnet.megaeth.com/rpc'],
  4663: ['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood.drpc.org'],
  5042: ['https://rpc.mainnet.arc.io'],
  8453: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'],
  42161: ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc'],
  42220: ['https://forno.celo.org', 'https://celo.drpc.org'],
  43114: ['https://avalanche-c-chain-rpc.publicnode.com', 'https://api.avax.network/ext/bc/C/rpc'],
  57073: ['https://rpc-gel.inkonchain.com'],
  59144: ['https://rpc.linea.build', 'https://linea-rpc.publicnode.com'],
  99901: ['https://rpc.elysium.kinetiq.xyz'],
}
/**
 * Chains whose nodes do not name the allowance: Monad says "gas required exceeds allowance" without a number (its 30M
 * is the documented limit), zkSync refuses an estimate from an account that does not exist. MegaETH (4326) has no 2^24
 * or 2^25 cap — an eth_call of the loop with any gas up to 1e8 runs out at exactly that gas — and the estimate runs the
 * loop to MegaETH's own per-transaction limit (~200M), where it reverts with MegaETH's error 0x84b90267 (2026-11-26).
 */
const ALLOWANCE_UNREPORTED = new Set([143, 324, 4326])
const LOOP = '0x5b600056' // JUMPDEST PUSH1 0 JUMP
const TARGET = '0x00000000000000000000000000000000dEaD0001'
const FROM = '0x0000000000000000000000000000000000000001'
const POWERS = new Set([1n << 24n, 1n << 25n])
/** A dummy actor (never a real account): the probes and corridors pay it, the balance override funds it. */
const ACTOR = '0x1111111111111111111111111111111111111111'
const NATIVE = '0x0000000000000000000000000000000000000000'
/**
 * The V4Quoter canary per chain: the hookless pool the 2026-11-25 research quoted on every chain (pins-evidence.json
 * `quoterSanity`, gas 36,448–91,425), as (other currency, fee, tickSpacing, amount in). Native is currency0 except on
 * Celo, whose native coin is the CELO ERC-20 there. HyperEVM had no quotable pool.
 */
const CANARY = {
  1: ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 3000, 60, 10n ** 15n],
  10: ['0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', 500, 10, 10n ** 15n],
  56: ['0x55d398326f99059fF775485246999027B3197955', 3000, 60, 10n ** 15n],
  130: ['0x078D782b760474a361dDA0AF3839290b0EF57AD6', 500, 10, 10n ** 15n],
  137: ['0xc2132D05D31c914a87C6611C10748AEb04B58e8F', 3000, 60, 10n ** 15n],
  143: ['0x754704Bc059F8C67012fEd69BC8A327a5aafb603', 500, 10, 10n ** 18n],
  196: ['0x779Ded0c9e1022225f8E0630b35a9b54bE713736', 100, 1, 10n ** 15n],
  480: ['0x79A02482A880bCE3F13e09Da970dC34db4CD24d1', 3000, 60, 10n ** 15n],
  4326: ['0xFAfDdbb3FC7688494971a79cc65DCa3EF82079E7', 100, 1, 10n ** 15n],
  4663: ['0x5fc5360D0400a0FD4f2Af552ADd042D716F1D168', 500, 10, 10n ** 15n],
  5042: ['0x3600000000000000000000000000000000000000', 100, 1, 10n ** 15n],
  8453: ['0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 3000, 60, 10n ** 15n],
  42161: ['0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 3000, 60, 10n ** 15n],
  42220: ['0x765DE816845861e75A25fCA122bb6898B8B1282a', 3000, 60, 10n ** 15n, '0x471EcE3750Da237f93B8E339c536989b8978a438'],
  43114: ['0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', 3000, 60, 10n ** 15n],
  57073: ['0x2D270e6886d130D724215A266106e6832161EAEd', 3000, 60, 10n ** 15n],
  59144: ['0x176211869cA2b568f2A7D4EE941E073a821EE1ff', 3000, 60, 10n ** 15n],
  99901: ['0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65', 3000, 60, 10n ** 15n],
}
const POOL_MANAGER = encodeFunctionData({ abi: parseAbi(['function poolManager() view returns (address)']), functionName: 'poolManager' })
const V3_ABI = parseAbi(['function factory() view returns (address)', 'function WETH9() view returns (address)'])

const redact = (s) => String(s).replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>').slice(0, 200)
const urlsOf = (id) => (process.env[`RPC_${id}`] ? process.env[`RPC_${id}`].split(',').map((u) => u.trim()).filter(Boolean) : PUBLIC[id] ?? [])
const short = (a) => `${a.slice(0, 10)}…`

/** One JSON-RPC call over the chain's URLs: the first that answers (an error object is an answer). */
async function rpc(urls, method, params) {
  let last
  for (const url of urls) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20_000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      if (body && typeof body === 'object' && ('result' in body || 'error' in body)) return body
      throw new Error('an answer with neither result nor error')
    } catch (e) {
      last = e
    }
  }
  throw new Error(`no RPC answered ${method} (${redact(last?.message ?? last)})`)
}
/** The result of a call that must succeed, else a thrown reason. */
async function must(urls, method, params, what) {
  const r = await rpc(urls, method, params)
  if (r.error !== undefined) throw new Error(`${what}: ${redact(r.error?.message ?? JSON.stringify(r.error))}`)
  return r.result
}
const addrWord = (hex) => (typeof hex === 'string' && /^0x[0-9a-fA-F]{64}$/.test(hex) ? getAddress(`0x${hex.slice(26)}`) : null)

// ── v3 ────────────────────────────────────────────────────────────────────────────────────────────────────────────

async function v3Facts(id, urls, problems, notes) {
  const d = UNISWAP_V3[id]
  if (!d) return
  const before = problems.length
  const code = await must(urls, 'eth_getCode', [d.factory, 'latest'], 'v3 factory code')
  if (!code || code === '0x') problems.push(`v3: no code at the pinned factory ${d.factory}`)
  const wrapped = d.nativeWrap === false ? NATIVE : getAddress(d.weth)
  for (const [name, at] of [['SwapRouter02', d.router], ['QuoterV2', d.quoter]]) {
    const f = addrWord(await must(urls, 'eth_call', [{ to: at, data: encodeFunctionData({ abi: V3_ABI, functionName: 'factory' }) }, 'latest'], `v3 ${name}.factory()`))
    const w = addrWord(await must(urls, 'eth_call', [{ to: at, data: encodeFunctionData({ abi: V3_ABI, functionName: 'WETH9' }) }, 'latest'], `v3 ${name}.WETH9()`))
    if (f !== getAddress(d.factory)) problems.push(`v3: ${name} reports factory ${f}, pinned ${d.factory}`)
    if (w !== wrapped) problems.push(`v3: ${name} reports WETH9 ${w}, pinned ${wrapped}`)
  }
  notes.push(problems.length === before ? 'v3 router/quoter linkage ok' : 'v3 router/quoter linkage drift (see Reason)')
}

// ── v4 ────────────────────────────────────────────────────────────────────────────────────────────────────────────

function v4Swap(key, zeroForOne, amountIn, minOut, minHop, deadline) {
  const swap = encodeAbiParameters(V4_EXACT_IN_SINGLE_ABI, [{ poolKey: key, zeroForOne, amountIn, amountOutMinimum: minOut, minHopPriceX36: minHop, hookData: '0x' }])
  const settle = encodeAbiParameters(V4_SETTLE_ABI, [zeroForOne ? key.currency0 : key.currency1, amountIn, false])
  const take = encodeAbiParameters(V4_TAKE_ABI, [zeroForOne ? key.currency1 : key.currency0, ACTOR, 0n])
  const input = encodeAbiParameters(V4_SWAP_INPUT_ABI, ['0x060b0e', [swap, settle, take]])
  return encodeFunctionData({ abi: UR_ABI, functionName: 'execute', args: ['0x10', [input], deadline] })
}

async function v4Facts(id, urls, problems, notes) {
  const d4 = UNISWAP_V4[id]
  if (!d4) return
  const roles = [['PoolManager', d4.poolManager], ['V4Quoter', d4.quoter], ['StateView', d4.stateView], ['Universal Router', d4.universalRouter], ['SwapProxy', d4.swapProxy], ['Permit2', d4.permit2]]
  // The note says "ok" only when this section added no problem: a FAIL line never reads "ok" beside a Reason line that
  // says otherwise (review LIVE3-3; a canary note is made from these lines).
  const before = problems.length
  const codes = {}
  for (const [name, at] of roles) {
    codes[name] = await must(urls, 'eth_getCode', [at, 'latest'], `v4 ${name} code`)
    if (!codes[name] || codes[name] === '0x') problems.push(`v4: no code at the pinned ${name} ${at}`)
  }
  if (codes['Universal Router'] && keccak256(codes['Universal Router']) !== d4.routerCodehash.toLowerCase()) problems.push(`v4: the Universal Router's code hashes to ${short(keccak256(codes['Universal Router']))}, pinned ${short(d4.routerCodehash)} (another build)`)
  if (codes.SwapProxy && keccak256(codes.SwapProxy) !== d4.swapProxyCodehash.toLowerCase()) problems.push(`v4: the SwapProxy's code hashes to ${short(keccak256(codes.SwapProxy))}, pinned ${short(d4.swapProxyCodehash)}`)
  if (!d4.permit2Codehash) problems.push('v4: no Permit2 codehash pinned for the chain')
  else if (codes.Permit2 && codes.Permit2 !== '0x' && keccak256(codes.Permit2) !== d4.permit2Codehash.toLowerCase()) problems.push(`v4: Permit2's code hashes to ${short(keccak256(codes.Permit2))}, pinned ${short(d4.permit2Codehash)} (not the canonical Permit2 read on 2026-11-25)`)
  for (const [name, at] of [['Universal Router', d4.universalRouter], ['V4Quoter', d4.quoter], ['StateView', d4.stateView]]) {
    const pm = addrWord(await must(urls, 'eth_call', [{ to: at, data: POOL_MANAGER }, 'latest'], `v4 ${name}.poolManager()`))
    if (pm !== getAddress(d4.poolManager)) problems.push(`v4: the ${name} reports PoolManager ${pm}, pinned ${d4.poolManager}`)
  }
  const list = UNISWAP_V4_POOLS[id]
  if (list && (getAddress(list.poolManager) !== getAddress(d4.poolManager) || getAddress(list.stateView) !== getAddress(d4.stateView))) problems.push('v4: the shipped pool list was built from another PoolManager / StateView than the pins')
  const drift = problems.length - before
  notes.push(`${drift === 0 ? 'v4 linkage + codehashes ok' : `v4 linkage/codehash drift (${drift} problem${drift === 1 ? '' : 's'}, see Reason)`}${list ? `, ${list.pools.length} listed pools (block ${list.block})` : ', no shipped pool list (not quoted)'}`)

  if (d4.quotable === false) {
    notes.push('quotable: false — no canary, not enabled')
    return
  }
  // A quotable chain must have its canary (and with it the build probe): a missing one is a problem, never a pass.
  if (!CANARY[id]) {
    problems.push('no V4Quoter canary pinned for a quotable chain (add it to CANARY): neither the canary nor the build probe ran')
    return
  }
  const [other, fee, tickSpacing, amountIn, nativeAs] = CANARY[id]
  const base = nativeAs ?? NATIVE
  const [currency0, currency1] = BigInt(base) < BigInt(other) ? [getAddress(base), getAddress(other)] : [getAddress(other), getAddress(base)]
  const key = { currency0, currency1, fee, tickSpacing, hooks: NATIVE }
  const zeroForOne = currency0 === getAddress(base)
  // The quoter canary.
  const q = await rpc(urls, 'eth_call', [{ to: d4.quoter, data: encodeFunctionData({ abi: V4_QUOTER_ABI, functionName: 'quoteExactInputSingle', args: [{ poolKey: key, zeroForOne, exactAmount: amountIn, hookData: '0x' }] }) }, 'latest'])
  if (q.error !== undefined) {
    problems.push(`v4: the V4Quoter canary (${fee}/${tickSpacing}) reverted: ${v4RevertChain(decodeV4Revert(q.error?.data)).map((r) => r.name).join(' > ')}`)
    return
  }
  const [out, gas] = decodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], q.result)
  if (out === 0n || gas === 0n) problems.push(`v4: the V4Quoter canary answered amountOut ${out}, gas ${gas}`)
  else notes.push(`canary ${fee}/${tickSpacing}: ${out} out, quoter gas ${gas}`)
  // The build probe: our 2.1.x layout with an unreachable per-hop price must hit the per-hop check.
  if (d4.nativeWrap === false) {
    notes.push('build probe skipped (the native coin is an ERC-20 here: native input is refused)')
    return
  }
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600)
  const data = v4Swap(key, zeroForOne, amountIn, 1n, 1n << 200n, deadline)
  // Each URL in turn until one answers with revert data: a node that reverts without data says nothing about the layout,
  // and when none gives data the probe did not run — a problem, never a pass (SEC-U4-R2-3).
  const probe = [{ from: ACTOR, to: d4.universalRouter, data, value: toHex(amountIn) }, 'latest', { [ACTOR]: { balance: toHex(10n ** 24n) } }]
  const silent = []
  for (const url of urls) {
    let r
    try {
      r = await rpc([url], 'eth_call', probe)
    } catch (e) {
      silent.push(redact(e?.message ?? e))
      continue
    }
    const chain = r.error !== undefined ? v4RevertChain(decodeV4Revert(r.error?.data)).map((x) => x.name) : []
    if (chain.includes('V4TooLittleReceivedPerHopSingle')) return notes.push('build probe: the router reads the 2.1.x layout (V4TooLittleReceivedPerHopSingle)')
    if (r.error === undefined) return problems.push('build probe: an unreachable minHopPriceX36 did not revert — the router does not read the 2.1.x layout')
    if (chain.length && !chain.every((n) => n === 'unknown' || n === 'empty')) return problems.push(`build probe: reverted ${chain.join(' > ')}, not V4TooLittleReceivedPerHopSingle`)
    silent.push(`no revert data: ${redact(r.error?.message ?? '')}`)
  }
  problems.push(`build probe did not run: no node returned revert data (${silent.join('; ').slice(0, 160)}) — set RPC_${id} to a node that does`)
}

// ── gas bounds (unchanged from 0.4.12) ──────────────────────────────────────────────────────────────────────────────

async function gasFacts(id, urls, problems, notes) {
  const block = await rpc(urls, 'eth_getBlockByNumber', ['latest', false])
  if (!block.result || !/^0x[0-9a-f]+$/i.test(block.result.gasLimit ?? '')) throw new Error(`the latest block came back without a gasLimit (${redact(JSON.stringify(block.error ?? block.result))})`)
  const blockGas = BigInt(block.result.gasLimit)
  notes.push(`block gasLimit ${blockGas}`)

  // The block's reserve.
  const reserve = KNOWN_BLOCK_GAS_RESERVE[id]
  const first = block.result.transactions?.[0]
  const tx = first ? (await rpc(urls, 'eth_getTransactionByHash', [first])).result : undefined
  const deposit = tx?.type === '0x7e'
  if (deposit) {
    const gas = BigInt(tx.gas)
    notes.push(`opens with an L1-info deposit (gasLimit ${gas})`)
    if (reserve === undefined) problems.push('the block opens with an OP-stack deposit, but KNOWN_BLOCK_GAS_RESERVE has no reserve for the chain')
    else if (gas > reserve) problems.push(`the deposit's gasLimit ${gas} is over the reserve ${reserve}`)
  } else if (reserve !== undefined) {
    problems.push(`KNOWN_BLOCK_GAS_RESERVE has ${reserve}, but the latest block opens with ${tx ? `a type ${tx.type} transaction` : 'no transaction'}`)
  }

  // The per-transaction cap.
  const est = await rpc(urls, 'eth_estimateGas', [{ from: FROM, to: TARGET, data: '0x' }, 'latest', { [TARGET]: { code: LOOP } }])
  const known = KNOWN_TX_GAS_CAP[id]
  if (est.result !== undefined) {
    problems.push(`an endless loop was estimated at ${BigInt(est.result)} gas: the node did not run the code override`)
  } else {
    const text = String(est.error?.message ?? '')
    const n = /(\d{6,})/.exec(text)?.[1]
    if (n === undefined) {
      if (ALLOWANCE_UNREPORTED.has(id)) notes.push(`the node does not name its allowance ("${redact(text)}")${known !== undefined ? `; cap ${known} as documented` : ''}`)
      else problems.push(`the estimate did not name the allowance: "${redact(text)}"`)
    } else {
      const allowance = BigInt(n)
      notes.push(`tx allowance ${allowance}`)
      if (known !== undefined && allowance !== known) problems.push(`KNOWN_TX_GAS_CAP has ${known}, the node allows ${allowance}${allowance < known ? ' (a lower cap, or an RPC gas cap: check another endpoint)' : ' (the cap was lifted?)'}`)
      if (known === undefined && POWERS.has(allowance) && allowance < blockGas) problems.push(`a per-transaction cap of ${allowance} below the block's ${blockGas} that KNOWN_TX_GAS_CAP does not have`)
    }
  }
}

// ── corridors through the provider (and the remote path) ──────────────────────────────────────────────────────────

const LIMIT = 500
const CORRIDORS = {
  143: [
    { sourceToken: 'MON', destToken: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a', amountIn: 10n ** 18n, label: '1 MON → AUSD', mustQuote: true },
    { sourceToken: 'MON', destToken: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a', amountIn: 100n * 10n ** 18n, label: '100 MON → AUSD' },
    { sourceToken: 'MON', destToken: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a', amountIn: 62_000n * 10n ** 18n, label: '62,000 MON → AUSD', remote: true },
    { sourceToken: 'AUSD', destToken: NATIVE, amountIn: 100_000_000n, label: '100 AUSD → MON (token input)' },
    { sourceToken: 'AUSD', destToken: NATIVE, amountIn: 2_000_000_000n, label: '2,000 AUSD → MON (token input; a candidate past the 30M cap)', mustQuote: true },
    { sourceToken: 'USDC', destToken: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a', amountIn: 700_000_000n, label: '700 USDC → AUSD (token input)', mustQuote: true, remote: true },
    { sourceToken: 'USDC', destToken: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a', amountIn: 20_000_000_000n, label: '20,000 USDC → AUSD (token input; a candidate past the 30M cap)', mustQuote: true },
  ],
  130: [{ sourceToken: 'ETH', destToken: '0x078D782b760474a361dDA0AF3839290b0EF57AD6', amountIn: 10n ** 18n, label: '1 ETH → USDC', mustQuote: true }],
  8453: [
    { sourceToken: 'USDC', destToken: NATIVE, amountIn: 1_000_000_000n, label: '1,000 USDC → ETH (token input, native output)', mustQuote: true },
    { sourceToken: 'USDC', destToken: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', amountIn: 1_000_000_000n, label: '1,000 USDC → USDT on v4 alone (the SwapProxy flow)', mustQuote: true, v4Only: true },
  ],
}

async function corridorFacts(id, urls, problems, notes) {
  for (const c of CORRIDORS[id] ?? []) {
    const params = { sourceChain: `eip155:${id}`, destChain: `eip155:${id}`, sourceToken: c.sourceToken, destToken: c.destToken, amountIn: c.amountIn.toString(), destAddress: ACTOR, refundAddress: ACTOR }
    const heard = []
    // v4Only: no v3 table, so v4 serves the corridor whatever v3 would pay (the SwapProxy flow is exercised every run).
    const p = uniswapProvider({ rpcUrls: { [id]: urls }, v4: 'all', maxPriceImpactBps: LIMIT, ...(c.v4Only ? { deployments: {} } : {}) })
    const q = await p.getQuote({ ...params, onRefusal: (t, i) => heard.push(`${t}${i?.reason ? ` [${i.reason}]` : ''}`) })
    if (!q) {
      const text = heard.join('; ') || 'no quote and no reason'
      if (c.mustQuote || !/loses [\d.]+% of the value to price impact/.test(text)) problems.push(`${c.label}: ${redact(text)}`)
      else notes.push(`${c.label}: refused at ${LIMIT} (${redact(text).slice(0, 80)})`)
      continue
    }
    const pd = q.providerData ?? {}
    const g = Math.max(Number(pd.priceImpactBps ?? 0), Number(pd.valueLossBps ?? 0))
    if (pd.priceImpactBps === undefined && pd.valueLossBps === undefined) problems.push(`${c.label}: a quote with no impact measure under maxPriceImpactBps`)
    if (g >= LIMIT) problems.push(`${c.label}: a quote at G = ${g} ≥ ${LIMIT}`)
    const pins = uniswapPins.verifyQuote(params, q)
    if (pins) problems.push(`${c.label}: the shipped pins refuse the quote — ${pins}`)
    if (pd.venue === 'v4' && q.txRequest?.approvalAddress !== undefined && (q.txRequest.approvalAddress !== UNISWAP_V4[id]?.swapProxy || q.txRequest.to !== UNISWAP_V4[id]?.swapProxy || q.txRequest.value !== '0')) problems.push(`${c.label}: a v4 token-input quote that is not a value-free SwapProxy call approving the SwapProxy`)
    if (c.v4Only && (pd.venue !== 'v4' || q.txRequest?.to !== UNISWAP_V4[id]?.swapProxy)) problems.push(`${c.label}: not a v4 SwapProxy quote (venue ${pd.venue ?? 'v3'}, to ${q.txRequest?.to})`)
    notes.push(`${c.label}: ${q.destAmount} on ${pd.venue ?? 'v3'}${pd.venue === 'v4' && q.txRequest?.approvalAddress ? ' via the SwapProxy' : ''} (${pd.route}, G ${g}${pd.v4Unexecutable ? `, ${pd.v4Unexecutable} v4 candidate(s) past the gas cap ranked out` : ''})`)
    if (c.remote) {
      const handle = createSwap2Handler({ providers: [p], sealSecret: 'verify-live-seal-secret-32-bytes-at-least', guard: () => {}, subject: () => 'verify-live' })
      const fetchImpl = async (url, init) => { const res = await handle(String(url).split('/').pop(), JSON.parse(String(init.body)), 'verify-live'); return new Response(JSON.stringify(res.body), { status: res.status, headers: { 'content-type': 'application/json' } }) }
      const stub = uniswapRemoteProvider({ baseUrl: 'https://backend.example/swap2', fetchImpl })
      if (stub.ownGasEstimate !== true) problems.push(`${c.label} (remote): the stub does not declare ownGasEstimate`)
      try {
        const rq = await stub.getQuote(params)
        if (!rq) problems.push(`${c.label} (remote): no quote`)
        else notes.push(`${c.label} (remote, uniswapRemoteProvider): ${rq.destAmount} on ${rq.providerData?.venue ?? 'v3'}`)
      } catch (e) {
        if (/loses [\d.]+% of the value to price impact/.test(String(e?.message))) notes.push(`${c.label} (remote): refused at ${LIMIT}`)
        else problems.push(`${c.label} (remote): ${redact(e?.message ?? e)}`)
      }
    }
  }
}

// ── run ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const failed = []
function report(id, problems, notes) {
  if (problems.length === 0) return console.log(`ok   chain ${id} — ${notes.join('; ')}`)
  failed.push(id)
  console.log(`FAIL chain ${id} — ${notes.join('; ')}`)
  for (const p of problems) console.log(`  Reason: ${p}`)
}

const all = [...new Set([...Object.keys(UNISWAP_V3), ...Object.keys(UNISWAP_V4)].map(Number))].sort((a, b) => a - b)
const chains = process.argv.length > 2 ? process.argv.slice(2).map(Number) : all
for (const id of chains) {
  const urls = urlsOf(id)
  const problems = []
  const notes = []
  if (!UNISWAP_V3[id] && !UNISWAP_V4[id]) problems.push('not a chain of the Uniswap v3 or v4 table')
  if (urls.length === 0) problems.push(`no RPC (set RPC_${id})`)
  if (problems.length) {
    report(id, problems, notes)
    continue
  }
  try {
    const cid = await must(urls, 'eth_chainId', [], 'eth_chainId')
    if (Number(cid) !== id) throw new Error(`the RPC serves chain ${Number(cid)}, not ${id}`)
    await v3Facts(id, urls, problems, notes)
    await v4Facts(id, urls, problems, notes)
    await gasFacts(id, urls, problems, notes)
    await corridorFacts(id, urls, problems, notes)
  } catch (e) {
    problems.push(redact(e?.message ?? e))
  }
  report(id, problems, notes)
}
if (failed.length) {
  console.log(`\n${failed.length} chain(s) failed`)
  console.log(`Reason: FAIL on ${failed.join(', ')}`)
  process.exit(1)
}
console.log(`\nall ${chains.length} chains agree with the pins and the tables`)
