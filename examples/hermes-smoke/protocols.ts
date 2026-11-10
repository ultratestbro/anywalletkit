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
import { NearIntentsSwap2Protocol } from '@anywalletkit/protocol-swap2-near-intents/protocol'
import { LifiSwap2Protocol } from '@anywalletkit/protocol-swap2-lifi/protocol'
import { lifiProvider } from '@anywalletkit/protocol-swap2-lifi/provider'
import { cctpProvider } from '@anywalletkit/protocol-swap2-cctp/provider'
import { CctpSwap2Protocol } from '@anywalletkit/protocol-swap2-cctp/protocol'
import { usdt0Provider } from '@anywalletkit/protocol-swap2-usdt0/provider'
import { Usdt0Swap2Protocol } from '@anywalletkit/protocol-swap2-usdt0/protocol'
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
import { encodeFunctionData, encodeFunctionResult } from 'viem'
import { nearIntentsProvider } from '@anywalletkit/protocol-swap2-near-intents/provider'
import { ThorchainSwap2Protocol } from '@anywalletkit/protocol-swap2-thorchain/protocol'
import { OmnistonSwap2Protocol } from '@anywalletkit/protocol-swap2-omniston/protocol'
import { createOmnistonTonValidators } from '@anywalletkit/protocol-swap2-omniston/validators'
import escrowLive from '../../packages/protocol-swap2-omniston/tests/fixtures/live-2026-10-10.json'
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
import { redactUrls, tonRawAddress } from '@anywalletkit/protocol-swap2-core'
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
    // 2026-10-28: a remote TON → EVM Omniston order is checked on the device — the live escrow (USDT on TON → USDC on Base) passes, another destination does not
    const c = (escrowLive as unknown as { baseUsdc: { quoteUpdated: { value: { inputUnits: string; outputAsset: { chain: { value: { kind: { value: string } } } }; settlementData: { value: { resolverSendsUnits: string } } } }; escrowRequest: { ownerSrcAddress: { chain: { value: string } }; traderDstAddress: { chain: { value: string } } }; escrowResponse: { messages: Array<{ payload: string }> } } }).baseUsdc
    const v = createOmnistonTonValidators()
    const expectation = {
      payloadBocHex: c.escrowResponse.messages[0]!.payload, ownerAddress: c.escrowRequest.ownerSrcAddress.chain.value, inputUnits: c.quoteUpdated.value.inputUnits,
      destinationChain: 'eip155:8453', destinationAddress: c.escrowRequest.traderDstAddress.chain.value, outputTokenAddress: c.quoteUpdated.value.outputAsset.chain.value.kind.value,
      minResolverSendsUnits: c.quoteUpdated.value.settlementData.value.resolverSendsUnits,
    }
    check('omniston: TON → EVM escrow verified on the device', v.verifyTonEscrowBuild(expectation) === null && v.verifyTonEscrowBuild({ ...expectation, destinationAddress: '0x' + '99'.repeat(20) }) !== null)
  }
  check('approvals: isRevokeCalldata', isRevokeCalldata('0x095ea7b3' + '0'.repeat(24) + 'beef'.padStart(40, '0') + '0'.repeat(64)) === true)
  check('approvals: isUnlimitedAmount', isUnlimitedAmount((1n << 256n) - 1n) === true && isUnlimitedAmount(5n) === false)
}
