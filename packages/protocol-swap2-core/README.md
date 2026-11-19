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
- **Approvals when a swap does not go out.** An ERC-20 swap approves exactly the input, then sends. When the swap cannot go out as quoted after an approval this execution mined — the quote expired while it mined, or the dry run of the call (Permit2 calls and `ownGasEstimate` providers) reverts — the engine quotes once more on that allowance instead of revoking it: same provider, route, spender and amount, the caller's minimum, a second `reviewExecution` (`requoted: true`) when the plan changed, phase `requoting`. One re-quote per execution; when that pass fails too, the allowance is revoked. One exception to the revoke: an allowance to canonical Permit2 (`PERMIT2_ADDRESS`) that the swap spends only as a signature transfer (`PermitTransferFrom`, the 0x Settler) is left in place, because Permit2 moves nothing on it without a fresh signature per transfer; revoking it would cost a transaction and a prompt, and the next such swap an approval. Every other spender is revoked, and so would be a Permit2 allowance a route spends through Permit2's own allowances (`AllowanceTransfer` / `PermitSingle`; no shipped provider does). A Permit2 permit is signed after the approval is mined (with an allowance already in place, first). A `simulation_failed` dry run names the revert when the account's error carries its data: `(reverted: 0x97a6f3b9 TooMuchSlippage)`, the 4-byte selector and, for known errors, the name, never the arguments.
- **Native fee ceiling** — a route may charge native coin on top of the input (a bridge's messaging fee, which the quote declares). `swap2()` refuses a fee above the chain's cap: 0.005 ETH on Ethereum and on every chain without a row of its own (Arbitrum, Base, …), 100 CELO on Celo, 20 POL on Polygon, and so on ("swap2: quoted native fee … exceeds the cap … for …"). An app that wants a route above it sets `nativeFeeCeiling` on the engine config (any swap2 protocol, or the router): the engine asks it for every execution pass whose quote declares a native fee, before that pass's review and approvals (once, unless the quote expires during an approval and the engine re-quotes), with `{provider, intentId, fromChain, destChain, nativeFee, defaultCap, maxCeiling}`. A non-negative `bigint` is the cap for that execution (higher or lower than the chain's; `0n` refuses any fee), `undefined` keeps the chain's cap. A number, a string, `null`, a Promise, a throw, or a value above `maxCeiling` — `NATIVE_FEE_CEILING_MAX_MULTIPLE` (20) × the chain's cap: 0.1 ETH on Ethereum, 2000 CELO on Celo — refuse the execution (`Swap2ConfigurationError`), so a units slip or a "no limit" sentinel cannot switch the cap off. Match the routes you mean and return `undefined` for every other one. USDT0 Legacy Mesh into Tron, whose LayerZero fee was 0.005341 ETH from Ethereum / Arbitrum and 170.5 CELO from Celo on 2026-11-12 (sealed with the provider's 25 % headroom: 0.006676 ETH, 213.1 CELO; 7-day p90 0.006879 ETH, 221.7 CELO), above the default caps:

  ```ts
  // Tron is LayerZero eid 30420; the usdt0 provider's mesh intent ids are usdt0-mesh:<srcEid>:<dstEid>
  // (through a swap2 server they end in ~<token>). Tron is opt-in in the usdt0 provider: see its README.
  const TRON_MESH_CEILING = new Map([
    ['eip155:1', 10n ** 16n],              // 0.01 ETH on Ethereum
    ['eip155:42161', 10n ** 16n],          // 0.01 ETH on Arbitrum
    ['eip155:42220', 300n * 10n ** 18n],   // 300 CELO on Celo
  ])
  const swaps = new RouterSwap2Protocol(account, {
    fromChain: account.chain,
    providers,                               // usdt0Provider(…) among them, with Tron turned on
    nativeFeeCeiling: ({ provider, intentId, fromChain, destChain }) =>
      provider === 'usdt0' && destChain === 'tron:728126428' && /^usdt0-mesh:\d+:30420(?:~|$)/.test(intentId)
        ? TRON_MESH_CEILING.get(fromChain)   // undefined for any other source: the chain's cap
        : undefined,                         // every other route: the chain's cap
  })
  ```

  `destChain` is the catalog id (`tron:728126428`) whichever form the app passed (`tron:0x2b6653dc` too); `provider` is the name the provider is installed under (the router binds each quote to it). Only `swap2()` applies a native-fee cap: `quoteSwap2` and the router's `quoteSwap2Routes` do not check one, so a route above the cap is listed and its `swap2()` is refused.
- **Refusal reasons** — every refusal keeps its text, and a classified one also carries `reason`: one of the 17 `Swap2RefusalReason` values (`SWAP2_REFUSAL_REASONS`: `no_route`, `unsupported_pair`, `amount_too_small`, `amount_too_large`, `insufficient_liquidity`, `rate_limited` with `retryAfterMs`, `key_rejected`, `upstream_unavailable` with `httpStatus`, `chain_halted`, `recipient_unverifiable`, `recipient_mismatch`, `vault_mismatch`, `stale_node`, `quote_expired`, `price_check_failed`, `simulation_failed`, `policy_refused`). `refusalOf(err)` reads it from the error or its `cause` chain (only reasons the SDK set; never on a `Swap2MaybeSentError`). The engine's "no route available" (`Swap2QuoteError`) lists each venue's refusal in `refusals`, and its own `reason` is their shared one or `no_route`. `onRefusal(text, info)` gets it as a second argument, `createSwap2Handler` sends it in error bodies and `noQuote`, and `remoteProvider` puts it back on the error (or reads it from the status: 429, 401/403, 408/425/5xx). Providers classify their own refusals with `refusal(reason, text)` / `withReason(err, reason)`, and their pins do the same through `reasonOf` (`refusalNotes()` keeps the text → reason map, bounded).
- **`remoteProvider`** — runs a provider on your server (API keys, shared state) while the app keeps the keys and signs. The backend is not the authority over what the wallet signs: spread the provider package's pins into the stub (`remoteProvider({name, baseUrl, ...lifiPins})`, `fyndPins`, `uniswapPins`, `cctpPins`…). The engine then lets an EVM route call only the pinned `callTargets`, approve only the pinned `spenders`, and runs the provider's own `verifyQuote` (Fynd: `checkFyndTransaction`) on the client; a stub without pins gets no EVM calldata route at all (the router drops it with the reason), and neither does a stub whose pins name call targets but carry no check of the call itself — `verifyQuote`, or a `verifyBuild` the app supplies — since a pinned contract executes whatever its arguments say. Every shipped EVM pins export carries one. A route that pays an address the backend names — a deposit address, or a plain value send — runs only on a stub the app opened with `depositAddressRoutes: true` (`nearIntentsPins`; `thorchainPins()` and `chainflipPins` for their Tron vaults), on every chain. Every token call in a swap's calldata, from any provider, must move the source token, at most the swap amount; operator and Permit2 approvals are never a swap's main call. A typed (gasless) order is signed only when it is the swap's own Limit Order Protocol `Order` — verifying contract = the approved settlement contract, maker = this account, the source token, exactly the input — never a `Permit*` or another typed message; a provider's own check of the build can run on the client too (`verifyBuild`), and a remote stub's typed order is signed only when it has one (Omniston: `omnistonVerifyBuild` opens the order with the `orderExtension` the build carries). A TON cell-body deposit (`bodyBoc`) is bound too: it attaches the input plus at most `tonGasCeiling` of gas (default 1 TON; a jetton source: the ceiling alone), a jetton source's body must be a TEP-74 transfer of exactly the input from this account's own jetton wallet (`getJettonWalletAddress`) with the excess returning here, the decoded body reaches the review (`cellBodyDecoded`), and a remote stub's cell body needs the app's own validator (`verifyBuild`). An absolute `baseUrl` must be `https:` (a same-origin path is fine; `allowInsecureBaseUrl` for local development). A provider with a claim step (CCTP) also takes `claimTargets` from the app: `claimSwap2` calls only those contracts.
- **`createSwap2Handler`** (`@anywalletkit/protocol-swap2-core/server`, server-only) — the other end of `remoteProvider`: validates every request, HMAC-seals only quotes that pass the engine's own checks (`validQuote`: provider, input, floor, slippage, expiry; else 502) and builds only sealed, unexpired ones, puts an intent token on every swap id (tracking, claims and notices without it are refused), passes refusals through with URLs redacted; you supply `guard` (auth + rate limits, it sees the validated request) and, with per-user sign-in, `subject` (quotes and swap ids bound to the user). A reference server: [`examples/server`](https://github.com/ultratestbro/anywalletkit/tree/main/examples/server).
- **Tokens outside the catalog** — `allowUnlistedTokens: true` on the engine (and on `createSwap2Handler` for a remote engine) lets a swap name a token the catalog does not list by its EVM contract or Solana mint: the user's own tokens. Off by default. The engine reads the token's decimals with the account's `getTokenInfo` and sends them as `sourceDecimals`; providers that trade any token resolve the source with `sourceAssetOf(params)`, the rest refuse it. Approvals and value binding are the same as for catalog tokens. A bridge to an unlisted destination token takes its decimals from the caller's `toTokenDecimals` (read on the destination chain), never from the quote alone: a quote whose `destDecimals` disagree is refused, and without them a Mayan leg out of Solana has no reviewed minimum and is refused at signing.
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
