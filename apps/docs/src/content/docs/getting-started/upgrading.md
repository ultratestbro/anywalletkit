---
title: Upgrading
description: What to change in your app when you move to a new Any Wallet Kit release — the 2026-10-29 audit fixes first.
sidebar:
  order: 5
---

Versions are `0.x`, so a minor release may change the API. A `^0.y` range never picks up the next minor
release by itself: you take these changes when you bump. Each package's CHANGELOG lists its changes;
the lines marked **Breaking** are the ones that need something from you. This page groups them by what
your app does.

## 2026-10-29: the audit fixes

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

## 2026-10-28: the modules security release

This release fixes the second 2026-10-27 security scan: 37 findings in the protocol modules. Most of
the changes are stricter checks, so input that used to pass is now refused. Go through the sections for
the packages you use.

### Swaps through your own server (`remoteProvider`)

#### Pins

A remote provider now takes the contracts its calldata may call and approve from your app, never
from your server. Without pins it gets **no EVM calldata route at all**. Deposit-address routes, such
as NEAR Intents, and Jupiter's Solana transactions need no pins. Every other provider package exports
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
