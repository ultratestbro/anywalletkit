// The Accounts & signers page renders the #region blocks of this file.

// #region external
import { externalSigner, type SignOptions } from '@forgewallet/core'
import { Wallet } from '@forgewallet/kit'
import { WalletManagerEvm } from '@forgewallet/wallet-evm'

/** Your device / MPC node / backend: it holds the key, the SDK never sees it. */
export interface RemoteKey {
  publicKey: Uint8Array // 33-byte compressed secp256k1
  sign(digest: Uint8Array, options: SignOptions): Promise<Uint8Array> // 65 bytes r‖s‖v
}

export function walletOnRemoteKey(remote: RemoteKey): Wallet {
  const signer = externalSigner({
    curve: 'secp256k1',
    publicKey: remote.publicKey,
    // Throw UserRejectedError from here when the user declines on the device.
    sign: (payload, options) => remote.sign(payload, options),
  })
  const wallet = new Wallet(signer) // no seed phrase anywhere
  wallet.registerWallet('eip155:1', WalletManagerEvm, { provider: 'https://ethereum-rpc.publicnode.com' })
  return wallet
}
// #endregion external
