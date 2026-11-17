// Stargate is opt-in: not part of the default provider list in examples/swap/src/swap.ts.
// Install runtime-hermes polyfills before importing providers in React Native.
import type {IWalletAccount} from '@anywalletkit/core'
import type {Swap2EngineConfig} from '@anywalletkit/protocol-swap2-core/swap2/base'
import {remoteProvider} from '@anywalletkit/protocol-swap2-core/remote'
import {RouterSwap2Protocol} from '@anywalletkit/protocol-swap2-router'
import {stargatePins} from '@anywalletkit/protocol-swap2-stargate/pins'
import type {StargatePinsConfig} from '@anywalletkit/protocol-swap2-stargate/pins'

export function stargateMobileRouter(account: IWalletAccount, options: {
  baseUrl: string
  headers: Record<string, string>
  // Public or app-proxied RPCs for independent client validation on BOTH chains.
  pins: StargatePinsConfig
  reviewExecution: NonNullable<Swap2EngineConfig['reviewExecution']>
  operationStore: NonNullable<Swap2EngineConfig['operationStore']>
}) {
  return new RouterSwap2Protocol(account, {
    fromChain: account.chain,
    providers: [remoteProvider({name: 'stargate', baseUrl: options.baseUrl, headers: options.headers, ...stargatePins(options.pins)})],
    reviewExecution: options.reviewExecution,
    operationStore: options.operationStore,
  })
}
// Quote with routeId: 'taxi'; pass the reviewed toTokenAmountMin as minAmountOut.
// Catch Swap2MaybeSentError and resume its id; never resubmit a possibly sent source.
// Persist operationStore across restarts; recovery is a separate reviewed paid action.
