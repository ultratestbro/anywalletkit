#!/usr/bin/env node
// Live check of the gas bounds the provider holds every Uniswap v3 chain to. Read-only: nothing is signed or sent.
//
//   node scripts/verify-live.mjs [chainId …]        (pnpm --filter @anywalletkit/protocol-swap2-uniswap verify:live)
//
// For each chain:
// - the per-transaction cap: `eth_estimateGas` of an endless loop (a code override) runs out of gas at the highest
//   gasLimit the node lets a transaction have, and says it ("gas required exceeds allowance (16777216)"). Where
//   KNOWN_TX_GAS_CAP lists the chain the two must agree; where it does not, a 2^24 or 2^25 allowance below the block's
//   is a cap the table misses. (An RPC gas cap can also read below the block — Avalanche's 50M — and is not a cap.)
// - the block's own reserve: the latest block's first transaction. An OP-stack L1-info deposit (type 0x7e) must be
//   covered by KNOWN_BLOCK_GAS_RESERVE, and a listed chain must still open its blocks with one.
// Every chain is a step: an unreachable chain, or an answer in another shape, is a FAIL with a "Reason:" line, and the
// run exits 1. RPC_<chainId>=url[,url] in the environment replaces the public RPCs below; URLs are never printed.
//
// src/impact.ts is imported as TypeScript (Node ≥ 22.18 strips types); build the workspace first for its imports.
import { UNISWAP_V3 } from '../dist/index.js'
import { KNOWN_BLOCK_GAS_RESERVE, KNOWN_TX_GAS_CAP } from '../src/impact.ts'

const PUBLIC = {
  1: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'],
  10: ['https://optimism-rpc.publicnode.com', 'https://mainnet.optimism.io'],
  56: ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org'],
  130: ['https://mainnet.unichain.org', 'https://unichain-rpc.publicnode.com'],
  137: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon.drpc.org'],
  143: ['https://rpc.monad.xyz'],
  196: ['https://rpc.xlayer.tech', 'https://xlayerrpc.okx.com'],
  324: ['https://mainnet.era.zksync.io', 'https://zksync.drpc.org'],
  480: ['https://worldchain-mainnet.g.alchemy.com/public', 'https://worldchain-mainnet.gateway.tenderly.co'],
  4663: ['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood.drpc.org'],
  8453: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'],
  42161: ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc'],
  42220: ['https://forno.celo.org', 'https://celo.drpc.org'],
  43114: ['https://avalanche-c-chain-rpc.publicnode.com', 'https://api.avax.network/ext/bc/C/rpc'],
  57073: ['https://rpc-gel.inkonchain.com'],
  59144: ['https://rpc.linea.build', 'https://linea-rpc.publicnode.com'],
}
/**
 * Chains whose nodes do not name the allowance: Monad says "gas required exceeds allowance" without a number (its 30M
 * is the documented limit), zkSync refuses an estimate from an account that does not exist.
 */
const ALLOWANCE_UNREPORTED = new Set([143, 324])
const LOOP = '0x5b600056' // JUMPDEST PUSH1 0 JUMP
const TARGET = '0x00000000000000000000000000000000dEaD0001'
const FROM = '0x0000000000000000000000000000000000000001'
const POWERS = new Set([1n << 24n, 1n << 25n])

const redact = (s) => String(s).replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>').slice(0, 200)
const urlsOf = (id) => (process.env[`RPC_${id}`] ? process.env[`RPC_${id}`].split(',').map((u) => u.trim()).filter(Boolean) : PUBLIC[id] ?? [])

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

let failures = 0
function report(id, problems, notes) {
  if (problems.length === 0) return console.log(`ok   chain ${id} — ${notes.join('; ')}`)
  failures++
  console.log(`FAIL chain ${id} — ${notes.join('; ')}`)
  for (const p of problems) console.log(`  Reason: ${p}`)
}

const chains = process.argv.length > 2 ? process.argv.slice(2).map(Number) : Object.keys(UNISWAP_V3).map(Number).sort((a, b) => a - b)
for (const id of chains) {
  const urls = urlsOf(id)
  const problems = []
  const notes = []
  if (!UNISWAP_V3[id]) problems.push('not a chain of the Uniswap v3 table')
  if (urls.length === 0) problems.push(`no RPC (set RPC_${id})`)
  if (problems.length) {
    report(id, problems, notes)
    continue
  }
  try {
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
  } catch (e) {
    problems.push(redact(e?.message ?? e))
  }
  report(id, problems, notes)
}
if (failures) {
  console.log(`\n${failures} chain(s) failed`)
  process.exit(1)
}
console.log(`\nall ${chains.length} chains agree with the tables`)
