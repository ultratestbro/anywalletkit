# @forgewallet/wallet-btc

Bitcoin accounts at `m/84'/0'/0'/0/i` (BIP-84 native segwit p2wpkh — the same
path and address type), pinned by golden vectors in
`@forgewallet/conformance`. Message signing is BIP-137 with the p2wpkh header
(`39 + recovery`), base64 — byte-identical to Electrum.

```ts
import WalletManagerBtc from '@forgewallet/wallet-btc'

const wallet = new WalletManagerBtc(seedPhrase, {
  network: 'bitcoin',
  client: [{ type: 'blockbook-http', clientConfig: { url: 'https://btc1.trezor.io' } }],
})
const account = await wallet.getAccount(0)
await account.transfer({ recipient: 'bc1q…', amount: 50_000n })            // sats
await account.sendTransaction({ to: 'bc1q…', value: 50_000n, feeRate: 12n }) // explicit sat/vB
const hex = await account.signTransaction({ to: 'bc1q…', value: 50_000n })   // sign only
wallet.dispose()
```

Coin selection uses `@bitcoinerlab/coinselect` with the exact parameters
(`addr()` descriptors, remainder = the account itself, 141-sat floor, 200-input
cap, 294-sat dust folded into the fee), so any wallet using them and this one pick the
same inputs and pay the same fee for the same spend.

Transports: `blockbook-http` (Trezor Blockbook REST; any `fetch`). `electrum-ws`
is reserved — pass your own object implementing `BtcClient` to use another
backend today.
