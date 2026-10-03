# @forgewallet/wallet-evm

EVM accounts for the forgewallet SDK, derived at `m/44'/60'/0'/0/i` — the same
path as MetaMask and ethers, pinned by golden vectors in
`@forgewallet/conformance`.

```ts
import WalletManagerEvm from '@forgewallet/wallet-evm'

const wallet = new WalletManagerEvm(seedPhrase, { provider: ['https://rpc-a', 'https://rpc-b'] })
const account = await wallet.getAccount(0)
await account.transfer({ recipient: '0x…', amount: 10n ** 15n })                  // ETH
await account.transfer({ token: USDT, recipient: '0x…', amount: 1_000_000n })      // ERC-20
await account.approve({ token: USDT, spender: ROUTER, amount: 1_000_000n })
const sig = await account.signTypedData({ domain, types, message })               // EIP-712
wallet.dispose()                                                                  // zeroizes seed + keys
```

Offline signing: omit `provider`, pass `chainId` (or put it on the tx) and call
`signTransaction` with every field set — nothing touches the network.

The account surface (`getAddress`, `sendTransaction`, `approve`, `getAllowance`,
`quoteSendTransaction`, `getTransactionReceipt`, `getTransactionByHash`) matches
what published protocol modules call, so they run unmodified.
