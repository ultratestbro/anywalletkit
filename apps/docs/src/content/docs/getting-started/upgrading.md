---
title: Upgrading
description: What to change in your app when you move to a new Any Wallet Kit release — the latest security releases first.
sidebar:
  order: 5
---

Versions are `0.x`, so a minor release may change the API. A `^0.y` range never picks up the next minor
release by itself: you take these changes when you bump. Each package's CHANGELOG lists its changes;
the lines marked **Breaking** are the ones that need something from you. This page groups them by what
your app does.

## Next release: policies, snapshots and EVM nonces

This release fixes six findings of the 2026-10-30 scan in `kit` and `wallet-evm`.

### Allowance increases are approvals (`kit`)

A raw `increaseAllowance(spender, x)` or `increaseApproval(spender, x)` call reaches `confirm` as
`kind: 'approval'` with the spender in `to` and the increase in `amount` (it was a `send` to the
token, and `increaseApproval`'s spender was never checked by the lists). Show it like an approve.

### Permit2 is read through its declared schema (`kit`, `wallet-evm`)

The Permit2 approval `confirm` sees — `approvals`, `token`, `amount`, `unlimited`, `to`, `deadline` — comes
only from fields the typed data declares, as Permit2 signs them. A payload whose schema is not Permit2's
(a missing or retyped `details` / `permitted`, both declared, a list where one entry belongs) reaches
`confirm` as the worst case: `unlimited: true`, `approvals: []`; one without a declared `spender` has an
unknown destination, so an allowlist refuses it. `describeTypedData` flags such a payload
`approve-unlimited`. Canonical Permit2 payloads from Uniswap, 1inch and other dApps read as before.

### Case-sensitive addresses are compared exactly (`kit`)

Allowlist and blocklist entries for Solana (and Bitcoin / Zcash base58, and any namespace without its
own rule) must be spelled exactly as the address: they were compared lowercased, which let a different
Solana key that differs only in letter case pass an allowlist. EVM, NEAR, Aptos and Starknet entries
still match in any case, bech32 Bitcoin / Zcash addresses in either case, Tron and TON in any of their
forms. If your lists hold lowercased Solana keys, store them as the wallet shows them.

### `nonce too low` from one RPC is not re-signed (`wallet-evm`)

A send whose transaction the node refuses with "nonce too low", and whose hash it says it never saw, was
signed again with the next nonce. The RPC that refused already holds the first signed bytes, so a lying
RPC could broadcast both. Now the account signs again only when at least two distinct configured RPCs
show the nonce mined by another transaction. Otherwise the send throws `NonceConflictError` — a
`BroadcastUnknownError` (`maybeSent: true`, `hash`), with `nonce` and the node's `nextNonce`. Apps should
show "the network didn't confirm — check activity, then retry": keep the operation pending on `hash`,
and let the user send again once activity shows the first transaction is not coming; the account's next
send already skips the refused nonce. With one RPC configured, a stale `pending` nonce now costs one
retry instead of being fixed silently; configure two RPCs to keep the automatic recovery.

## Next release: the 2026-10-30 scan (remote swap pins)

- **THORChain memo.** `thorchainPins().verifyBuild` refuses a remote build whose memo is not exactly the
  canonical memo for the request (output asset, destination/refund, limit, affiliate). Your server's
  `thorchainProvider` already builds that memo; nothing to wire.
- **CCTP burn decoded on the device.** `cctpPins` carry `verifyQuote` (`cctpVerifyQuote`): a remote
  `depositForBurn` must burn exactly the input of the source USDC for the recipient on the requested
  domain, with no destination caller and a `maxFee` that leaves the quoted minimum. Spread the pins as
  before.
- **USDT0 send decoded on the device.** `usdt0Pins` carry `verifyQuote` (`usdt0VerifyQuote`): the OFT
  `send` must go to the requested chain's eid and recipient, move exactly the input with a
  `minAmountLD` that keeps the quoted minimum, carry no options or compose message, refund the trader,
  and attach the declared native fee. Spread the pins as before.
- **Wrap call checked on the device.** `wrapPins` carry `verifyQuote` (`wrapVerifyQuote`): only
  `deposit()` with the input as value, or `withdraw(input)` with no value, on the chain's wrapped
  native, for the sender.
- **LI.FI Diamond call decoded on the device.** `lifiPins` carry `verifyQuote` (`lifiVerifyQuote`):
  the same calldata check the server's provider runs on LI.FI's answer — receiver, minimum, input,
  output token, destination chain — runs again in the app, with the input's value and approval.
  Checked against live LI.FI answers on 32 corridors (every route the provider accepts passes).
- **Breaking: a pinned call needs a check of the call.** A remote stub's EVM calldata route — a call on
  a contract its `callTargets` pin — now also needs the app's own check of what the call does:
  `verifyQuote` or `verifyBuild` on `remoteProvider`. Without either, the router and the
  single-provider path drop the route with the reason, and the engine refuses it. Every shipped EVM
  pins export carries one (`lifiPins`, `cctpPins`, `usdt0Pins`, `wrapPins`, `uniswapPins`,
  `balancerPins`, `fyndPins`, `chainflipPins`; `thorchainPins()` checks builds), so spreading the
  pins is enough. If you build `callTargets` by hand, pass a `verifyQuote` or `verifyBuild` that
  decodes the call against the request. Omniston: keep adding
  `verifyBuild: omnistonVerifyBuild(...)` next to `...omnistonPins(...)` — `omnistonPins` alone has no
  check, and the app-supplied `verifyBuild` satisfies this rule. NEAR Intents (`nearIntentsPins`)
  and Jupiter are not affected: they pin no EVM call targets.

## Next release: the 2026-10-30 scan fixes

### Omniston

- **TON → TON swaps need `validateTonSwapLeg`.** Same-chain TON swaps are advertised and built only with
  `validateTonJettonWallet`, `validateTonSwapTarget` and `validateTonSwapLeg`: the leg check is what proves
  the DEX pays out the quoted token. A server that builds Omniston locally and wires the TON validators one
  by one loses TON → TON routes until it passes the leg check too — use `createOmnistonTonValidators()`
  whole (`omnistonProvider({...createOmnistonTonValidators(), ...})`). On the device,
  `omnistonVerifyBuild` refuses a TON swap body without `validateTonSwapLeg`; spreading
  `createOmnistonTonValidators()` into it, as the guide shows, already passes it.
  `tonSwapPayloadCheck: "report"` keeps building without it as an explicit, temporary opt-in.
- **FULLY_FILLED needs proof.** `trackIntent` reports an Omniston order `completed` only once every
  execution's secret was disclosed or a delivery locator (`locateEvmDelivery`, `locateTonDelivery`)
  found the payout; a feed that says FULLY_FILLED without that stays `pending` and keeps its secrets.
  Keep polling pending orders and keep your refund backstop as before; an order that never shows a
  disclosure or a delivery is closed by TTL or by the backstop, not by the feed.
- **Intent ids carry the quote's digest.** An Omniston intent id now ends its dest segment with
  `#<digest>` of the quote's terms, and a build whose cached quote differs refuses with "quote was
  replaced — request a fresh quote"; a reused quote id with other terms is refused at quote time. Quotes
  issued by the previous version (no digest) are refused on build with "request a fresh quote" — a quote
  is valid for under a minute, so only a quote taken right across the deploy is affected; re-quote.
  Orders already signed keep being tracked and disclosed. If your code splits the id, strip `#…` from
  the dest segment; the quote id, trader and source chain segments are unchanged.

## Next release: the 2026-10-30 scan, chain packages

- **NEAR AddKey permissions are exactly one variant.** `wallet-near` refuses an AddKey whose
  permission is not exactly `{ fullAccess: {} }` or `{ functionCall: { receiverId, methodNames,
  allowance? } }` (`malformed-action`); it used to encode anything else as FullAccess. Keys built
  from the documented shapes are unchanged.
- **Tron history fails instead of hanging on a malformed page.** `listActivity` throws
  `HistoryUnavailableError` when a TronGrid row's `block_timestamp` is not a non-negative integer;
  it used to loop forever. Handle it like any other history outage.
- **Tonstakers derives the tsTON jetton wallet.** The unstake destination is computed on the device
  from the minter's pinned wallet code and must match the node's `get_wallet_address`. The default
  mainnet and testnet deployments need nothing. With a custom `addresses.jetton`, pass that minter's
  `jettonWalletCode`, or `allowUnverifiedJettonWallet: true` to keep the old unchecked behaviour.
- **SPL stake-pool delayed exits reclaim pre-funded slots.** When someone sent SOL to the wallet's
  next delayed-exit slot address, the exit transaction now starts with a System `TransferWithSeed`
  that returns that SOL to the wallet. A signing review shows one extra incoming transfer; nothing
  to change in the app.

## Next release: remote swaps checked on the device

This release fixes four findings of the 2026-10-28 scan in `remoteProvider` setups. If you run swaps
through your own server:

- **Pins now open the call.** `uniswapPins` and `balancerPins` carry `verifyQuote`
  (`uniswapVerifyQuote`, `balancerVerifyQuote`): the router or Vault call is decoded on the device and
  must be exactly the swap the user asked for — tokens, input, minimum, recipient. `chainflipPins`
  carry `chainflipVerifyQuote`. Spread the pins as before; nothing else to wire.
- **Deposit-address routes need an opt-in.** A remote stub's route that pays an address the server
  names — a deposit address or a plain value send — is refused unless the stub has
  `depositAddressRoutes: true`. `nearIntentsPins`, `thorchainPins()` (Tron) and `chainflipPins` (Tron)
  set it; add `...nearIntentsPins` to your NEAR Intents stub.
- **Remote typed orders need `verifyBuild`.** The engine signs a remote EIP-712 order only after the
  stub's `verifyBuild` ran. `omnistonVerifyBuild` now opens Omniston's EVM orders too, with the order
  extension the server's build carries: deploy the new server before the new app, or remote EVM → TON
  and EVM → EVM orders are refused.

## Next release: the audit fixes

This release fixes three findings of the 2026-10-29 external audit.

### The signer is no longer a property of an account

Every chain account (`wallet-evm`, `-solana`, `-ton`, `-tron`, `-btc`, `-near`, `-zcash`) keeps its
signer in a private field. `account.signer` is `undefined` now, on the accounts your app gets too,
and `LocalSigner` has no `key()` method at runtime. A protocol module always gets the policy wrapper,
even on a `Wallet` without `policies`; without them the wrapper applies no limits.

What to change:
- `account.signer.kind` → `account.signerKind` (`'seed' | 'key' | 'external'`);
- `account.signer.publicKey` → `account.publicKey`;
- an injected `Signer` you need later: keep your own reference to it;
- tests that patched `account.signer.sign` to count signatures: spy on your own external signer, or
  on `LocalSigner.prototype.sign`;
- do not compare a module's account with `wallet.getAccount(chain)` by identity: it is a wrapper.

### `setProtection` reports an old copy it could not remove

`@anywalletkit/secure-storage-react-native` used to ignore a failed delete of the old copy after it
rewrote a secret. `setProtection(id, 'biometricsOnly')` resolved, `info` and `list` said strict mode,
and the old `biometricsOrPasscode` copy stayed in the Keychain.

Now:
- `setProtection` and `set` reject with `SecureStorageError` code `stale-copy` when the new copy is
  stored but the old one could not be removed;
- `info` and `list` report the weakest protection among the copies still stored;
- the store retries the removal on its next operation, on first use after a restart and in `prune`
  (which rejects with `stale-copy` if a copy still stays).

What to change: catch `stale-copy` where you call `setProtection` and do not show strict mode as on.
Offer a retry: calling `setProtection` again removes the old copy without another sheet. After `set`,
`stale-copy` means the new secret is stored, so do not roll back the account.

### Permit calls in the transaction preview

`@anywalletkit/tx-preview-evm` decodes the calls that grant an allowance without `approve`: an EIP-2612
`permit()` call (the token is the target), Permit2 `permit()` single and batch (the token is inside the
struct) and `increaseApproval`. They now carry `approval`, with the usual `approval-unlimited` and
`approval-unknown-spender` warnings. A Permit2 batch lists every allowance in the new `approvals`
field. A permit body whose arguments can't be read gives the new `approval-unparsed` warning.

What to change: if your review screen maps check codes to text, add `approval-unparsed`. If it shows
`approval`, show every entry of `approvals` when it is set.

## Next release: names, typed data, Solana and URLs

This release fixes the 2026-10-28 scan. Four changes can need something from you: offchain ENS names
on React Native, typed-data signatures under policies, Solana transactions that create token accounts,
and URLs with a backslash.

### ENS on React Native (`names-ens`)

React Native's fetch follows a redirect whatever `redirect: 'error'` says, so an offchain name's
gateway could redirect the device to a host on the user's network. There, the resolver no longer asks
gateways with the global fetch. **Offchain names (`cb.id`, Basenames, `uni.eth` subnames) fail with
`lookup-failed`** until you set `ccip`. The error's `reason` is `ccip-proxy-required` and its message
says what to set. Browsers, extensions and Node are unchanged.

The safe fix is one route on your server with the new `createEnsCcipHandler`, and the new
`ensCcipViaProxy` in the app:

```ts
// server (Node), behind your auth and rate limits
import { createEnsCcipHandler } from '@anywalletkit/names-ens/server'
const ccip = createEnsCcipHandler()
// POST /ccip: const out = await ccip(JSON.parse(rawBody)); reply out.status with JSON out.body

// app
import { ensCcipViaProxy, ensResolver } from '@anywalletkit/names-ens'
const ens = ensResolver({
  rpcUrl: ETHEREUM_RPC,
  ccip: { fetch: ensCcipViaProxy('https://api.example.com/ccip', { headers: { authorization: `Bearer ${token}` } }) },
})
```

- **The server route** asks only https gateways on public hosts, checks every address the host
  resolves to, connects to the checked one, and never follows a redirect. See
  [Names](/guides/names/#react-native) and the reference server's `POST /ccip`.
- **Without a server**, `ccip: { allowRedirectFollowingFetch: true }` brings direct lookups back and
  accepts that a redirecting gateway can make the device send one blind request.
- **Your own viem `client`:** pass the same options as `ccipRead: createEnsCcipRead({ … })`.
- **A 3xx answer is never used**, on every runtime.

### Policies and typed data (`kit`)

The policies now read typed data that moves value by itself:
- EIP-3009 `TransferWithAuthorization` / `ReceiveWithAuthorization` is a `send` to `to`, with the
  verifying contract as the token and `value` as the amount;
- an ERC-2771 `ForwardRequest` and a `MetaTransaction` are judged by the call they make;
- a 1inch LOP `Order` (the Omniston EVM order) by its settlement contract, and by a `receiver` other
  than the maker.

What this changes:
- **Under an allowlist,** these signatures need their destinations on the list. Typed data the
  policies cannot read is refused: it is `kind: 'typedData'` with `destinationUnknown: true`.
- **Under a blocklist,** unreadable typed data is refused unless you have a `confirm` hook, which then
  sees `destinationUnknown: true`.
- **A blocklisted verifying contract** is refused for all typed data, Permit and Permit2 included. The
  new `WriteIntent.verifyingContract` carries it.
- **`WriteIntent.message`** is now `false` for every `signTypedData`.

See [Policies](/concepts/policies/).

### Solana token accounts the transaction creates (`wallet-solana`)

The guard that simulates what a program does by CPI now also watches token accounts the transaction
creates, such as an associated token account made with `CreateAssociatedTokenIdempotent`.
- A transaction that leaves a close authority or another owner on a token account of this wallet that
  it creates, or a delegate allowance no top-level `Approve` shows, is refused with
  `UnsafeTransactionError` (`sets-authority` / `approves-delegate`).
- Creating this wallet's associated token account for another owner is refused.
- `allowAuthorityChanges` still overrides the guard, for example for a token launch.
- `checkSerialized` asks the simulation only for accounts of the transaction. An address outside it
  keeps its pre-state.

### URLs with a backslash (`networks`)

A WHATWG parser (browsers, Node, the extension) and OkHttp end a host at `\` and drop tabs and line
breaks, so `https://192.168.1.1\admin` was checked as one host and fetched from another. Now a URL with
`\`, a tab, CR, LF or another control character anywhere is refused:
- `checkRpcUrl` answers `not-a-url`;
- `isPublicHttpsUrl` answers `false`;
- a site's `rpcUrls` entry in `wallet_addEthereumChain` is dropped;
- ENS gateway and avatar URLs with one are not used.

If you store user-entered RPC URLs, a saved one with a backslash no longer passes: ask the user to
enter it again.

## 2026-10-28: the modules security release

This release fixes the second 2026-10-27 security scan: 37 findings in the protocol modules. Most of
the changes are stricter checks, so input that used to pass is now refused. Go through the sections for
the packages you use.

### Swaps through your own server (`remoteProvider`)

#### Pins

A remote provider now takes the contracts its calldata may call and approve from your app, never
from your server. Without pins it gets **no EVM calldata route at all**. Jupiter's Solana transactions
need no pins; deposit-address routes such as NEAR Intents need `depositAddressRoutes` since the next
release (above). Every other provider package exports
its pins:

```ts
import { remoteProvider } from '@anywalletkit/protocol-swap2-core/remote'
import { lifiPins } from '@anywalletkit/protocol-swap2-lifi'
import { thorchainPins } from '@anywalletkit/protocol-swap2-thorchain'
import { chainflipPins } from '@anywalletkit/protocol-swap2-chainflip'
import { omnistonPins, omnistonVerifyBuild } from '@anywalletkit/protocol-swap2-omniston'
import { AUDITED_OMNISTON_EVM_ORDER_PROTOCOLS, createOmnistonTonValidators } from '@anywalletkit/protocol-swap2-omniston/validators'

const PINS = {
  lifi: lifiPins,
  chainflip: chainflipPins,
  // Exactly your server's THORChain affiliate and affiliateBps: the memo must carry both as configured
  // there. If your server has no affiliate, use thorchainPins().
  thorchain: thorchainPins({ affiliate: 'your-affiliate', affiliateBps: '30' }),
  // integratorAddress: only if your server's Omniston provider sets one. It is the only referral a TON
  // swap body may name.
  omniston: {
    ...omnistonPins(AUDITED_OMNISTON_EVM_ORDER_PROTOCOLS),
    verifyBuild: omnistonVerifyBuild({ ...createOmnistonTonValidators(), integratorAddress: null }),
  },
}
const remote = (name: string) => remoteProvider({ name, baseUrl: 'https://api.example.com/swap2', ...PINS[name as keyof typeof PINS] })
```

The other pins are:
- `fyndPins`: it carries `verifyQuote: fyndVerifyQuote`, so the quote is also checked on the device;
- `cctpPins`, with its `claimTargets`;
- `uniswapPins`, `usdt0Pins`, `balancerPins` and `wrapPins`.

The reference server's client shows the whole wiring: [Ship a wallet](/build-a-wallet/ship-a-wallet/).

#### The server address

`baseUrl` must be https, or a same-origin path such as `/api/swap2`. Leading spaces and
scheme-relative values (`//host/…`) are refused too. For a server on your own machine during
development, pass `allowInsecureBaseUrl: true`.

#### Typed orders

Typed data is signed only when it is the swap's own order. That means an EIP-712 `Order` that is:
- from the user;
- selling the source token, exactly the input;
- on the swap's chain, to the approval address.

A permit, or any other message from a provider, is refused.

#### TON swaps

- **Attached TON.** A TON message may attach at most the input plus the gas ceiling; for a jetton
  source, the ceiling alone. The ceiling is 1 TON by default. Change it on the swap engine, for example
  `new RouterSwap2Protocol(account, { …, tonGasCeiling })`, not on `remoteProvider`.
- **Jetton source.** It must be a plain TEP-74 transfer of exactly the input to your own jetton
  wallet, so **the TON signer must have `getJettonWalletAddress`**.
- **Server-built bodies.** A TON cell body built by your server is refused unless the app checks it
  (`verifyBuild`; for Omniston, `omnistonVerifyBuild({...createOmnistonTonValidators()})`). It checks
  TON → TON swap bodies and, from omniston 0.3.1, TON → EVM escrow bodies too (`verifyTonEscrowBuild`).
  On 0.3.0 a remote TON → EVM build was refused: upgrade to 0.3.1, and if you turned the route off with
  a `supportsRoute` filter, turn it back on.

#### Omniston quote store

If Omniston runs on your server, give your durable quote store a `claim(quoteId, json)` that writes
only if nothing is stored yet (Redis `SET NX`). Without it, two server instances can race on one quote
id.

### Swap providers in your own process

#### Every provider

When the swap call is itself a token call (`transfer`, `approve`, `increaseAllowance`), it may only
move the source token, by at most the input. It may only pay the user, the deposit address or the
declared spender.

These are refused as the swap call:
- an operator approval (`setApprovalForAll`);
- a Permit2 approval;
- a `transferFrom`;
- calldata that is not hex bytes.

Valid hex that calls an unknown function still goes through as a plain contract call. A router's
calldata is not decoded by this check: each provider checks its own targets.

#### LI.FI

- `apiUrl` must be https; `allowInsecureApiUrl` allows a local mock.
- On an EVM source, every step of the Diamond call is checked:
  - steps must chain;
  - only the input token may be deposited;
  - a bridge without source swaps must bridge the input, less at most 1 % (its `minAmount`). What
    arrives on the destination is still LI.FI's figure.

#### THORChain

- **A second node confirms the vault.** The inbound vault must be confirmed by a second node, at
  quote time and before broadcast. The second node is any node other than the one that quoted.
- **The default nodes** are Liquify (`https://gateway.liquify.com/chain/thorchain_api`) and IBS
  (`https://thorchain.ibs.team/api`). They are run by different operators.
- **With one configured `nodeUrl`**, the default nodes confirm it, unless `confirmNodeUrl` names
  another node; if you name your own, pick one of another operator. A quote is refused when no second
  node answers, or when one reports another vault or router. For a local mock, name a second mock in
  `confirmNodeUrl`, because the public nodes report another vault.
- **https only.** Nodes must be https; `allowInsecureNodeUrl` allows a local mock.
- **Routers are pinned per chain.** Pass `trustedRouters` if THORChain migrates its router before you
  upgrade.

#### Jupiter, Balancer and Fynd

- **Jupiter:** every instruction of a `/build` transaction besides the swap must have one of the
  expected shapes. Anything else is refused.
- **Balancer:** `preflightDeposit` refuses calldata that is not the quote's own batch.
- **Fynd:** `preflightDeposit` refuses a transaction whose target, calldata or value differs from
  the quote's.

Pass the transaction `buildDeposit` returned, unchanged.

### Earn

#### Kamino

Upgrade `@anywalletkit/wallet-solana` together with the Kamino module.

- **Chain reads.** Writes and their quotes (`supply`, `withdraw`, `borrow`, `repay` and every
  `quote…` call) need an account that can read accounts from the chain (`getAccountInfos`), because
  the module checks the API's figures against the chain. Reads do not.
- **Vaults.** On a vault write or quote, an API `tokensPerShare` more than 1 % away from the share
  price computed on chain is refused.
- **Lend `'max'`.** It is refused when the API reports a deposit or debt more than 1 % away from the
  obligation's. APYs and other reads are still the API's.
- **`WITHDRAW_ALL`.** It is deprecated, and Kamino's API now refuses it (above u64). To withdraw
  everything, use the vault's `withdraw({ amount: 'max' })`, which sends the exact share count read
  from the chain.

#### Mellow

- **Vaults picked with `preset`** work as before. A queue Mellow adds after this release needs a
  package update or `config.queues`.
- **Any other vault needs `config.queues`**: the deposit and redeem queues you expect. That includes a
  preset's vault passed only by address as `vault`; pass `preset` for it instead.
- **No queue is trusted on the RPC's word.** Deposits, redemptions, `cancelSupply`, `claimShares`
  and `claimWithdrawals` go only to a pinned queue.

### Approvals

#### `isRevokeTransaction(tx, { targets })`

- Without `targets`, only a Permit2 `lockdown` counts as a revoke.
- Pass the approvals your scan returned, a `Map` from address to standard, or a plain object from
  address to standard (`RevokeTargets`).
- `approve(spender, 0)` is a revoke only on an ERC-20. On an ERC-721 the same call approves
  `spender` for token #0. A bare address list no longer makes it one.
- It never throws.

#### `revoke()` / `revokeAll()`

- **ERC-165 first.** An `'erc20'` revoke first asks the token for ERC-165 (one `eth_call`, with
  CCIP-Read off), so it needs the protocol's provider (`config.provider` or the account's). Without one
  it is refused (`provider-required`).
- **Outcomes:**
  - an ERC-721 is refused (`invalid-approval`);
  - a token without ERC-165 (the call reverts) is revoked as before;
  - a read that fails sends nothing (`source-failed`).
- **`revokeAll()`** applies this per approval: a refused one comes back as that approval's `error`,
  and the others still go out.
- **`buildRevokeTransaction()`** does not check. Run your own ERC-165 read before you batch its
  output.

### Extension kit

- **Method names.** The relay drops a request whose `method` is not a method name: letters, digits
  and `_`, at most 128 characters (`isRelayMethod`). Reject such a request in your injected provider
  with `-32600`, so the page gets an answer instead of a promise that never settles.
- **`setSecret` refuses a key that does not open the vault's secrets** (`locked`). A vault that holds
  no secret yet has nothing to check the key against, so the first `setSecret` after `create`, or after
  the last secret is deleted, must get the key that `create` or `rotateVaultKey` returned. After the
  new `vault.rotateVaultKey(password)`, hand the returned key to `session.unlock`.
- **Re-keying.** `changePassword` keeps the same vault key. After a suspected compromise, offer
  `rotateVaultKey`. It drops the passkeys, so ask the user to add them again: see
  [Extension kit](/guides/extension-kit/).
- **`wallet_addEthereumChain`.** A site's RPC URL is kept only when it is https on a public host
  (`isPublicHttpsUrl`).

### Names, tokens and networks

#### ENS

- **Your own client.** If you pass your own viem `client` to `ensResolver`, create it with
  `ccipRead: ensCcipRead`. With viem's default, an offchain name's resolver chooses URLs the device
  fetches, including addresses on the user's network. See [Names](/guides/names/).
- **https avatars on a public host** come back as written, without a fetch.
- **`ipfs://` avatars** come back through `ipfsGateway`: an origin (`/ipfs/<cid>` is appended) or a
  prefix ending in `/ipfs/`.
- **Every other avatar now comes back `null`:** NFT avatars, and `http://`, `data:`, `ipns://` and
  `ar://` ones. Show your placeholder.

#### Tokens

- **Length.** A user token's symbol is stored trimmed and cut to 32 characters, and its name to 128.
  Longer stored symbols are cut when the table loads.
- **Look-alikes.** The check now also folds ASCII look-alikes ("DAl" reads as DAI) and spacing
  accents.
- **`odd-characters` at `danger`** applies when a symbol has:
  - any letter of a script whose letters pass for Latin ones: Cyrillic, Greek, Armenian, Cherokee and
    others, the whole script (`ЖЛБ` too);
  - small capitals, Roman numerals, enclosed or math letters;
  - characters that hide in text: zero-width, bidi, controls, line breaks, tag characters.

  Emoji (™ included), CJK, other scripts and accented Latin stay a `caution`.

#### Networks

`isPrivateHost` now also treats these as private:
- IPv4 in every ASCII spelling a URL parser accepts (`127.1`, `2130706433`, `0x7f.0.0.1`);
- any host that is not printable ASCII, which a URL parser would map to ASCII (`127.0.0.１`);
- CGNAT and link-local ranges;
- all of 0/8, 192.0.0/24, the 198.18/15 benchmark range, multicast and reserved addresses (224/4 and
  up);
- a numeric host that is no valid IPv4 (`256.1.1.1`);
- IPv6 addresses that carry a private IPv4 one (IPv4-mapped `::ffff:…`, IPv4-compatible, NAT64
  `64:ff9b::…`, 6to4 `2002::…`), IPv6 multicast, and hosts with `%` (an IPv6 zone);
- `*.internal`, `*.home.arpa` and `*.lan`.

What this changes:
- **`checkRpcUrl`** reports them as `local`. http to them is accepted behind `allowHttpLocal`; it used
  to be refused as `http-not-local`. https is accepted as before.
- **`parseAddChainParams`** now drops a site's RPC URL on them, https included, unless
  `allowHttpLocal` is on.
- **For your own fetches,** use the new `isPublicHttpsUrl`. Import it from `@anywalletkit/networks/url`,
  together with `isPrivateHost`, `checkRpcUrl` and `parseUrl`, to leave the catalog out: the package
  root loads it.
- **CCIP-Read is off** in the viem clients the SDK creates (wallet-evm and the protocol modules;
  names-ens has its own filter). A contract's `OffchainLookup` revert, such as a spam token's, no
  longer makes the device fetch the URLs it names.
