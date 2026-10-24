# AGENTS.md — Any Wallet Kit for coding agents

A compact, exact reference for AI coding agents (Claude Code, Cursor, Codex…) building on
Any Wallet Kit. Every name below exists in the packages; when something is not here, read
the guides as plain text at **https://docs.anywallet.tech/llms-small.txt**, the generated API
reference in **https://docs.anywallet.tech/llms-full.txt** (search it, it is large), the twenty everyday
operations at **https://docs.anywallet.tech/getting-started/api-at-a-glance/**, or the
per-package `README.md` (shipped inside each npm package). Do not invent APIs.

## What it is

An open multichain wallet SDK in TypeScript. One seed (or an external signer) gives accounts on
EVM (30+ networks), Solana, TON, Tron, Bitcoin, NEAR and Zcash. Protocol modules add swaps and
bridges (one router over 14 venues), staking, lending, approvals, history and names. React Native
(Hermes) is the primary target; Node ≥ 20 works without polyfills. ESM + CJS, types included.

All packages are `@anywalletkit/*` **on npm** (https://www.npmjs.com/org/anywalletkit), published from
CI with provenance. Install only what you use, with any package manager:

```sh
npm install @anywalletkit/kit @anywalletkit/wallet-evm        # + the chains / modules you need
# pnpm add …  ·  yarn add …  ·  Expo: npx expo install …
```

Protocol and data packages take `@anywalletkit/core` as a peer: install it next to them. Pin versions
exactly while the SDK is `0.x` (minor releases may change the API). Never vendor or copy SDK source
into the app; never install from GitHub.

| Need | Packages |
|---|---|
| Wallet orchestrator, policies | `core`, `kit` |
| Chains | `wallet-evm`, `wallet-solana`, `wallet-ton`, `wallet-tron`, `wallet-btc`, `wallet-near`, `wallet-zcash` |
| Many accounts, imports | `keyring` |
| Seed on the phone (Face ID / passcode) | `secure-storage-react-native` (Expo module: dev build, not Expo Go) |
| Encrypted backup file / iCloud backup | `seed-vault`, `backup-cloud` |
| Hermes polyfills | `runtime-hermes` |
| Swaps and bridges | `protocol-swap2-router` + providers: `protocol-swap2-{lifi,near-intents,thorchain,chainflip,cctp,usdt0,uniswap,balancer,wrap,jupiter,omniston,fynd}`; engine/types in `protocol-swap2-core`; token catalog `swap2-assets` |
| Earn | `protocol-staking-{lido-evm,ssv-evm,tonstakers-ton,spl-stake-pool-solana}`, `protocol-lending-{aave-evm,morpho-evm,mellow-evm,kamino-solana}` |
| Safety and data | `tx-preview-evm`, `protocol-approvals-evm`, `history-evm`, `names-ens`, `networks` |
| Testing your own module | `conformance` (Vitest suites) |

## Chain ids (CAIP-2)

| Chain | `account.chain` / `registerWallet` | catalog id (`swap2-assets`, `networks`, swap2) |
|---|---|---|
| Ethereum / any EVM | `eip155:1` / `eip155:<id>` | same |
| Solana | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | `solana:mainnet` |
| Tron | `tron:0x2b6653dc` | `tron:728126428` |
| Bitcoin | `bip122:000000000019d6689c085ae165831e93` | `bitcoin:mainnet` |
| TON | `ton:-239` | same |
| NEAR | `near:mainnet` | same |
| Zcash | `zcash:mainnet` | same |

Two id forms exist for Solana, Tron and Bitcoin. Accounts report the genesis-hash form; the catalogs
(`ccChain` / `ccAsset` in `swap2-assets`, `builtinNetwork` / `NetworksTable` in `networks`) are keyed by
the catalog id, so `builtinNetwork('solana:5eykt…')` is `undefined` — convert first with
`swap2ChainId(account.chain)` from `protocol-swap2-core` (or the three-entry map above). The swap
engine accepts either form for `fromChain` / `toChain`. Register **each EVM network under its exact id with its own
RPC**; registering `'eip155'` once sends every EVM chain's transactions to that one RPC's network.
Other families register by namespace: `'solana'`, `'ton'`, `'tron'`, `'bip122'`, `'near'`, `'zcash'`.

## Money rules

- Amounts are `bigint` in base units (wei, lamports, satoshi, nanotons). Never use `Number`/floats for
  money; `Number(bigint)` is wrong above 2^53 and returns garbage on Hermes above 2^63. Use
  `bigintToUnits` / `bigintToNumber` from `core` only for display.
- Token ids for `getTokenBalance` / `transfer` are the chain's own (ERC-20 address, SPL mint, jetton
  master). Native coin: omit `token`.
