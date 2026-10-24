// The "Custom signer" guide on docs.anywallet.tech renders the #region blocks of this file.

// #region imports
import { UserRejectedError, externalSigner, type SignOptions, type SignScheme, type Signer } from '@anywalletkit/core'
import { Wallet, type Policies } from '@anywalletkit/kit'
import { WalletManagerBtc } from '@anywalletkit/wallet-btc'
import { WalletManagerEvm } from '@anywalletkit/wallet-evm'
import { WalletManagerSolana } from '@anywalletkit/wallet-solana'
// #endregion imports

// #region device
/** What a hardware wallet SDK typically gives you. */
export interface Device {
  publicKey(path: string): Promise<Uint8Array> // 33-byte compressed secp256k1
  signDigest(path: string, digest: Uint8Array, prompt: string): Promise<Uint8Array | 'rejected'>
}

const PROMPTS: Record<string, string> = {
  'evm-tx': 'Sign transaction',
  'evm-191': 'Sign message',
  'evm-712': 'Sign typed data',
}

export async function deviceSigner(device: Device, path = "m/44'/60'/0'/0/0"): Promise<Signer> {
  return externalSigner({
    curve: 'secp256k1',
    publicKey: await device.publicKey(path),
    sign: async (digest, options) => {
      // options.context says what the bytes are, so the device can show the right screen.
      const sig = await device.signDigest(path, digest, PROMPTS[options.context ?? ''] ?? 'Sign')
      if (sig === 'rejected') throw new UserRejectedError('Rejected on the device.')
      return sig // 65 bytes r‖s‖v (v = 0 or 1)
    },
  })
}

export async function walletOnDevice(device: Device, policies: Policies): Promise<Wallet> {
  const wallet = new Wallet(await deviceSigner(device), { policies }) // no seed in the app at all
  wallet.registerWallet('eip155:1', WalletManagerEvm, { provider: 'https://ethereum-rpc.publicnode.com', chainId: 1 })
  return wallet
}
// #endregion device

// #region remote
/** A signing service you run (MPC node, HSM, KMS proxy): it holds the key, the app holds a session token. */
export function remoteSigner(options: {
  url: string
  token: string
  curve: 'secp256k1' | 'ed25519'
  publicKey: Uint8Array
  schemes?: readonly SignScheme[]
  fetch?: typeof fetch
}): Signer {
  return externalSigner({
    curve: options.curve,
    publicKey: options.publicKey,
    ...(options.schemes ? { schemes: options.schemes } : {}),
    sign: async (payload: Uint8Array, opts: SignOptions & { scheme: SignScheme }) => {
      const res = await (options.fetch ?? fetch)(options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${options.token}` },
        body: JSON.stringify({ payload: toHex(payload), scheme: opts.scheme, context: opts.context ?? null }),
      })
      if (res.status === 403) throw new UserRejectedError('The signing service refused.')
      if (!res.ok) throw new Error(`Signing service: HTTP ${res.status}`)
      const { signature } = (await res.json()) as { signature: string }
      return fromHex(signature) // the SDK checks the length for the scheme
    },
  })
}
// #endregion remote

// #region curves
/**
 * One external signer = one key = one curve. Two curves → two wallets.
 * The secp256k1 key serves EVM and Bitcoin, but it is ONE key: the Bitcoin
 * address is that key's SegWit address, not the m/84' one a seed wallet shows.
 */
export function walletsOnService(service: { url: string; token: string; secpKey: Uint8Array; edKey: Uint8Array; fetch?: typeof fetch }) {
  const evmAndBitcoin = new Wallet(
    remoteSigner({
      ...service, curve: 'secp256k1', publicKey: service.secpKey,
      schemes: ['ecdsa-recoverable', 'ecdsa'], // EVM and BTC messages use the first, SegWit inputs the second
    }),
  )
  evmAndBitcoin.registerWallet('eip155:1', WalletManagerEvm, { provider: 'https://ethereum-rpc.publicnode.com', chainId: 1 })
  evmAndBitcoin.registerWallet('bip122', WalletManagerBtc, {
    client: { type: 'esplora-http', clientConfig: { url: 'https://mempool.space/api' } },
  })

  const solana = new Wallet(remoteSigner({ ...service, curve: 'ed25519', publicKey: service.edKey }))
  solana.registerWallet('solana', WalletManagerSolana, { provider: 'https://api.mainnet-beta.solana.com' })
  return { evmAndBitcoin, solana }
}
// #endregion curves

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const fromHex = (h: string) => Uint8Array.from((h.replace(/^0x/, '').match(/../g) ?? []).map((x) => parseInt(x, 16)))
