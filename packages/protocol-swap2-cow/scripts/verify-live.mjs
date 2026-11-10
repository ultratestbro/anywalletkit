#!/usr/bin/env node
// Live, read-only check of the CoW Protocol module on every chain it ships. Nothing is placed, posted or sent: the
// orderbook only prices (POST /quote) and lists (GET), the chains are only read (eth_getCode / eth_call /
// eth_estimateGas). The account is a throwaway key made for the run — it signs locally, to prove the typed data the
// module hands out verifies; no signature leaves the process.
//
// Per chain:
//   pins      code at GPv2Settlement / GPv2VaultRelayer / CoWSwapEthFlow; domainSeparator() = the local separator;
//             vaultRelayer() = the pin; eth-flow's cowSwapSettlement() and wrappedNativeToken() = the pins.
//   order     USDC → WETH through the provider (executable quote): the order is the request (core's own GPv2 gate),
//             its digest and UID are the local ones, the throwaway key's signature recovers the account.
//   permit    the same quote offers an EIP-2612 permit for the vault relayer; the signed permit is accepted by the
//             token in an eth_estimateGas of the exact hook call, and the order then commits to the appData that
//             carries it — every other field unchanged.
//   reverse   WETH → USDC and USDC → native coin (dry quotes): priced, minimum within the slippage.
//   eth-flow  native coin → USDC: the createOrder transaction is simulated with eth_call (the sender is given the
//             input by a state override); the hash the contract returns is the digest the module derives its status
//             id from, and the refund call is refused while the order does not exist.
//   status    a settled order from the chain's own history (an account's first fulfilled order) reads as completed.
//
//   node scripts/verify-live.mjs [chainId[,chainId…]]            (build first: pnpm build)
//
// RPC: COW_RPC_<chainId>, else the public endpoint below.
import {decodeAbiParameters, encodeFunctionData, hashTypedData, keccak256, parseAbi, recoverTypedDataAddress} from 'viem'
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts'
import {assertGpv2Order, assertGpv2Permit} from '@anywalletkit/protocol-swap2-core'
import {
  COW_DEPLOYMENTS, COW_NATIVE, ETH_FLOW_ABI, cowDomainSeparator, cowProvider, decodeEthFlowCall, ethFlowOrderId, orderUid, parseCowIntent,
} from '../dist/index.js'

const PUBLIC_RPC = {1: 'https://ethereum-rpc.publicnode.com', 8453: 'https://base-rpc.publicnode.com', 42161: 'https://arbitrum-one-rpc.publicnode.com'}
const USDC = {1: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 8453: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 42161: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'}
/** The status check needs no account of ours: it reads the newest fulfilled order the orderbook lists for the eth-flow contract (the owner of every native-coin order). */
const only = process.argv.slice(2).find((a) => /^[0-9,]+$/.test(a))?.split(',').map(Number)
const chains = only ?? Object.keys(COW_DEPLOYMENTS).map(Number)
const urlFor = (id) => process.env[`COW_RPC_${id}`] || PUBLIC_RPC[id]
const ABI = parseAbi([
  'function domainSeparator() view returns (bytes32)',
  'function vaultRelayer() view returns (address)',
  'function cowSwapSettlement() view returns (address)',
  'function wrappedNativeToken() view returns (address)',
])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function rpc(url, method, params) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params}), signal: AbortSignal.timeout(30_000)})
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      if (body.error) return {error: body.error}
      return {result: body.result}
    } catch (e) {
      if (attempt >= 4) throw e
      await sleep(1000 * 2 ** attempt)
    }
  }
}
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()

let failed = 0
const lines = []
function check(chainId, name, ok, detail = '') {
  if (!ok) failed++
  lines.push(`${ok ? 'ok  ' : 'FAIL'} ${String(chainId).padEnd(6)} ${name}${detail ? ` — ${detail}` : ''}`)
  console.log(lines[lines.length - 1])
}