- Always show the **guaranteed minimum** of a swap (`toTokenAmountMin`), not the expected amount.

## React Native / Expo setup (do this first)

```sh
npx expo install react-native-get-random-values
npm i @anywalletkit/runtime-hermes buffer fastestsmallesttextencoderdecoder react-native-url-polyfill
```

```js
// polyfills.js — imported before anything else
import 'react-native-get-random-values'          // 1. secure randomness, must be first
import { Buffer } from 'buffer'
globalThis.Buffer ??= Buffer                       // 2. TON / Bitcoin libraries read it
import 'fastestsmallesttextencoderdecoder/EncoderDecoderTogether.min.js' // 3. TextDecoder
import 'react-native-url-polyfill/auto'            // 4. a URL with working searchParams
import { installHermesRuntime } from '@anywalletkit/runtime-hermes'
installHermesRuntime()                             // 5. AbortSignal.timeout/any, subtle.digest, structuredClone, Buffer.subarray
```

```js
// index.js — package.json "main": "index.js"
import './polyfills'
import 'expo-router/entry'
```

With `wallet-ton` in the app, also `npx expo install expo-crypto` and add to `metro.config.js`
(the TON crypto library requires a native `react-native-fast-pbkdf2`; this resolves it to a JS drop-in):

```js
const { getDefaultConfig } = require('expo/metro-config')
const config = getDefaultConfig(__dirname)
const resolveRequest = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) =>
  moduleName === 'react-native-fast-pbkdf2'
    ? { type: 'sourceFile', filePath: require.resolve('@anywalletkit/runtime-hermes/fast-pbkdf2') }
    : (resolveRequest ?? context.resolveRequest)(context, moduleName, platform)
module.exports = config
```

Import order matters: ES `import`s are hoisted, so keep the polyfills in their own module and import
it first from the entry file. `installHermesRuntime()` throws if randomness, TextEncoder/Decoder or
a full `URL` is missing; `installHermesRuntime({ throwOnMissing: false })` returns a report instead.
Test on a Release build; debug builds can hide Hermes problems.

## Create a wallet, addresses, balances, send

