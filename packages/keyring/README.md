# @forgewallet/keyring

Many accounts from many key sources, the way MetaMask, Phantom or Tonkeeper do it:

- **a BIP-39 seed** (created or imported, optional passphrase) → accounts 0, 1, 2… on every registered chain;
- **an imported private key** → exactly one account on one chain;
- **a TON-native 24-word mnemonic** (Tonkeeper, Tonhub, MyTonWallet) → one TON account.

```ts
import { Keyring } from '@forgewallet/keyring'
import { WalletManagerEvm } from '@forgewallet/wallet-evm'
import { WalletManagerSolana } from '@forgewallet/wallet-solana'

const keyring = await Keyring.load({
  storage,  // KeyringStorage: names, addresses, flags — no secrets
  secrets,  // SecretStorage: one secure-storage entry per source
  chains: { evm: { Manager: WalletManagerEvm, config: { provider } }, solana: { Manager: WalletManagerSolana, config: { rpcUrl } } },
})

const { mnemonic } = await keyring.createMnemonic()             // show the backup screen once
const next = await keyring.addAccount(keyring.listSources()[0]!.id)
await keyring.importMnemonic(words, { discover: { isUsed } })   // restore: adds used accounts 1, 2, …
await keyring.previewPrivateKey('solana', key)                  // show the address first
await keyring.importPrivateKey('solana', key)

await keyring.withAccount(next.id, 'evm', (account) => account.sendTransaction(tx))
```

## Derivation (what changes per account)

| chain  | account `i`               | same accounts as                    |
|--------|---------------------------|-------------------------------------|
| EVM    | `m/44'/60'/0'/0/i`        | MetaMask, Rabby, Trust, Rainbow     |
| Solana | `m/44'/501'/i'/0'`        | Phantom, Solflare, Backpack         |
| TON    | `m/44'/607'/i'` (V5R1)    | Trust (BIP-39); Tonkeeper words → `importTonMnemonic` |
| Tron   | `m/44'/195'/0'/0/i`       | TronLink, Trust                     |
| BTC    | `m/84'/0'/0'/0/i` (P2WPKH)| BIP-84 wallets, address index `i`   |
| NEAR   | `m/44'/397'/i'`           | MyNearWallet, Meteor (implicit)     |

Golden vectors for i = 0..4 are in `test/vectors.test.ts`; account 0 matches the public
reference vectors and the chain managers' own derivation (no existing address moves).

## Private-key formats

EVM / Tron: hex · BTC: compressed WIF or hex · Solana: base58 64-byte secret, the JSON byte
array, or a base58 32-byte seed · TON: hex seed or 64-byte secret · NEAR: `ed25519:<base58>`.
A 64-byte ed25519 secret must match its embedded public key.

Not yet: TON V4R2/V3R2 wallet versions for an imported key (V5R1 only), BTC P2TR/P2PKH
scanning for an imported WIF (the BTC manager's configured address type is used), non-English
BIP-39 wordlists.

## Security model

- The SDK holds no secret between calls. Each call that signs reads the source's secret from
  `SecretStorage`, builds the chain manager, and the returned handle zeroizes the key on `dispose()`
  (`withAccount` disposes for you).
- `KeyringStorage` only ever sees public data: labels, addresses, indexes, flags and a
  fingerprint (a hash of the master *public* key, or of the imported key's public key).
- Duplicates are caught by that fingerprint — the same seed, the same seed + passphrase, or the
  same key in another format — without keeping anything secret around.
- Error messages never echo words, keys or passphrases.
- `exportSecret()` returns the secret for a backup screen: gate it behind biometrics in the app.
