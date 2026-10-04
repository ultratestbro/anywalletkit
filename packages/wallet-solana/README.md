# @forgewallet/wallet-solana

Solana accounts at `m/44'/501'/i'/0'` (SLIP-10 ed25519 — Phantom / Solflare default),
pinned by golden vectors in `@forgewallet/conformance`.

Signing uses noble ed25519 over the compiled message bytes, so there is no
WebCrypto dependency: the same code runs in Node and in React Native Hermes
without the Ed25519 subtle polyfill.

```ts
import WalletManagerSolana from '@forgewallet/wallet-solana'

const wallet = new WalletManagerSolana(seedPhrase, { provider: ['https://rpc-a', 'https://rpc-b'] })
const account = await wallet.getAccount(0)
await account.transfer({ recipient: 'So1…', amount: 10_000_000n })                 // SOL (lamports)
await account.transfer({ token: USDC_MINT, recipient: 'So1…', amount: 1_000_000n }) // SPL, creates the ATA if missing
await account.sendTransaction(transactionMessage)                                  // any @solana/kit message
wallet.dispose()
```