```ts
import { Wallet, type Policies } from '@anywalletkit/kit'
import { getRandomSeedPhrase, isValidSeedPhrase } from '@anywalletkit/core'
import { WalletManagerEvm } from '@anywalletkit/wallet-evm'
import { WalletManagerSolana } from '@anywalletkit/wallet-solana'
import { WalletManagerTon } from '@anywalletkit/wallet-ton'
import { WalletManagerTron } from '@anywalletkit/wallet-tron'
import { WalletManagerBtc } from '@anywalletkit/wallet-btc'
import { WalletManagerNear } from '@anywalletkit/wallet-near'

const phrase = getRandomSeedPhrase(12)            // or 24; isValidSeedPhrase(words) checks wordlist + checksum
const wallet = new Wallet(phrase, { policies })    // or new Wallet(seedBytes64) / new Wallet(signer)
wallet.registerWallet('eip155:1', WalletManagerEvm, { provider: 'https://ethereum-rpc.publicnode.com', chainId: 1 })
wallet.registerWallet('eip155:8453', WalletManagerEvm, { provider: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'], chainId: 8453 }) // a list fails over
wallet.registerWallet('solana', WalletManagerSolana, { provider: 'https://api.mainnet-beta.solana.com' })
wallet.registerWallet('ton', WalletManagerTon, { tonClient: { url: 'https://toncenter.com/api/v2/jsonRPC' } })
wallet.registerWallet('tron', WalletManagerTron, { provider: 'https://api.trongrid.io' })
wallet.registerWallet('bip122', WalletManagerBtc, { client: { type: 'esplora-http', clientConfig: { url: 'https://mempool.space/api' } } })
wallet.registerWallet('near', WalletManagerNear, { provider: 'https://free.rpc.fastnear.com' })

const account = await wallet.getAccount('eip155:1')        // account #0; getAccount(chain, 1) = next
await account.getAddress()                                 // derived locally, no network
await account.getBalance()                                 // native, bigint
await account.getTokenBalance('0xdAC17F958D2ee523a2206206994597C13D831ec7') // USDT, 6 decimals
const transfer = { token: '0xdAC1…', recipient, amount: 1_000_000n }      // omit token for native
const { fee } = await account.quoteTransfer(transfer)       // nothing signed
const { hash } = await account.transfer(transfer)           // simulate → policies → sign → broadcast
await account.getTransactionReceipt(hash)                   // undefined until mined
await account.sign('message'); await account.verify('message', sig)
wallet.dispose()                                            // zeroizes seed + keys; build a new Wallet on unlock
```

`IWalletAccount` (every chain): `chain`, `getAddress`, `getBalance`, `getTokenBalance`, `quoteTransfer`,
`transfer`, `quoteSendTransaction`, `sendTransaction`, `signTransaction`, `sign`, `verify`,
`getTransactionReceipt`, `toReadOnlyAccount`, `dispose`. Read balances with `Promise.allSettled` and
show a failed read as an error, never as 0.

Errors: `core` has `InsufficientFundsError`, `UserRejectedError`, `ReadOnlyAccountError`, `NetworkError`,
`SignerError`; `wallet-evm` adds `SimulationError` (the transfer would revert — `quoteTransfer` of a token
the account does not hold fails this way, so an empty wallet cannot quote token fees),
`ChainMismatchError`, `UnsafeTransactionError` and `BroadcastUnknownError` (sent, no answer from the node:
`.hash` may still land — treat as pending, never resend).

Token lists: `builtinNetwork(catalogId)` (`networks`) gives the native symbol/decimals (TON's coin is
GRAM since 2026); `ccChain(catalogId)?.assets` (`swap2-assets`) lists catalog tokens `{ symbol, decimals, contract }`.

## Policies (run before every signature, including protocol modules)

```ts
const policies: Policies = {
  maxFee: { 'eip155:1': 5_000_000_000_000_000n },              // native base units
  allowlist: { 'eip155:1': ['0x…'] },                          // recipients, contracts, spenders
  blocklist: { 'eip155:1': ['0x000000000000000000000000000000000000dEaD'] },
  confirm: async (intent) => showSheet(intent),                // WriteIntent: method, chain, from, to, kind, raw
}
```

A broken rule throws `PolicyViolationError` (`.policy`); a `false` from `confirm` throws
`UserRejectedError`. `applyPolicies(account, policies, account.chain)` wraps a single account
(e.g. one from the keyring).

## Keys on the phone, many accounts, imports (`keyring`)

