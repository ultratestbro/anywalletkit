# @anywalletkit/protocol-swap2-0x

[![npm](https://img.shields.io/npm/v/@anywalletkit/protocol-swap2-0x?label=npm)](https://www.npmjs.com/package/@anywalletkit/protocol-swap2-0x)

[0x Swap API v2](https://docs.0x.org/docs/api/swap-permit2) as a same-chain swap2 provider for Any Wallet Kit, through the Permit2 flow. Exact-input swaps on eight chains: Ethereum, Base, Arbitrum, Optimism, Polygon, Avalanche, BNB Smart Chain and Monad (since 0.2.0). Written from the 0x API and the Settler contracts; it uses no 0x package.

## Install

```sh
npm install @anywalletkit/protocol-swap2-0x @anywalletkit/core
# or: pnpm add @anywalletkit/protocol-swap2-0x @anywalletkit/core  ·  yarn add @anywalletkit/protocol-swap2-0x @anywalletkit/core
```

On npm: [@anywalletkit/protocol-swap2-0x](https://www.npmjs.com/package/@anywalletkit/protocol-swap2-0x), published from the [release workflow](https://github.com/ultratestbro/anywalletkit/blob/main/RELEASING.md) with provenance.

## The API key

0x wants a key on every request. A key cannot ship inside a mobile app or an extension, so the module has two modes:

- **Remote (apps).** Your backend runs `zeroExProvider` with the key behind the swap2 handler. The app uses `zeroExRemoteProvider`, which holds no key and re-checks every quote and every transaction on the device, as described below. A backend that is wrong or compromised cannot move the swap anywhere else.
- **Local, with a key: servers only** (a backend, scripts, an integrator's own service). `zeroExProvider({ apiKey: () => … })` or `ZeroExSwap2Protocol` talk to 0x directly. Under React Native (Hermes or JSC) building either with a key throws, pointing to the remote mode: the key would ship in the app bundle, and React Native's fetch follows redirects with the key header whatever `redirect` says.

The key is best passed as a getter, read at request time (a string is accepted too), and is sent only in the `0x-api-key` header, to an `https://` origin. Redirects are refused (`redirect: "error"`), and an answer that came through one anyway, or from another origin than `baseUrl`, is not used (`policy_refused`). It is never put in a URL, a quote, an error or a log line.

The SDK reads no environment. By convention apps and backends name the switch and the key `ZEROEX_ENABLED` (dark unless set) and `ZEROEX_API_KEY`, as the routes canary and `verify:live` here do.

## How a swap goes

1. `GET /swap/permit2/price` for an indicative quote, `GET /swap/permit2/quote` for a live one (`chainId`, `sellToken`, `buyToken`, `sellAmount`, `taker`, `recipient`, `slippageBps`).
2. If the token's allowance to Permit2 is below the input, the engine approves **Permit2** for exactly the input (USDT is reset first on mainnet; the approval is revoked if the swap does not go out). A standing allowance that covers the input is left as it is; a smaller one is replaced and, if the swap does not go out, set to 0. No allowance is ever given to a 0x contract. An account without `signTypedData` is refused before this step.
3. The account signs one EIP-712 `PermitTransferFrom` for this swap — exactly one per swap. Typed data only: the account needs `signTypedData`, and there is no raw-hash path. With a standing allowance the permit comes first, so a declined prompt costs nothing. With an approval to send, it comes after the approval is mined, the quote is re-checked (re-quoted if it lapsed meanwhile) and the Settler registry is read again: a permit signed before a slow mainnet approval would lapse with its quote and be asked for twice. The trade-off: a permit declined after the approval costs a revoke.
4. The signature is appended to the calldata as 0x specifies (`data ++ uint256(length) ++ signature`), the signed call is estimated from the account, and then sent to the Settler with the account's own gas estimate (the quoted gas limit is not used).

Selling the native coin needs no approval and no signature: the call carries the amount as value. It too is dry-run from the account right before the broadcast and sent with the account's own gas estimate, never the quoted limit (the provider declares `ownGasEstimate`). A dry run that reverts refuses the swap (`simulation_failed`); one the account's RPC does not answer is asked once more and then refused as `upstream_unavailable`.

**Monad charges the gas limit, not the gas used** (limit × price). That is one more reason every 0x call goes out with the account's own estimate rather than the quoted limit: the quoted limit is never sent, so the gas cap only decides which quotes are refused. A quote's gas limit, as the module pads it (0x's `transaction.gas` × 1.2 + 20,000, room for the appended signature), may come to at most the chain's cap: 6,000,000 on Ethereum, Base, Arbitrum, Optimism, Polygon, Avalanche and BNB Smart Chain (`ZEROEX_MAX_GAS_LIMIT`; in 0x's own terms, a quote asking for at most 4,983,334 gas), and 15,000,000 on Monad, whose table entry carries a cap of its own (`maxGasLimit`, since 0.2.0; 0x asking for at most 12,483,334). Monad needs it because its gas grows with the size of the sale, 0x splitting a large one across many pools. In the recordings of 2026-11-26 a $1–25 swap took about 1.6 times Base's gas (25 USDC → MON 435,460 against 269,610 for 25 USDC → ETH on Base; 100 MON → AUSD 453,247), but 62,000 MON → AUSD (about $660, 10 fills) took 3,970,462 and 1,000,000 MON → AUSD (about $10,700, 11 fills) 6,140,730. Under one 6,000,000 cap for every chain, live 0x sales of MON were refused from about $10,000 (2026-11-26: for 1,000,000 MON → AUSD 0x asked for 5.0–6.1 million, a padded 6.05–7.39 million — the recording `monad-mon-ausd-1m.2026-11-25` is one of them). `eth_estimateGas` of that recorded call, from the taker with its balance overridden for the call (nothing sent), came to 5,995,993 at first and to 6,107,627–6,423,555 when read again later that day (the call's deadline moved forward, Monad's RPC taking no block override), and those later reads ran out of gas at 6,000,000: the swap alone can need more than the old cap. Sales of 150,000–700,000 MON (about $1,600–7,600) sat at 82–93 % of that cap — refused or not depending on the route 0x picked, its gas moving about 20 % from one quote to the next. Under 15,000,000 those sales pass with room; a quote whose stated gas, padded, is past it is still refused (`policy_refused`, naming the chain and its cap). The cap reads 0x's `transaction.gas` as a decimal string: a quote that states none that way (absent, zero, or in another notation) carries no gas limit, so there is nothing for the cap to hold, and nothing the engine would have sent either, as it sends its own estimate. A `chains` entry may set its own `maxGasLimit`, a bigint from 1 to 30,000,000 (Monad's per-transaction gas limit), so config can raise a chain's cap but not remove the bound; an entry replaces the default whole, so a Monad entry of your own without `maxGasLimit` has the 6,000,000 cap. An EIP-7702-delegated account on Monad cannot go below 10 MON (Monad's reserve balance), so selling all of its MON does not go through; how a plain account fares on "sell all MON" has not been verified.

## What is checked before anything is signed

**The Settler comes from the chain, not from the API.** 0x replaces its Settler contracts regularly. The module reads the Settler in force (`ownerOf(2)`) and the one it replaced (`prev(2)`) from 0x's on-chain registry `0x00000000000004533Fe15556B1E086BB1A72cEae` through your RPC, and accepts a transaction only when its target is one of the two. The answer is held to bounds the RPC cannot move:
- it must be an address the registry deploys Settlers to — `CREATE3(registry, feature 2, this chain, nonce)`, computed on the device (`zeroExSettlerNonce`) — so an RPC cannot name an arbitrary contract or account;
- that deployment must sit inside the window the chain table pins: no older than the previous Settler live when the table was pinned (`previousLiveNonce`; an older, replaced Settler is refused) and no newer than the one in force then (`newestLiveNonce`; Base: 23 and 22 since 2026-11-25, after 0x's 2026-11-24 release; Monad: 12 and 11) plus, for a token sale, a margin of two (`ZEROEX_SETTLER_NONCE_MARGIN`);
- a **native-coin sale goes only to the pinned current or previous Settler**, never into the margin: its value is sent to the address as it is, and whether a deployment inside the margin exists is only the RPC's word. A token sale may use the margin, since its permit can be spent only with the account itself as the caller;
- a newer deployment is refused with what to do (update the package, or raise the pins once the deployment is checked) — native sales from the day 0x deploys it, token sales once it is past the margin. The watch job reports every new deployment (`ownerOf(2)` and `prev(2)` per chain in `watch.json`; a new Settler in force is a severity-high change) and `verify:live` fails as long as the registry names anything but the pinned pair, so the pins are raised promptly;
- there must be a contract at that address (`eth_getCode`, through the same RPC): a deployment that does not exist yet would strand what is sent to it.

A live quote therefore needs `rpcUrls` for its chain. The read is cached for five minutes (`settlerMaxAgeMs`) and repeated right before the broadcast — in remote mode on the device, before the backend's own preflight is asked — so a Settler paused, replaced or removed while the review screen is open is refused with nothing sent. A live quote in remote mode is held to exactly the set its own request read, however long the backend takes, and a native sale's quote stays valid for at most two minutes (`ZEROEX_MAX_NATIVE_QUOTE_SECONDS`; a token sale's is bounded by its permit).

**The Permit2 payload is rebuilt locally.** The API's typed data is read strictly and compared with the request; what the account signs is rebuilt from local constants:
- domain: `Permit2`, the chain of the swap, the canonical Permit2 address;
- type: `PermitTransferFrom` and nothing else (no witness, no `PermitSingle`);
- token: the token being sold; amount: exactly the input, not more;
- spender: the Settler the transaction calls, which is one from the registry;
- deadline: in the future and no further than ten minutes away (0x signs five minutes ahead).

**The transaction is decoded.** The calldata must be the Settler's `execute(AllowedSlippage, bytes[], bytes32)`:
- `to` is a registry Settler inside the pinned window (for a native sale, one of the two pinned); the chain id matches; the value is zero for a token sale and exactly the input for a native sale;
- the slippage tuple pays **the recipient of this swap**, in **the token asked for**, at least **the quoted minimum** — and the quoted minimum is within the requested slippage of the quoted output and not below the caller's floor;
- for a token sale, the first action is one of the Settler's Permit2 payments, it pulls the sold token for the input amount with the same nonce and deadline as the signed payload, and the place for the signature is the very end of the calldata;
- for a native sale, the first action is `NATIVE_CHECK`. The Settler spends a Permit2 signature only in its first action and pulls from the caller, so this keeps an earlier, unspent permit of the account (one whose swap reverted) from being spent inside what looks like a plain native sale;
- 0x names canonical Permit2 as `allowanceTarget` on every answer, native sales included; anything else is refused, and a native sale's transaction carries no allowance target at all;
- the gas limit is held to the chain's cap (6,000,000; Monad 15,000,000), and the allowance target is the canonical Permit2.

Anything else is refused, with the reason, before an approval or a signature.

**What this gives.** The Settler checks the slippage tuple itself at the end of `execute`: the swap reverts, or the recipient receives at least the minimum of the buy token. The permit can move only the input amount of the sold token, only to that Settler, only once, and the only Permit2 payment the call can make is that permit. So the most a wrong answer can cost is the input of this swap (and gas), and only by reverting or by filling at the minimum.

One exception to "at least the minimum": the Settler measures its own balance of the buy token before the last transfer, so a buy token that takes a fee on transfer arrives short of it. Quotes for tokens 0x flags as taxed (`tokenMetadata.buyToken`) are refused; a tax 0x does not report (or reports as null) is not caught here.

**What is still taken from the API.**
- The route and the price above the minimum. A better fill than the minimum is not guaranteed by any check here: 0x's routes end in a `POSITIVE_SLIPPAGE` action that keeps the surplus above the quoted amount for 0x (it is in the calldata), and a route could set that line at the minimum.
- The fee amounts and the gas estimate it reports.
- The actions after the first one (the route itself), the recipient argument inside the first action (where the Settler sends the pulled tokens on its way through the route) and `zidAndAffiliate`. These decide how the swap is filled, not what the recipient must receive.
- The device trusts its own RPC for the registry read, within the bounds above: the RPC can name only a genuine 0x deployment inside the pinned window, and within the margin (token sales only) it is trusted to say truthfully whether a contract is there.

In remote mode the same checks run on the device (`zeroExPins` → `verifyQuote`, `verifyBuild`, pinned call targets and spender, and the fresh registry read in `preflightDeposit`), so the list above is what the app trusts in its backend and in 0x together. Keep the app's `rpcUrls` out of the backend's hands where you can: the registry read is what the device trusts for "which contract is the Settler", and the CREATE3, pin and code checks bound it to deployed 0x Settlers — for native value, to the two pinned ones.

**Signing policies.** The engine's permit names the Settler as spender, and the Settler rotates. A kit allowlist must list Permit2, the token and the Settlers in force, and wallet-evm's `describeTypedData` should know them as `knownSpenders` rather than a fixed address. `zeroExKnownSpenders(provider, chainId)` gives that map (`{ [settler]: "0x Settler" }`) from the resolver the provider itself reads through (`provider.settlerResolver`):

```ts
const zeroex = zeroExRemoteProvider({ baseUrl, rpcUrls })
const knownSpenders = await zeroExKnownSpenders(zeroex, 8453)
describeTypedData(typed, { chainId: 8453, account, knownSpenders })
// kit allowlist: [PERMIT2_ADDRESS, token, ...Object.keys(knownSpenders)]
```

It is empty when the registry cannot be read, so the permit is then described as a grant to an unknown spender. `extension-kit` shows the permit on the swap sheet and pre-approves exactly it and the signed call.

## Fees

0x reports its fees in the answer, and a quote whose fees cannot be read is refused rather than shown as free.

| In the 0x answer | In the quote |
|---|---|
| `fees.zeroExFee` — 0x's own fee, taken on-chain out of the trade; `buyAmount` is already net of it | `protocol`, `included: true` |
| `fees.integratorFee` / `integratorFees` | none is requested; an answer that carries one is refused |
| `fees.gasFee` (gasless trades only) | `network`, `included: true` |
| `totalNetworkFee`, or `gas × gasPrice` | `network`, `included: false` (paid by the account in the native coin) |

0x also keeps positive slippage (the part of a fill above the quoted amount): it is not a line in the answer's fees but the calldata's `POSITIVE_SLIPPAGE` action, which sends the surplus above the quoted amount to 0x. The quoted amount and the minimum are what the checks hold the swap to.

## Configure

```ts
import { zeroExProvider } from '@anywalletkit/protocol-swap2-0x'

// on your server only: under React Native a provider with a key throws
const zeroex = zeroExProvider({
  apiKey: () => process.env.ZEROEX_API_KEY,
  rpcUrls: { 8453: ['https://base.example/rpc'] },   // needed for live quotes: the Settler registry is read here
})
```

```ts
import { zeroExRemoteProvider } from '@anywalletkit/protocol-swap2-0x/remote'

// in the app: no key, the checks stay on the device
const zeroex = zeroExRemoteProvider({
  baseUrl: 'https://your-backend.example/api/swap2',
  rpcUrls: { 8453: ['https://base.example/rpc'] },
})
```

| Option | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` takes the provider out of the auction (wire it to `ZEROEX_ENABLED`). |
| `apiKey` | none | The 0x key (local mode, servers only — refused under React Native): a getter (preferred) or a string. Without one the provider serves no route. |
| `baseUrl` | `https://api.0x.org` | API origin (local mode), or your swap2 backend (remote mode). `https` only. |
| `rpcUrls` | none | `{ chainId: [url…] }` — registry reads and receipts. Required for live quotes. |
| `chains` | the eight chains above | Chain table: `{ chainId: { name, registry, newestLiveNonce, previousLiveNonce, wrappedNative, maxGasLimit } }` merged over the defaults; `null` removes a chain. `newestLiveNonce` and `previousLiveNonce` (required) are the Settler deployments the registry names as current and previous when you pin the entry (`pnpm verify:live` prints both): native sales go only to these two, token sales also to the next two deployments once they hold code, nothing older than the previous one. `maxGasLimit` (optional) is the chain's gas cap on the padded limit, a bigint from 1 to 30,000,000; without it, 6,000,000 (the default table sets 15,000,000 on Monad only). An entry replaces the default whole. |
| `defaultSlippageBps` | `50` | Used when the caller passes none. Keep it the same on the backend and in the app. |
| `quoteTtlMs` | `120000` | How long a quote is offered; never past the Permit2 deadline − 20 s, and a native sale's never past 90 s. A quote that lapses while an approval mines is re-quoted by the engine (the permit is signed once, after the approval). |
| `timeoutMs` | `10000` | Per API request. |
| `excludedSources` | none | Liquidity sources 0x must not route through, by their names in 0x's `/sources` list. A name 0x does not know refuses the quote (it would not be excluded). |
| `settlerMaxAgeMs` | `300000` (5 minutes) | How long a registry read is reused. |

`ZeroExSwap2Protocol` (`/protocol`) is the same provider as a stand-alone swap2 protocol over one account.

## Not supported

- **AllowanceHolder.** 0x's docs now recommend the AllowanceHolder flow (an allowance to the AllowanceHolder contract, one transaction, no signature) for most integrations. This module implements the Permit2 flow: the allowance stays with Permit2 and each swap is authorized by its own exact, expiring signature. AllowanceHolder is pinned only so it can be told apart and refused as an allowance target.
- The Gasless API, cross-chain swaps, exact-output swaps.
- Wrapping and unwrapping (native ↔ wrapped native): 0x answers those with a call to the token, not to a Settler.
- Buy tokens that tax transfers, a first action that is not a known Permit2 payment (including RFQ fills as the first action), and the older calldata layout with the signature placed inside the action. They are refused, not attempted.

## Refusals

Every refusal reads `zeroex: <what was found>` and reaches `onRefusal(text, info)` with a `Swap2RefusalReason` in `info` (thrown errors carry it for `refusalOf`; `zeroExPins().reasonOf` classifies the remote verifiers' texts). A malformed request and the caller's own abort stay unclassified.

| What was found | Reason |
|---|---|
| HTTP 429 | `rate_limited` (with `retryAfterMs` from Retry-After) |
| HTTP 401 / 403, no key configured | `key_rejected` |
| 5xx, an unreachable API, an answer that cannot be read (amounts, fees, transaction) | `upstream_unavailable` |
| no liquidity | `insufficient_liquidity` |
| 0x's own error names | the closest reason (`TOKEN_NOT_SUPPORTED` → `unsupported_pair`, `INPUT_INVALID` → `no_route`, …) |
| a chain or pair 0x does not serve, wrapping, a buy token that taxes transfers | `unsupported_pair` |
| a paused registry | `chain_halted` |
| another Settler; a Settler outside the pinned window, without code, or — for a native sale — not one of the two pinned; another Permit2 spender, domain or allowance target | `vault_mismatch` |
| another recipient | `recipient_mismatch` |
| what the swap is held to deliver: a transaction value other than the input (a native sale) or zero (a token sale), the slippage check's buy token or minimum, a quoted minimum outside the requested slippage or below the caller's floor, a Permit2 payload for another token or amount | `price_check_failed` |
| what the answer itself says: other tokens or another sell amount than the ones asked for, a first action that pulls another token, amount or permit; an integrator fee nobody asked for, an excluded source 0x does not know, an answer that came through a redirect, a native-sale quote valid for more than two minutes, and anything else the checks refuse | `policy_refused` |
| a passed deadline, a Permit2 deadline too close to sign against | `quote_expired` |

## Checks

```sh
pnpm test                                   # unit, probes, and every recorded real 0x answer (fixtures/quotes)
ZEROEX_LIVE=1 ZEROEX_API_KEY=… pnpm test    # also live quotes from api.0x.org (read-only)
pnpm verify:live                            # registry, Settlers (code, the pinned current / previous pair), Permit2 on all eight chains; with ZEROEX_API_KEY also live corridors
```

The recordings in `fixtures/quotes` are real 0x answers, one set per pin era (`fixtures/pin-eras.json`): 2026-11-15 on the first seven chains, 2026-11-25 on all eight (recorded 2026-11-26, when 0x still quoted the previous Settler everywhere). Each replays with its own era's chain table and registry answer (exactly the era's current and previous Settler), every era must be recorded on every one of its chains — a native-coin sale, a token sale and an indicative price — and each era's recordings are pinned by name. No era or chain may be listed as unrecorded, not even the era in force, so a pin raise lands with its recordings, which need a 0x API key and must be made while 0x still quotes the new era's Settlers.

`verify:live` reads public RPCs (`RPC_<chainId>=url[,url]` overrides one: the first URL, then the retry). A chain no RPC answers fails the run: its pins are unchecked. A read the RPC did not answer (a JSON-RPC error that is not a revert, an answer for another chain, an RPC with no state) moves to the next URL; a registry that names no Settler is read again (up to three tries) until a second answer names none too; what `ownerOf(2)` named is kept when a later read gets no answer, so a new deployment is reported as NEW even then; `ownerOf(2)` reads that disagree print a `note chain …` line. A failed run ends with `FAILED (n)` and a `Reason:` line that names every chain that is not ok, by verdict (`Reason: NEW on 1, 8453; unreachable on 143`), preceded by `Severity: high` when a sale through the Settler in force is refused today (a new deployment on a pinned chain refuses native-coin sales from the day it lands). Without `ZEROEX_API_KEY` the live corridors (including Monad MON → AUSD and USDC → MON) are skipped with a neutral line.


## `blockNumber`

`QuoteParams.blockNumber` (one block for a comparison round) is not supported: the price comes from the 0x Swap API, so the quote names no block (`Quote.blockNumber` absent).

## License

Apache-2.0
