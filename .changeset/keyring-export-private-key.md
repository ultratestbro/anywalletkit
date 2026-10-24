---
"@anywalletkit/keyring": minor
---

New `keyring.exportPrivateKey(accountId, chain)` returns one account's private key on one chain, in the format that chain's wallets import:

| Chain | Format |
|---|---|
| EVM | `0x`-hex |
| Tron | hex |
| BTC / Zcash | compressed WIF |
| Solana | base58, 64 bytes (Phantom) |
| NEAR | `ed25519:…` |
| TON | 128 hex |

How it works:
- **Seed accounts:** derived at the chain manager's own path.
- **Imported keys:** exported on their own chain only.
- **TON 24-word wallets:** refused, with a pointer to `exportSecret`.
- **Self-check:** a wallet is built from the key, and its address must equal the account's before anything is returned.
- **Secret reads:** one.

New `formatPrivateKey()` is the inverse of `parsePrivateKey()`.