```ts
import { Keyring, type KeyringStorage } from '@anywalletkit/keyring'
import { createSecureStorage } from '@anywalletkit/secure-storage-react-native'

const secrets = createSecureStorage({ namespace: 'my-wallet' })   // Face ID / Touch ID, passcode fallback; every read prompts
const storage: KeyringStorage = {                                 // plain storage: names, addresses — no secrets
  load: async () => JSON.parse((await AsyncStorage.getItem('awk.keyring')) ?? 'null'),
  save: (state) => AsyncStorage.setItem('awk.keyring', JSON.stringify(state)),
}
const keyring = await Keyring.load({ storage, secrets, chains: {
  evm: { Manager: WalletManagerEvm, config: { provider: RPC_ETH, chainId: 1 } },
  solana: { Manager: WalletManagerSolana, config: { provider: RPC_SOL } },
} })                                                   // ChainKey: evm | solana | ton | tron | btc | near | zcash

const { account, mnemonic } = await keyring.createMnemonic({ words: 12 })  // mnemonic: backup screen only, then drop it
await keyring.importMnemonic(phrase, { discover: { isUsed, gapLimit: 1, maxIndex: 20 } })
await keyring.addAccount(sourceId, { name: 'Savings' })
keyring.listAccounts()                                 // AccountMeta[]: id, sourceId, index, name, hidden, addresses — no prompt
await keyring.renameAccount(id, 'x'); await keyring.setActiveAccount(id); await keyring.setHidden(id, true)
await keyring.previewPrivateKey('evm', key)            // address, stores nothing
await keyring.importPrivateKey('evm', key, { label: 'Imported' })
await keyring.importTonMnemonic(words24)               // Tonkeeper / Tonhub format
const sig = await keyring.withAccount(id, 'evm', (acc) => applyPolicies(acc, policies, acc.chain).sign('hi')) // key zeroized after
await keyring.exportSecret(sourceId); await keyring.exportPrivateKey(id, 'evm')  // behind your own re-authentication
await keyring.removeSource(sourceId)
```

**Balances without a biometric prompt.** Build read-only accounts from `AccountMeta.addresses`:
`new WalletAccountReadOnlyEvm(address, { provider })`, and likewise `WalletAccountReadOnlySolana`,
`WalletAccountReadOnlyTron`, `WalletAccountReadOnlyBtc`, `WalletAccountReadOnlyNear` (each from its chain
package), then `getBalance()`. TON is the exception: `new WalletAccountReadOnlyTon(publicKey, config)`
needs the 32-byte public key, which `AccountMeta` does not keep. Read it once at onboarding with
`keyring.withAccount<Uint8Array, WalletAccountTon>(id, 'ton', async (a) => a.publicKey)`, and store its hex in plain storage (it is
public).

**One EVM network per keyring.** `chains.evm` takes one config (one RPC), so `withAccount(id, 'evm', …)`
signs on that network only. The address is the same on every EVM network. To sign on Base too, load a
second `Keyring` over the same `secrets`, with `chains: { evm: { Manager: WalletManagerEvm, config: { provider: BASE_RPC, chainId: 8453 } } }`,
and a `storage` whose `save` does nothing (the first keyring owns the metadata).

`secure-storage-react-native` needs `NSFaceIDUsageDescription` in Info.plist and a dev/Release build
(it is a native Expo module). In Expo Go, implement `SecretStorage` (`get`/`set`/`delete`) over
`expo-secure-store` with `requireAuthentication: true` instead. `keyring.getAccount(id, chain)` returns a
handle for repeated use; prefer `withAccount` for one-off signing.

## Your server (`protocol-swap2-core/server`, `examples/server`)

Keys you pay for (RPC, provider API keys, affiliate settings) stay on a server; the app talks to it.

```ts
// server (Node ≥ 20 / edge): POST /swap2/:action
import { createSwap2Handler, Swap2HandlerError } from '@anywalletkit/protocol-swap2-core/server'
const handle = createSwap2Handler({ providers: [lifiProvider({ apiKey })], sealSecret /* ≥ 32 bytes */, guard: (call, req) => { /* auth + per-user rate limit; throw new Swap2HandlerError(401|429, …) */ } })
const { status, body } = await handle(action, json, req)

// app: the same router, providers proxied — the engine still validates everything on the device
import { remoteProvider } from '@anywalletkit/protocol-swap2-core/remote'
const providers = ['lifi', 'near_intents', 'thorchain', 'chainflip'].map((name) => remoteProvider({ name, baseUrl: `${API}/swap2`, headers: { authorization: `Bearer ${token}` } }))
```

Quotes are HMAC-sealed: `build`/`preflight` refuse an unsealed, altered or expired quote. Never
import `./server` into the app. `examples/server` adds a JSON-RPC proxy (method allowlist, failover)
and an EIP-1193 client for it; walkthrough: https://docs.anywallet.tech/build-a-wallet/ship-a-wallet/.

