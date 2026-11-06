# @anywalletkit/walletconnect-ton

[![npm](https://img.shields.io/npm/v/@anywalletkit/walletconnect-ton?label=npm)](https://www.npmjs.com/package/@anywalletkit/walletconnect-ton)

WalletConnect for TON: what a wallet built on Any Wallet Kit answers in the `ton` namespace, so TON dApps that offer WalletConnect connect to it today, with no listing in the TON wallets registry. `@tonconnect/sdk` 3.4+ (through 5.x) and `@tonconnect/ui` show a **WalletConnect** entry once the dApp calls `initializeWalletConnect(...)`; STON.fi does.

The package gives you the session namespace, the two session properties the dApp requires, the `ton_proof` answer at connect, and `ton_sendMessage` / `ton_signData` answered through a `wallet-ton` account: parsed and checked, shown to your review, then one signing call under the account's policies.

## Install

```sh
npm install @anywalletkit/walletconnect-ton @anywalletkit/wallet-ton
# or: pnpm add …  ·  yarn add …
```

On npm: [@anywalletkit/walletconnect-ton](https://www.npmjs.com/package/@anywalletkit/walletconnect-ton), published from the [release workflow](https://github.com/ultratestbro/anywalletkit/blob/main/RELEASING.md) with provenance.

`@anywalletkit/wallet-ton` is a peer. There is **no WalletConnect dependency**: you bring [Reown WalletKit](https://docs.reown.com) and a project id, and hand its plain objects in. Runs under Hermes (React Native) and Node.

## Use

```ts
import { handleTonRequest, tonProofAuthentication, tonProposalChains, tonSessionNamespace, tonSessionProperties } from '@anywalletkit/walletconnect-ton'
import { applyPolicies } from '@anywalletkit/kit'

// the key, once, behind Face ID; policies wrap the account like any other write
const withSigner = (run) => keyring.withAccount(accountId, 'ton', (a) => run(applyPolicies(a, policies, a.chain)))

// session_proposal: the user approved the connection on your sheet
walletKit.on('session_proposal', async ({ id, params }) => {
  const { required, optional } = tonProposalChains(params)
  const ton = tonSessionNamespace(tonReadOnly, { chains: [...required, ...optional] })
  if (!ton && required.length) return walletKit.rejectSession({ id, reason: { code: 5100, message: 'Unsupported TON network' } })
  const authentication = await tonProofAuthentication(tonReadOnly, params, { withSigner })   // undefined unless the dApp asked for ton_proof
  await walletKit.approveSession({
    id,
    namespaces: { ...(ton ? { ton } : {}) /* , eip155, solana… */ },
    sessionProperties: tonSessionProperties(tonReadOnly),            // required by @tonconnect/sdk; no key read
    ...(authentication ? { proposalRequestsResponses: { authentication } } : {}),
  })
})

// session_request on the ton namespace
walletKit.on('session_request', async (request) => {
  if (!request.params.chainId.startsWith('ton:')) return
  const session = walletKit.getActiveSessions()[request.topic]
  const response = await handleTonRequest(tonReadOnly, request, {
    session,                                      // peer domain + the session's TON account
    review: (r) => showSheet(r),                  // r.method: 'ton_sendMessage' (transactions, description, simulate()) | 'ton_signData' (payload, peerDomain)
    withSigner,                                   // opens the key only after a yes
  })
  await walletKit.respondSessionRequest({ topic: request.topic, response })
})

```

`tonReadOnly` is the session's TON account without a key (`new WalletAccountReadOnlyTon(publicKey, config)`, or the signing account itself if you already hold it; then `withSigner` is not needed).

## API

| Function | What it does |
| --- | --- |
| `tonSessionNamespace(account, { chains })` | `{ chains: [account.chain], methods: ['ton_sendMessage', 'ton_signData'], events: [], accounts: ['ton:-239:<UQ…>'] }`, or `undefined` when the proposal asks only for another TON network |
| `tonProposalChains(proposal)` | The TON chains a proposal asks for, `{ required, optional }`, in both namespace forms |
| `tonSessionProperties(account)` | `{ ton_getPublicKey: hex, ton_getStateInit: base64 BoC }`; the StateInit is checked to derive the account's address |
| `tonProofAuthentication(account, proposal, { peerDomain, withSigner })` | Answers the proposal's `ton_proof` (CAIP-122 `requests.authentication`, `aud: 'ton_proof'`) for `proposalRequestsResponses.authentication`; `undefined` when none was asked |
| `handleTonRequest(account, request, { session, peerDomain, review, signal, withSigner })` | Resolves to the JSON-RPC response for `respondSessionRequest`; never throws for a refused or failed request |
| `tonConnectTransactions(messages)` | TON Connect messages → `wallet-ton` transactions, every address and BoC decoded and checked |

The request parsing (`parseSendTransaction`, `parseSignData`, addresses, error codes) is the one shared by every TON Connect transport in the kit: `@anywalletkit/wallet-ton/tonconnect`, also used by `@anywalletkit/extension-kit` for the JS bridge.

## What is checked, in order

`ton_sendMessage`:

1. The request's chain is the account's network; the session's `ton` namespace holds this account on that chain.
2. The payload (the object `@tonconnect/sdk` sends, the Reown `[object]` form, or a JSON string): `valid_until` not past, `network` and `from` match the wallet, 1–4 messages, each address raw or friendly with a valid checksum, a non-zero decimal amount, `payload` / `stateInit` that decode as a cell / a whole StateInit. Structured `items` and extra currencies: not supported (400).
3. `review` with the parsed request, the transactions, the account's offline `describe`, and `simulate()` for an emulation on demand. Nothing is signed before it resolves `true`.
4. `valid_until` again (the review may have taken a while), then **one** call, `account.sendTransaction(messages)`: the policies (`applyPolicies`: allowlist, `maxFee`, `confirm`), the account's own checks (drain send modes 128 / 32, balance, preflight emulation, `transactionMaxFee`), one signature, the broadcast of those bytes. The reply is the external message **exactly as broadcast** (base64 BoC), with the StateInit only while the wallet is not deployed.

`ton_signData`: chain and session as above; text or binary (`cell` is refused, 400); `review`; `account.signTonConnectData`. The domain is the session peer's host (or `peerDomain`, e.g. WalletKit's verified origin), **never** a domain written in the request.

Errors carry TON Connect codes: **300** declined (the review said no, a policy `confirm` said no, the signal was aborted), **1** bad request, **400** not supported, **0** anything else (a maybe-sent broadcast says so and asks to check activity before sending again).

## Where `@tonconnect/sdk` 5.x and the specs differ

The dApp side is `@tonconnect/sdk`'s `WalletConnectProvider`; this package does what it actually reads (checked against `@tonconnect/sdk` 5.0.0, 2026-11-05):

- **Account form.** The dApp splits the CAIP-10 account with `split(':', 3)`, so a raw `0:<hex>` address would be cut to `0`. Accounts are user-friendly (`UQ…`, test-only on testnet). The Reown reference only says "TEP-123 format".
- **Session properties.** `ton_getPublicKey` and `ton_getStateInit` are required (the dApp disconnects without them); the Reown reference does not mention them.
- **Params form.** `@tonconnect/sdk` sends `ton_sendMessage` / `ton_signData` params as an object, with `network` removed and moved into the request's `chainId`; the Reown reference shows an array. Both are accepted. The Reown reference allows a numeric `amount`; whole numbers within 2^53 are accepted, TON Connect sends strings.
- **Error codes are ignored by the dApp.** It maps a wallet error by its message text: containing "reject" → user declined (300), containing "TonValidationError" → bad request (1), anything else → unknown error (0). Messages are written for that: declines contain "rejected", bad requests start with `TonValidationError: `, other errors never contain either word. A 400 reaches the dApp as an unknown error.
- **Features are assumed, not asked.** The dApp lists every WalletConnect wallet as `SendTransaction` with `maxMessages: 4` and `SignData` with `text`, `binary` **and `cell`**. The cap is held at 4; a `cell` request is refused (400, an unknown error on the dApp side).
- **`ton_proof` is not a request.** It travels in the session proposal as a CAIP-122 `authentication` entry (`uri: 'ton_proof'`, which arrives as `aud`; the payload in `statement`; `chains: ['ton:-239']` even on testnet), answered in `proposalRequestsResponses.authentication`. The dApp reads `p.domain`, `p.iat` (ISO time, read back as unix seconds), `p.statement` and `s.s` (the base64 signature). Neither the Reown reference nor the TON Connect spec describes this. The dApp sets the domain to its own metadata URL's hostname (no port); the wallet signs for the peer metadata host, which is the same name.
- **`domain.lengthBytes`.** The dApp fills it with the domain's string length; the signature covers the UTF-8 byte length (TON Connect spec). They differ only for a non-ASCII domain.
- **signData result.** The TON Connect result (`signature`, `address` raw, `timestamp`, `domain`, `payload`) is returned, plus the `publicKey` (hex) the Reown reference lists.

## Security notes

- Nothing is signed before `review` resolves `true`, and with `withSigner` the key is not even read before that.
- One signature per request; the bytes broadcast are the bytes signed, and the reply is built from them.
- The signing account must be the session's account on the session's chain; anything else is refused before signing.
- Wrap the signing account with `applyPolicies` so your policies run on WalletConnect writes like on any other.
