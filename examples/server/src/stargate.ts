// Private workspace example; mount behind application authentication/rate limiting.
import {createSwap2Handler} from '@anywalletkit/protocol-swap2-core/server'
import {stargateProvider, type StargateProviderConfig} from '@anywalletkit/protocol-swap2-stargate/provider'

export function createStargateHandler(
  config: StargateProviderConfig,
  sealSecret: string,
  guard: NonNullable<Parameters<typeof createSwap2Handler>[0]['guard']>,
) {
  // config.enabled must be explicitly true before exposing executable quotes.
  // The seal secret belongs to this backend; it is not a LayerZero API key.
  return createSwap2Handler({providers: [stargateProvider(config)], sealSecret, guard})
}