## Swaps and bridges (`protocol-swap2-router`)

```ts
import { RouterSwap2Protocol, type Swap2Route } from '@anywalletkit/protocol-swap2-router'
import { lifiProvider } from '@anywalletkit/protocol-swap2-lifi/provider'
import { nearIntentsProvider } from '@anywalletkit/protocol-swap2-near-intents/provider'
import { chainflipProvider } from '@anywalletkit/protocol-swap2-chainflip/provider'
import { uniswapProvider } from '@anywalletkit/protocol-swap2-uniswap/provider'
import { suggestSlippage, Swap2MaybeSentError, Swap2QuoteError } from '@anywalletkit/protocol-swap2-core'

const swaps = new RouterSwap2Protocol(account, {
  fromChain: account.chain,                              // the source is the account's chain
  providers: [lifiProvider({}), nearIntentsProvider({}), chainflipProvider(), uniswapProvider({ rpcUrls: { 1: [RPC_ETH] } })],
  onExecutionPhase: (phase) => setPhase(phase),          // approving → requoting → preflight → signing → broadcast
  reviewExecution: async (plan) => { if (!(await confirm(plan))) throw new Error('cancelled') }, // BEFORE any approval/signature
})
const slip = suggestSlippage({ fromChain: account.chain, toChain, fromSymbol: 'USDC', toSymbol: 'ETH' }).bps // auto slippage, bps
const options = { fromToken: 'USDC', toToken: '0x8335…2913', toChain: 'eip155:8453', fromTokenAmount: 100_000_000n,
  recipient: await account.getAddress(), slippage: slip / 10_000 }          // toToken: destination chain's address or symbol; omit toChain for same-chain
const routes = await swaps.quoteSwap2Routes(options, { onUpdate: (routes, pending) => render(routes, pending.length > 0) })
// Swap2Route: { provider, quote: { toTokenAmount, toTokenAmountMin, estimatedDuration, fees }, netValueUsd, relativeValue, tags: ['best'|'fastest'] }
const { id } = await swaps.using(route.provider).swap2({ ...options, minAmountOut: route.quote.toTokenAmountMin })
const { status, transactions } = await swaps.getSwap2Status(id)   // poll every ~10 s
// status: pending… | 'action-required' (CCTP: await swaps.claimSwap2(id, destinationAccount)) | completed | failed | refunded | cancelled | expired | partial
```

- `quoteSwap2(options)` returns the single best quote; `quoteSwap2Routes` streams every provider's.
- Execution **requires** `minAmountOut` and re-quotes; pass the same `slippage` you quoted with.
- Errors: `Swap2MaybeSentError` (may be on chain — never retry, track `e.id`/`e.hash`), `Swap2InFlightError`
  (double tap), `Swap2InsufficientGasError`, `Swap2FeeLimitError`, `Swap2QuoteError` (no route; message says why).
- Keys: LI.FI `apiKey` (rate limit), 1Click `jwt` (no fee). Fynd needs an `apiKey`. Chainflip, Uniswap,
  Balancer, Wrap, CCTP, USDT0 need no key; on-chain venues need `rpcUrls`.
- Also via the kit: `wallet.registerProtocol('swap', RouterSwap2Protocol, { chain, config: { fromChain: chain, providers } })`
  then `await wallet.getProtocol<RouterSwap2Protocol>('swap')` — policies then wrap the router's account.

## Transaction review (`tx-preview-evm`)

```ts
import { previewEvmTx, type Rpc, type TxPreview } from '@anywalletkit/tx-preview-evm'
const rpc: Rpc = async (method, params) => { /* JSON-RPC POST; on error throw Object.assign(new Error(msg), body.error) */ }
const preview = await previewEvmTx({ chainId: 1, from, rpc, own: [from], known: { [router]: 'Uniswap' },
  calls: [{ to, data, value }], expectedApproval: amount })
preview.checks      // [{ code, status, detail }] — codes: simulation-reverted, simulation-unavailable, approval-unlimited,
                    // approval-excess, approval-unknown-spender, contract-unknown, recipient-foreign, …
preview.simulation  // { status: 'ok', changes: [{ token, symbol, decimals, delta: bigint }] } | { status: 'reverted'|'unavailable', reason }
```

