/**
 * Protocol modules in Hermes: every module must LOAD (no missing globals, no
 * unsupported syntax), construct over an offline account, expose its surface,
 * and answer a read without a runtime error. Network reads are expected to
 * fail — with an ordinary Error, never a ReferenceError/TypeError, which is
 * what a missing polyfill looks like. Pure helpers are checked for real values.
 */
import { createMockAccount, parseActivityFixture, type ActivityFixtureJson } from '@anywalletkit/conformance'
import { bigintToNumber, bigintToUnits } from '@anywalletkit/core'
import { Address } from '@ton/core'
import { RouterSwap2Protocol } from '@anywalletkit/protocol-swap2-router/swap2/router'
import { usdValue } from '@anywalletkit/protocol-swap2-router/value'
import { NearIntentsSwap2Protocol } from '@anywalletkit/protocol-swap2-near-intents/protocol'
import { LifiSwap2Protocol } from '@anywalletkit/protocol-swap2-lifi/protocol'
import { lifiProvider, lifiVerifyQuote } from '@anywalletkit/protocol-swap2-lifi/provider'
import lifiSolanaLive from '../../packages/protocol-swap2-lifi/tests/fixtures-live-2026-11-12-evm-solana.json'
import lifiEvmIntentsLive from '../../packages/protocol-swap2-lifi/tests/fixtures-live-2026-11-13-evm-intents.json'
import { cctpProvider } from '@anywalletkit/protocol-swap2-cctp/provider'
import { CctpSwap2Protocol } from '@anywalletkit/protocol-swap2-cctp/protocol'
import { usdt0Provider } from '@anywalletkit/protocol-swap2-usdt0/provider'
import { Usdt0Swap2Protocol } from '@anywalletkit/protocol-swap2-usdt0/protocol'
import { USDT0_MESH_DESTINATIONS, USDT0_MESH_SOURCES, meshRecipientBytes32, meshRecipientMatches, usdt0VerifyQuote } from '@anywalletkit/protocol-swap2-usdt0/config'
import { describeUsdt0Activity } from '@anywalletkit/protocol-swap2-usdt0/activity'
import usdt0MeshTonLive from '../../packages/protocol-swap2-usdt0/fixtures/activity/arb-mesh-send-ton-1.json'
import usdt0MeshTronLive from '../../packages/protocol-swap2-usdt0/fixtures/activity/arb-mesh-send-tron-1.json'
import { chainflipProvider } from '@anywalletkit/protocol-swap2-chainflip/provider'
import { ChainflipSwap2Protocol } from '@anywalletkit/protocol-swap2-chainflip/protocol'
import { decodeTronNote } from '@anywalletkit/protocol-swap2-chainflip/codec'
import { symbiosisProvider } from '@anywalletkit/protocol-swap2-symbiosis/provider'
import { SymbiosisSwap2Protocol } from '@anywalletkit/protocol-swap2-symbiosis/protocol'
import { jupiterProvider } from '@anywalletkit/protocol-swap2-jupiter/provider'
import { JupiterSwap2Protocol } from '@anywalletkit/protocol-swap2-jupiter/protocol'
import { decodeSwapArgs, fromBase64 as jupFromBase64 } from '@anywalletkit/protocol-swap2-jupiter/codec'
import { assembleTransaction as jupAssemble } from '@anywalletkit/protocol-swap2-jupiter/transaction'
import { fyndProvider } from '@anywalletkit/protocol-swap2-fynd/provider'
import { FyndSwap2Protocol } from '@anywalletkit/protocol-swap2-fynd/protocol'
import { FYND_CHAINS, TYCHO_ROUTER_ABI, checkFyndTransaction } from '@anywalletkit/protocol-swap2-fynd/router'
import { curveProvider } from '@anywalletkit/protocol-swap2-curve/provider'
import { CurveSwap2Protocol } from '@anywalletkit/protocol-swap2-curve/protocol'
import { CURVE_DEPLOYMENTS, CURVE_POOLS, EXCHANGE_SELECTOR, curveVerifyQuote, decodeExchange, encodeExchange, findRoutes, routeArgs } from '@anywalletkit/protocol-swap2-curve'
import curveQuotesLive from '../../packages/protocol-swap2-curve/fixtures/quotes/quotes-2026-11-06.json'
import { RelaySwap2Protocol } from '@anywalletkit/protocol-swap2-relay/protocol'
import { RELAY_SOLVERS, RelayRefusal, parseRelayOrder, relayOrderId, relayOrderSigner, relayProvider, verifyRelayOrder } from '@anywalletkit/protocol-swap2-relay'
import relayVectors from '../../packages/protocol-swap2-relay/fixtures/orders/vectors.json'
import relayUsdcLive from '../../packages/protocol-swap2-relay/fixtures/quotes/user.arb-usdc_base-usdc.json'
import relayNativeLive from '../../packages/protocol-swap2-relay/fixtures/quotes/base-eth_arb-eth.json'
import { decodeFunctionData, encodeFunctionData, encodeFunctionResult, parseAbi } from 'viem'
import { nearIntentsProvider } from '@anywalletkit/protocol-swap2-near-intents/provider'
import { ThorchainSwap2Protocol } from '@anywalletkit/protocol-swap2-thorchain/protocol'
import { THORNODE_CONFIRM_PATHS, thorchainPins, thorchainProvider } from '@anywalletkit/protocol-swap2-thorchain/provider'
import thorAsgardLive from '../../packages/protocol-swap2-thorchain/fixtures/thornode/2026-11-12/liquify/vaults_asgard.json'
import thorInboundLive from '../../packages/protocol-swap2-thorchain/fixtures/thornode/2026-11-12/liquify/inbound_addresses.json'
import thorLastblockLive from '../../packages/protocol-swap2-thorchain/fixtures/thornode/2026-11-12/liquify/lastblock.json'
import thorMimirLive from '../../packages/protocol-swap2-thorchain/fixtures/thornode/2026-11-12/liquify/mimir.json'
import { OmnistonSwap2Protocol } from '@anywalletkit/protocol-swap2-omniston/protocol'
import { createOmnistonTonValidators } from '@anywalletkit/protocol-swap2-omniston/validators'
import escrowLive from '../../packages/protocol-swap2-omniston/tests/fixtures/live-2026-10-10.json'
import escrowRev2Live from '../../packages/protocol-swap2-omniston/tests/fixtures/live-ton-settlement-rev2-2026-11-11.json'
import LidoProtocolEvm, { splitWithdrawalAmounts } from '@anywalletkit/protocol-staking-lido-evm'
import SsvProtocolEvm, { MINIMAL_STAKING_AMOUNT } from '@anywalletkit/protocol-staking-ssv-evm'
import TonstakersProtocolTon, { buildStakeBody, buildUnstakeBody } from '@anywalletkit/protocol-staking-tonstakers-ton'
import SplStakePoolProtocolSolana, { base58Decode } from '@anywalletkit/protocol-staking-spl-stake-pool-solana'
import MellowProtocolEvm, { toAsset } from '@anywalletkit/protocol-lending-mellow-evm'
import { AaveProtocolEvm, parseReserveConfiguration, rayToApyPct, AAVE_MARKETS } from '@anywalletkit/protocol-lending-aave-evm'
import { MorphoVaultProtocolEvm, MorphoMarketProtocolEvm, marketId, accrue, MORPHO_CHAINS } from '@anywalletkit/protocol-lending-morpho-evm'
import { ScrvUsdProtocolEvm, SCRVUSD, VAULT_V3_ABI, scrvUsdAprWad, aprWadToApyPct, clampApy, assertCurveHost, describeCurveLendingActivity } from '@anywalletkit/protocol-lending-curve-evm'
import scrvUsdDepositLive from '../../packages/protocol-lending-curve-evm/fixtures/activity/ethereum-deposit-crvusd.json'
import { NativeStakingProtocolSolana, createWithSeed as nativeCreateWithSeed, activationStatus as nativeActivation, decodeStakeAccount as nativeDecodeStake, STAKE_PROGRAM as NATIVE_STAKE_PROGRAM } from '@anywalletkit/protocol-staking-native-solana'
import { NativeStakingProtocolMonad, packWithdrawalId as monadPack, unpackWithdrawalId as monadUnpack, commissionToPercent as monadCommission, describeRevert as monadRevert, STAKING_ABI as MONAD_STAKING_ABI } from '@anywalletkit/protocol-staking-native-monad'
import { NativeStakingProtocolNear, factoryOf as nearFactoryOf, poolRequestId as nearPoolRequestId, annualize as nearAnnualize, describeNativeNearStakingActivity } from '@anywalletkit/protocol-staking-native-near'
import { LiquidStakingProtocolNear, resolvePool as liquidResolvePool, sharesForNear, nearForShares, aprFromPrices, assertLiquidPlan, fc as liquidFc, describeLiquidNearStakingActivity } from '@anywalletkit/protocol-staking-liquid-near'
import nearStakeLive from '../../packages/protocol-staking-native-near/fixtures/activity/deposit_and_stake.json'
import rnearStakeLive from '../../packages/protocol-staking-liquid-near/fixtures/activity/rnear-deposit_and_stake.json'
import {
  KaminoVaultProtocolSolana, KaminoMarketProtocolSolana, MAIN_MARKET, KLEND_PROGRAM, KVAULT_PROGRAM, instructionName, toDecimalString, fromDecimalString,
  decodeVault, decodeReserve, decodeObligation, vaultTokensPerShareWad, debtNow, farmUserState, plumbing, associatedTokenAddress,
} from '@anywalletkit/protocol-lending-kamino-solana'
import { unexpectedInstruction } from '@anywalletkit/wallet-solana'
import { redactUrls, tonRawAddress, refusal, refusalOf, withReason, httpRefusal, parseRetryAfter, combinedRefusal, refusalNotes, Swap2QuoteError, SWAP2_REFUSAL_REASONS } from '@anywalletkit/protocol-swap2-core'
import ApprovalsProtocolEvm, { isRevokeCalldata, isUnlimitedAmount } from '@anywalletkit/protocol-approvals-evm'

type Check = (what: string, ok: boolean, detail?: string) => void
declare const print: ((s: string) => void) | undefined
/** A line in the run log that is not a gate (engine quirks worth seeing next to a failure). */
const note = (s: string) => (typeof print === 'function' ? print : console.log)(`[note] ${s}`)

const runtimeError = (e: unknown) => e instanceof ReferenceError || e instanceof TypeError || e instanceof SyntaxError

/** Call a read; pass when it resolves or rejects with a NON-runtime error. */
async function tolerates(check: Check, what: string, fn: () => Promise<unknown>) {
  try { await fn(); check(what, true) } catch (e) { check(what, !runtimeError(e), e instanceof Error ? `${e.name}: ${e.message}` : String(e)) }
}

