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
- **`remoteProvider`** — runs a provider on your server (API keys, shared state) while the app keeps the keys and signs. The backend is not the authority over what the wallet signs: spread the provider package's pins into the stub (`remoteProvider({name, baseUrl, ...lifiPins})`, `fyndPins`, `uniswapPins`, `cctpPins`…). The engine then lets an EVM route call only the pinned `callTargets`, approve only the pinned `spenders`, and runs the provider's own `verifyQuote` (Fynd: `checkFyndTransaction`) on the client; a stub without pins gets no EVM calldata route at all (the router drops it with the reason), while deposit-address routes need none. Every token call in a swap's calldata, from any provider, must move the source token, at most the swap amount; operator and Permit2 approvals are never a swap's main call. A typed (gasless) order is signed only when it is the swap's own Limit Order Protocol `Order` — verifying contract = the approved settlement contract, maker = this account, the source token, exactly the input — never a `Permit*` or another typed message; a provider's own check of the build can run on the client too (`verifyBuild`). An absolute `baseUrl` must be `https:` (a same-origin path is fine; `allowInsecureBaseUrl` for local development). A provider with a claim step (CCTP) also takes `claimTargets` from the app: `claimSwap2` calls only those contracts.
- **`createSwap2Handler`** (`@anywalletkit/protocol-swap2-core/server`, server-only) — the other end of `remoteProvider`: validates every request, HMAC-seals only quotes that pass the engine's own checks (`validQuote`: provider, input, floor, slippage, expiry; else 502) and builds only sealed, unexpired ones, puts an intent token on every swap id (tracking, claims and notices without it are refused), passes refusals through with URLs redacted; you supply `guard` (auth + rate limits, it sees the validated request) and, with per-user sign-in, `subject` (quotes and swap ids bound to the user). A reference server: [`examples/server`](https://github.com/ultratestbro/anywalletkit/tree/main/examples/server).
- **Tokens outside the catalog** — `allowUnlistedTokens: true` on the engine (and on `createSwap2Handler` for a remote engine) lets a swap name a token the catalog does not list by its EVM contract or Solana mint: the user's own tokens. Off by default. The engine reads the token's decimals with the account's `getTokenInfo` and sends them as `sourceDecimals`; providers that trade any token resolve the source with `sourceAssetOf(params)`, the rest refuse it. Approvals and value binding are the same as for catalog tokens.
- **Errors** — `Swap2Error` and its subclasses (quote, validation, execution, fee limit, status…).
- **Activity helpers** — what `describeActivity` implementations share.

Providers live in their own packages: `@anywalletkit/protocol-swap2-near-intents`, `-lifi`, `-thorchain`, `-omniston`, `-cctp`, `-usdt0`, `-chainflip`, `-jupiter`, `-uniswap`, `-balancer`, `-wrap`. `@anywalletkit/protocol-swap2-router` auctions several of them.


Docs: [Swaps](https://docs.anywallet.tech/guides/swaps/)

Apache-2.0