Wire it into `policies.confirm` (preview `intent.raw` for `sendTransaction`/`approve` on `eip155:*`) and into a
swap's `reviewExecution` (`plan.approvals` + `plan.source` when `plan.source.kind === 'call'`). The
copy and the language of warnings are yours: map codes to text.

## Earn

```ts
import LidoProtocolEvm from '@anywalletkit/protocol-staking-lido-evm'
import { AaveProtocolEvm } from '@anywalletkit/protocol-lending-aave-evm'
import { MorphoVaultProtocolEvm, MorphoApi } from '@anywalletkit/protocol-lending-morpho-evm'

wallet.registerProtocol('lido', LidoProtocolEvm, { chain: 'eip155:1' })
wallet.registerProtocol('aave', AaveProtocolEvm, { chain: 'eip155:1', config: { market: 'core' } })
const lido = await wallet.getProtocol<LidoProtocolEvm>('lido')
await lido.quoteStake({ amount }); await lido.stake({ amount })              // ETH → stETH
await lido.getStakedBalance(); await lido.getApr()                           // .total; APR percent (2.7 = 2.7 %)
await lido.requestWithdrawal({ amount }); const q = await lido.getWithdrawalRequests()
if (q.claimableIds.length) await lido.claimWithdrawals({ ids: q.claimableIds })
const aave = await wallet.getProtocol<AaveProtocolEvm>('aave')
await aave.getSupplyApy(USDC); await aave.quoteSupply({ token: USDC, amount }); await aave.supply({ token: USDC, amount })
await aave.withdraw({ token: USDC, amount: 'max' }); await aave.getPosition()  // { supplies, borrows, account: { healthFactor } }
const [best] = await new MorphoApi().listVaults({ chainId: 8453, asset: USDC_BASE })
const vault = new MorphoVaultProtocolEvm(baseAccount, { vault: best.address })
await vault.getApy(); await vault.supply({ amount }); await vault.getPosition(); await vault.withdraw({ amount: 'max' })
```

Protocol classes also construct directly over any account: `new AaveProtocolEvm(account, { market: 'core' })`,
`new LidoProtocolEvm(account)`. Apps on the `keyring` (which has no `registerProtocol`) do exactly that:
reads and quotes over a read-only account (no prompt), writes inside
`keyring.withAccount(id, 'evm', (a) => new AaveProtocolEvm(applyPolicies(a, policies, a.chain), cfg).supply(…))`.

Staking = `stake` → `requestWithdrawal` → wait → `claimWithdrawals` (two-phase). Lending = `supply` /
`withdraw` (+ `borrow` / `repay` where the market allows). Every write has a `quote*` twin that signs nothing.
Other modules: SSV (`protocol-staking-ssv-evm`, default export), Tonstakers (TON), SPL stake pool / Jito
(Solana), Mellow (EarnETH/EarnUSD), Kamino (`KaminoVaultProtocolSolana`, `KaminoMarketProtocolSolana`).

## History, names, networks

- History: `wallet.registerHistorySource(createEvmHistory({ chainId: 1 }))` (`history-evm`; optional explorer keys),
  `createSolanaHistory` / `createTonHistory` / `createTronHistory` from the chain packages, then
  `await wallet.history({ limit: 20, cursor })` → items with modules' descriptions ("Supplied 100 USDC · Aave v3").
- Names: `nameResolvers([ensResolver({ rpcUrl: ETHEREUM_RPC })])` (`core` + `names-ens`); `resolver.supports(text)`,
  `await resolver.resolve('vitalik.eth', chain)` → `ResolvedName`; errors are `NameError` with a `code`.
