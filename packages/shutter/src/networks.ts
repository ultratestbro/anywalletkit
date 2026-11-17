/** Where the Shutter API runs and which contracts its keypers watch. */
export interface ShutterNetwork {
  readonly name: string
  readonly chainId: number
  /** API origin + `/api`. */
  readonly apiBaseUrl: string
  /**
   * The ShutterRegistry the keypers watch: identities registered here get their decryption key at the registered time.
   * Self-registration (`register(eon, identityPrefix, timestamp)` from the user's own account) goes here.
   */
  readonly registry: string
  /** The account the API registers from: identities the API registers are keccak256(prefix ‖ this address). */
  readonly apiRegistrant: string
}

/**
 * Gnosis Chain mainnet. The registry is the one the API itself registers into and the keypers serve (checked on
 * chain 2026-11-17: the API's `register_identity` transactions call it, and it is the one emitting
 * `IdentityRegistered`); the address in the API README (0x694e…67D9) has no registrations.
 */
export const SHUTTER_GNOSIS: ShutterNetwork = {
  name: 'gnosis',
  chainId: 100,
  apiBaseUrl: 'https://shutter-api.shutter.network/api',
  registry: '0x0baaEa85A5aa87603772cCcDd41A07C7D712cee4',
  apiRegistrant: '0x228DefCF37Da29475F0EE2B9E4dfAeDc3b0746bc',
}

/** Gnosis Chiado testnet (no rate limits: the place to develop against). */
export const SHUTTER_CHIADO: ShutterNetwork = {
  name: 'chiado',
  chainId: 10200,
  apiBaseUrl: 'https://shutter-api.chiado.staging.shutter.network/api',
  registry: '0x2693a4Fb363AdD4356e6b80Ac5A27fF05FeA6D9F',
  apiRegistrant: '0xd150bbf86C686de1a25820A94c2C2397e0bC54ab',
}

export const SHUTTER_NETWORKS = { gnosis: SHUTTER_GNOSIS, chiado: SHUTTER_CHIADO } as const
