# @anywalletkit/protocol-swap2-core

[![npm](https://img.shields.io/npm/v/@anywalletkit/protocol-swap2-core?label=npm)](https://www.npmjs.com/package/@anywalletkit/protocol-swap2-core)

The swap2 engine: one interface for swaps and bridges ("swap2"), and the execution safety every swap2 provider package relies on.

## Install

```sh
npm install @anywalletkit/protocol-swap2-core @anywalletkit/core
# or: pnpm add @anywalletkit/protocol-swap2-core @anywalletkit/core  ·  yarn add @anywalletkit/protocol-swap2-core @anywalletkit/core
```

On npm: [@anywalletkit/protocol-swap2-core](https://www.npmjs.com/package/@anywalletkit/protocol-swap2-core), published from the [release workflow](https://github.com/ultratestbro/anywalletkit/blob/main/RELEASING.md) with provenance.

- **`BaseSwap2Protocol` / `SingleProviderSwap2`** — a `Swap2Protocol` (from `@anywalletkit/core`) over a provider. It quotes, binds the execution to the quote, runs approvals, sends, and resumes status by id (`getSwap2Status`, `claimSwap2` for two-phase routes).
- **Safety checks.** Quote validation, a minimum-output floor, fee caps, a review gate before signing, and refusals that name their reason. Status ids look like `awk1.<provider>.<intent>[.<hash>]` (`SWAP2_ID_PREFIX`).
- **`remoteProvider`** — runs a provider on your server (API keys, shared state) while the app keeps the keys and signs. The backend is not the authority over what the wallet signs: spread the provider package's pins into the stub (`remoteProvider({name, baseUrl, ...lifiPins})`, `fyndPins`, `uniswapPins`, `cctpPins`…). The engine then lets an EVM route call only the pinned `callTargets`, approve only the pinned `spenders`, and runs the provider's own `verifyQuote` (Fynd: `checkFyndTransaction`) on the client; a stub without pins gets no EVM calldata route at all (the router drops it with the reason), and neither does a stub whose pins name call targets but carry no check of the call itself — `verifyQuote`, or a `verifyBuild` the app supplies — since a pinned contract executes whatever its arguments say. Every shipped EVM pins export carries one. A route that pays an address the backend names — a deposit address, or a plain value send — runs only on a stub the app opened with `depositAddressRoutes: true` (`nearIntentsPins`; `thorchainPins()` and `chainflipPins` for their Tron vaults), on every chain. Every token call in a swap's calldata, from any provider, must move the source token, at most the swap amount; operator and Permit2 approvals are never a swap's main call. A typed (gasless) order is signed only when it is the swap's own Limit Order Protocol `Order` — verifying contract = the approved settlement contract, maker = this account, the source token, exactly the input — never a `Permit*` or another typed message; a provider's own check of the build can run on the client too (`verifyBuild`), and a remote stub's typed order is signed only when it has one (Omniston: `omnistonVerifyBuild` opens the order with the `orderExtension` the build carries). A TON cell-body deposit (`bodyBoc`) is bound too: it attaches the input plus at most `tonGasCeiling` of gas (default 1 TON; a jetton source: the ceiling alone), a jetton source's body must be a TEP-74 transfer of exactly the input from this account's own jetton wallet (`getJettonWalletAddress`) with the excess returning here, the decoded body reaches the review (`cellBodyDecoded`), and a remote stub's cell body needs the app's own validator (`verifyBuild`). An absolute `baseUrl` must be `https:` (a same-origin path is fine; `allowInsecureBaseUrl` for local development). A provider with a claim step (CCTP) also takes `claimTargets` from the app: `claimSwap2` calls only those contracts.
- **`createSwap2Handler`** (`@anywalletkit/protocol-swap2-core/server`, server-only) — the other end of `remoteProvider`: validates every request, HMAC-seals only quotes that pass the engine's own checks (`validQuote`: provider, input, floor, slippage, expiry; else 502) and builds only sealed, unexpired ones, puts an intent token on every swap id (tracking, claims and notices without it are refused), passes refusals through with URLs redacted; you supply `guard` (auth + rate limits, it sees the validated request) and, with per-user sign-in, `subject` (quotes and swap ids bound to the user). A reference server: [`examples/server`](https://github.com/ultratestbro/anywalletkit/tree/main/examples/server).
- **Tokens outside the catalog** — `allowUnlistedTokens: true` on the engine (and on `createSwap2Handler` for a remote engine) lets a swap name a token the catalog does not list by its EVM contract or Solana mint: the user's own tokens. Off by default. The engine reads the token's decimals with the account's `getTokenInfo` and sends them as `sourceDecimals`; providers that trade any token resolve the source with `sourceAssetOf(params)`, the rest refuse it. Approvals and value binding are the same as for catalog tokens.
- **Errors** — `Swap2Error` and its subclasses (quote, validation, execution, fee limit, status…).
- **Activity helpers** — what `describeActivity` implementations share.

Providers live in their own packages: `@anywalletkit/protocol-swap2-near-intents`, `-lifi`, `-thorchain`, `-omniston`, `-cctp`, `-usdt0`, `-chainflip`, `-jupiter`, `-uniswap`, `-balancer`, `-wrap`. `@anywalletkit/protocol-swap2-router` auctions several of them.


## Durable execution and recovery

Pass `operationStore` in the engine config and a fresh application-owned `operationId`
in each `swap2` call to record execution across app restarts. Both options must be
present together; existing callers can omit both. The store implements `load(id)` and
`compareAndSet(id, expectedRevision, next)`. The latter must atomically commit across
all processes/tabs; `null` means create only if absent. Use a database transaction
(for example, IndexedDB or SQLite). A read followed by an independent write is not
an implementation of this contract.

The versioned JSON record contains caller terms, provider/route/intent identity and
approval, source, order-sign/register or recovery steps. Amounts are decimal strings.
No signed transaction, order signature or secret is stored. Each side effect has a
durable pending marker before the wallet is called and an outcome/hash afterward.
Storage failure before that marker prevents signing. Failure after sending produces
`Swap2MaybeSentError`; the pending marker remains and cannot authorize a repeat.
An operation ID is never automatically reused, including after an interrupted review.

```ts
const swaps = new RouterSwap2Protocol(account, {fromChain: account.chain, providers, operationStore});
const result = await swaps.swap2({...options, operationId, minAmountOut});
// After restarting: reads stored identity and asks the provider about its recorded transaction.
const {operation, id, status} = await swaps.resumeSwap2(operationId);
```

`resumeSwap2` is read-only: it does not repeat approvals, signatures, transfers or
order registration. A missing source hash, interrupted approval, inaccessible RPC
or uncertain broadcast remains `unknown`; it is not assumed to be failed or refunded.
With a source hash (or a submitted order registration), the provider checks current
network state. Existing `awk1` IDs and `getSwap2Status` still work. If a post-send
storage write failed, the error may carry a hash/status ID even though the durable
record has only its pending marker: retain that error information and reconcile it
with the wallet's history. The journal is not a signed-transaction outbox or an
automatic retry queue. Applications own storage retention and backup.

Recovery is separate from the source transfer:

```ts
const offers = await swaps.getSwap2RecoveryQuotes(result.id);
const recovered = await swaps.recoverSwap2(result.id, offers[0].id, recoveryAccount, {
  operationId: recoveryOperationId,
  maxNativeValue: 123n, // cap attached value; wallet gas policies apply separately
  review: async (freshOffer) => { if (!await confirmRecovery(freshOffer)) throw new Error('cancelled'); },
});
```

The selected offer is refreshed, checked against local recovery targets, bounded by
`maxNativeValue`, and validated against the original intent by `verifyRecovery` on
the signing client. That validator must check calldata/recipient/amount and current
on-chain recoverability (including the queue prefix for `driveBus`). It runs again
after review. Actual account chain and identity are checked; token transfers,
approvals and non-EVM payloads are refused. A recovery uses its own durable operation
ID and never overwrites the original source transaction hash. Reconcile it with
`resumeSwap2(recoveryOperationId)`. The provider receives its separate recovery hash,
chain and action ID when tracking. Legacy `claimSwap2` remains a zero-value EVM path.

Providers opt into `getRecoveryQuotes`, `recoveryTargets` and `verifyRecovery`.
Remote providers require both client-side pins and the validator to enable
`/recoveries`; the server requires an issued intent token and the normal guard.
Recovery offers are untrusted unsigned data, not authority to sign: local validation,
the caller's value cap and explicit review are mandatory. No generic endpoint retry,
composer or Bus action is advertised until its provider implements that validation.

## Multiple routes from one provider

`CrossChainProvider.getQuotes` is an optional display-only hook returning at most 32
candidates with distinct, stable `routeId` strings. The selector is scoped to that
provider and describes a path/mode, not a temporary quote or tracking ID. Execution
still uses `getQuote(params)`, which must honor `params.routeId` or refuse the quote.
A provider implementing `getQuotes` must identify the route of its default quote too.
The public `Swap2Quote`, `Swap2Options` and execution review carry the selector.
The router picker uses `using(provider, routeId)`; `getQuote` and `using(provider)`
remain supported for existing providers.

When approval mining outlasts a quote, the engine pins the original provider and
route on refresh and preserves the caller's floor. A substituted or unavailable route
is refused. `awk1` tracking IDs and provider intent IDs keep their existing format.

For a remote provider, `multiQuotes: true` enables `/quotes`; deploy support for that
action in the backend and its auth/rate-limit guard first. `/quotes` requires `dry: true`,
normalizes and validates each candidate, and HMAC-seals the selector with its other
terms. The client checks the requested selector and runs `verifyQuote` on each
candidate. The provider's client validator must verify that calldata implements that
route; an unchanged selector alone is insufficient. Older deployments keep using
`/quote` when the flag is omitted.

Docs: [Swaps](https://docs.anywallet.tech/guides/swaps/)

Apache-2.0