- Networks: `new NetworksTable(storage)` + `await table.load()`; `table.rpcUrlsForSync(caip2)` feeds `provider`;
  `checkRpcUrl` / `verifyNetwork` before saving a user RPC.

## Keys elsewhere: hardware, MPC, backend bots

```ts
import { externalSigner, UserRejectedError } from '@anywalletkit/core'
const signer = externalSigner({ curve: 'secp256k1', publicKey /* 33-byte compressed */, sign: async (digest, opts) => sig65 })
const wallet = new Wallet(signer, { policies })   // one signer = one key = one curve
```

A Node bot that holds a seed: read it from a secret manager / env at start (never from the repo), build
`new Wallet(phrase, { policies: { allowlist, maxFee } })`, keep the allowlist tight (payout addresses,
venue contracts), quote before every write, log hashes and addresses only, call `dispose()` on shutdown.

## Writing a protocol module

- Extend a base class from `core`: `StakingProtocol`, `LendingProtocol`, `Swap2Protocol` (or
  `SingleProviderSwap2` / a `CrossChainProvider` for swap venues), `ApprovalsProtocol`. Unimplemented
  methods throw `NotImplementedError`; writes call `this.requireSigningAccount('method')`.
- Reads: the account interface has no generic contract read. Take an RPC in the config (`provider`,
  like the Aave module) and read with your own viem `PublicClient`; a `wallet-evm` account also has
  `simulateTransaction(tx)`.
- Implement `describeActivity(tx, ctx)` (pure, sync, no network) so wallets label your transactions.
  `ChainTx` carries `chain`, `hash`, `status`, `address`, `from`, `to`, `nativeValue`, `transfers`
  (token movements), `call` (`to`, `selector`, `data`) and `raw`; match on `call.to` + `call.selector`
  and the `transfers`, as the shipped modules do (`callsContract` / `matchesCall` in `protocol-swap2-core`).
- Test with `@anywalletkit/conformance` under Vitest:
  `describeProtocolModule('my-module', { type: 'staking', Protocol: MyProtocol, config, samples: { quoteStake: [{ amount: 1n }] }, activity: { fixtures, negatives } })`,
  plus `describeProtocolBehaviour` for swap2 modules and `createMockAccount()` for unit tests.
- Ship a `module.json` (`name`, `type`, `chains`, `tier: "community"`, `maintainers` as GitHub handles (`"@you"`), `conformance: "0.x"`,
  `repo`, `description`, `addedAt`). Modules live in **your own repository and npm scope**; the SDK
  repo does not accept pull requests yet. The registry lists external modules from `registry/external.json`.

## Pitfalls

- Expo Go cannot load `secure-storage-react-native` / `backup-cloud` (native modules): use a dev or Release build.
- Missing polyfills show up as `crypto.getRandomValues must be defined`, `Buffer is not defined`,
  `TextDecoder is not defined`, `AbortSignal.timeout is not a function`, or URLs without `searchParams`.
- Never `Number()` a balance; never `JSON.stringify` a bigint without a replacer (`(k, v) => typeof v === 'bigint' ? v.toString() : v`).
- One EVM registration per network; an account's transactions go to its manager's RPC.
- A swap's `toToken` is the **destination** chain's token id (or symbol); `fromToken` the source's.
- `Swap2MaybeSentError` means "maybe broadcast": never auto-retry a swap or a transfer.
- Public RPCs rate-limit; production apps pass their own endpoints (each `provider` accepts a list).

## Security rules (non-negotiable)

- Never log, print, send or persist the seed phrase, seed bytes or private keys (no analytics, crash
  reports, clipboard, plain storage). SDK objects never expose keys as properties.
- Keep the phrase in a JS string only on the backup screen; store it via secure storage behind
  biometrics or passcode; block screenshots on the phrase screen.
- Show a review (amounts, minimum received, recipient, fees, approvals) before every signature; use
  `policies.confirm` / `reviewExecution`. Prefer exact approvals over unlimited ones.
- Test with tiny amounts or testnets first. Never hard-code real secrets; examples use the public test
  phrase `abandon abandon … about`.
