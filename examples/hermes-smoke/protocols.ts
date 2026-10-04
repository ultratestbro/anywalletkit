/**
 * Protocol modules in Hermes: every module must LOAD (no missing globals, no
 * unsupported syntax), construct over an offline account, expose its surface,
 * and answer a read without a runtime error. Network reads are expected to
 * fail — with an ordinary Error, never a ReferenceError/TypeError, which is
 * what a missing polyfill looks like. Pure helpers are checked for real values.
 */
import { createMockAccount } from '@forgewallet/conformance'
import { Address } from '@ton/core'
import { CrossChainRouter } from '@forgewallet/protocol-swidge-core/router'
import { RouterSwidgeProtocol } from '@forgewallet/protocol-swidge-router/swidge/router'
import { NearIntentsSwidgeProtocol } from '@forgewallet/protocol-swidge-near-intents/protocol'
import { LifiSwidgeProtocol } from '@forgewallet/protocol-swidge-lifi/protocol'
import { ThorchainSwidgeProtocol } from '@forgewallet/protocol-swidge-thorchain/protocol'
import { OmnistonSwidgeProtocol } from '@forgewallet/protocol-swidge-omniston/protocol'
import LidoProtocolEvm, { splitWithdrawalAmounts } from '@forgewallet/protocol-staking-lido-evm'
import SsvProtocolEvm, { MINIMAL_STAKING_AMOUNT } from '@forgewallet/protocol-staking-ssv-evm'
import TonstakersProtocolTon, { buildStakeBody, buildUnstakeBody } from '@forgewallet/protocol-staking-tonstakers-ton'
import SplStakePoolProtocolSolana, { base58Decode } from '@forgewallet/protocol-staking-spl-stake-pool-solana'
import MellowProtocolEvm, { toAsset } from '@forgewallet/protocol-lending-mellow-evm'
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
  const swidgeCfg = { fromChain: 'eip155:1', skipAccountChainCheck: true }

  // swidge
  const router = new RouterSwidgeProtocol(evm, { ...swidgeCfg, router: new CrossChainRouter([]) })
  check('router: surface', typeof router.quoteSwidge === 'function' && typeof router.getSwidgeStatus === 'function')
  await tolerates(check, 'router: getSupportedChains', () => router.getSupportedChains())
  for (const [name, P] of [['near-intents', NearIntentsSwidgeProtocol], ['lifi', LifiSwidgeProtocol], ['thorchain', ThorchainSwidgeProtocol], ['omniston', OmnistonSwidgeProtocol]] as const) {
    const p = new (P as never as new (a: unknown, c: unknown) => { getSupportedChains(): Promise<unknown>; quoteSwidge(o: unknown): Promise<unknown> })(evm, swidgeCfg)
    check(`${name}: constructs`, typeof p.quoteSwidge === 'function')
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

  // lending
  const mellow = new (MellowProtocolEvm as never as new (a: unknown, c?: unknown) => { quoteSupply(o: unknown): Promise<unknown> })(evm, { preset: 'lido-earn-eth' })
  await tolerates(check, 'mellow: quoteSupply', () => mellow.quoteSupply({ token: toAsset('0x0000000000000000000000000000000000000000'), amount: 1n }))
  check('mellow: toAsset', typeof toAsset('0xdAC17F958D2ee523a2206206994597C13D831ec7') === 'string')

  // approvals
  const approvals = new (ApprovalsProtocolEvm as never as new (a: unknown, c?: unknown) => { getSupportedStandards(): Promise<unknown> })(evm, {})
  await tolerates(check, 'approvals: getSupportedStandards', () => approvals.getSupportedStandards())
  check('approvals: isRevokeCalldata', isRevokeCalldata('0x095ea7b3' + '0'.repeat(24) + 'beef'.padStart(40, '0') + '0'.repeat(64)) === true)
  check('approvals: isUnlimitedAmount', isUnlimitedAmount((1n << 256n) - 1n) === true && isUnlimitedAmount(5n) === false)
}