for (const chainId of chains) {
  const d = COW_DEPLOYMENTS[chainId]
  const url = urlFor(chainId)
  const chain = `eip155:${chainId}`
  const read = async (to, functionName) => {
    const r = await rpc(url, 'eth_call', [{to, data: encodeFunctionData({abi: ABI, functionName})}, 'latest'])
    return r.result
  }

  // ── pins ──
  for (const [name, address] of [['GPv2Settlement', d.settlement], ['GPv2VaultRelayer', d.vaultRelayer], ['CoWSwapEthFlow', d.ethFlow]]) {
    const code = (await rpc(url, 'eth_getCode', [address, 'latest'])).result ?? '0x'
    check(chainId, `pins: code at ${name} ${address}`, code.length > 2, `${(code.length - 2) / 2} bytes, keccak ${keccak256(code).slice(0, 18)}…`)
  }
  const separator = await read(d.settlement, 'domainSeparator')
  check(chainId, 'pins: domainSeparator() equals the local EIP-712 separator', same(separator, cowDomainSeparator(chainId)), separator)
  check(chainId, 'pins: vaultRelayer() is the pinned relayer', same(`0x${(await read(d.settlement, 'vaultRelayer')).slice(-40)}`, d.vaultRelayer))
  check(chainId, 'pins: eth-flow cowSwapSettlement() is the pinned settlement', same(`0x${(await read(d.ethFlow, 'cowSwapSettlement')).slice(-40)}`, d.settlement))
  check(chainId, 'pins: eth-flow wrappedNativeToken() is the pinned wrapped native', same(`0x${(await read(d.ethFlow, 'wrappedNativeToken')).slice(-40)}`, d.wrappedNative), d.wrappedNative)

  // ── the provider, as an app runs it ──
  const account = privateKeyToAccount(generatePrivateKey())
  const provider = cowProvider({enabled: true, rpcUrls: {[chainId]: [url]}})
  const refusals = []
  const base = {sourceChain: chain, destChain: chain, destAddress: account.address, refundAddress: account.address, slippageBps: 50, onRefusal: (r) => refusals.push(r)}
  const withinSlippage = (q) => BigInt(q.minDestAmount) <= BigInt(q.destAmount) && BigInt(q.minDestAmount) >= (BigInt(q.destAmount) * 9949n) / 10000n

  // order + permit: 25 USDC → WETH
  const amount = '25000000'
  const q = await provider.getQuote({...base, sourceToken: 'USDC', destToken: d.wrappedNative, amountIn: amount})
  if (!q) check(chainId, 'order: USDC → WETH quote', false, refusals.pop())
  else {
    check(chainId, 'order: USDC → WETH quote', withinSlippage(q), `${amount} USDC units → ${q.destAmount} (min ${q.minDestAmount}), network cost ${q.fees[0].amount}, verified=${q.providerData.verified}, permit=${q.providerData.permit}, validTo in ${Number(q.providerData.validTo) - Math.floor(Date.now() / 1000)} s`)
    const build = await provider.buildDeposit(q)
    const now = Math.floor(Date.now() / 1000)
    const expectation = {self: account.address, token: USDC[chainId], amount, chainId, recipient: account.address, destToken: d.wrappedNative, minDest: q.minDestAmount, now}
    let gate
    try { gate = assertGpv2Order(build.typedData, build.approvalAddress, expectation) } catch (e) { check(chainId, 'order: passes the engine GPv2 gate', false, e.message) }
    if (gate) {
      check(chainId, 'order: passes the engine GPv2 gate', same(build.to, d.settlement) && build.value === '0' && !build.data, `validTo ${gate.validTo}, appData ${gate.appData.slice(0, 18)}…, allowance ${build.approvalAmount}`)
      const td = JSON.parse(build.typedData)
      const {EIP712Domain: _d, ...types} = td.types
      const digest = hashTypedData({domain: td.domain, types, primaryType: 'Order', message: td.message})
      const signature = await account.signTypedData({domain: td.domain, types, primaryType: 'Order', message: td.message})
      const signer = await recoverTypedDataAddress({domain: td.domain, types, primaryType: 'Order', message: td.message, signature})
      check(chainId, 'order: the throwaway key signature over the typed data recovers the account (not submitted)', same(signer, account.address), `digest ${digest}, uid ${orderUid(digest, account.address, gate.validTo).slice(0, 26)}…`)

      if (!build.permit) check(chainId, 'permit: offered for USDC', false, 'no permit in the build')
      else {
        let permitOk
        try { permitOk = assertGpv2Permit(build.permit, {self: account.address, token: USDC[chainId], value: BigInt(build.approvalAmount), chainId, deadline: gate.validTo}) } catch (e) { check(chainId, 'permit: passes the engine permit gate', false, e.message) }
        if (permitOk) {
          const p = JSON.parse(build.permit)
          const {EIP712Domain: _p, ...ptypes} = p.types
          check(chainId, 'permit: passes the engine permit gate', true, `domain ${p.domain.name} / ${p.domain.version ?? '(no version)'}, value ${p.message.value}, nonce ${p.message.nonce}, deadline = validTo`)
          const permitSignature = await account.signTypedData({domain: p.domain, types: ptypes, primaryType: 'Permit', message: p.message})
          try {
            // applyPermit runs the exact hook call against the token (eth_estimateGas) before it writes the order.
            const funded = await provider.applyPermit(q.intentId, permitSignature)
            const gate2 = assertGpv2Order(funded.typedData, funded.approvalAddress, expectation)
            const a = JSON.parse(build.typedData).message, b = JSON.parse(funded.typedData).message
            const others = Object.keys(a).filter((k) => k !== 'appData').every((k) => a[k] === b[k])
            check(chainId, 'permit: the token accepts the signed permit (simulated); the order now commits to the appData with the hook, nothing else changed', others && gate2.appData !== gate.appData && !funded.permit, `appData ${gate.appData.slice(0, 14)}… → ${gate2.appData.slice(0, 14)}…`)
          } catch (e) {
            check(chainId, 'permit: the token accepts the signed permit (simulated)', false, e.message)
          }
        }
      }
    }
  }

  // reverse + native buy (dry)
  for (const [name, params] of [
    ['reverse: WETH → USDC dry quote', {sourceToken: 'WETH', destToken: USDC[chainId], amountIn: '10000000000000000'}],
    ['native buy: USDC → native coin dry quote', {sourceToken: 'USDC', destToken: COW_NATIVE, amountIn: '25000000'}],
  ]) {
    const dq = await provider.getQuote({...base, ...params, dry: true})
    check(chainId, name, !!dq && withinSlippage(dq) && !dq.txRequest, dq ? `${params.amountIn} → ${dq.destAmount} (min ${dq.minDestAmount}), verified=${dq.providerData.verified}` : refusals.pop())
  }

  // eth-flow
  const value = '10000000000000000'
  const eq = await provider.getQuote({...base, sourceToken: 'ETH', destToken: USDC[chainId], amountIn: value})
  if (!eq) check(chainId, 'eth-flow: native → USDC quote', false, refusals.pop())
  else {
    const tx = await provider.buildDeposit(eq)
    const call = decodeEthFlowCall(tx.data)
    const intent = parseCowIntent(eq.intentId)
    const sameTx = same(tx.to, eq.txRequest.to) && tx.data === eq.txRequest.data && tx.value === eq.txRequest.value && same(tx.to, d.ethFlow) && tx.value === value
    check(chainId, 'eth-flow: native → USDC quote and createOrder transaction', sameTx && withinSlippage(eq) && call?.method === 'createOrder' && same(call.order.receiver, account.address) && same(call.order.buyToken, USDC[chainId]) && call.order.buyAmount === eq.minDestAmount,
      `${value} wei → ${eq.destAmount} (min ${eq.minDestAmount}), quoteId ${call?.order.quoteId}, validTo in ${call ? call.order.validTo - Math.floor(Date.now() / 1000) : '?'} s`)
    const {digest, uid} = ethFlowOrderId(d, intent.data)
    const override = {[account.address]: {balance: '0x56bc75e2d63100000'}}
    const sim = await rpc(url, 'eth_call', [{from: account.address, to: tx.to, value: `0x${BigInt(tx.value).toString(16)}`, data: tx.data}, 'latest', override])
    check(chainId, 'eth-flow: createOrder simulated on-chain returns the digest the status id is derived from', same(sim.result, digest), sim.result ?? JSON.stringify(sim.error).slice(0, 160))
    const gas = await rpc(url, 'eth_estimateGas', [{from: account.address, to: tx.to, value: `0x${BigInt(tx.value).toString(16)}`, data: tx.data}, 'latest', override])
    check(chainId, 'eth-flow: createOrder gas fits the declared limit', !!gas.result && BigInt(gas.result) <= BigInt(tx.gasLimit), `estimate ${gas.result ? BigInt(gas.result) : JSON.stringify(gas.error).slice(0, 120)} ≤ ${tx.gasLimit}`)
    const stored = await rpc(url, 'eth_call', [{to: d.ethFlow, data: encodeFunctionData({abi: ETH_FLOW_ABI, functionName: 'orders', args: [digest]})}, 'latest'])
    const [owner] = decodeAbiParameters([{type: 'address'}, {type: 'uint32'}], stored.result)
    check(chainId, 'eth-flow: no such order exists yet (nothing was sent); status and refund say so', /^0x0{40}$/.test(owner)
      && (await provider.trackIntent({intentId: eq.intentId})).state === 'pending' && (await provider.buildClaim({intentId: eq.intentId})) === null, `uid ${uid.slice(0, 26)}…`)
  }

  // status of a real settled order: the newest fulfilled order of the eth-flow contract's own account
  try {
    const res = await fetch(`https://api.cow.fi/${d.network}/api/v1/account/${d.ethFlow}/orders?limit=50`, {signal: AbortSignal.timeout(30_000)})
    const list = await res.json()
    const done = Array.isArray(list) ? list.find((o) => o.status === 'fulfilled') : null
    if (!done) check(chainId, 'status: a fulfilled order reads as completed', false, 'no fulfilled order among the newest 50')
    else {
      const status = await provider.trackIntent({intentId: `o:${chainId}:${done.uid}`})
      const cancel = await provider.buildCancel({intentId: `o:${chainId}:${done.uid}`}, {owner: d.ethFlow, onchain: true})
      check(chainId, 'status: a real fulfilled order reads as completed with its settlement hash; nothing to cancel', status.state === 'completed' && /^0x[0-9a-f]{64}$/.test(status.destTxHash ?? '') && cancel === null, `uid ${done.uid.slice(0, 26)}… settled in ${status.destTxHash}`)
    }
  } catch (e) {
    check(chainId, 'status: a fulfilled order reads as completed', false, e.message)
  }
}

console.log(`\n${lines.length - failed}/${lines.length} checks passed on chains ${chains.join(', ')} — read-only: no order placed, no appData uploaded, no cancellation sent, no transaction broadcast.`)
process.exit(failed ? 1 : 0)
