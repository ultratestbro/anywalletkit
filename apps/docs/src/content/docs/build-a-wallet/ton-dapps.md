---
title: TON dApps
description: How a wallet built on the kit connects to TON dApps — WalletConnect works on day one, TON Connect needs a listing in the TON wallets registry.
sidebar:
  order: 10
---

**The job:** "Connect wallet" on a TON site (STON.fi, DeDust, Tonstakers…) ends in your wallet.

TON dApps connect wallets in two ways, and they don't behave the same for a new wallet:

| Way | Works without a listing? | Where |
| --- | --- | --- |
| **WalletConnect** (`ton` namespace) | **Yes** | dApps that turned it on (STON.fi does) |
| **TON Connect**: extension or in-app browser (JS bridge) | No | every TON dApp |
| **TON Connect**: QR code / link to a mobile app (HTTP bridge) | No | every TON dApp |

Start with WalletConnect; it works the day you ship. Apply for the TON Connect listing in
parallel; it takes weeks.

## Why TON Connect needs the listing

The dApp side, `@tonconnect/ui` and `@tonconnect/sdk`, offers only the wallets in the
[TON wallets registry](https://github.com/ton-blockchain/wallets-list) (served from
`config.ton.org`). A wallet that injects `window.<key>.tonconnect` into the page but is not
in the registry is ignored: since `@tonconnect/sdk` 3.3, injected wallets outside the
registry are read only in the dApp's QA mode (`enableQaMode()`), which production dApps
don't turn on. `isWalletBrowser: true` changes nothing; the dApp still shows its own wallet
list.

So for a wallet that isn't listed:

- your extension or in-app browser can inject a correct TON Connect bridge, and dApps won't
  use it;
- a TON Connect QR code can't be answered: the dApp only listens on the bridges of listed
  wallets.

A dApp can add a wallet by hand (`walletsListConfiguration.includeWallets` in
`@tonconnect/ui`). That is the dApp's own choice, made one dApp at a time.

:::danger[Don't borrow another wallet's key]
Injecting your bridge under a listed wallet's key (`window.tonkeeper`…) makes dApps show
that wallet's name and icon for your app. Don't do it.
:::

## WalletConnect for TON

`@tonconnect/sdk` (3.4 and later, through 5.x) and `@tonconnect/ui` carry a WalletConnect option. A dApp turns it on
with `initializeWalletConnect(...)` from the SDK; the TON Connect modal then shows a
**WalletConnect** entry, and the user pairs any WalletConnect wallet by QR code or link. The
entry is hidden inside Telegram Mini Apps.

