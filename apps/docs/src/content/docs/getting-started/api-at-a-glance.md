---
title: API at a glance
description: The twenty operations most wallets need, each with a short snippet and links to its guide and its full API page. The rest of the API reference is lower-level.
sidebar:
  order: 4
---

The [API reference](/api/readme/) lists every exported class, function and type: about two thousand
pages, most of them for module authors. These are the operations an app actually calls. The
snippets come from [`examples/`](https://github.com/ultratestbro/anywalletkit/tree/main/examples),
which CI type-checks and tests on every change; the storage and backup ones from the package
READMEs. Chain ids are CAIP-2 (`eip155:1`, `solana:…`): see [Chain ids](/concepts/chain-ids/).

## Wallet and accounts

**1. Create or restore a seed phrase** — [`getRandomSeedPhrase`](/api/anywalletkit/core/functions/getrandomseedphrase/), [`isValidSeedPhrase`](/api/anywalletkit/core/functions/isvalidseedphrase/)

```ts
import { getRandomSeedPhrase, isValidSeedPhrase } from '@anywalletkit/core'
const phrase = getRandomSeedPhrase(12)          // or 24
isValidSeedPhrase(words)                        // wordlist + checksum
```

**2. Open a wallet on the chains you support** — [`Wallet`](/api/anywalletkit/kit/classes/wallet/) · guide: [Quickstart](/getting-started/quickstart/)

```ts
import { Wallet } from '@anywalletkit/kit'
import { WalletManagerEvm } from '@anywalletkit/wallet-evm'
import { WalletManagerSolana } from '@anywalletkit/wallet-solana'

const wallet = new Wallet(phrase, { policies })  // policies are optional (step 7)
wallet.registerWallet('eip155:1', WalletManagerEvm, { provider: 'https://ethereum-rpc.publicnode.com', chainId: 1 })
wallet.registerWallet('solana', WalletManagerSolana, { provider: 'https://api.mainnet-beta.solana.com' })
// … wallet-ton, wallet-tron, wallet-btc, wallet-near, wallet-zcash the same way
```

**3. Address and balances** — guide: [Balances](/guides/balances/)

```ts
const account = await wallet.getAccount('eip155:1')   // account #0; getAccount(chain, 1) = the next
await account.getAddress()                             // derived locally, no network
await account.getBalance()                             // native, bigint in base units
await account.getTokenBalance('0xdAC17F958D2ee523a2206206994597C13D831ec7') // USDT
```

Read many balances with `Promise.allSettled` and show a failed read as an error, never as 0.

**4. Several accounts, imported seeds and keys** — [`Keyring`](/api/anywalletkit/keyring/classes/keyring/) · guide: [Keyring](/guides/keyring/)

```ts
import { Keyring } from '@anywalletkit/keyring'
const keyring = await Keyring.load({ storage, secrets, chains })
const { account, mnemonic } = await keyring.createMnemonic({ words: 12 })
await keyring.importMnemonic(phrase, { discover: { isUsed, gapLimit: 1, maxIndex: 20 } })
await keyring.addAccount(sourceId, { name: 'Savings' })      // next index of the same seed
await keyring.previewPrivateKey('evm', key)                   // address only, stores nothing
```

**5. Keep the seed on the phone behind Face ID** — [`createSecureStorage`](/api/anywalletkit/secure-storage-react-native/functions/createsecurestorage/) · guide: [Keys and storage](/build-a-wallet/keys-and-storage/#key-storage)

```ts
import { createSecureStorage } from '@anywalletkit/secure-storage-react-native'
const secrets = createSecureStorage({ namespace: 'my-wallet' })   // iOS Keychain / Android Keystore
const keyring = await Keyring.load({ storage, secrets, chains })
```

An Expo native module: a development or Release build, not Expo Go.

**6. Encrypted backup to iCloud** — [`saveBackup`](/api/anywalletkit/backup-cloud/functions/savebackup/), [`restoreBackup`](/api/anywalletkit/backup-cloud/functions/restorebackup/)

```ts
import { iCloudDrive, iCloudKeychain, saveBackup, restoreBackup } from '@anywalletkit/backup-cloud'
const store = iCloudDrive({ container: 'iCloud.com.example.wallet' })
await saveBackup({ store, keyVault: iCloudKeychain(), password, secret, meta })
const opened = await restoreBackup({ store, name, keyVault: iCloudKeychain(), expect: source }) // or { password }
```

## Sending and signing

**7. Guard every write: fee caps, blocklists, a confirm step** — [`Policies`](/api/anywalletkit/kit/interfaces/policies/), [`applyPolicies`](/api/anywalletkit/kit/functions/applypolicies/) · concept: [Policies](/concepts/policies/)

```ts
const policies: Policies = {
  maxFee: { 'eip155:1': 5_000_000_000_000_000n },
  blocklist: { 'eip155:1': ['0x000000000000000000000000000000000000dEaD'] },
  confirm: async (intent) => showReviewSheet(intent),   // false cancels; nothing is signed
}
```

**8. Send** — guide: [Quickstart](/getting-started/quickstart/)

```ts
const transfer = { token: USDT, recipient, amount: 1_000_000n }   // omit token for the native coin
const { fee } = await account.quoteTransfer(transfer)             // nothing is signed
const { hash } = await account.transfer(transfer)                 // simulate → policies → sign → broadcast
await account.getTransactionReceipt(hash)                         // undefined until mined
```

**9. Sign and verify a message**

```ts
const signature = await account.sign('Sign in to example.com')
await account.verify('Sign in to example.com', signature)
```

**10. Show what a transaction will do before signing** — [`previewEvmTx`](/api/anywalletkit/tx-preview-evm/functions/previewevmtx/) · guide: [Transaction preview](/guides/tx-preview/)

```ts
import { previewEvmTx } from '@anywalletkit/tx-preview-evm'
const preview = await previewEvmTx({ chainId: 8453, from, rpc, own: [from], calls })
preview.checks      // simulation-reverted, approval-unlimited, recipient-foreign, contract-unknown, …
preview.simulation  // { status: 'ok', changes } — simulated balance changes per address and token
```

**11. Send to `name.eth`** — [`ensResolver`](/api/anywalletkit/names-ens/functions/ensresolver/), [`nameResolvers`](/api/anywalletkit/core/functions/nameresolvers/) · guide: [Names](/guides/names/)

```ts
import { nameResolvers, assertNameUnchanged } from '@anywalletkit/core'
import { ensResolver } from '@anywalletkit/names-ens'
const names = nameResolvers([ensResolver({ rpcUrl: 'https://ethereum-rpc.publicnode.com' })])
const resolved = await names.resolve('vitalik.eth', 'eip155:8453')
await assertNameUnchanged(names, resolved.name, resolved.chain, resolved.address) // right before signing
```

## Swaps and Earn

**12. Quote a swap or bridge across every provider** — [`RouterSwap2Protocol`](/api/anywalletkit/protocol-swap2-router/classes/routerswap2protocol/) · guide: [Swaps](/guides/swaps/)

```ts
import { RouterSwap2Protocol } from '@anywalletkit/protocol-swap2-router'
const swaps = new RouterSwap2Protocol(account, { fromChain: account.chain, providers: [lifiProvider({}), nearIntentsProvider({}), /* … */] })
const routes = await swaps.quoteSwap2Routes(options, { onUpdate: (routes, pending) => render(routes) })
```

**13. Execute the route the user picked** — guide: [Swaps](/guides/swaps/)

```ts
const { id } = await swaps.using(route.provider).swap2({ ...options, minAmountOut: route.quote.toTokenAmountMin })
```

Pass the minimum you showed; add `slippage` (a decimal) to bound the re-quote.
`suggestSlippage(...)` from `@anywalletkit/protocol-swap2-core/slippage` gives an automatic one.

**14. Track it to the end** — guide: [Swaps](/guides/swaps/)

```ts
const { status, transactions } = await swaps.getSwap2Status(id)
if (status === 'action-required') await swaps.claimSwap2(id, destinationAccount)   // CCTP mint
```

**15. Stake, lend, withdraw** — [`AaveProtocolEvm`](/api/anywalletkit/protocol-lending-aave-evm/classes/aaveprotocolevm/), [Lido](/api/anywalletkit/protocol-staking-lido-evm/classes/default/) · guide: [Earn](/guides/earn/)

```ts
wallet.registerProtocol('aave', AaveProtocolEvm, { chain: 'eip155:1', config: { market: 'core' } })
const aave = await wallet.getProtocol<AaveProtocolEvm>('aave')
await aave.getSupplyApy(USDC)                       // 4.1 = 4.1 %
await aave.supply({ token: USDC, amount })
await aave.withdraw({ token: USDC, amount: 'max' })
await aave.getPosition()                            // supplies, borrows, health factor
```

## Safety, data and networks

**16. List and revoke token approvals** — [`ApprovalsProtocolEvm`](/api/anywalletkit/protocol-approvals-evm/classes/default/) · guide: [Approvals](/guides/approvals/)

```ts
const approvals = await wallet.getProtocol<ApprovalsProtocolEvm>('approvals')
const { approvals: list, coverage } = await approvals.getApprovals()
await approvals.revoke(list[0])
```

**17. Activity history** — [`createEvmHistory`](/api/anywalletkit/history-evm/functions/createevmhistory/) · guide: [History](/guides/history/)

```ts
wallet.registerHistorySource(createEvmHistory({ chainId: 1 }))
const page = await wallet.history({ limit: 20 })           // every chain with a source, labelled by the modules
await wallet.history({ limit: 20, cursor: page.cursor })
```

**18. User RPCs and custom networks** — [`NetworksTable`](/api/anywalletkit/networks/classes/networkstable/) · guide: [Networks](/guides/networks/)

```ts
const table = new NetworksTable(storage); await table.load()
wallet.registerWallet('eip155:1', WalletManagerEvm, { provider: table.rpcUrlsForSync('eip155:1'), chainId: 1 })
await table.addRpc('eip155:1', url)       // after checkRpcUrl + verifyNetwork
```

**19. Run on React Native (Hermes)** — guide: [Installation](/getting-started/installation/#react-native--expo)

```ts
import { installHermesRuntime } from '@anywalletkit/runtime-hermes'
installHermesRuntime()   // first line of your entry file, before any other @anywalletkit import
```

**20. Lock the app** — [`Wallet`](/api/anywalletkit/kit/classes/wallet/)

```ts
wallet.dispose()   // zeroizes the seed and keys; build a new Wallet on unlock
```

## Everything else

The API reference also documents the building blocks: provider classes for each swap venue,
chain-specific account types, error classes, catalog data and the conformance kit for
[writing your own module](/build-with-ai/own-module/). Errors you branch on are listed in
[Errors](/concepts/errors/).