export async function smokeProtocols(check: Check): Promise<void> {
  const evm = createMockAccount({ chain: 'eip155:1', address: '0x000000000000000000000000000000000000dEaD' }).toReadOnlyAccount()
  const ton = createMockAccount({ chain: 'ton:-239', address: 'UQBHyu-oZVDHRYQ1-rKlGqpHy5yAqanPBirEQNMNOmfHLtaT' }).toReadOnlyAccount()
  const sol = createMockAccount({ chain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', address: 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk' }).toReadOnlyAccount()
  const swap2Cfg = { fromChain: 'eip155:1', skipAccountChainCheck: true }

  // swap2
  // The aggregator is optional and takes whichever providers the app installed.
  const router = new RouterSwap2Protocol(evm, { ...swap2Cfg, providers: [lifiProvider({}), nearIntentsProvider({})] })
  check('router: surface', typeof router.quoteSwap2 === 'function' && typeof router.getSwap2Status === 'function')
  const chains = (await router.getSupportedChains()).map((c) => String(c.id))
  // TON is a hand-suspended 1Click corridor (HOT bridge dark since 2026-10-16) and LI.FI has no Bitcoin, so
  // Bitcoin can only have come from the near-intents provider.
  check('router: capabilities come from the passed providers', chains.includes('eip155:1') && chains.includes('bitcoin:mainnet'), chains.join(','))
  for (const [name, P] of [['near-intents', NearIntentsSwap2Protocol], ['lifi', LifiSwap2Protocol], ['thorchain', ThorchainSwap2Protocol], ['omniston', OmnistonSwap2Protocol], ['cctp', CctpSwap2Protocol], ['usdt0', Usdt0Swap2Protocol], ['chainflip', ChainflipSwap2Protocol], ['symbiosis', SymbiosisSwap2Protocol], ['jupiter', JupiterSwap2Protocol], ['fynd', FyndSwap2Protocol]] as const) {
    const p = new (P as never as new (a: unknown, c: unknown) => { getSupportedChains(): Promise<unknown>; quoteSwap2(o: unknown): Promise<unknown> })(evm, swap2Cfg)
    check(`${name}: constructs`, typeof p.quoteSwap2 === 'function')
    await tolerates(check, `${name}: getSupportedChains`, () => p.getSupportedChains())
  }
  {
    // LI.FI EVM → Solana (live answers 2026-11-12): the Solana recipient read from Mayan, Polymer CCTP and Chainflip
    // calldata (bytes32 → base58), Polymer's USDC account derived on the device (sha256 + ed25519 off-curve check under
    // Hermes BigInt); NEAR Intents / LayerSwap deposits and LI.FI Intents (unpinned oracles and settler) refused. A dry
    // quote priced for a placeholder carries no transaction: the provider keeps only its price, buildDeposit and
    // lifiVerifyQuote refuse one with a transaction.
    type C = { name: string; params: Parameters<typeof lifiVerifyQuote>[0]; response: { action: { fromToken: { address: string } }; estimate: { toAmountMin: string }; transactionRequest: { to: string; data: string; value: string; chainId: number } } }
    const corridors = (lifiSolanaLive as unknown as { corridors: C[] }).corridors
    const asQuote = (c: C, data = c.response.transactionRequest.data): Parameters<typeof lifiVerifyQuote>[1] => {
      const tr = c.response.transactionRequest
      const native = /^0x0{40}$/.test(c.response.action.fromToken.address)
      const value = BigInt(tr.value)
      const fee = native ? value - BigInt(c.params.amountIn) : value
      return {
        provider: 'lifi', intentId: `lifi:${tr.chainId}:1151111081099710`, depositAddress: '', depositMemo: null, sourceAmount: c.params.amountIn,
        destAmount: c.response.estimate.toAmountMin, minDestAmount: c.response.estimate.toAmountMin, feeUsd: 0, etaSeconds: 60, reliability: 1, validUntilMs: Date.now() + 60_000,
        txRequest: { to: tr.to, data, value: value.toString(), chainId: tr.chainId, ...(native ? {} : { approvalAddress: tr.to }), ...(fee > 0n ? { nativeFee: fee.toString() } : {}) },
      }
    }
    const readable = corridors.filter((c) => !/ (near|layerswap|lifiIntents)$/.test(c.name))
    const passed = readable.filter((c) => lifiVerifyQuote(c.params, asQuote(c)) === null).map((c) => c.name)
    check(`lifi: EVM → Solana recorded quotes pass lifiVerifyQuote (${passed.length}/${readable.length})`, readable.length === 12 && passed.length === readable.length, readable.filter((c) => !passed.includes(c.name)).join(', '))
    const other = 'd8a9e6d2f2a3c5ad3b7a6f1c8f5c4b3e2d1c0b9a8f7e6d5c4b3a2918f7e6d5c4'
    const refusalFor = (c: C) => lifiVerifyQuote({ ...c.params, destAddress: 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS' }, asQuote(c)) ?? ''
    for (const name of ['ethereum-usdc>solana-usdc polymerStandard', 'base-usdc>solana-sol mayan', 'ethereum-eth>solana-sol chainflip']) {
      const c = corridors.find((k) => k.name === name)!
      check(`lifi: EVM → Solana refuses another requested recipient (${name})`, /not (the recipient )?Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS/.test(refusalFor(c)), refusalFor(c))
      const data = c.response.transactionRequest.data.toLowerCase()
      const atAta = name.includes('polymer') ? data.indexOf('40d2f27c461f29e9feba1ab8acd39496a9c65b0ae62a713f01f941a993bf55ed') : -1
      if (atAta > 0) {
        const swapped = `${data.slice(0, atAta)}${other}${data.slice(atAta + 64)}`
        check('lifi: EVM → Solana refuses a Polymer CCTP mint to an account that is not the owner\'s USDC account', /^the transaction does not match the request: the Polymer CCTP transfer mints to /.test(lifiVerifyQuote(c.params, asQuote(c, swapped)) ?? ''))
      }
    }
    const near = corridors.find((k) => k.name.endsWith(' near'))!
    check('lifi: EVM → Solana refuses a NEAR Intents deposit address', /pays a deposit address whose off-chain order names the Solana recipient/.test(lifiVerifyQuote(near.params, asQuote(near)) ?? ''))
    const intents = corridors.filter((k) => k.name.endsWith(' lifiIntents'))
    const intentsWhy = intents.map((c) => lifiVerifyQuote(c.params, asQuote(c)) ?? '')
    check(`lifi: EVM → Solana refuses LI.FI Intents (oracles / settler not pinned) (${intents.length})`, intents.length === 2 && intentsWhy.every((w) => /^the transaction does not match the request: a LI\.FI Intents order to Solana names its own oracles, output settler and output amount/.test(w)), intentsWhy.join(' | '))

    // Dry quote without a recipient: priced for the Solana placeholder, carried without a transaction (the provider's
    // whole getQuote path under Hermes over a scripted fetch: URL params, the Diamond call decode, the strip).
    const polymer = corridors.find((k) => k.name === 'ethereum-usdc>solana-usdc polymerStandard')!
    const dryParams = { ...polymer.params, destAddress: '', dry: true }
    const carries = 'a dry quote priced for a placeholder recipient carries a transaction — it would pay or refund that placeholder, not the wallet that signs it'
    check('lifi: a dry EVM → Solana request without a recipient refuses a transaction (lifiVerifyQuote)', lifiVerifyQuote(dryParams, asQuote(polymer)) === carries, lifiVerifyQuote(dryParams, asQuote(polymer)) ?? 'accepted')
    const g = globalThis as { fetch?: unknown }
    const offline = g.fetch
    let toAddress: string | null = null
    g.fetch = async (u: unknown) => {
      const url = new URL(String(u))
      toAddress = url.searchParams.get('toAddress')
      const answer = (polymer as unknown as { response: { action: object } }).response
      const body = { ...answer, action: { ...answer.action, slippage: Number(url.searchParams.get('slippage')) } }
      return { ok: true, status: 200, json: async () => body }
    }
    try {
      const dryQuote = await lifiProvider({}).getQuote(dryParams)
      check('lifi: a dry EVM → Solana quote prices the Solana placeholder recipient', toAddress === 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk', String(toAddress))
      check('lifi: a dry quote priced for a placeholder carries no transaction', !!dryQuote && dryQuote.txRequest === undefined && dryQuote.providerData?.placeholder === 'recipient', JSON.stringify(dryQuote?.providerData ?? null))
      check('lifi: a price-only dry quote passes lifiVerifyQuote', !!dryQuote && lifiVerifyQuote(dryParams, dryQuote) === null, dryQuote ? lifiVerifyQuote(dryParams, dryQuote) ?? '' : 'no quote')
      let built = ''
      try { if (dryQuote) await lifiProvider({}).buildDeposit({ ...dryQuote, txRequest: asQuote(polymer).txRequest! }) } catch (e) { built = e instanceof Error ? e.message : String(e) }
      check('lifi: buildDeposit refuses a quote priced for a placeholder, even with a transaction attached', /^swap2: this LI\.FI quote was priced for a placeholder recipient/.test(built), built)
    } finally {
      g.fetch = offline
    }
  }
  {
    // LI.FI Intents between EVM chains (live answers 2026-11-13): the escrowed order names its own oracles, output
    // settler and output amount, so the Diamond call is refused on the device too (lifiVerifyQuote, the remote pin).
    // A dry quote without the sender (price-only) declares its native bridge fee as providerData.nativeFee, and the
    // router's usdValue nets it out (live Stargate V2 answer: LayerZero's fee in value).
    type A = { tool?: string; action: { fromToken: { address: string } }; estimate: { toAmountMin: string }; transactionRequest: { to: string; data: string; value: string; chainId: number } }
    type C = { name: string; params: Parameters<typeof lifiVerifyQuote>[0]; status?: number; response: A }
    const fx = lifiEvmIntentsLive as unknown as { corridors: C[]; intents: C[]; priceOnly: C }
    const asQuote = (c: C): Parameters<typeof lifiVerifyQuote>[1] => {
      const tr = c.response.transactionRequest
      const native = /^0x0{40}$/.test(c.response.action.fromToken.address)
      const value = BigInt(tr.value)
      const fee = native ? value - BigInt(c.params.amountIn) : value
      return {
        provider: 'lifi', intentId: `lifi:${tr.chainId}:${c.params.destChain.split(':')[1]}`, depositAddress: '', depositMemo: null, sourceAmount: c.params.amountIn,
        destAmount: c.response.estimate.toAmountMin, minDestAmount: c.response.estimate.toAmountMin, feeUsd: 0, etaSeconds: 60, reliability: 1, validUntilMs: Date.now() + 60_000,
        txRequest: { to: tr.to, data: tr.data, value: value.toString(), chainId: tr.chainId, ...(native ? {} : { approvalAddress: tr.to }), ...(fee > 0n ? { nativeFee: fee.toString() } : {}) },
      }
    }
    const unpinned = 'the transaction does not match the request: a LI.FI Intents order to an EVM chain names its own oracles, output settler and output amount, which cannot be checked here — its escrow could release the input without the delivery'
    const intentsWhy = fx.intents.map((c) => lifiVerifyQuote(c.params, asQuote(c)) ?? 'accepted')
    check(`lifi: EVM → EVM refuses LI.FI Intents (oracles / settler not pinned) (${fx.intents.length})`, fx.intents.length === 3 && intentsWhy.every((w) => w === unpinned), intentsWhy.join(' | ').slice(0, 300))
    const others = fx.corridors.filter((c) => c.status === 200)
    const passed = others.filter((c) => lifiVerifyQuote(c.params, asQuote(c)) === null).map((c) => c.name)
    check(`lifi: EVM → EVM quotes through other bridges pass lifiVerifyQuote (${passed.length}/${others.length})`, others.length === 13 && passed.length === others.length, others.filter((c) => !passed.includes(c.name)).map((c) => c.name).join(', '))

    const stargate = fx.priceOnly
    const g = globalThis as { fetch?: unknown }
    const offline = g.fetch
    g.fetch = async (u: unknown) => {
      const url = new URL(String(u))
      const answer = stargate.response as unknown as { action: object }
      return { ok: true, status: 200, json: async () => ({ ...answer, action: { ...answer.action, slippage: Number(url.searchParams.get('slippage')) } }) }
    }
    try {
      const q = await lifiProvider({}).getQuote(stargate.params)
      const fee = BigInt(stargate.response.transactionRequest.value).toString()
      check('lifi: a price-only quote declares its native bridge fee (providerData.nativeFee)', !!q && q.txRequest === undefined && q.providerData?.placeholder === 'sender' && q.providerData?.nativeFee === fee, JSON.stringify(q?.providerData ?? null))
      check('lifi: lifiVerifyQuote passes it, refuses a malformed declared fee', !!q && lifiVerifyQuote(stargate.params, q) === null
        && lifiVerifyQuote(stargate.params, { ...q, providerData: { ...q.providerData, nativeFee: '0x10' } }) === 'the price-only quote declares a native fee of 0x10, not a base-unit integer')
      const value = q ? usdValue({ ETH: 3000, USDC: 1 })(q, stargate.params) : null
      const gross = Number(stargate.response.estimate.toAmountMin) / 1e6
      const net = gross - (Number(fee) / 1e18) * 3000
      check('router: usdValue nets a price-only quote\'s providerData.nativeFee', value !== null && Math.abs(value - net) < 1e-6 && net < gross - 1, `${value} vs ${net} (gross ${gross})`)
    } finally {
      g.fetch = offline
    }
  }

  // staking
  const lido = new (LidoProtocolEvm as never as new (a: unknown, c?: unknown) => { getApr(): Promise<number> })(evm, {})
  await tolerates(check, 'lido: getApr', () => lido.getApr())
  const split = splitWithdrawalAmounts(2500n * 10n ** 18n, 1000n * 10n ** 18n) as bigint[]
  check('lido: splitWithdrawalAmounts', Array.isArray(split) && split.reduce((a, b) => a + b, 0n) === 2500n * 10n ** 18n, JSON.stringify(split.map(String)))
  const ssv = new (SsvProtocolEvm as never as new (a: unknown, c?: unknown) => { getApr(): Promise<number> })(evm, {})
  await tolerates(check, 'ssv: getApr', () => ssv.getApr())
  check('ssv: MINIMAL_STAKING_AMOUNT', typeof MINIMAL_STAKING_AMOUNT === 'bigint' && MINIMAL_STAKING_AMOUNT > 0n)
  const tonst = new (TonstakersProtocolTon as never as new (a: unknown, c?: unknown) => { getApr(): Promise<number> })(ton, {})
  await tolerates(check, 'tonstakers: getApr', () => tonst.getApr())
  const stakeBody = buildStakeBody(0) as { hash(): Uint8Array }
  check('tonstakers: buildStakeBody', typeof stakeBody?.hash === 'function' && stakeBody.hash().length === 32)
  const unstakeBody = buildUnstakeBody(10n ** 9n, Address.parse('UQBHyu-oZVDHRYQ1-rKlGqpHy5yAqanPBirEQNMNOmfHLtaT')) as { hash(): Uint8Array }
  check('tonstakers: buildUnstakeBody', unstakeBody.hash().length === 32)
  const jito = new (SplStakePoolProtocolSolana as never as new (a: unknown, c?: unknown) => { getApr(): Promise<number> })(sol, {})
  await tolerates(check, 'spl-stake-pool: getApr', () => jito.getApr())
  check('spl-stake-pool: base58Decode', (base58Decode('HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk') as Uint8Array).length === 32)

  const cctp = cctpProvider({})
  check('cctp: route USDC Base → Arbitrum', cctp.supportsRoute({ chain: 'eip155:8453', token: 'USDC' }, { chain: 'eip155:42161', token: 'USDC' }) && !cctp.supportsRoute({ chain: 'eip155:56', token: 'USDC' }, { chain: 'eip155:1', token: 'USDC' }))
  await tolerates(check, 'cctp: getQuote (network)', () => cctp.getQuote({ sourceChain: 'eip155:8453', sourceToken: 'USDC', destChain: 'eip155:42161', destToken: 'USDC', amountIn: '10000000', destAddress: '0x000000000000000000000000000000000000dEaD' }))
  const usdt0 = usdt0Provider({ rpcUrls: { 'eip155:42161': 'https://arbitrum-one-rpc.publicnode.com' } })
  check('usdt0: route USDT0 Arbitrum → HyperEVM, none from BSC', usdt0.supportsRoute({ chain: 'eip155:42161', token: 'USDT0' }, { chain: 'eip155:999', token: 'USDT0' }) && !usdt0.supportsRoute({ chain: 'eip155:56', token: 'USDT' }, { chain: 'eip155:1', token: 'USDT' }))
  await tolerates(check, 'usdt0: getQuote (network)', () => usdt0.getQuote({ sourceChain: 'eip155:42161', sourceToken: 'USDT0', destChain: 'eip155:999', destToken: 'USDT0', amountIn: '10000000', destAddress: '0x000000000000000000000000000000000000dEaD' }))
  // USDT0 Legacy Mesh (2026-11-12): the recipient bytes of real delivered packets (Ethereum → Tron, Arbitrum → TON) from the
  // address the destination paid — base58check + sha256 and TON base64 + CRC16 under Hermes; the send decoded back.
  const mTron = USDT0_MESH_DESTINATIONS['tron:728126428']!
  const mTon = USDT0_MESH_DESTINATIONS['ton:-239']!
  const mArb = USDT0_MESH_SOURCES['eip155:42161']!
  const tronTo = meshRecipientBytes32(mTron, 'TRjNDwg9kSj7sv1J6qGG4ad2wB9S9XqjMn')
  const tonTo = meshRecipientBytes32(mTon, 'UQAQskXMoOIlwQZWQaqDmfRsNQaYsyTE5ImQoZ2QMCMqzp5R')
  check('usdt0 mesh: Tron recipient → the packet bytes32', 'to' in tronTo && tronTo.to === '0x000000000000000000000000ace3e3286b7692028204857bd539c82517372727' && meshRecipientMatches(mTron, tronTo.to, 'TRjNDwg9kSj7sv1J6qGG4ad2wB9S9XqjMn'), JSON.stringify(tronTo))
  check('usdt0 mesh: TON recipient → the packet bytes32', 'to' in tonTo && tonTo.to === '0x10b245cca0e225c1065641aa8399f46c350698b324c4e48990a19d9030232ace' && meshRecipientMatches(mTon, tonTo.to, 'UQAQskXMoOIlwQZWQaqDmfRsNQaYsyTE5ImQoZ2QMCMqzp5R'), JSON.stringify(tonTo))
  check('usdt0 mesh: a garbled Tron / a masterchain TON recipient is refused', 'refusal' in meshRecipientBytes32(mTron, 'TRjNDwg9kSj7sv1J6qGG4ad2wB9S9XqjMm') && 'refusal' in meshRecipientBytes32(mTon, '-1:10b245cca0e225c1065641aa8399f46c350698b324c4e48990a19d9030232ace'))
  // TON by default; Tron only through meshDestinations (its LayerZero fee is above the engine's native-fee ceiling today).
  const usdt0Tron = usdt0Provider({ rpcUrls: { 'eip155:42161': 'https://arbitrum-one-rpc.publicnode.com' }, meshDestinations: ['tron', 'ton'] })
  check('usdt0 mesh: route Arbitrum USDT0 → TON USDT by default, → Tron only opted in, never from Tron',
    usdt0.supportsRoute({ chain: 'eip155:42161', token: 'USDT0' }, { chain: 'ton:-239', token: 'USDT' })
    && !usdt0.supportsRoute({ chain: 'eip155:42161', token: 'USDT0' }, { chain: 'tron:728126428', token: 'USDT' })
    && usdt0Tron.supportsRoute({ chain: 'eip155:42161', token: 'USDT0' }, { chain: 'tron:728126428', token: 'USDT' })
    && !usdt0Tron.supportsRoute({ chain: 'tron:728126428', token: 'USDT' }, { chain: 'eip155:42161', token: 'USDT0' }))
  const meshSend = parseAbi([
    'struct SendParam { uint32 dstEid; bytes32 to; uint256 amountLD; uint256 minAmountLD; bytes extraOptions; bytes composeMsg; bytes oftCmd; }',
    'struct MessagingFee { uint256 nativeFee; uint256 lzTokenFee; }',
    'struct OFTLimit { uint256 minAmountLD; uint256 maxAmountLD; }',
    'struct OFTFeeDetail { int256 feeAmountLD; string description; }',
    'struct OFTReceipt { uint256 amountSentLD; uint256 amountReceivedLD; }',
    'function send(SendParam s, MessagingFee fee, address refundAddress) payable',
    'function quoteSend(SendParam s, bool payInLzToken) view returns (MessagingFee)',
    'function quoteOFT(SendParam s) view returns (OFTLimit, OFTFeeDetail[], OFTReceipt)',
    'function token() view returns (address)',
    'function approvalRequired() view returns (bool)',
    'function peers(uint32 eid) view returns (bytes32)',
  ])
  if ('to' in tronTo) {
    const meshData = encodeFunctionData({ abi: meshSend, functionName: 'send', args: [{ dstEid: 30420, to: tronTo.to, amountLD: 10_000_000n, minAmountLD: 9_997_000n, extraOptions: '0x', composeMsg: '0x', oftCmd: '0x' }, { nativeFee: 7n, lzTokenFee: 0n }, '0x4444444444444444444444444444444444444444'] })
    const meshQuote = { provider: 'usdt0', intentId: 'usdt0-mesh:30110:30420', depositAddress: '', depositMemo: null, txRequest: { to: mArb.oft, data: meshData, value: '7', chainId: 42161, approvalAddress: mArb.oft, nativeFee: '7' }, sourceAmount: '10000000', destAmount: '9997000', minDestAmount: '9997000', feeUsd: 0, etaSeconds: 90, reliability: 1, validUntilMs: 0 }
    const meshParams = { sourceChain: 'eip155:42161', sourceToken: 'USDT0', destChain: 'tron:728126428', destToken: 'USDT', amountIn: '10000000', destAddress: 'TRjNDwg9kSj7sv1J6qGG4ad2wB9S9XqjMn', refundAddress: '0x4444444444444444444444444444444444444444', dry: false }
    check('usdt0 mesh: verifyQuote passes the send, refuses another recipient', usdt0VerifyQuote(meshParams, meshQuote) === null && usdt0VerifyQuote({ ...meshParams, destAddress: 'TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj' }, meshQuote) !== null, String(usdt0VerifyQuote(meshParams, meshQuote)))
  }
  // A TON delivery completes on the tonapi payout of the packet's amount to 0:<to> (canned Scan + tonapi answers; the VM
  // has no Response, so the answers are the three fields the provider reads).
  const answer = (body: unknown) => ({ ok: true, status: 200, json: async () => body })
  const meshTrackFetch = (async (url: string) => String(url).startsWith('https://scan.test')
    ? answer({ data: [{ pathway: { srcEid: 30110, dstEid: 30343, sender: { address: mArb.oft.toLowerCase() } }, source: { tx: { payload: '0x000210b245cca0e225c1065641aa8399f46c350698b324c4e48990a19d9030232ace000000003a1ec3dc' } }, destination: { tx: { txHash: '0x' + 'ef'.repeat(32) } }, status: { name: 'DELIVERED' } }] })
    : answer({ in_progress: false, actions: [{ type: 'JettonTransfer', status: 'ok', JettonTransfer: { sender: { address: '0:1ddf580052174ed1dd0d66c35bfdc1a5fcc69af4f4ae36154b13dcfc6c14a35f' }, recipient: { address: '0:10b245cca0e225c1065641aa8399f46c350698b324c4e48990a19d9030232ace' }, amount: '975094748', jetton: { address: '0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe' } } }] })) as unknown as typeof fetch
  const meshTracker = usdt0Provider({ rpcUrls: { 'eip155:42161': 'https://arbitrum-one-rpc.publicnode.com' }, scanUrl: 'https://scan.test', tonApiUrl: 'https://ton.test', fetchImpl: meshTrackFetch })
  const meshTon = await meshTracker.trackIntent({ intentId: 'usdt0-mesh:30110:30343', sourceTxHash: '0x' + 'cd'.repeat(32) })
  check('usdt0 mesh: TON payout found in the delivery trace → completed', meshTon.state === 'completed' && meshTon.destTxHash === 'ef'.repeat(32), JSON.stringify(meshTon))
  await tolerates(check, 'usdt0 mesh: getQuote Arbitrum → TON (network)', () => usdt0.getQuote({ sourceChain: 'eip155:42161', sourceToken: 'USDT0', destChain: 'ton:-239', destToken: 'USDT', amountIn: '10000000', destAddress: 'UQAQskXMoOIlwQZWQaqDmfRsNQaYsyTE5ImQoZ2QMCMqzp5R' }))
  // The whole quote → build → preflight path on device: a canned Arbitrum mesh OFT behind fetchImpl answering token(),
  // approvalRequired(), peers(), quoteOFT and quoteSend as the live one did on 2026-11-12 (quoteSend into TON
  // 56287292611713 wei). viem's http transport reads only these response fields (the VM has no Response).
  const MESH_FEE = 56_287_292_611_713n
  let meshRpcCalls = 0
  const meshRpc = (async (_url: string, init?: { body?: string }) => {
    meshRpcCalls++
    const req = JSON.parse(String(init?.body)) as { id: number; method: string; params: Array<{ to: string; data: `0x${string}` }> }
    const reply = (result: unknown) => {
      const text = JSON.stringify({ jsonrpc: '2.0', id: req.id, result })
      return { ok: true, status: 200, statusText: 'OK', body: null, headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) }, text: async () => text, json: async () => JSON.parse(text) as unknown }
    }
    if (req.method === 'eth_chainId') return reply('0xa4b1')
    if (req.method !== 'eth_call' || req.params[0]!.to.toLowerCase() !== mArb.oft.toLowerCase()) throw new Error(`canned mesh RPC: unexpected ${req.method}`)
    const { functionName, args } = decodeFunctionData({ abi: meshSend, data: req.params[0]!.data })
    const enc = (result: unknown) => reply(encodeFunctionResult({ abi: meshSend, functionName, result } as never))
    if (functionName === 'token') return enc(mArb.token)
    if (functionName === 'approvalRequired') return enc(true)
    if (functionName === 'peers') return enc((args as unknown as [number])[0] === mTon.eid ? mTon.peer : mTron.peer)
    const sp = (args as unknown as [{ amountLD: bigint }])[0]
    if (functionName === 'quoteOFT') return enc([{ minAmountLD: 0n, maxAmountLD: 10n ** 13n }, [], { amountSentLD: sp.amountLD, amountReceivedLD: sp.amountLD - (sp.amountLD * 3n) / 10_000n }])
    if (functionName === 'quoteSend') return enc({ nativeFee: MESH_FEE, lzTokenFee: 0n })
    throw new Error(`canned mesh RPC: unexpected ${functionName}`)
  }) as unknown as typeof fetch
  const meshLive = usdt0Provider({ rpcUrls: { 'eip155:42161': 'https://rpc.test' }, fetchImpl: meshRpc })
  const meshReasons: string[] = []
  const tonParams = { sourceChain: 'eip155:42161', sourceToken: 'USDT0', destChain: 'ton:-239', destToken: 'USDT', amountIn: '10000000', destAddress: 'UQAQskXMoOIlwQZWQaqDmfRsNQaYsyTE5ImQoZ2QMCMqzp5R', refundAddress: '0x4444444444444444444444444444444444444444', dry: false }
  const mq = await meshLive.getQuote({ ...tonParams, onRefusal: (r: string) => meshReasons.push(r) })
  const sealedFee = (MESH_FEE + (MESH_FEE * 2_500n) / 10_000n).toString()
  check('usdt0 mesh: getQuote Arbitrum → TON from the OFT (canned RPC): received − 3 bps, fee + 25 %, mesh fee row, recipient bytes',
    !!mq && mq.intentId === 'usdt0-mesh:30110:30343' && mq.destAmount === '9997000' && mq.txRequest?.value === sealedFee && mq.txRequest?.approvalAddress === mArb.oft
    && Math.abs(mq.feeUsd - 0.003) < 1e-9 && mq.fees?.[0]?.amount === '3000' && mq.providerData?.recipientBytes32 === '0x10b245cca0e225c1065641aa8399f46c350698b324c4e48990a19d9030232ace',
    mq ? JSON.stringify({ v: mq.txRequest?.value, out: mq.destAmount, fee: mq.feeUsd }) : meshReasons.join('; '))
  if (mq) {
    check('usdt0 mesh: the provider\'s own quote passes usdt0VerifyQuote', usdt0VerifyQuote(tonParams, mq) === null, String(usdt0VerifyQuote(tonParams, mq)))
    const mtx = await meshLive.buildDeposit(mq)
    let pre = 'ok'
    try { await meshLive.preflightDeposit!(mq, mtx) } catch (e) { pre = (e as Error).message }
    const [sp0, fee0, refund0] = decodeFunctionData({ abi: meshSend, data: mtx.data as `0x${string}` }).args as unknown as [Record<string, unknown>, { nativeFee: bigint; lzTokenFee: bigint }, `0x${string}`]
    const swapped = encodeFunctionData({ abi: meshSend, functionName: 'send', args: [{ ...sp0, to: `0x${'22'.repeat(32)}` } as never, fee0, refund0] })
    let tampered = 'passed'
    try { await meshLive.preflightDeposit!(mq, { ...mtx, data: swapped }) } catch (e) { tampered = (e as Error).message }
    check('usdt0 mesh: buildDeposit + preflightDeposit pass (sealed send decoded, fee re-quoted); a swapped recipient in the calldata is refused',
      pre === 'ok' && mtx.to === mArb.oft && mtx.value === sealedFee && tampered === 'usdt0: the deposit is not the sealed Legacy Mesh send', `${pre} | ${tampered}`)
    // The rest of the sealed send (review 2026-11-12): the view call that carries the same SendParam, the three byte
    // fields, the MessagingFee, the refund and the chain — each swapped alone is refused before any RPC read.
    const resend = (sp: Record<string, unknown>, fee: { nativeFee: bigint; lzTokenFee: bigint }, refund: `0x${string}`) => encodeFunctionData({ abi: meshSend, functionName: 'send', args: [sp as never, fee, refund] })
    const attacker = '0x9999999999999999999999999999999999999999' as const
    const tampers: Array<[string, typeof mtx, string]> = [
      ['quoteSend', { ...mtx, data: encodeFunctionData({ abi: meshSend, functionName: 'quoteSend', args: [sp0 as never, false] }) }, 'usdt0: the deposit calls quoteSend, not send(SendParam, MessagingFee, refund)'],
      ['extraOptions', { ...mtx, data: resend({ ...sp0, extraOptions: '0x0003' }, fee0, refund0) }, "usdt0: the deposit's SendParam.extraOptions 0x0003 is not the sealed 0x"],
      ['composeMsg', { ...mtx, data: resend({ ...sp0, composeMsg: '0x01' }, fee0, refund0) }, "usdt0: the deposit's SendParam.composeMsg 0x01 is not the sealed 0x"],
      ['oftCmd', { ...mtx, data: resend({ ...sp0, oftCmd: '0x01' }, fee0, refund0) }, "usdt0: the deposit's SendParam.oftCmd 0x01 is not the sealed 0x"],
      ['nativeFee', { ...mtx, data: resend(sp0, { ...fee0, nativeFee: 1n }, refund0) }, `usdt0: the deposit's MessagingFee.nativeFee 1 is not the sealed ${sealedFee}`],
      ['lzTokenFee', { ...mtx, data: resend(sp0, { ...fee0, lzTokenFee: 1n }, refund0) }, "usdt0: the deposit's MessagingFee.lzTokenFee 1 is not 0"],
      ['refund', { ...mtx, data: resend(sp0, fee0, attacker) }, `usdt0: the deposit refunds ${attacker}, not the sealed refund address 0x4444444444444444444444444444444444444444`],
      ['chainId', { ...mtx, chainId: 1 }, 'usdt0: the deposit is for eip155:42161 (chainId 1), not Arbitrum (eip155:42161)'],
    ]
    const rpcBefore = meshRpcCalls
    const missed: string[] = []
    for (const [what, t, want] of tampers) {
      let got = 'passed'
      try { await meshLive.preflightDeposit!(mq, t) } catch (e) { got = (e as Error).message }
      if (got !== want) missed.push(`${what}: ${got}`)
    }
    check('usdt0 mesh: preflight refuses the view-call selector, options / compose / OFT command, another MessagingFee, refund or chain — before any RPC read',
      missed.length === 0 && meshRpcCalls === rpcBefore, `${missed.join(' | ')} | rpc ${meshRpcCalls - rpcBefore}`)
    // Review r3 (2026-11-13): a dry quote without a recipient is priced for the zero account and keeps only its price —
    // no send to build or sign; build, preflight and the remote pin refuse it by name, and a named zero account is refused.
    const dryParams = { ...tonParams, destAddress: '', dry: true }
    const priced = await meshLive.getQuote(dryParams)
    let built = 'built'
    try { await meshLive.buildDeposit(priced!) } catch (e) { built = (e as Error).message }
    let pre2 = 'passed'
    try { await meshLive.preflightDeposit!({ ...priced!, txRequest: mq.txRequest }, mtx) } catch (e) { pre2 = (e as Error).message }
    const standIn = encodeFunctionData({ abi: meshSend, functionName: 'send', args: [{ ...sp0, to: `0x${'00'.repeat(32)}` } as never, fee0, refund0] })
    const carries = usdt0VerifyQuote(dryParams, { ...mq, txRequest: { ...mq.txRequest!, data: standIn } })
    check('usdt0 mesh: a dry quote priced for the zero-account placeholder carries no send; build, preflight and verifyQuote refuse it by name',
      !!priced && priced.txRequest === undefined && priced.providerData?.placeholder === 'recipient' && priced.destAmount === '9997000'
      && built === 'swap2: this USDT0 quote was priced for a placeholder recipient (a dry quote without that address) and has no transaction to build — quote again with the recipient and the refund address'
      && pre2 === 'usdt0: this quote was priced for a placeholder recipient (a dry quote without that address) and has nothing to sign — quote again with the recipient and the refund address'
      && carries === 'a dry quote priced for a placeholder recipient carries a transaction — it would pay or refund that placeholder, not the wallet that signs it'
      && usdt0VerifyQuote(dryParams, priced!) === null,
      `${priced ? JSON.stringify(priced.providerData) : 'null'} | ${built} | ${pre2} | ${String(carries)}`)
    const zeroReasons: string[] = []
    const rpcBeforeZero = meshRpcCalls
    const zero = await meshLive.getQuote({ ...tonParams, destAddress: 'UQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJKZ', onRefusal: (r: string) => zeroReasons.push(r) })
    check('usdt0 mesh: a live quote to the TON zero account is refused before any RPC read',
      zero === null && zeroReasons.join() === 'destination is the zero account — nothing sent there can be recovered' && meshRpcCalls === rpcBeforeZero, zeroReasons.join('; '))
  }
  // describeActivity runs on device for every EVM transaction in the history: two recorded Legacy Mesh sends (Arbitrum →
  // TON and → Tron, 2026-11-12) read their destination from the calldata's eid; the LayerZero fee is not a bridged asset.
  for (const [fixture, dstName, amount] of [[usdt0MeshTonLive, 'TON', 7_327_122_217n], [usdt0MeshTronLive, 'Tron', 800_000_000_000n]] as const) {
    const { tx: aTx, own: aOwn } = parseActivityFixture(fixture as unknown as ActivityFixtureJson)
    const item = describeUsdt0Activity(aTx, { own: aOwn })
    check(`usdt0 mesh: describeActivity on a recorded Arbitrum → ${dstName} send`,
      !!item && item.kind === 'bridge' && item.title === 'Bridged USDT0 → USDT' && item.subtitle === `USDT0 Legacy Mesh · Arbitrum → ${dstName}`
      && item.assetsOut.length === 1 && item.assetsOut[0]!.token === mArb.token && item.assetsOut[0]!.amount === amount
      && item.counterparty === mArb.oft && item.fee === aTx.fee,
      item ? `${item.title} | ${item.subtitle} | ${item.assetsOut.map((a) => `${a.token}:${a.amount}`).join(',')} | fee ${item.fee}` : 'null')
    // The same calldata on another contract is not a mesh send.
    check(`usdt0 mesh: the ${dstName} send's calldata to another contract is not described`, describeUsdt0Activity({ ...aTx, to: '0x9999999999999999999999999999999999999999', call: { ...aTx.call!, to: '0x9999999999999999999999999999999999999999' } }, { own: aOwn }) === null)
  }
  // Tron off by default: answered as before the mesh, without a network call.
  const offReasons: string[] = []
  const off = await meshLive.getQuote({ ...tonParams, destChain: 'tron:728126428', destAddress: 'TRjNDwg9kSj7sv1J6qGG4ad2wB9S9XqjMn', onRefusal: (r: string) => offReasons.push(r) })
  check('usdt0 mesh: Tron without meshDestinations → "USDT0 is not deployed on this chain"', off === null && offReasons.join() === 'USDT0 is not deployed on this chain', offReasons.join('; '))
  const cf = chainflipProvider()
  check('chainflip: route Tron USDT → Arbitrum USDC, none from BSC', cf.supportsRoute({ chain: 'tron:728126428', token: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' }, { chain: 'eip155:42161', token: 'USDC' }) && !cf.supportsRoute({ chain: 'eip155:56', token: 'USDT' }, { chain: 'eip155:1', token: 'USDT' }))
  // live encoder note 2026-10-20: Tron USDT → Arbitrum USDC (asset 7, tag 3 = Arb) — SCALE + U256 LE min price under Hermes BigInt
  const cfNote = decodeTronNote('0x0703111111111111111111111111111111111111111100890101320000008840e6c55b9ada326d211d818c34a994aeced808f5285c8fc2f5285c8fc2f5285c8fc2f50000000000000000000000000000000000016400000070d0cd75a367987344a3896a18e1510e5429ca5e88357b6c2a2e306b3877380d000000')
  check('chainflip: decodes a Tron vault-swap note', cfNote.outputAsset === 7 && cfNote.destTag === 3 && cfNote.destAddress.length === 20 && cfNote.params.minPriceX128 > 0n && !cfNote.ccm, JSON.stringify({ a: cfNote.outputAsset, t: cfNote.destTag }))
  await tolerates(check, 'chainflip: getQuote dry (network)', () => cf.getQuote({ sourceChain: 'tron:728126428', sourceToken: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', destChain: 'eip155:42161', destToken: 'USDC', amountIn: '20000000', destAddress: '0x000000000000000000000000000000000000dEaD', dry: true }))
  const sym = symbiosisProvider()
  check('symbiosis: route BSC USDC → TON USDT, Tron source off by default', sym.supportsRoute({ chain: 'eip155:56', token: 'USDC' }, { chain: 'ton:-239', token: 'USDT' }) && !sym.supportsRoute({ chain: 'tron:728126428', token: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' }, { chain: 'eip155:8453', token: 'USDC' }))
  await tolerates(check, 'symbiosis: getQuote dry (network)', () => sym.getQuote({ sourceChain: 'eip155:56', sourceToken: 'USDC', destChain: 'ton:-239', destToken: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs', amountIn: '1500000000000000000000', destAddress: 'UQBHyu-oZVDHRYQ1-rKlGqpHy5yAqanPBirEQNMNOmfHLtaT', dry: true }))
  const jup = jupiterProvider()
  check('jupiter: route SOL → USDC on Solana only', jup.supportsRoute({ chain: 'solana:mainnet', token: 'SOL' }, { chain: 'solana:mainnet', token: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }) && !jup.supportsRoute({ chain: 'solana:mainnet', token: 'SOL' }, { chain: 'eip155:1', token: 'USDC' }))
  // live /build 2026-10-23: shared_accounts_route_v2, 25 USDC → SOL at 75 bps — u64 / u16 LE reads under Hermes
  const jArgs = decodeSwapArgs(jupFromBase64('0ZhTk3z+2OkCQHh9AQAAAADp7kIOAAAAAEsAAAAAAAQAAAAm/AMABKEAAQAAAGsSAAIaECcCBBEAqRAABA=='))
  check('jupiter: decodes the swap instruction arguments', jArgs.kind === 'shared_accounts_route_v2' && jArgs.inAmount === 25_000_000n && jArgs.slippageBps === 75 && jArgs.platformFeeBps === 0, JSON.stringify({ k: jArgs.kind, s: jArgs.slippageBps }))
  const jWire = jupAssemble({ taker: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', instructions: [{ programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', accounts: [{ pubkey: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', isSigner: true, isWritable: true }], data: '0ZhTk3z+2OkCQHh9AQAAAADp7kIOAAAAAEsAAAAAAAQAAAAm/AMABKEAAQAAAGsSAAIaECcCBBEAqRAABA==' }], computeUnitLimit: 200_000, computeUnitPrice: 1_000n, blockhash: '9sHcv6xwn9YkB8nxTUGKDwPwNnmqVp5oAXxU8Fdkm4J6', lastValidBlockHeight: 100, addressesByLookupTableAddress: {} })
  check('jupiter: assembles a v0 transaction (@solana/kit under Hermes)', typeof jWire === 'string' && jupFromBase64(jWire)[0] === 1 && (jupFromBase64(jWire)[65] & 0x80) === 0x80, String(jWire.length))
  await tolerates(check, 'jupiter: getQuote dry (network)', () => jup.getQuote({ sourceChain: 'solana:mainnet', sourceToken: 'SOL', destChain: 'solana:mainnet', destToken: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', amountIn: '100000000', destAddress: '', dry: true }))
  const fynd = fyndProvider({ apiKey: 'smoke' })
  check('fynd: same-chain routes on Base only', fynd.supportsRoute({ chain: 'eip155:8453', token: 'USDC' }, { chain: 'eip155:8453', token: '0x4200000000000000000000000000000000000006' }) && !fynd.supportsRoute({ chain: 'eip155:8453', token: 'USDC' }, { chain: 'eip155:1', token: 'USDC' }))
  const fyndFee = { clientFeeBps: 0, clientFeeReceiver: '0x0000000000000000000000000000000000000000', maxClientContribution: 0n, deadline: 0n, clientSignature: '0x' } as const
  const fyndData = encodeFunctionData({ abi: TYCHO_ROUTER_ABI, functionName: 'splitSwap', args: [10n ** 9n, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', '0x4200000000000000000000000000000000000006', 4n * 10n ** 17n, 39n * 10n ** 16n, 3n, '0x000000000000000000000000000000000000dEaD', fyndFee as never, '0xbeef'] })
  const fyndExpected = { chainId: 8453, tokenIn: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', tokenOut: '0x4200000000000000000000000000000000000006', amountIn: 10n ** 9n, receiver: '0x000000000000000000000000000000000000dEaD', expectedAmountOut: 4n * 10n ** 17n, minAmountOut: 39n * 10n ** 16n }
  check('fynd: checks the Tycho router calldata (viem decode under Hermes)', checkFyndTransaction({ to: FYND_CHAINS[8453]!.router, value: 0n, data: fyndData }, fyndExpected).method === 'splitSwap')
  let fyndRefused = false
  try { checkFyndTransaction({ to: FYND_CHAINS[8453]!.router, value: 0n, data: fyndData }, { ...fyndExpected, receiver: '0x1111111111111111111111111111111111111111' }) } catch { fyndRefused = true }
  check('fynd: refuses calldata paying someone else', fyndRefused)
  {
    // Curve Router NG: both ABI families encode and decode the explicit-receiver exchange; recorded live quotes pass the
    // client check (shipped deployments + allowlist, catalog-only hops between pools) and fail once they pay someone else.
    const dead = '0x000000000000000000000000000000000000dEaD'
    const curve = curveProvider({ rpcUrls: { 1: ['https://rpc.invalid'] }, onWarning: () => {} })
    check('curve: offers a chain with pools and an RPC, not one without pools', curve.supportsChain('eip155:1') && !curve.supportsChain('eip155:56'))
    for (const chainId of [1, 143] as const) {
      const d = CURVE_DEPLOYMENTS[chainId]!
      const pool = CURVE_POOLS[chainId]!.pools.find((p) => p.swapTypes.includes(1))!
      const route = findRoutes(chainId, d, CURVE_POOLS[chainId], pool.coins[0]!, pool.coins[1]!).routes[0]!
      const args = routeArgs(d.family, route)
      const data = encodeExchange(d.family, args, 10n ** 21n, 999n * 10n ** 18n, dead)
      const back = decodeExchange(d.family, data)
      check(`curve: ${d.family} exchange encodes and decodes (${pool.name})`, data.slice(0, 10) === EXCHANGE_SELECTOR[d.family] && !!back && back.amount === 10n ** 21n && back.minDy === 999n * 10n ** 18n
        && back.receiver?.toLowerCase() === dead.toLowerCase() && back.route.every((a, i) => a.toLowerCase() === args.route[i]!.toLowerCase())
        && back.params.every((row, k) => row.length === args.params[k]!.length && row.every((x, c) => x === args.params[k]![c])))
    }
    const recorded = curveQuotesLive as unknown as { label: string; params: Parameters<typeof curveVerifyQuote>[0]; quote: Parameters<typeof curveVerifyQuote>[1] }[]
    for (const r of recorded) check(`curve: recorded quote passes curveVerifyQuote (${r.label})`, curveVerifyQuote(r.params, r.quote) === null)
    const r0 = recorded[0]!
    const fam = CURVE_DEPLOYMENTS[1]!.family
    const call = decodeExchange(fam, r0.quote.txRequest!.data!)!
    const elsewhere = { ...r0.quote, txRequest: { ...r0.quote.txRequest!, data: encodeExchange(fam, call, call.amount, call.minDy, '0x1111111111111111111111111111111111111111') } }
    check('curve: refuses the recorded quote paying someone else', /not the recipient/.test(curveVerifyQuote(r0.params, elsewhere) ?? ''))
    check('curve: a swap2 server token on the intent id passes; one id for the whole chain does not',
      curveVerifyQuote(r0.params, { ...r0.quote, intentId: `${r0.quote.intentId}~${'ab'.repeat(16)}` }) === null
      && /not a curve:1 swap/.test(curveVerifyQuote(r0.params, { ...r0.quote, intentId: 'curve:1' }) ?? ''))
    const cp = new CurveSwap2Protocol(evm, { ...swap2Cfg, rpcUrls: { 1: ['https://rpc.invalid'] } })
    check('curve: CurveSwap2Protocol constructs', typeof cp.quoteSwap2 === 'function')
    await tolerates(check, 'curve: getSupportedChains', () => cp.getSupportedChains())
  }
  {
    // Relay: the order id is our own EIP-712 hashStruct and the solver signature is recovered here (keccak + secp256k1
    // recovery on Hermes); recorded live quotes pass the whole on-device check and fail once the order pays someone else.
    const solver = RELAY_SOLVERS[0]!.address
    const vectors = relayVectors as unknown as { label: string; orderId: string; orderSignature?: string; orderData: unknown }[]
    check(`relay: order hash vectors (${vectors.length})`, vectors.length >= 4 && vectors.every((v) => relayOrderId(parseRelayOrder(v.orderData)) === v.orderId))
    check('relay: solver signature recovers to the pinned signer', vectors.filter((v) => v.orderSignature).length > 0
      && vectors.filter((v) => v.orderSignature).every((v) => relayOrderSigner(v.orderId as `0x${string}`, v.orderSignature) === solver))
    type Recorded = { request: { sourceChain: string; destChain: string; sourceToken: string; destToken: string; amount: string; depositor: string; recipient: string; nowMs: number }
      response: { steps: { id: string; items: { data: { to: string; data: string; value: string; chainId: number } }[] }[]; protocol: { v2: Parameters<typeof verifyRelayOrder>[1] } } }
    for (const [label, raw] of [['Arbitrum USDC → Base USDC', relayUsdcLive], ['Base ETH → Arbitrum ETH', relayNativeLive]] as const) {
      const f = raw as unknown as Recorded
      const request = { ...f.request, amount: BigInt(f.request.amount) }
      const offered = f.response.steps.find((x) => x.id === 'deposit')!.items[0]!.data
      const ok = verifyRelayOrder(request, f.response.protocol.v2, offered)
      check(`relay: recorded quote passes the on-device check and the deposit is rebuilt byte for byte (${label})`, ok.deposit.data.toLowerCase() === offered.data.toLowerCase() && ok.deposit.to.toLowerCase() === offered.to.toLowerCase())
      let code = ''
      try { verifyRelayOrder({ ...request, recipient: '0x000000000000000000000000000000000000dEaD' }, f.response.protocol.v2, offered) } catch (e) { code = e instanceof RelayRefusal ? e.code : 'other' }
      check(`relay: refuses the recorded order for another recipient (${label})`, code === 'output-recipient')
    }
    const relay = relayProvider()
    check('relay: pinned EVM chains only', relay.supportsChain('eip155:42161') && relay.supportsChain('eip155:99901') && !relay.supportsChain('eip155:14') && !relay.supportsChain('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'))
    const rp = new RelaySwap2Protocol(evm, { ...swap2Cfg })
    check('relay: RelaySwap2Protocol constructs', typeof rp.quoteSwap2 === 'function')
  }
  check('cctp: claimSwap2 on the router', typeof (router as unknown as { claimSwap2?: unknown }).claimSwap2 === 'function')

  // lending
  const mellow = new (MellowProtocolEvm as never as new (a: unknown, c?: unknown) => { quoteSupply(o: unknown): Promise<unknown> })(evm, { preset: 'lido-earn-eth' })
  await tolerates(check, 'mellow: quoteSupply', () => mellow.quoteSupply({ token: toAsset('0x0000000000000000000000000000000000000000'), amount: 1n }))
  check('mellow: toAsset', typeof toAsset('0xdAC17F958D2ee523a2206206994597C13D831ec7') === 'string')
  const aave = new AaveProtocolEvm(evm, { chainId: 1 })
  check('aave: constructs from the preset', aave.addressesProvider === AAVE_MARKETS[1]!.core!.addressesProvider)
  await tolerates(check, 'aave: getMarket (no provider → NetworkError)', () => aave.getMarket())
  const cfg = parseReserveConfiguration((7500n) | (7800n << 16n) | (6n << 48n) | (1n << 56n) | (1n << 58n))
  check('aave: parseReserveConfiguration', cfg.ltv === 0.75 && cfg.decimals === 6 && cfg.active && cfg.borrowingEnabled)
  // Engine BigInt → Number is known-bad on some Hermes builds (Linux x64: Number(2n ** 64n) = 3·2^64),
  // so the SDK converts through core's bigintToNumber. The raw engine results are printed for the
  // record; the gate is the helper.
  const big = 4n * 10n ** 25n
  check(`aave: bigint ** and * (${big.toString()})`, big.toString() === '40000000000000000000000000' && big === 40000000000000000000000000n)
  note(`engine Number(bigint): 2^53 → ${Number(2n ** 53n)}, 2^64 → ${Number(2n ** 64n)}, 1e19 → ${Number(10n ** 19n)}, 4e25 → ${Number(big)}`)
  check(`core: bigintToNumber(2^53) (${bigintToNumber(2n ** 53n)})`, bigintToNumber(2n ** 53n) === 9007199254740992)
  check(`core: bigintToNumber(2^64) (${bigintToNumber(2n ** 64n)})`, bigintToNumber(2n ** 64n) === 18446744073709551616)
  check(`core: bigintToNumber(4e25) (${bigintToNumber(big)})`, bigintToNumber(big) === 4e25)
  check(`core: bigintToNumber(-4e25) (${bigintToNumber(-big)})`, bigintToNumber(-big) === -4e25)
  check(`core: bigintToNumber(uint256.max) (${bigintToNumber((1n << 256n) - 1n)})`, Math.abs(bigintToNumber((1n << 256n) - 1n) / 1.157920892373162e77 - 1) < 1e-12)
  check(`core: bigintToUnits(1e20, 18) (${bigintToUnits(10n ** 20n, 18)})`, bigintToUnits(10n ** 20n, 18) === 100)
  const perSec = 0.04 / 31_536_000
  const l = Math.log1p(perSec), e = Math.expm1(0.04)
  check(`aave: log1p(${perSec}) (${l})`, Math.abs(l / perSec - 1) < 1e-6)
  check(`aave: expm1(0.04) (${e})`, Math.abs(e - 0.0408107742) < 1e-8)
  const apy = rayToApyPct(4n * 10n ** 25n)
  check(`aave: rayToApyPct (${apy.toFixed(4)} ≈ 4.081)`, Math.abs(apy - 4.081) < 0.01)
  {
    // Curve Savings crvUSD: constructs over the pinned vault, builds deposit / max_loss-0 redeem calldata, APR maths on
    // live-sized bigints (profitUnlockingRate ~2.6e28, totalSupply ~1.3e25), the API band, the host allowlist, activity.
    const dead = '0x000000000000000000000000000000000000dEaD'
    const scrv = new ScrvUsdProtocolEvm(evm)
    check('scrvUSD: constructs on Ethereum', typeof scrv.supply === 'function' && SCRVUSD.vault === '0x0655977FEb2f289A4aB78af67BAB0d17aAb84367')
    await tolerates(check, 'scrvUSD: quoteSupply (no provider → refused before any write)', () => scrv.quoteSupply({ amount: 10n ** 21n }))
    const dep = encodeFunctionData({ abi: VAULT_V3_ABI, functionName: 'deposit', args: [10n ** 21n, dead] })
    const red = encodeFunctionData({ abi: VAULT_V3_ABI, functionName: 'redeem', args: [10n ** 21n, dead, dead, 0n] })
    check('scrvUSD: deposit and redeem(max_loss 0) calldata', dep.slice(0, 10) === '0x6e553f65' && red.slice(0, 10) === '0x9f40a7b3' && red.endsWith('0'.repeat(64)) && red.length === 10 + 4 * 64)
    const aprWad = scrvUsdAprWad({ profitUnlockingRate: 26n * 10n ** 27n, totalSupply: 13n * 10n ** 24n, fullProfitUnlockDate: 2_000_000_000n, now: 1_800_000_000n })
    const sApy = aprWadToApyPct(aprWad)
    check(`scrvUSD: APR / APY from live-sized bigints (${aprWad} → ${sApy.toFixed(4)} %)`, aprWad === 63072000000000000n && Math.abs(sApy - 6.5103) < 0.001)
    check('scrvUSD: the API figure within the band stands; after the unlock it is clamped to 0.5 %', clampApy(6.2769, 6.273).source === 'api' && clampApy(6.3, 0).apy === 0.5 && clampApy(6.3, 0).source === 'api-clamped' && clampApy(null, 6.27).source === 'chain')
    let fiRefused = false
    try { assertCurveHost('https://prices.curve.fi/v1/crvusd/savings/statistics') } catch { fiRefused = true }
    check('scrvUSD: API host allowlist (curve.finance yes, curve.fi no)', fiRefused && typeof assertCurveHost('https://prices.curve.finance') === 'string')
    const { tx: sTx, own: sOwn } = parseActivityFixture(scrvUsdDepositLive as unknown as ActivityFixtureJson)
    check('scrvUSD: describeActivity on a recorded deposit', describeCurveLendingActivity(sTx, { own: sOwn })?.kind === 'supply')
  }
  const mv = new MorphoVaultProtocolEvm(evm, { chainId: 1, vault: '0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB', api: null })
  await tolerates(check, 'morpho vault: getVault (no provider → NetworkError)', () => mv.getVault())
  const mm = new MorphoMarketProtocolEvm(evm, { chainId: 1, market: { loanToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', collateralToken: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', oracle: '0x663BECd10daE6C4A3Dcd89F1d76c1174199639B9', irm: '0x46415998764C29aB2a25CbeA6254146D50D22687', lltv: 860000000000000000n }, api: null })
  check('morpho market: id from params (keccak)', mm.id === '0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836' && MORPHO_CHAINS[1]!.morpho.startsWith('0xBBBB'))
  check('morpho: marketId helper', typeof marketId === 'function' && accrue({ totalSupplyAssets: 10n, totalSupplyShares: 10n, totalBorrowAssets: 5n, totalBorrowShares: 5n, lastUpdate: 0n, fee: 0n }, 0n, 10n).lastUpdate === 10n)
  const solAcc = createMockAccount({ chain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', address: 'KUMtRazMP7vwvc2kthnGZ9Cq6ZsGRiYC97snMYepNx9' })
  const kv = new KaminoVaultProtocolSolana(solAcc, { vault: 'HDsayqAsDWy3QvANGqh2yNraqcD8Fnjgh73Mhb3WRS5E' })
  check('kamino vault: constructs', kv.vault === 'HDsayqAsDWy3QvANGqh2yNraqcD8Fnjgh73Mhb3WRS5E' && typeof kv.supply === 'function')
  await tolerates(check, 'kamino vault: getVault (API fetch)', () => kv.getVault())
  const km = new KaminoMarketProtocolSolana(solAcc)
  check('kamino market: Main Market by default', km.market === MAIN_MARKET)
  check('kamino: decimal strings', toDecimalString(1_500_000n, 6) === '1.5' && fromDecimalString('1.0627800342202071868', 6) === 1_062_780n && fromDecimalString('4.66e-16', 9) === 0n)
  // native staking: seed derivation (sha256, no WebCrypto) and the bigint warm-up math run in Hermes; reads over an offline provider
  check('native stake: create_with_seed (mainnet vector)', nativeCreateWithSeed('9bhvajVaz6ECMoa93J8p699zkrrH14hoTN1EcPVd1Pzp', 'jup:mvo9aw5k:83ed053d:0', NATIVE_STAKE_PROGRAM) === '2wv6Sys5aZyECZm94KVygYzxVQyKi9egorRBAoVEZyS9')
  const warm = nativeActivation({ voter: 'v', stake: 50n, activationEpoch: 10n, deactivationEpoch: 0xffff_ffff_ffff_ffffn }, 12n, new Map([[10n, { effective: 100n, activating: 100n, deactivating: 0n }], [11n, { effective: 109n, activating: 91n, deactivating: 0n }]]), 0n)
  check('native stake: warm-up math (bigint)', warm.effective === 8n && warm.activating === 42n, `${warm.effective}/${warm.activating}`)
  const stakeBlob = Uint8Array.from(Buffer.from('AgAAAIDVIgAAAAAAf8GEAGLL6VQQ1OKW6eB1dElnCVXJG+hd4QKC9tB5S/F/wYQAYsvpVBDU4pbp4HV0SWcJVckb6F3hAoL20HlL8QAAAAAAAAAAAAAAAAAAAAB/wYQAYsvpVBDU4pbp4HV0SWcJVckb6F3hAoL20HlL8awfg/25zlUN6V1VjNx5VGHM9DdKxojsE6mEACIKeNoGACPSDAMAAAAsBAAAAAAAAP//////////AAAAAAAAAACcVzmLFQUAAAAAAAA=', 'base64'))
  const decoded = nativeDecodeStake(stakeBlob)
  check('native stake: decodes a mainnet stake account', decoded.delegation?.stake === 13_100_000_000n && decoded.delegation?.voter === 'CatzoSMUkTRidT5DwBxAC2pEtnwMBTpkCepHkFgZDiqb')
  const offline = { request: async (method: string) => { if (method === 'getEpochInfo') return { epoch: 1068, slotIndex: 1, slotsInEpoch: 432000 }; throw new Error(`offline: ${method}`) } }
  const native = new NativeStakingProtocolSolana(solAcc, { validators: ['CatzoSMUkTRidT5DwBxAC2pEtnwMBTpkCepHkFgZDiqb'], provider: offline })
  check('native stake: epoch clock over a { request } provider', (await native.getEpochInfo()).epoch === 1068n)
  await tolerates(check, 'native stake: getStakeAccounts (offline → Error)', () => native.getStakeAccounts())
  await tolerates(check, 'native stake: quoteStake (offline → Error)', () => native.quoteStake({ amount: 1_000_000_000n }))
  // native Monad staking: id packing and commission math (bigint), revert mapping, and a read through viem over an offline EIP-1193 provider
  const packed = monadPack(300n, 7)
  check('native monad: withdrawal id packing (bigint)', packed === 300n * 256n + 7n && monadUnpack(packed).validatorId === 300n && monadUnpack(packed).withdrawId === 7)
  check('native monad: commission 1e18 → percent', monadCommission(15n * 10n ** 16n) === 15)
  check('native monad: revert in plain words', /not ready yet/.test(monadRevert(new Error('execution reverted: withdrawal not ready')).message))
  const epochResult = encodeFunctionResult({ abi: MONAD_STAKING_ABI, functionName: 'getEpoch', result: [2332n, false] })
  const monadOffline = { request: async ({ method }: { method: string }) => { if (method === 'eth_chainId') return '0x8f'; if (method === 'eth_call') return epochResult; throw new Error(`offline: ${method}`) } }
  const monadAcc = createMockAccount({ chain: 'eip155:143', address: '0x000000000000000000000000000000000000dEaD' })
  const monad = new NativeStakingProtocolMonad(monadAcc, { validators: [97n], provider: monadOffline })
  const monadEpoch = await monad.getEpoch()
  check('native monad: getEpoch over viem + EIP-1193', monadEpoch.epoch === 2332n && monadEpoch.activatesAtEpoch === 2333n)
  await tolerates(check, 'native monad: quoteStake (offline → Error)', () => monad.quoteStake({ amount: 10n ** 18n }))
  {
    // NEAR staking: the local pool-id verdict, sha256 request ids as u64 and the APR / share maths on 10^24-scale bigints, the
    // epoch clock over an offline NEAR transport (validators + block), a foreign contract refused with no RPC call, the liquid
    // plan guard, and recorded mainnet stakes (native and rNEAR) described.
    const NEAR = 10n ** 24n
    check('native near: pool factory by suffix, local', nearFactoryOf('astro-stakers.poolv1.near', 'mainnet') === 'poolv1' && nearFactoryOf('aurora.pool.near', 'mainnet') === 'pool'
      && nearFactoryOf('lst-pool.near', 'mainnet') === null && nearFactoryOf('a.b.poolv1.near', 'mainnet') === null)
    check('native near: poolRequestId (sha256 → u64, live vector)', nearPoolRequestId('astro-stakers.poolv1.near') === 13507970402022783992n)
    const nearApr = nearAnnualize(1350n * NEAR, 33_000_000n * NEAR, 24_840_000)
    check(`native near: reward ÷ stake annualized in bigint fixed point (${nearApr})`, Math.abs(nearApr - 5.197233201580913) < 1e-9)
    const START = 223_574_400
    let nearCalls = 0
    const nearOffline = async (method: string, params: unknown) => {
      nearCalls++
      if (method === 'validators') return { epoch_height: 4948, epoch_start_height: START, current_validators: [], next_validators: [], validator_reward_paid_prev_epoch: {} }
      if (method === 'block') {
        const height = (params as { block_id?: number }).block_id ?? START + 40_000
        return { header: { height, epoch_id: 'e', timestamp_nanosec: String(BigInt(1_794_000_000_000 + (height - START) * 575) * 1_000_000n) } }
      }
      throw new Error(`offline: ${method}`)
    }
    const nearAcc = createMockAccount({ chain: 'near:mainnet', address: 'alice.near' })
    const nativeNear = new NativeStakingProtocolNear(nearAcc, { pools: ['astro-stakers.poolv1.near'], provider: nearOffline })
    const nearEpoch = await nativeNear.getEpoch()
    check('native near: epoch clock over a NEAR transport', nearEpoch.height === 4948n && nearEpoch.epochMs === 24_840_000 && nearEpoch.blocksLeft === 3_200n, `${nearEpoch.height}/${nearEpoch.epochMs}/${nearEpoch.blocksLeft}`)
    const before = nearCalls
    const foreign = await nativeNear.getPool('lst-pool.near')
    check('native near: a foreign contract is refused with no RPC call', !foreign.eligible && foreign.refusals.includes('not-factory-pool') && nearCalls === before)
    await tolerates(check, 'native near: quoteStake (offline → Error)', () => nativeNear.quoteStake({ amount: NEAR }))
    const { tx: nsTx, own: nsOwn } = parseActivityFixture(nearStakeLive as unknown as ActivityFixtureJson)
    const nsItem = describeNativeNearStakingActivity(nsTx, { own: nsOwn })
    check('native near: describeActivity on a recorded deposit_and_stake', nsItem?.kind === 'stake' && nsItem.assetsOut[0]?.amount === 1_280_210n * 10n ** 21n)

    check('liquid near: presets pinned per network (rNEAR mainnet only)', liquidResolvePool('rnear', 'mainnet').contract === 'lst.rhealab.near' && liquidResolvePool('linear', 'testnet').contract === 'linear-protocol.testnet'
      && (() => { try { liquidResolvePool('rnear', 'testnet'); return false } catch (e) { return (e as { code?: string }).code === 'unsupported-network' } })())
    const totals = { totalStaked: 18_798_398_837_425_000_000_000_000_000_000n, totalShares: 17_593_656_000_000_000_000_000_000_000_000n }
    const minted = sharesForNear(NEAR, totals)
    check(`liquid near: share maths rounds down like the contract (${minted})`, minted === 935_912_475_959_041_553_434_480n && nearForShares(minted, totals) === NEAR - 1n)
    const lstApr = aprFromPrices(NEAR, NEAR + 9n * 10n ** 20n, 0, 7 * 86_400_000)
    check(`liquid near: APR from the price in 10^12 fixed point (${lstApr})`, Math.abs(lstApr - 4.696071428571) < 1e-9)
    let ftRefused = false
    try { assertLiquidPlan([{ receiverId: 'lst.rhealab.near', actions: [liquidFc('ft_transfer_call', { receiver_id: 'lst.rhealab.near', amount: '1', msg: '' }, 30n * 10n ** 12n, 1n)] }], 'lst.rhealab.near') } catch { ftRefused = true }
    check('liquid near: the plan guard refuses ft_transfer_call into the contract', ftRefused)
    const rnear = new LiquidStakingProtocolNear(nearAcc, { pool: 'rnear', provider: nearOffline })
    const lstEpoch = await rnear.getEpoch()
    check('liquid near: epoch clock over a NEAR transport', lstEpoch.height === 4948n && lstEpoch.epochMs === 24_840_000)
    await tolerates(check, 'liquid near: quoteStake (offline → Error)', () => rnear.quoteStake({ amount: NEAR }))
    const { tx: lsTx, own: lsOwn } = parseActivityFixture(rnearStakeLive as unknown as ActivityFixtureJson)
    const lsItem = describeLiquidNearStakingActivity(lsTx, { own: lsOwn })
    check('liquid near: describeActivity on a recorded rNEAR stake', lsItem?.kind === 'stake' && lsItem.assetsIn[0]?.amount === 1_534_909_765_973_083_758_154_606n && lsItem.assetsIn[0]?.symbol === 'rNEAR')
  }
  check('kamino: instructionName', instructionName(KLEND_PROGRAM, Uint8Array.from([0xd8, 0xe0, 0xbf, 0x1b, 0xcc, 0x97, 0x66, 0xaf, 0])) === 'depositReserveLiquidityAndObligationCollateralV2')
  // Kamino chain reads (scan 2026-10-27 modules, G2): u64 / u128 / u256 fields out of account bytes, the vault's share price
  // and a debt with interest — all bigint, the u128 and u256 values above 2^64 — plus the farm PDA (live vector) and the rule check.
  const SF = 1n << 60n
  const kamAcc = (owner: string, disc: string, size: number, fill: (v: DataView) => void) => {
    const data = new Uint8Array(size)
    for (let i = 0; i < 8; i++) data[i] = parseInt(disc.slice(i * 2, i * 2 + 2), 16)
    const v = new DataView(data.buffer)
    fill(v)
    return { owner, lamports: 1n, data }
  }
  const u128 = (v: DataView, o: number, x: bigint) => { v.setBigUint64(o, x & 0xffff_ffff_ffff_ffffn, true); v.setBigUint64(o + 8, x >> 64n, true) }
  const vaultBytes = kamAcc(KVAULT_PROGRAM, 'e4c452a562d2eb98', 62_552, (v) => {
    v.setBigUint64(112, 6n, true); v.setBigUint64(216, 6n, true); v.setBigUint64(224, 500n, true); v.setBigUint64(232, 1000n, true)
    for (let i = 0; i < 32; i++) v.setUint8(312 + i, 7)
    v.setBigUint64(312 + 1104, 1000n, true)
  })
  const kVault = decodeVault('HDsayqAsDWy3QvANGqh2yNraqcD8Fnjgh73Mhb3WRS5E', vaultBytes)
  const kReserveAddr = kVault.allocations[0]!.reserve
  const kReserve = decodeReserve(kReserveAddr, kamAcc(KLEND_PROGRAM, '2bf2ccca1af73b7f', 8_624, (v) => {
    v.setBigUint64(224, 3000n, true); u128(v, 232, 1000n * SF); v.setBigUint64(272, 6n, true); u128(v, 296, (3n * SF) / 2n); v.setBigUint64(2592, 2000n, true)
  }))
  const kTps = vaultTokensPerShareWad(kVault, new Map([[kReserveAddr, kReserve]]))
  check(`kamino: vault share price from chain bytes (${kTps})`, kTps === 25n * 10n ** 17n && kReserve.totalLiquiditySf === 4000n * SF)
  const kOb = decodeObligation('EnxJnydiZPsyQx2ZmXdg7vfggsRLQWpogz19cP6R9SPb', kamAcc(KLEND_PROGRAM, 'a8ce8d6a584caca7', 3_344, (v) => {
    for (let i = 0; i < 32; i++) v.setUint8(1208 + i, 7)
    u128(v, 1208 + 32, SF); u128(v, 1208 + 88, 1000n * SF)
  }))
  check(`kamino: debt with the reserve's borrow rate (u256) (${debtNow(kOb, kReserve, kReserveAddr)})`, debtNow(kOb, kReserve, kReserveAddr) === 1500n)
  check('kamino: farm user-state PDA (live vector)', farmUserState('9FVjHqduhDPMVqvu3cXiEBjU6nvxvGdCCLRwd9WpVRZj', 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk') === '3QZ4o2qDKytc2uq1Gs3wV5xD2241MWNC7t7SUSKfUu36')
  const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
  const wsolAta = associatedTokenAddress('HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk', 'So11111111111111111111111111111111111111112', TOKEN)
  const rules = plumbing('HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk', wsolAta)
  const sync = (account: string, data: Uint8Array) => unexpectedInstruction({ instructions: [{ programAddressIndex: 0, accountIndices: [1], data }] }, [{ address: TOKEN }, { address: account }], rules)
  // swap2 TON cell-body gate (scan 2026-10-27 modules, G5): friendly/raw TON addresses compared without Buffer or @ton/core (base64 + CRC16 by hand).
  check('swap2: tonRawAddress (friendly, raw, bad checksum)', tonRawAddress('UQCbXJ1-Hd_CyyAt3TNgircduNIn5QH5dj1_LBNz__y4fQaq') === tonRawAddress('EQCbXJ1-Hd_CyyAt3TNgircduNIn5QH5dj1_LBNz__y4fVtv') && tonRawAddress('UQCbXJ1-Hd_CyyAt3TNgircduNIn5QH5dj1_LBNz__y4fQaq') === '0:9b5c9d7e1ddfc2cb202ddd33608ab71db8d227e501f9763d7f2c1373fffcb87d' && tonRawAddress('UQCbXJ1-Hd_CyyAt3TNgircduNIn5QH5dj1_LBNz__y4fQab') === null)
  check('wallet-solana: instruction rules (SyncNative on our wSOL only)', sync(wsolAta, Uint8Array.of(0x11)) === undefined && sync('Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS', Uint8Array.of(0x11))?.index === 0 && sync(wsolAta, Uint8Array.of(0x03))?.index === 0)

  // approvals
  const approvals = new (ApprovalsProtocolEvm as never as new (a: unknown, c?: unknown) => { getSupportedStandards(): Promise<unknown> })(evm, {})
  await tolerates(check, 'approvals: getSupportedStandards', () => approvals.getSupportedStandards())
  {
    // scan 2026-10-27 modules F34: redactUrls is linear on Hermes too (the regex it replaced was quadratic on "a.a.a…")
    const t0 = Date.now()
    const out = redactUrls('a.'.repeat(32_768) + ' https://rpc.example/v2/KEY')
    check('swap2: redactUrls linear on 64 KB', Date.now() - t0 < 1_000 && out.endsWith(' <url>') && !out.includes('KEY'))
  }
  {
    // CS-13: refusal reasons ride on the error without changing its class or text; Retry-After dates are read by hand (no Date.parse).
    const e = refusal('rate_limited', 'lifi: 429', { retryAfterMs: 2000, httpStatus: 429 })
    const sim = Object.assign(new Error('simulation failed'), { reason: 'execution reverted' })
    withReason(sim, 'simulation_failed')
    const wrapped = new Error('outer', { cause: e })
    const now = Date.UTC(2026, 10, 13, 12, 0, 0)
    const quoteError = new Swap2QuoteError('swap2: no route available for the requested pair', { ...combinedRefusal([{ message: 'a', reason: 'amount_too_small' }, { message: 'b', reason: 'amount_too_small' }]) })
    const notes = refusalNotes(1)
    notes.note('lifi: recipient differs', 'recipient_mismatch')
    notes.note('lifi: vault moved', 'vault_mismatch')
    check('swap2: refusal reasons (plain Error, cause chain, foreign reason kept, 17 frozen, bounded notes)',
      notes.reasonOf('lifi: recipient differs') === undefined && notes.reasonOf('lifi: vault moved')?.reason === 'vault_mismatch' &&
      e.constructor === Error && e.message === 'lifi: 429' && refusalOf(wrapped)?.retryAfterMs === 2000 && sim.reason === 'execution reverted' && refusalOf(sim) === undefined &&
      SWAP2_REFUSAL_REASONS.length === 17 && Object.isFrozen(SWAP2_REFUSAL_REASONS) && quoteError.reason === 'amount_too_small' && quoteError.code === 'QUOTE',
      JSON.stringify({ r: refusalOf(wrapped), sim: sim.reason, q: quoteError.reason }))
    check('swap2: httpRefusal / parseRetryAfter (seconds, IMF-fixdate)',
      httpRefusal(429, 'Fri, 13 Nov 2026 12:00:30 GMT', now)?.retryAfterMs === 30_000 && parseRetryAfter('120', now) === 120_000 && parseRetryAfter('2026-11-13T12:00:30Z', now) === undefined &&
      httpRefusal(503)?.reason === 'upstream_unavailable' && httpRefusal(401)?.reason === 'key_rejected' && httpRefusal(404) === undefined,
      JSON.stringify(httpRefusal(429, 'Fri, 13 Nov 2026 12:00:30 GMT', now)))
  }
  {
    // 2026-10-28: a remote TON → EVM Omniston order is checked on the device — the live escrow (USDT on TON → USDC on Base) passes, another destination does not.
    // 2026-11-12 (SDK-306): the default trusts the rev2 TON Escrow Minter only — its live escrow passes; the rev1 escrow of 2026-10-10 is refused.
    // An app that lists rev1 in trustedProtocolAddresses trusts it again for new builds (an explicit widening; old orders do not need it),
    // and the other checks still run: the same body for another recipient is refused.
    type EscrowFixture = { quoteUpdated: { inputUnits: string; outputAsset: { chain: { value: { kind: { value: string } } } }; settlementData: { value: { resolverSendsUnits: string } } }; escrowRequest: { ownerSrcAddress: { chain: { value: string } }; traderDstAddress: { chain: { value: string } } }; escrowResponse: { messages: Array<{ payload: string }> } }
    const expectationOf = (c: EscrowFixture) => ({
      payloadBocHex: c.escrowResponse.messages[0]!.payload, ownerAddress: c.escrowRequest.ownerSrcAddress.chain.value, inputUnits: c.quoteUpdated.inputUnits,
      destinationChain: 'eip155:8453', destinationAddress: c.escrowRequest.traderDstAddress.chain.value, outputTokenAddress: c.quoteUpdated.outputAsset.chain.value.kind.value,
      minResolverSendsUnits: c.quoteUpdated.settlementData.value.resolverSendsUnits,
    })
    const rev1 = (escrowLive as unknown as { baseUsdc: Omit<EscrowFixture, 'quoteUpdated'> & { quoteUpdated: { value: EscrowFixture['quoteUpdated'] } } }).baseUsdc
    const old = expectationOf({ ...rev1, quoteUpdated: rev1.quoteUpdated.value })
    const now = expectationOf((escrowRev2Live as unknown as { tonToEvm: EscrowFixture }).tonToEvm)
    const v = createOmnistonTonValidators()
    const withRev1 = createOmnistonTonValidators({ trustedProtocolAddresses: ['EQDybO88l2lrrAmALRUqpmgEE_tuxk510F4Yd4xjbQZxC9IA', 'EQAbWJ3Y1HgIIvcMq1prG1anlDC0T3cZlAU7luPT6LmTpmrZ'] })
    check('omniston: TON → EVM escrow verified on the device', v.verifyTonEscrowBuild(now) === null && v.verifyTonEscrowBuild({ ...now, destinationAddress: '0x' + '99'.repeat(20) }) !== null &&
      v.verifyTonEscrowBuild(old) !== null && withRev1.verifyTonEscrowBuild(old) === null && withRev1.verifyTonEscrowBuild({ ...old, destinationAddress: '0x' + '99'.repeat(20) }) !== null)
  }
  await smokeThorchainVaultRotation(check)

  {
    // 2026-11-13: the app's native-fee ceiling on the execution path (USDT0 Legacy Mesh Ethereum → Tron, eid 30420): the live
    // LayerZero fee + 25 % headroom (0.006676 ETH) passes the app's 0.01 ETH ceiling and reaches the review; without the hook
    // the 0.005 ETH default refuses it with the unchanged text; a garbage answer, a throw and a value above 20 × the default refuse.
    const OFT = '0x1F748c76dE468e9D11bd340fA9D5CBADf315dFB0'
    const FEE = 6_676_000_000_000_000n
    let sent = 0
    const mesh = (name: string) => ({
      name, enabled: () => true, supportsRoute: () => true,
      getQuote: async (params: { amountIn: string }) => ({
        provider: name, intentId: 'usdt0-mesh:30101:30420', depositAddress: '', depositMemo: null,
        txRequest: { to: OFT, data: '0xc7c7f5b3', value: FEE.toString(), chainId: 1, gasLimit: '400000', approvalAddress: OFT, nativeFee: FEE.toString() },
        sourceAmount: params.amountIn, destAmount: '9997000', minDestAmount: '9997000', feeUsd: 0, etaSeconds: 120, reliability: 1, validUntilMs: Date.now() + 60_000,
      }),
      buildDeposit: async () => ({ chain: 'eip155:1', to: OFT, data: '0xc7c7f5b3', value: FEE.toString(), chainId: 1, gasLimit: '400000', approvalAddress: OFT }),
      trackIntent: async () => ({ state: 'pending' as const }),
    })
    const payer = {
      getAddress: async () => '0x4444444444444444444444444444444444444444', getChainId: async () => 1, getAllowance: async () => 0n,
      sendTransaction: async () => { sent += 1; return { hash: '0x1' } },
    }
    const TRON_MESH = new Map([['eip155:1', 10n ** 16n], ['eip155:42161', 10n ** 16n], ['eip155:42220', 300n * 10n ** 18n]])
    const tronMesh = ({ provider, intentId, fromChain, destChain }: { provider: string; intentId: string; fromChain: string; destChain: string }) =>
      provider === 'usdt0' && destChain === 'tron:728126428' && /^usdt0-mesh:\d+:30420(?:~|$)/.test(intentId) ? TRON_MESH.get(fromChain) : undefined
    const attempt = async (name: string, nativeFeeCeiling?: unknown): Promise<string> => {
      const p = new RouterSwap2Protocol(payer, {
        fromChain: 'eip155:1', providers: [mesh(name) as never],
        reviewExecution: (plan) => { throw new Error(`review ${String((plan.source as { value?: bigint }).value)}`) },
        ...(nativeFeeCeiling !== undefined ? { nativeFeeCeiling: nativeFeeCeiling as never } : {}),
      })
      try {
        await p.swap2({ fromToken: 'USDT', toToken: 'USDT', toChain: 'tron:0x2b6653dc', recipient: 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8', fromTokenAmount: 10_000_000n, minAmountOut: 9_997_000n })
        return 'resolved'
      } catch (e) { return e instanceof Error ? `${e.name}: ${e.message}` : String(e) }
    }
    const allowed = await attempt('usdt0', tronMesh)
    check('swap2: nativeFeeCeiling lets USDT0 mesh → Tron through at 0.006676 ETH (0.01 ETH app ceiling)', allowed === `Error: review ${FEE}`, allowed)
    const plain = await attempt('usdt0')
    check('swap2: no nativeFeeCeiling → the 0.005 ETH default refuses it (unchanged text)', plain === 'Error: swap2: quoted native fee 6676000000000000 exceeds the cap 5000000000000000 for eip155:1', plain)
    const other = await attempt('copycat', tronMesh)
    check('swap2: nativeFeeCeiling for usdt0 only — another provider keeps the default', /exceeds the cap 5000000000000000 for eip155:1$/.test(other), other)
    const garbage = await attempt('usdt0', () => 0.01)
    const thrown = await attempt('usdt0', () => { throw new Error('table missing') })
    const tooHigh = await attempt('usdt0', () => 10n ** 17n + 1n)
    check('swap2: nativeFeeCeiling garbage / throw / above 20 × the default refuse (Swap2ConfigurationError)',
      garbage === 'Swap2ConfigurationError: swap2: nativeFeeCeiling returned the number 0.01 for usdt0 eip155:1 → tron:728126428, not a non-negative bigint or undefined — the native fee is refused'
      && thrown === 'Swap2ConfigurationError: swap2: nativeFeeCeiling threw for usdt0 eip155:1 → tron:728126428 (table missing) — the native fee is refused'
      && tooHigh === 'Swap2ConfigurationError: swap2: nativeFeeCeiling returned 100000000000000001 for usdt0 eip155:1 → tron:728126428, above the hard maximum 100000000000000000 (20 × the default cap 5000000000000000) — the native fee is refused',
      `${garbage} | ${thrown} | ${tooHigh}`)
    check('swap2: nativeFeeCeiling runs — nothing signed in any of them', sent === 0, String(sent))
  }
  check('approvals: isRevokeCalldata', isRevokeCalldata('0x095ea7b3' + '0'.repeat(24) + 'beef'.padStart(40, '0') + '0'.repeat(64)) === true)
  check('approvals: isUnlimitedAmount', isUnlimitedAmount((1n << 256n) - 1n) === true && isUnlimitedAmount(5n) === false)
}

/**
 * CS-9 (2026-11-12): THORChain's second-node vault check on Hermes — the confirming node accepts any ActiveVault of
 * its asgard list (the inbound rotates), a node more than 50 blocks behind or slower than its per-node timeout
 * (AbortController + setTimeout, no AbortSignal.timeout/any) is skipped for the next one, a RetiringVault is refused.
 * Review round 2: a redirect React Native's fetch followed is caught by `res.url` alone (no `redirected` there), the
 * mimir's compromised / insolvent flags and an answer in another shape are handled on the device, the re-check in
 * preflightDeposit refuses a vault retired since the quote, a hanging first quote host does not use up the vault
 * check's budget, the budget running out before a node is asked and a lastblock-only failure get their own texts, the
 * quoting node's lastblock read is armed with its own 8 s (not confirmTimeoutMs), and thorchainPins().verifyBuild
 * applies the same rule. Review round 3: a field of another type (an address or router as a number, a halt flag as a
 * string) skips the confirming node and makes the quoting node unavailable instead of throwing a TypeError. The
 * nodes are a fake fetch serving the answers recorded on 2026-11-12 (React Native's fetch
 * shape: no Response class, `url` set, no `redirected`). The Hermes CLI runs timers in the order they were set,
 * without waiting, so elapsed time is a jump of Date.now (what an app backgrounded mid-quote sees) and a read's bound
 * is checked as the delay its timer was armed with.
 */
async function smokeThorchainVaultRotation(check: Check): Promise<void> {
  type Vault = { pub_key: string; status: string; addresses: { chain: string; address: string }[] }
  const asgard = thorAsgardLive as unknown as Vault[]
  const mimirLive = thorMimirLive as Record<string, number>
  const height = Math.max(...(thorLastblockLive as { thorchain: number }[]).map((e) => e.thorchain))
  const addr = (tail: string, chain: string) => asgard.find((v) => v.pub_key.endsWith(tail))!.addresses.find((a) => a.chain === chain)!.address
  const vaultA = addr('udx7767', 'ETH')
  const vaultB = addr('4wxjp8az', 'ETH')
  const pubB = asgard.find((v) => v.pub_key.endsWith('4wxjp8az'))!.pub_key.toUpperCase()
  const router = '0xD37BbE5744D730a1d98d8DC97c42F0Ca46aD7146'
  const inboundWith = (evm: string, ethRouter = router) => (thorInboundLive as Record<string, unknown>[]).map((e) => {
    if (!['ETH', 'BASE', 'BSC', 'AVAX'].includes(String(e.chain))) return e
    return String(e.chain) === 'ETH' ? { ...e, address: evm, router: ethRouter } : { ...e, address: evm }
  })
  const retiredB = asgard.map((v) => (v.addresses.some((a) => a.address === vaultB) ? { ...v, status: 'RetiringVault' } : v))
  const btc = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'
  type Answer = { status?: number; url?: string; body?: unknown }
  type FakeNode = { height: number; inbound: unknown; asgard: unknown; mimir?: unknown; hang?: boolean; down?: boolean; answer?: Record<string, Answer> }
  const nodes: Record<string, FakeNode> = {}
  const Q = 'https://quote.invalid', QH = 'https://quote-hang.invalid', C1 = 'https://confirm1.invalid', C2 = 'https://confirm2.invalid'
  const LIQUIFY = 'https://gateway.liquify.com/chain/thorchain_api', IBS = 'https://thorchain.ibs.team/api'
  const urls: string[] = []
  let cacheOption = false
  let onRead: ((host: string, path: string) => void) | null = null
  const g = globalThis as { fetch: unknown }
  const realFetch = g.fetch
  const realNow = Date.now
  const aborted = () => Object.assign(new Error('aborted'), { name: 'AbortError' })
  g.fetch = (input: string, init?: { signal?: AbortSignal; cache?: string }) => {
    const url = String(input)
    const host = Object.keys(nodes).find((h) => url.startsWith(`${h}/`))
    if (!host) return Promise.reject(new Error(`no fake node for ${url}`))
    const n = nodes[host]!
    const path = url.slice(host.length).split('?')[0]!
    // The confirming reads, and the quoting node's lastblock (its quote and inbound snapshot are read as before).
    if (host !== Q || path === THORNODE_CONFIRM_PATHS.lastblock) {
      urls.push(url)
      if (init && 'cache' in init) cacheOption = true
    }
    onRead?.(host, path)
    if (n.down) return Promise.reject(new TypeError('Network request failed'))
    const s = init?.signal
    if (n.hang) {
      return new Promise((_, reject) => {
        if (s?.aborted) reject(aborted())
        else s?.addEventListener('abort', () => reject(aborted()))
      })
    }
    const custom = n.answer?.[path]
    const body = custom && 'body' in custom ? custom.body
      : path === '/thorchain/quote/swap'
      ? { expected_amount_out: '100000', inbound_address: vaultB, router, memo: `=:b:${btc}:95000`, expiry: Math.floor(Date.now() / 1000) + 3600 }
      : path === THORNODE_CONFIRM_PATHS.lastblock ? (thorLastblockLive as Record<string, unknown>[]).map((e) => ({ ...e, thorchain: n.height }))
      : path === THORNODE_CONFIRM_PATHS.inboundAddresses ? n.inbound
      : path === THORNODE_CONFIRM_PATHS.asgardVaults ? n.asgard
      : path === THORNODE_CONFIRM_PATHS.mimir ? (n.mimir ?? mimirLive)
      : undefined
    const status = custom?.status ?? (body !== undefined ? 200 : 404)
    return Promise.resolve({ ok: status >= 200 && status < 300, status, url: custom?.url ?? url, json: async () => body ?? null })
  }
  const quoteParams = {
    sourceChain: 'eip155:1', sourceToken: 'ETH', destChain: 'bitcoin:mainnet', destToken: '0x0000000000000000000000000000000000000000',
    amountIn: '50000000000000000', destAddress: btc,
  }
  type ProviderOptions = { confirmTimeoutMs?: number; nodeUrl?: string[]; confirmNodeUrl?: string[] }
  const quote = async (o: ProviderOptions = {}) => {
    const reasons: string[] = []
    const q = await thorchainProvider({ nodeUrl: Q, confirmNodeUrl: [C1, C2], ...o }).getQuote({ ...quoteParams, onRefusal: (r: string) => reasons.push(r) })
    return { q, reasons }
  }
  const fresh = (o: Partial<FakeNode> = {}): FakeNode => ({ height, inbound: inboundWith(vaultA), asgard, ...o })
  const reset = () => {
    for (const h of Object.keys(nodes)) delete nodes[h]
    // The default public nodes stay unreachable here: down, so a check with one configured node is not slowed.
    nodes[LIQUIFY] = fresh({ down: true })
    nodes[IBS] = fresh({ down: true })
    nodes[Q] = fresh({ inbound: inboundWith(vaultB) })
    nodes[C1] = fresh()
    nodes[C2] = fresh()
  }
  const NO_SECOND = 'thorchain: no second node answered to confirm the inbound vault (configure confirmNodeUrl)'
  try {
    for (const h of [LIQUIFY, IBS]) nodes[h] = { height, inbound: [], asgard: [], hang: true }
    nodes[Q] = { height, inbound: inboundWith(vaultB), asgard }
    nodes[C1] = { height, inbound: inboundWith(vaultA), asgard }
    nodes[C2] = { height, inbound: inboundWith(vaultA), asgard }
    let r = await quote()
    check('thorchain: rotated vault confirmed by an ActiveVault of the confirming node', r.q?.providerData?.inboundAddress === vaultB && r.reasons.length === 0, r.reasons.join('; '))
    check('thorchain: confirming reads are fixed paths with no query and no cache option', urls.length > 0 && urls.every((u) => !u.includes('?')) && !cacheOption, urls.join(' '))
    nodes[C1]!.height = height - 60
    r = await quote()
    check('thorchain: a node 60 blocks behind is skipped for the next one', r.q !== null && urls.some((u) => u.startsWith(`${C2}/`)), r.reasons.join('; '))
    nodes[C1] = { height, inbound: inboundWith(vaultA), asgard, hang: true }
    const t0 = Date.now()
    r = await quote({ confirmTimeoutMs: 150 })
    check('thorchain: per-node timeout (AbortController + setTimeout) moves to the next node', r.q !== null && Date.now() - t0 < 3_000, `${Date.now() - t0} ms; ${r.reasons.join('; ')}`)
    nodes[C1] = { height, inbound: inboundWith(vaultA), asgard: retiredB }
    r = await quote()
    check('thorchain: a RetiringVault never confirms', r.q === null && r.reasons[0] === 'thorchain: a second node lists the inbound vault as RetiringVault, not ActiveVault — refused', r.reasons.join('; '))
    nodes[C1] = { height: height - 60, inbound: inboundWith(vaultA), asgard }
    nodes[C2] = { height: height - 60, inbound: inboundWith(vaultA), asgard }
    r = await quote({ confirmTimeoutMs: 150 })
    check('thorchain: every confirming node behind → refused by name', r.q === null && /^thorchain: no confirming node is within 50 blocks/.test(r.reasons[0] ?? ''), r.reasons.join('; '))

    // A redirect React Native's fetch followed: only `res.url` shows it (no `redirected` field) — the node is skipped.
    reset()
    nodes[C1]!.answer = { [THORNODE_CONFIRM_PATHS.lastblock]: { url: `${C1}/thorchain/lastblock?height=1` } }
    r = await quote({ confirmNodeUrl: [C1] })
    const alone = r.q === null && r.reasons[0] === NO_SECOND
    nodes[C1]!.answer = { [THORNODE_CONFIRM_PATHS.inboundAddresses]: { url: 'https://elsewhere.invalid/thorchain/inbound_addresses' } }
    r = await quote()
    check('thorchain: a followed redirect (res.url only) is not trusted: skipped, refused when alone', alone && r.q !== null && urls.some((u) => u.startsWith(`${C2}/`)), r.reasons.join('; '))

    // The confirming node's mimir flags the quoted vault.
    reset()
    nodes[C1]!.mimir = { ...mimirLive, [`COMPROMISEDVAULT-${pubB}`]: 1 }
    r = await quote()
    const compromised = r.q === null && r.reasons[0] === "thorchain: a second node's mimir flags the inbound vault as compromised — refused"
    nodes[C1]!.mimir = { ...mimirLive, [`SOLVENCYHALTVAULT-${pubB}-ETH`]: 1 }
    r = await quote()
    check('thorchain: mimir CompromisedVault / SolvencyHaltVault refuse', compromised && r.q === null && r.reasons[0] === "thorchain: a second node's mimir flags the inbound vault as insolvent — refused", r.reasons.join('; '))

    // An answer in another shape: the node is skipped, never trusted.
    reset()
    nodes[C1]!.answer = { [THORNODE_CONFIRM_PATHS.asgardVaults]: { body: { vaults: [] } } }
    r = await quote({ confirmNodeUrl: [C1] })
    const shapeAlone = r.q === null && r.reasons[0] === NO_SECOND
    r = await quote()
    check('thorchain: an asgard answer in another shape is skipped, refused when alone', shapeAlone && r.q !== null, r.reasons.join('; '))

    // Review round 3: a field of another type is another shape — an address as a number made sameTarget throw a
    // TypeError out of getQuote, and `halted: "true"` read as open. The confirming node is skipped, the quoting node
    // unavailable, with the existing texts.
    reset()
    const ethWith = (inbound: unknown, o: Record<string, unknown>) => (inbound as Record<string, unknown>[]).map((e) => (e.chain === 'ETH' ? { ...e, ...o } : e))
    nodes[C1]!.inbound = ethWith(inboundWith(vaultA), { address: 42 })
    const typeAlone = await quote({ confirmNodeUrl: [C1] }).then((x) => x.q === null && x.reasons[0] === NO_SECOND, (e: unknown) => `threw ${String(e)}`)
    const typeNext = await quote().then((x) => x.q !== null && x.reasons.length === 0, (e: unknown) => `threw ${String(e)}`)
    nodes[C1] = fresh()
    nodes[Q]!.inbound = ethWith(inboundWith(vaultB), { halted: 'true' })
    const quotingType = await quote().then((x) => x.q === null && x.reasons[0] === 'thorchain: inbound addresses unavailable from every node', (e: unknown) => `threw ${String(e)}`)
    check('thorchain: a field of another type skips the confirming node and makes the quoting node unavailable (no TypeError)',
      typeAlone === true && typeNext === true && quotingType === true, `${typeAlone}; ${typeNext}; ${quotingType}`)

    // The re-check right before broadcast confirms the same way, and refuses a vault retired since the quote.
    reset()
    const p = thorchainProvider({ nodeUrl: Q, confirmNodeUrl: [C1, C2] })
    const q = (await p.getQuote(quoteParams))!
    const tx = await p.buildDeposit(q)
    const first = await p.preflightDeposit!(q, tx).then(() => 'ok', (e: unknown) => String(e))
    nodes[C1]!.asgard = retiredB
    const second = await p.preflightDeposit!(q, tx).then(() => 'ok', (e: Error) => e.message)
    check('thorchain: preflightDeposit re-confirms (rotated vault ok, retired since the quote refused)', first === 'ok' && second === 'thorchain: a second node lists the inbound vault as RetiringVault, not ActiveVault — refused', `${first}; ${second}`)

    // A hanging first quote host (8.5 s pass while it is asked) does not use up the vault check's budget.
    reset()
    nodes[QH] = fresh({ hang: true })
    onRead = (host) => {
      if (host === QH) Date.now = () => realNow() + 8_500
    }
    urls.length = 0
    r = await quote({ nodeUrl: [QH, Q] })
    Date.now = realNow
    onRead = null
    check('thorchain: a hanging first quote host + a sound second → confirmed (own budget from the quote in hand)', r.q?.providerData?.inboundAddress === vaultB && r.reasons.length === 0 && urls.some((u) => u.startsWith(`${C1}/thorchain/vaults/asgard`)), r.reasons.join('; '))

    // The clock jumps while the quoting node reads its height (the app backgrounded): no time is left to ask a node.
    reset()
    let asked = 0
    onRead = (host, path) => {
      if (host === Q && path === THORNODE_CONFIRM_PATHS.lastblock) Date.now = () => realNow() + 9_000
      if (host === C1 || host === C2) asked++
    }
    r = await quote()
    Date.now = realNow
    onRead = null
    check('thorchain: budget gone before any confirming node was asked → its own text', r.q === null && asked === 0 && r.reasons[0] === 'thorchain: the 8 s confirmation budget ran out before a second node could be asked to confirm the inbound vault — retry', r.reasons.join('; '))

    // Only the quoting node's lastblock failing names lastblock; a small confirmTimeoutMs does not cut it.
    reset()
    nodes[Q]!.answer = { [THORNODE_CONFIRM_PATHS.lastblock]: { status: 404, body: null } }
    r = await quote()
    const heightGone = r.q === null && r.reasons[0] === 'thorchain: THORChain height (/thorchain/lastblock) unavailable from every node that answered the inbound addresses'
    nodes[Q]!.answer = {}
    const gt = globalThis as unknown as { setTimeout: (fn: () => void, ms?: number) => unknown }
    const realSetTimeout = gt.setTimeout
    const delays: number[] = []
    let armed: number[] = []
    gt.setTimeout = (fn: () => void, ms?: number) => {
      delays.push(ms ?? 0)
      return realSetTimeout(fn, ms)
    }
    onRead = (host, path) => {
      if (host === Q && path === THORNODE_CONFIRM_PATHS.lastblock) armed = delays.slice()
    }
    try {
      r = await quote({ confirmTimeoutMs: 100 })
    } finally {
      gt.setTimeout = realSetTimeout
      onRead = null
    }
    // Every timer armed up to the quoting node's lastblock read (quote, inbound_addresses, lastblock) is 8 s.
    check('thorchain: quoting node lastblock: own 8 s bound (not confirmTimeoutMs), its failure named', heightGone && r.q !== null && armed.length >= 3 && armed.every((d) => d === 8_000), `${armed.join(',')}; ${r.reasons.join('; ')}`)

    // thorchainPins().verifyBuild on the device: the same rule.
    reset()
    const built = (await thorchainProvider({ nodeUrl: Q, confirmNodeUrl: [C1, C2] }).getQuote(quoteParams))!
    const builtTx = await thorchainProvider({ nodeUrl: Q }).buildDeposit(built)
    const verify = (o: { nodeUrl?: string[]; confirmTimeoutMs?: number } = {}) => thorchainPins({ nodeUrl: [C1, C2], ...o }).verifyBuild(built, builtTx, quoteParams)
    urls.length = 0
    cacheOption = false
    const rotated = await verify()
    check('thorchain: verifyBuild confirms a rotated ActiveVault on fixed GET paths', rotated === null && urls.length > 0 && urls.every((u) => !u.includes('?')) && !cacheOption, String(rotated))
    nodes[C2]!.asgard = retiredB
    const retired = await verify()
    nodes[C2]!.asgard = asgard
    nodes[C1]!.mimir = { ...mimirLive, [`COMPROMISEDVAULT-${pubB}`]: 1 }
    const flagged = await verify()
    nodes[C1]!.mimir = undefined
    nodes[C1]!.inbound = inboundWith(vaultA, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    const routerSwap = await verify()
    check('thorchain: verifyBuild refuses RetiringVault, a compromised vault and another router',
      retired === 'a THORNode lists the inbound vault as RetiringVault, not ActiveVault' && flagged === "a THORNode's mimir flags the inbound vault as compromised" && routerSwap === 'a THORNode reports another router',
      `${retired}; ${flagged}; ${routerSwap}`)
    reset()
    nodes[C2]!.height = height - 51
    const lagging = await verify()
    nodes[C2] = fresh({ answer: { [THORNODE_CONFIRM_PATHS.lastblock]: { url: `${C2}/thorchain/lastblock?height=1` } } })
    const redirected = await verify()
    nodes[C2] = fresh({ hang: true })
    const t2 = Date.now()
    const slow = await verify({ confirmTimeoutMs: 150 })
    check('thorchain: verifyBuild skips a lagging, redirected or slow node (two must confirm)',
      lagging === 'two THORNodes within 50 blocks of the highest THORChain height they report could not confirm the inbound vault (behind or unreachable)' &&
      redirected === 'two THORNodes could not confirm the inbound vault' && slow === 'two THORNodes could not confirm the inbound vault' && Date.now() - t2 < 2_000,
      `${lagging}; ${redirected}; ${slow}; ${Date.now() - t2} ms`)
    // A node whose router is a number is skipped by verifyBuild too (it threw a TypeError before).
    nodes[C2] = fresh({ inbound: ethWith(inboundWith(vaultB), { router: 42 }) })
    const typed = await verify().then((x) => x, (e: unknown) => `threw ${String(e)}`)
    check('thorchain: verifyBuild skips a node with a field of another type (no TypeError)', typed === 'two THORNodes could not confirm the inbound vault', String(typed))
  } finally {
    Date.now = realNow
    onRead = null
    g.fetch = realFetch
  }
}