**You bring:** [Reown WalletKit](https://docs.reown.com) and a project id, as for EVM and
Solana ([dApp connection](/build-a-wallet/dapp-connection/)). To show your wallet by name in
Reown's wallet picker, list it in the WalletConnect / Reown wallet directory; that is a
separate listing from the TON registry, and pairing by QR works without it.

**What the wallet answers** ([Reown TON RPC reference](https://docs.reown.com/advanced/multichain/rpc-reference/ton-rpc)):

| Part | Value |
| --- | --- |
| Namespace / chains | `ton`; `ton:-239` mainnet, `ton:-3` testnet |
| Account | `ton:-239:<address>` |
| Methods | `ton_sendMessage`, `ton_signData` |
| Events | none |
| Session properties | `ton_getPublicKey` (hex) and `ton_getStateInit` (base64 BoC). **Required**: without them `@tonconnect/sdk` drops the session |

**With the kit:** [`@anywalletkit/walletconnect-ton`](https://www.npmjs.com/package/@anywalletkit/walletconnect-ton)
answers all of it. It has no WalletConnect dependency: hand it WalletKit's objects.

```sh
npm install @anywalletkit/walletconnect-ton @anywalletkit/wallet-ton
```

```ts
import { handleTonRequest, tonProofAuthentication, tonProposalChains, tonSessionNamespace, tonSessionProperties } from '@anywalletkit/walletconnect-ton'
import { applyPolicies } from '@anywalletkit/kit'
import { WalletAccountReadOnlyTon } from '@anywalletkit/wallet-ton'

// the TON account without its key (public key only), and the key opened once, after the review
const ton = new WalletAccountReadOnlyTon(publicKeyHex, tonConfig)
const withSigner = (run) => keyring.withAccount(accountId, 'ton', (a) => run(applyPolicies(a, policies, a.chain)))

walletKit.on('session_proposal', async ({ id, params }) => {
  // …after the user approved the connection
  const { required, optional } = tonProposalChains(params)
  const namespace = tonSessionNamespace(ton, { chains: [...required, ...optional] })   // undefined: not this network
  const authentication = await tonProofAuthentication(ton, params, { withSigner })     // only when the dApp asked for ton_proof
  await walletKit.approveSession({
    id,
    namespaces: { ...(namespace ? { ton: namespace } : {}) },
    sessionProperties: tonSessionProperties(ton),                                        // the two required properties, no key read
    ...(authentication ? { proposalRequestsResponses: { authentication } } : {}),
  })
})

walletKit.on('session_request', async (request) => {
  const session = walletKit.getActiveSessions()[request.topic]
  const response = await handleTonRequest(ton, request, { session, withSigner, review: (r) => showReview(r) })
  await walletKit.respondSessionRequest({ topic: request.topic, response })
})
```

- **`ton_sendMessage`.** `valid_until`, `network` and `from` are checked against the session, at
  most 4 messages, every address and BoC decoded; then your
  [review](/build-a-wallet/review-and-safety/) sees the transactions, the offline description and an
  emulation on demand. After a yes, one `account.sendTransaction(messages)`: policies, the account's
  checks (drain modes, balance, preflight, fee cap), one signature, the broadcast of those bytes. The
  reply is the external message exactly as broadcast, with the StateInit only while the wallet is not
  deployed.
- **`ton_signData`.** `text` and `binary`; `cell` is refused (400).
- **Domain.** Taken from the session's peer metadata (or the `peerDomain` you pass, such as
  WalletKit's verified origin), never from the request body. The same holds for `ton_proof`.
- **`ton_proof`** does not come as a request: `@tonconnect/sdk` puts it in the session proposal
  (`requests.authentication`, `aud: "ton_proof"`) and reads the answer from
  `proposalRequestsResponses.authentication`.
- **Errors.** The dApp side maps a wallet error by its text, not its code: "reject" means the user
  declined, `TonValidationError` a bad request, anything else an unknown error. The package writes
  its messages that way. The package README lists every place where `@tonconnect/sdk` 5.x and the
  specs differ.

## TON Connect listing

### What you need first

- **A public build.** The pull-request template asks for App Store / Google Play or store
  links for your extension, plus a demo dApp.
- **The HTTP bridge** (`sse`) for a mobile wallet. All mobile wallets in the registry have
  one; entries with only a JS bridge are browser extensions. You don't need your own bridge
  server: the public `https://connect.ton.org/bridge` works. A universal link and a deep link
  that accept
  [TON Connect parameters](https://github.com/ton-blockchain/ton-connect/blob/main/bridge.md#universal-link)
  are required with `sse`.
- **The JS bridge** for an extension or an in-app browser: `window.<app_name>.tonconnect`
  with `deviceInfo`, `walletInfo`, `protocolVersion: 2`, `isWalletBrowser`, `connect`,
  `restoreConnection`, `send`, `listen`. The [extension kit](/guides/extension-kit/) parses
  and answers the requests.
- **An icon.** PNG, 288×288, non-transparent background, no rounded corners, at a permanent
  HTTPS URL.

### Entry

Added **to the end** of `wallets-v2.json`. Required fields: `app_name`, `name`, `image`,
`about_url`, `bridge`, `platforms`, `features`.

```json
{
  "app_name": "yourwallet",
  "name": "Your Wallet",
  "image": "https://yourwallet.app/tonconnect-icon.png",
  "about_url": "https://yourwallet.app",
  "universal_url": "https://yourwallet.app/ton-connect",
  "deepLink": "yourwallet-tc://",
  "bridge": [
    { "type": "sse", "url": "https://connect.ton.org/bridge" },
    { "type": "js", "key": "yourwallet" }
  ],
  "platforms": ["ios", "android"],
  "features": [
    { "name": "SendTransaction", "maxMessages": 4, "extraCurrencySupported": false },
    { "name": "SignData", "types": ["text", "binary"] }
  ]
}
```

- `app_name` must equal `device.appName` in your connect reply **and** the JS bridge key.
- `features` must match what your bridge reports in `deviceInfo.features`. dApps that require
  a feature (`walletsRequiredFeatures`) hide wallets without it.
- An extension-only wallet drops `sse`, `universal_url` and `deepLink`, and lists
  `"chrome"` / `"firefox"` / `"safari"` in `platforms`.

### Checklist

1. Icon is live at its permanent URL (`curl -I` returns 200, `image/png`, 288×288).
2. `app_name` = `device.appName` = JS bridge key.
3. `features` in the entry = `deviceInfo.features` in the bridge.
4. Connect with and without `ton_proof`; `ton_addr` carries `publicKey` and
   `walletStateInit`.
5. `sendTransaction` with several messages, an expired `valid_until`, the wrong `network` and
   the wrong `from`: the last three are refused.
6. `signData` text and binary; the signature verifies against the TON Connect digest.
7. Disconnect from the wallet and from the dApp; `restoreConnection` after a reload.
8. QR code and universal link from a desktop dApp open the app and connect (with `sse`).
9. Fill the
   [pull-request template](https://github.com/ton-blockchain/wallets-list/blob/main/pull_request_template.md):
   store links, supported bridges and features, demo dApp, contacts.

### After the merge

Open a TON dApp in your in-app browser and press Connect: it should go straight to your
connect screen, with no wallet list. On desktop, the dApp's QR code should open your app.

:::caution[Check before you rely on this]
Review takes weeks: on 2026-11-05 the registry had 54 open pull requests, and new wallets
had been waiting since mid-October. The registry's rules and the `@tonconnect/sdk` behaviour
above were checked on 2026-11-05 (`@tonconnect/sdk` 3.0.5 – 5.0.0). Follow the registry's
current README.
:::
