/**
 * Protocol modules in Hermes: every module must LOAD (no missing globals, no
 * unsupported syntax), construct over an offline account, expose its surface,
 * and answer a read without a runtime error. Network reads are expected to
 * fail — with an ordinary Error, never a ReferenceError/TypeError, which is
 * what a missing polyfill looks like. Pure helpers are checked for real values.
 */
import { createMockAccount } from '@forgewallet/conformance'
import { Address } from '@ton/core'
import { RouterSwap2Protocol } from '@forgewallet/protocol-swap2-router/swap2/router'
import { NearIntentsSwap2Protocol } from '@forgewallet/protocol-swap2-near-intents/protocol'
import { LifiSwap2Protocol } from '@forgewallet/protocol-swap2-lifi/protocol'
import { lifiProvider } from '@forgewallet/protocol-swap2-lifi/provider'
import { cctpProvider } from '@forgewallet/protocol-swap2-cctp/provider'
import { CctpSwap2Protocol } from '@forgewallet/protocol-swap2-cctp/protocol'
import { nearIntentsProvider } from '@forgewallet/protocol-swap2-near-intents/provider'
import { ThorchainSwap2Protocol } from '@forgewallet/protocol-swap2-thorchain/protocol'
import { OmnistonSwap2Protocol } from '@forgewallet/protocol-swap2-omniston/protocol'
import LidoProtocolEvm, { splitWithdrawalAmounts } from '@forgewallet/protocol-staking-lido-evm'
import SsvProtocolEvm, { MINIMAL_STAKING_AMOUNT } from '@forgewallet/protocol-staking-ssv-evm'
import TonstakersProtocolTon, { buildStakeBody, buildUnstakeBody } from '@forgewallet/protocol-staking-tonstakers-ton'
import SplStakePoolProtocolSolana, { base58Decode } from '@forgewallet/protocol-staking-spl-stake-pool-solana'
import MellowProtocolEvm, { toAsset } from '@forgewallet/protocol-lending-mellow-evm'
import { AaveProtocolEvm, parseReserveConfiguration, rayToApyPct, AAVE_MARKETS } from '@forgewallet/protocol-lending-aave-evm'
import { MorphoVaultProtocolEvm, MorphoMarketProtocolEvm, marketId, accrue, MORPHO_CHAINS } from '@forgewallet/protocol-lending-morpho-evm'
import { KaminoVaultProtocolSolana, KaminoMarketProtocolSolana, MAIN_MARKET, KLEND_PROGRAM, instructionName, toDecimalString, fromDecimalString } from '@forgewallet/protocol-lending-kamino-solana'
import ApprovalsProtocolEvm, { isRevokeCalldata, isUnlimitedAmount } from '@forgewallet/protocol-approvals-evm'

type Check = (what: string, ok: boolean, detail?: string) => void

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
  for (const [name, P] of [['near-intents', NearIntentsSwap2Protocol], ['lifi', LifiSwap2Protocol], ['thorchain', ThorchainSwap2Protocol], ['omniston', OmnistonSwap2Protocol], ['cctp', CctpSwap2Protocol]] as const) {
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
  // Engine math the APY depends on, each checked on its own so a Hermes build that gets one of
  // them wrong (BigInt → Number, log1p/expm1/pow near 1) names the culprit instead of the sum.
  const big = 4n * 10n ** 25n
  check(`aave: bigint ** and * (${big.toString()})`, big.toString() === '40000000000000000000000000' && big === 40000000000000000000000000n)
  check(`aave: Number(2n**53n) (${Number(2n ** 53n)})`, Number(2n ** 53n) === 9007199254740992)
  check(`aave: Number(2n**64n) (${Number(2n ** 64n)})`, Number(2n ** 64n) === 18446744073709551616)
  check(`aave: Number(2n**64n + 1n) (${Number(2n ** 64n + 1n)})`, Number(2n ** 64n + 1n) === 18446744073709551616)
  check(`aave: Number(10n**19n) (${Number(10n ** 19n)})`, Number(10n ** 19n) === 1e19)
  check(`aave: Number(10n**20n) (${Number(10n ** 20n)})`, Number(10n ** 20n) === 1e20)
  check(`aave: Number(big.toString()) (${Number(big.toString())})`, Number(big.toString()) === 4e25)
  check(`aave: Number(big / 10n**18n) / 1e-18 (${Number(big / 10n ** 18n) * 1e18})`, Number(big / 10n ** 18n) * 1e18 === 4e25)
  const ray = Number(big)
  check(`aave: Number(4e25 ray) (${ray})`, ray === 4e25)
  const perSec = 0.04 / 31_536_000
  const l = Math.log1p(perSec), e = Math.expm1(0.04), p = Math.pow(1 + perSec, 31_536_000)
  check(`aave: log1p(${perSec}) (${l})`, Math.abs(l / perSec - 1) < 1e-6)
  check(`aave: expm1(0.04) (${e})`, Math.abs(e - 0.0408107742) < 1e-8)
  check(`aave: pow(1 + r/n, n) (${p})`, Math.abs(p - 1.0408107720) < 1e-6)
  const apy = rayToApyPct(4n * 10n ** 25n)
  check(`aave: rayToApyPct (${apy.toFixed(4)} ≈ 4.081)`, Math.abs(apy - 4.081) < 0.01)
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
  check('kamino: instructionName', instructionName(KLEND_PROGRAM, Uint8Array.from([0xd8, 0xe0, 0xbf, 0x1b, 0xcc, 0x97, 0x66, 0xaf, 0])) === 'depositReserveLiquidityAndObligationCollateralV2')

  // approvals
  const approvals = new (ApprovalsProtocolEvm as never as new (a: unknown, c?: unknown) => { getSupportedStandards(): Promise<unknown> })(evm, {})
  await tolerates(check, 'approvals: getSupportedStandards', () => approvals.getSupportedStandards())
  check('approvals: isRevokeCalldata', isRevokeCalldata('0x095ea7b3' + '0'.repeat(24) + 'beef'.padStart(40, '0') + '0'.repeat(64)) === true)
  check('approvals: isUnlimitedAmount', isUnlimitedAmount((1n << 256n) - 1n) === true && isUnlimitedAmount(5n) === false)
}
