/**
 * Seal a message until a time, open it after: the commit-reveal flow a wallet or app shows. The ciphertext is made on
 * the device and only ever leaves it the way the app sends it; the API sees a random prefix and the reveal time.
 */
import { ShutterApi, type EncryptionData } from './api.js'
import { bytesOf, randomHex32, toHex, utf8Decode, utf8Encode, type BytesLike } from './bytes.js'
import { decrypt, encrypt, parseCiphertext } from './crypto.js'
import { ShutterApiError, ShutterNotYetRevealedError } from './errors.js'
import { decodeRegistration, registerCalldata, registrationsCalldata } from './registry.js'

/** Everything needed to open a sealed message later. Plain JSON: store it, send it, publish it. */
export interface SealedMessage {
  readonly version: 1
  readonly network: string
  readonly chainId: number
  readonly eon: number
  readonly identity: `0x${string}`
  readonly identityPrefix: `0x${string}`
  /** The account the identity is derived from: the API's, or the user's own when self-registered. */
  readonly registrant: string
  readonly eonKey: `0x${string}`
  /** Unix time, seconds: the keypers release the decryption key from then on. */
  readonly revealAt: number
  readonly ciphertext: `0x${string}`
  /** How the identity was registered, and the registration transaction. */
  readonly registration: { readonly by: 'api' | 'self'; readonly txHash: `0x${string}` }
}

/** The user's own account registering the identity: sends `register(eon, prefix, revealAt)` on the network's chain. */
export interface SelfRegistrant {
  readonly address: string
  sendTransaction(tx: { to: string; data: `0x${string}`; value: bigint; chainId: number }): Promise<{ hash: string }>
}

export interface SealInput {
  readonly api: ShutterApi
  /** Text (UTF-8) or bytes. */
  readonly message: string | Uint8Array
  /** Unix time, seconds, in the future. */
  readonly revealAt: number
  /** Register from the user's own account instead of the API's. The identity then depends on no API account. */
  readonly registrant?: SelfRegistrant | undefined
}

/**
 * Register an identity for `revealAt` and encrypt the message for it. With `registrant`, the user's account sends the
 * registration (and pays the gas); the message is encrypted only once the transaction is handed over, so a refused
 * registration leaves nothing sealed that can never open. Wait for that transaction before relying on the reveal
 * ({@link readRegistration}).
 */
export async function seal(input: SealInput): Promise<SealedMessage> {
  const { api } = input
  const message = typeof input.message === 'string' ? utf8Encode(input.message) : input.message
  if (!Number.isSafeInteger(input.revealAt) || input.revealAt <= Math.floor(Date.now() / 1000)) throw new ShutterApiError('revealAt must be a Unix time in seconds, in the future')
  let data: EncryptionData
  let registration: SealedMessage['registration']
  if (input.registrant) {
    data = await api.getEncryptionData({ identityPrefix: randomHex32(), registrant: input.registrant.address })
    const sent = await input.registrant.sendTransaction({
      to: api.network.registry, data: registerCalldata({ eon: data.eon, identityPrefix: data.identityPrefix, revealAt: input.revealAt }), value: 0n, chainId: api.network.chainId,
    })
    if (!/^0x[0-9a-fA-F]{64}$/.test(sent.hash)) throw new ShutterApiError('the registration was not sent (no transaction hash)')
    registration = { by: 'self', txHash: sent.hash.toLowerCase() as `0x${string}` }
  } else {
    const r = await api.registerIdentity({ revealAt: input.revealAt })
    data = r
    registration = { by: 'api', txHash: r.txHash }
  }
  const ciphertext = toHex(encrypt({ message, identity: data.identity, eonKey: data.eonKey }))
  return {
    version: 1, network: api.network.name, chainId: api.network.chainId, eon: data.eon, identity: data.identity, identityPrefix: data.identityPrefix,
    registrant: data.registrant, eonKey: data.eonKey, revealAt: input.revealAt, ciphertext, registration,
  }
}

/**
 * Open a sealed message once its time has come: fetch the decryption key, check it by pairing, decrypt on the device.
 * Before `revealAt` it throws {@link ShutterNotYetRevealedError} without asking anyone.
 */
export async function open(sealed: SealedMessage, api: ShutterApi): Promise<Uint8Array> {
  if (sealed.version !== 1) throw new ShutterApiError(`unsupported sealed message version ${String(sealed.version)}`)
  if (sealed.chainId !== api.network.chainId) throw new ShutterApiError(`the message was sealed on chain ${sealed.chainId}, the API is for chain ${api.network.chainId}`)
  parseCiphertext(sealed.ciphertext)
  if (Math.floor(Date.now() / 1000) < sealed.revealAt) throw new ShutterNotYetRevealedError(`sealed until ${new Date(sealed.revealAt * 1000).toISOString()}`, sealed.revealAt)
  const key = await api.getDecryptionKey({ identity: sealed.identity, eonKey: sealed.eonKey })
  return decrypt(sealed.ciphertext, key.decryptionKey)
}

/** {@link open} for a text message. */
export async function openText(sealed: SealedMessage, api: ShutterApi): Promise<string> {
  return utf8Decode(await open(sealed, api))
}

/**
 * Read the registry: the identity's eon and reveal time, or `null` when it is not registered (yet). `call` is an
 * `eth_call` on the network's chain — any RPC client fits (`(to, data) => client.call({ to, data })`).
 */
export async function readRegistration(call: (to: string, data: `0x${string}`) => Promise<string>, api: ShutterApi, identity: BytesLike): Promise<{ eon: bigint; revealAt: bigint } | null> {
  return decodeRegistration(await call(api.network.registry, registrationsCalldata(bytesOf(identity, 'identity'))))
}
