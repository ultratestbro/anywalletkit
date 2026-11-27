# @anywalletkit/protocol-swap2-across

[Across Protocol](https://across.to) for the swap2 engine, with **the SpokePool deposit built on the device and every argument verified before anything is signed**.

An Across deposit is one call, `deposit(...)` on the source chain's SpokePool. Its arguments say everything — who is refunded, who is paid, in which token and how much, on which chain, by when, and what runs on arrival — and the SpokePool checks almost none of it: there is no route list on chain, no token pairing, and the `depositor` (refunds, speed-ups) is not bound to the sender. So this module never signs a transaction a quote source hands over. The quote source supplies only **numbers** (the output amount, the quote time); the call is encoded here from the pinned SpokePool and the user's own request, and checked again right before signing.

- EVM → EVM, exact input, the same asset on both sides: USDC, USDT / USDT0, ETH / WETH, WBTC, on 17 chains (below). Ethereum as the destination is not priced yet (refused, `route-unpriced`).
- One source transaction: `deposit` on the source SpokePool — a **direct deposit**, empty message, no exclusive relayer, a fill deadline two hours after the quote time. An ERC-20 input is approved for exactly the input amount, to the pinned SpokePool; the native coin is sent as `value` and wrapped by the SpokePool.
- Priced from **Across API V5** against **Across's relayer fee** (below). V5's own execution steps (`nextActions`) are never run.
- No provider SDK: `viem` for the ABI and hashing.

The V5 key belongs on a server. Run the provider there, behind `createSwap2Handler`, and the remote provider in the app — it re-runs every check below on the device:

```ts
// server
import {acrossProvider} from "@anywalletkit/protocol-swap2-across";
import {createSwap2Handler} from "@anywalletkit/protocol-swap2-core/server";
const across = acrossProvider({apiKey: () => process.env.ACROSS_API_KEY, rpcUrls});
const handle = createSwap2Handler({providers: [across, /* … */], sealSecret, guard, subject});

// app
import {acrossRemoteProvider} from "@anywalletkit/protocol-swap2-across";
import {CrossChainRouter} from "@anywalletkit/protocol-swap2-router";
const router = new CrossChainRouter([acrossRemoteProvider({baseUrl: "https://api.example.com/swap2", rpcUrls}) /*, … */]);
```

Standalone (server): `new AcrossSwap2Protocol(account, {fromChain: "eip155:8453", apiKey})`. Conventional env names: `ACROSS_ENABLED`, `ACROSS_API_KEY` (the V5 key from dashboard.across.to). Across's integrator id and its V4 key are not used.

| `acrossProvider` option | |
|---|---|
| `apiKey` | The Across API V5 key, a getter (read on every request) or a string. Sent only as `Authorization: Bearer` to `baseUrl`; an answer that came through a redirect is refused. Without one the provider is disabled (it still builds, verifies and tracks). **Under React Native it throws**: an app bundle keeps no secret. |
| `enabled` | Dark flag (default true). |
| `baseUrl` | V5 origin, default `https://api.across.to` (https only; http only for localhost). |
| `suggestedFeesUrl` | Across's keyless relayer-fee quote, default `https://app.across.to/api/suggested-fees`; `null` prices every quote from the pinned floor. |
| `rpcUrls` | JSON-RPC URL per CAIP-2 chain: status (the source chain's to read the deposit, the destination's to read its fill), and the quote time when `/suggested-fees` does not answer (Ethereum's and the source chain's latest block). |
| `maxFeeBps` | The most a deposit may leave to relayers (input − output), in bps of the input. Default 1000, at most 5000. |
| `quoteTtlMs`, `timeoutMs`, `fetchImpl` | Local quote life (default 60 s, at most 5 min), per-request timeout (default 10 s), your own `fetch`. |

`acrossRemoteProvider({baseUrl, maxFeeBps?, rpcUrls?, suggestedFeesUrl?, headers?, timeoutMs?, fetchImpl?})`: the app's fee cap (the server's is not known on this side), and with `rpcUrls` for both chains the deposit's status is read on the device instead of asked of the backend. For every quote the backend sends, dry or live, the app reads **Across's keyless relayer fee itself** (`https://app.across.to/api/suggested-fees` through `fetchImpl` — a browser app's CSP must allow it in `connect-src`; nothing secret is sent) and refuses a deposit that leaves relayers more than 10 % under it (`relayer-price`, `price_check_failed`): a backend cannot get a deposit signed that relayers would leave unfilled, nor win the router's comparison with one. Across refusing the deposit refuses the quote; no answer leaves only routes the pinned floor covers (below), on the per-asset floor, and refuses the rest (`upstream_unavailable`). `suggestedFeesUrl: null` turns the read off, with that same fallback. Right before signing, `preflightDeposit` runs the whole check again by the device's clock before the backend is asked.

## Pricing

The one number a quote source decides is how much the deposit leaves to relayers. Too much asked of relayers (output too high) and nobody fills: the funds wait for the two-hour fill deadline and then Across's refund bundles. Too little and the user overpays. A V5 quote prices **V5's own route**, not a direct deposit: an execution step on the origin chain (Across's Gateway, its gas charged inside the fee — over $1 on Ethereum origins), sometimes another rail (USDT Ethereum → Arbitrum went to a ~20-minute rail), and an auction whose relayers take large ETH L2 → L2 transfers at ~1 bp, well below what direct deposits are filled at. So the provider (on the server) prices:

```
F5    = V5 fee.totalFee − Σ V5 gasEstimates[origin, included_in_transfer_fee]   (wei on ETH routes; else USD at the token's price, rounded down)
Fneed = /suggested-fees totalRelayFee.total                                       while Across answers it
      = floor(asset, origin, size) + 1.5 × V5's destination gas                  otherwise
fee   = max(F5, Fneed);   outputAmount = input − fee
      = Fneed from /suggested-fees alone, when V5's fill estimate is over a minute     (V5 priced another rail)
quoteTimestamp = /suggested-fees `timestamp` (its LP fee was priced there; never ahead of the server's clock), else min(Ethereum's latest block − 60 s, the source chain's)
fillDeadline   = quoteTimestamp + 7200;   exclusiveRelayer = 0
```

- Never more than V5 charges for the same transfer (net of the step a direct deposit does not have; the user's wallet pays the deposit's own gas), never less than direct deposits are filled at. Study of 2026-11-14 (27 V5 / `/suggested-fees` pairs, 8 272 deposits over 24 h on Ethereum, Optimism, Base, Arbitrum): 1 369 of 1 369 organic plain deposits to Base, Arbitrum and Optimism priced at or above the relayer fee were filled — p50 2 s, p90 13 s, p99 76 s.
- When V5's `expectedFillTimeMs` is over a minute it priced another rail (a CCTP or OFT transfer: USDT Ethereum → Arbitrum at ~20 min and 12× the relayer fee), which is no bound on a direct deposit: the deposit is then priced on `/suggested-fees` alone, and refused without it (`route-unpriced`, `upstream_unavailable`) — never on the floor or on V5.
- V5 is asked with `maxFee.bps = 5000`: that bounds only V5's own guaranteed minimum (never used); at 1000 it refused Ethereum-origin transfers under ~$17 because of its own origin gas. The user's cap is held on the deposit.
- The floor without `/suggested-fees` (read off 24 h of fills): stablecoins 1.00 bp, WBTC 3.10 bps, ETH from Ethereum 1.00 bp, ETH from an L2 4.77 bps at $0 → 5.4 at $2 000 → 9.2 at $36 000 (linear), refused above $36 000. It covers Ethereum, Optimism, Base and Arbitrum to Optimism, Base and Arbitrum; other routes are refused without `/suggested-fees` (`relayer-price`) rather than priced on a guess. Across calls `/suggested-fees` legacy: the floor is a snapshot of today's market, and the watch's canary turns `warn` when it answers no more (`fail` when it refuses a pinned corridor).
- `/suggested-fees` refusing the deposit — any 400: `AMOUNT_TOO_LOW`, `AMOUNT_TOO_HIGH`, `ROUTE_NOT_ENABLED`, `INVALID_PARAM` for a token or chain it does not serve (`unsupported_pair`), a code this module does not know — or `isAmountTooLow`, outside its `limits`, refuses the quote; naming another SpokePool than the pinned one refuses it too (`vault_mismatch`: the pins need a review). Only no answer, a 404 / 5xx, or an answer of another shape falls back to the floor.
- `providerData` shows how the number was reached: `priceSource` (`suggested-fees`, `suggested-fees (V5 other rail)` or `floor`), `v5Fee` (F5) and `relayerFee` (Fneed), base units.

## What is checked

Every check has a code; a refusal reads `across: <what was found> [<code>]`. Next to the text it carries `reason`, a stable `Swap2RefusalReason` from `@anywalletkit/protocol-swap2-core` (on the thrown error, as `onRefusal`'s second argument, and through `acrossPins.reasonOf` for the pins' texts): `recipient_mismatch` for a deposit crediting or paying someone else, `vault_mismatch` for a call or approval off the pinned SpokePool, `price_check_failed` for an output under the floor or a fee over the cap, `quote_expired` for a quote time or fill deadline too close, `unsupported_pair` for a route this module does not serve, `policy_refused` for the rest. A malformed request from the caller carries none.

**The request names a served route** (`chain-unsupported`, `token-unsupported`, `pair-unsupported`, `native-unsupported`, `wrapped-native-destination`)

- two different pinned chains; on each side a pinned token of the same asset with the same decimals;
- the native coin only where it is ether and the SpokePool has a wrapped native token for it;
- never the wrapped native token as a destination ERC-20: the destination SpokePool unwraps it for an EOA (`_unwrapwrappedNativeTokenTo`), so WETH asked for would arrive as ETH — ask for the native coin instead.

**The transaction is a deposit on the pinned SpokePool** (`tx-chain`, `tx-target`, `tx-selector`, `tx-calldata`)

- `to` is the source chain's SpokePool, `chainId` that chain;
- the calldata is exactly the canonical encoding of `deposit(bytes32,…,bytes)` (selector `0xad5425c6`): clean padding, the message at the only offset the encoding allows, nothing appended — Across's API appends a marker (`73c0de`, with `1dc0de` + an integrator id before it), which this module neither sends nor accepts; every party and token word is an EVM address (upper twelve bytes zero);
- `unsafeDeposit`, `depositNow`, `depositV3Now`, `speedUpDeposit`, `speedUpV3Deposit`, `multicall` are refused by name, anything else as unknown.

**Its arguments are the request**

- `depositor` is the signing account (`tx-depositor`) — `QuoteParams.sender`, which the engine sets to the account that signs; it is the address refunded on the source chain and the only one whose signature can speed the deposit up (redirect its output), so it is never a `refundAddress` the caller names: a live request without `sender` is refused, and so is one whose `refundAddress` is another account (`request-invalid`, `recipient_mismatch`); `recipient` is the user's recipient (`tx-recipient`); `destinationChainId` the requested chain (`tx-destination`);
- `inputToken` is the pinned token, the wrapped native token for the native coin (`tx-input-token`); `inputAmount` exactly the requested amount (`tx-input-amount`);
- `outputToken` is the same asset on the destination, the wrapped native token for the native coin (`tx-output-token`); `outputAmount` is above zero, at least the caller's floor, and not more than the input — a deposit asking relayers for more than it puts in is never filled (`tx-output-amount`); input − output is at least what relayers take on that asset — stablecoins 1.0 bp, ETH from Ethereum 0.7 bp, ETH from Optimism, Base or Arbitrum 4.5 bps, ETH from another L2 0.7 bp (Across's own relayer fee from Linea and Ink was 1.27 and 2.71 bps; those routes are priced only on it), WBTC 2.5 bps, at or under the lowest fees direct deposits were filled at (zero is refused by name: a deposit relayers do not fill waits hours for its refund, while its output would win any comparison of routes) — and within `maxFeeBps` (`tx-fee`);
- `message` is empty: a message starting with Across's V5 witness prefix (`keccak256("AcrossV5MessagePrefix.V1")`) is refused as `tx-message-v5`, any other as `tx-message`;
- no exclusivity: no exclusive relayer and no window — this module never sets one, and a relayer a quote source names would be the only one allowed to fill (`tx-exclusivity`);
- `quoteTimestamp` is at most 15 s ahead (the SpokePool reverts one ahead of its block; an honest one is minutes in the past) and at most 3600 − 300 s old — the SpokePool takes 3600 s, 300 s are kept for the deposit to land (`tx-quote-time`);
- `fillDeadline` is at least 30 min ahead, within the SpokePool's 6 h buffer, at most 7800 s after the quote time (Across's API gives 7200 s; an unfilled deposit holds the funds until then, and its refund comes after), and at least 3600 + 1800 s after it — the SpokePool has no lower bound on the fill deadline and takes the deposit until the quote time is 3600 s old, so a deposit that waits to be mined could otherwise land already expired (`tx-fill-deadline`);
- `value` is the input amount for the native coin and 0 otherwise (`tx-value`); an ERC-20 deposit approves the pinned SpokePool, a native one approves nothing (`tx-approval`).

**Around it**

- `buildAcrossDeposit(request, normalizedQuote)` encodes the call from the pins and the request and runs the verifier on its own result; `acrossQuoteOf` turns it into a swap2 `Quote` whose amounts are the deposit's (a relayer pays exactly `outputAmount`, so it is both the expected and the guaranteed output) and whose id names the calldata (`across:<from>:<to>:<digest>`).
- `buildDeposit` and `preflightDeposit` run the verifier again on the exact transaction about to be signed; `preflightDeposit` refuses typed data, a memo or a serialized transaction (`tx-shape`), and an Across speed-up signature by name (`speed-up`). `isAcrossSpeedUpTypedData` is exported for a wallet's signing guard.
- A dry quote (pricing only, priced for the caller's addresses or a placeholder) is never built or signed; a remote client derives the same request from the same parameters to verify it.
- `acrossPins` gives `remoteProvider` the same checks on the client of a swap2 server: `callTargets` / `spenders` are the SpokePool, `verifyQuote` and `verifyBuild` run the verifier against the user's own request, plus the gas limit band (`quote-gas`), a quote life of at most five minutes plus clock skew and never past quote time + 3300 s, when a deposit signed then would revert on its quote time (`quote-expiry`), and an id that names the deposit (`quote-intent`; a server's `~<tag>` suffix is accepted). It holds remote quotes to the default fee cap (10 %); `acrossPinsWith({maxFeeBps})` gives the pins the app's own cap — a server's `acrossProvider({maxFeeBps})` is not known on the client.
- The amounts a quote shows are the deposit's; the quote source's `expectedOutputAmount` is refused above `outputAmount` (`quote-normalized`), and `feeUsd` is the verified fee itself for USDC / USDT (one unit a dollar) and 0 for ETH and WBTC (no price here) — never the quote source's own USD figure. The fee in base units is in `fees`: exactly one included `protocol` fee of input − output in the input token (the zero address for the native coin). The pins hold a remote quote's `fees`, `feeUsd` and `destDecimals` to exactly that (`quote-amounts`): the engine's fee caps (`maxProtocolFeeBps`) add up `fees`, and the router scores by `feeUsd`.

**What a quote source can still do**

It cannot get a deposit signed for another recipient, depositor, chain, token, amount in, message or SpokePool, nor for an output under the caller's floor, a fee over the cap or under what relayers take on that asset. It chooses the numbers within those bounds: a worse (but capped) output, or a fill deadline inside the limits above (this provider sets two hours). Through `acrossRemoteProvider` the fee is also held to Across's own relayer fee, read on the device (10 % tolerance); with that read off or unanswered, a fee just over the per-asset floor can still be one relayers' prices have risen past on a route the floor covers. A deposit nobody fills is refunded to the signer on the source chain after its fill deadline (at most 7800 s after its quote time) — money is delayed by hours, not lost.

## What is refused by design

- **Periphery routes**: origin swaps (`swapAndBridge*`), `depositNative` through the periphery, gasless deposits — their target is not the SpokePool (`tx-target`). The native coin goes straight to the SpokePool's own `deposit`.
- **CCTP and OFT routes** Across's API may return (Circle's TokenMessengerV2, USDT0 OFT): not a SpokePool (`tx-target`).
- **Destination actions and any non-empty message**, including the MulticallHandler routes Across uses even for some bridge-only quotes (WETH → WETH): the recipient must be the user and nothing may run.
- **Speed-ups** (`UpdateDepositDetails` under the `ACROSS-V2` domain): never produced, refused if offered.
- Integrator / app fees, non-EVM chains, same-chain swaps, exact-output.

## After the deposit

`trackIntent` reads the chains, not Across (with `rpcUrls` for both chains):

1. the source receipt: a reverted deposit is `failed`; the deposit is the one `FundsDeposited` of the pinned SpokePool whose fields make the intent's own calldata — the canonical `deposit` call they encode hashes to the intent id's digest (an offset exclusivity resolved against the source block's time) — so another deposit in the transaction, or another transaction's, is never taken for it; a mined transaction without exactly one stays `pending` (a node with partial logs is not a failure);
2. the relay hash, computed as the destination SpokePool computes it (`keccak256(abi.encode(V3RelayData, destinationChainId))`);
3. the destination's `fillStatuses(relayHash)` at the latest block, with that block's time:

| on chain | swap2 |
|---|---|
| no receipt yet, or no source RPC | `pending` |
| deposit seen, no destination RPC | `pending` (deposit received) |
| `fillStatuses` 0 or 1, block time ≤ fill deadline | `pending` (deposit received) |
| `fillStatuses` 2 | `completed` |
| `fillStatuses` 0 or 1, block time > fill deadline | `expired` — no fill can land any more; Across refunds the depositor on the source chain through its settlement bundles, in hours |

A node that does not answer leaves the status `pending`; nothing is signed on what tracking reads. `trackAcrossDeposit` returns the deposit, the relay hash, the fill state (`unfilled`, `slow-fill-requested`, `filled`, `expired`) and the destination block alongside. The refund itself is not detected, so an expired deposit is reported `expired` (terminal: a poller stops) rather than a `refund-pending` that would never move on. The fill status is read at the destination's `latest` block from the app's own RPC (`rpcUrls`): `safe` / `finalized` tags are not served alike on every pinned chain and would hold `completed` back by minutes to an hour.

Activity: a `deposit` or `depositV3` call on a pinned SpokePool is recognised (`Bridged USDC`, `Across · Base`). Deposits made through another contract (the periphery, an aggregator, a Safe) and the fill (an ordinary transfer from a relayer) are not claimed.

## Pins

Read on 2026-11-15 from github.com/across-protocol/contracts @ `d652689f` (`broadcast/deployed-addresses.json`), the HubPool's `crossChainContracts(chainId)` on Ethereum (`0xc186fa914353c44b2e33ebe05f21846f1048beda`), and each SpokePool on chain (`chainId()`, `wrappedNativeToken()`, the 3600 s / 21600 s buffers, `pausedDeposits()` false, the deposit selector in the implementation; on zkSync Era a real deposit traced instead). Tokens from Across's own route and token lists, intersected with the SDK catalog.

| chain | SpokePool | tokens |
|---|---|---|
| Ethereum | `0x5c7bcd6e7de5423a257d81b442095a1a6ced35c5` | ETH, USDC, USDT, WETH, WBTC |
| Optimism | `0x6f26bf09b1c792e3228e5467807a900a503c0281` | ETH, USDC, USDT, WETH |
| Unichain | `0x09aea4b2242abc8bb4bb78d537a67a245a7bec64` | ETH, USDC, USDT0, WETH |
| Polygon | `0x9295ee1d8c5b022be115a2ad3c30c72e34e7f096` | USDC, USDT, WBTC |
| Monad | `0xd2ecb3afe598b746f8123cae365a598da831a449` | USDC, USDT0 |
| zkSync Era | `0xe0b015e54d54fc84a6cb9b666099c46ade9335ff` | ETH, USDT, WETH, WBTC |
| World Chain | `0x09aea4b2242abc8bb4bb78d537a67a245a7bec64` | ETH, USDC, WETH, WBTC |
| HyperEVM | `0x35e63ea3eb0fb7a3bc543c71fb66412e1f6b0e04` | USDC, USDT0 |
| MegaETH | `0x3db06da8f0a24a525f314eec954fc5c6a973d40e` | ETH, USDT0, WETH |
| Robinhood Chain | `0xd29c85f15df544ba632c9e25829fd29d767d7978` | ETH, WETH |
| Arc | `0x9b4a302a548c7e313c2b74c461db7b84d3074a84` | USDC (the 6-decimal interface of the gas coin; no native deposits) |
| Base | `0x09aea4b2242abc8bb4bb78d537a67a245a7bec64` | ETH, USDC, USDT, WETH |
| Plasma | `0x50039faefebef707cfd94d6d462fe6d10b39207a` | USDT0 |
| Arbitrum | `0xe35e9842fceaca96570b734083f4a58e8f7c5f2a` | ETH, USDC, USDT0, WETH, WBTC |
| Avalanche | `0xfe9d541c92e4e90437c7152a00244886de37a658` | USDC, USDT |
| Ink | `0xef684c38f94f48775959ecf2012d7e864ffb9dd4` | ETH, USDC, USDT0, WETH |
| Linea | `0x7e63a5f1a8f0b4d0934b2f2327daed3f6bb2ee75` | ETH, USDC, USDT, WETH, WBTC |

WETH is a source only (as a destination it arrives as ETH). USDT and USDT0 are one asset (Tether's USDT), as Across bridges them.

Not pinned: Scroll (deposits paused on chain), BNB Chain (Across moves its 18-decimal Binance-Peg USDC / USDT only into other assets), and the Across chains the SDK does not carry. `watch.json` has the watch job read each SpokePool's implementation and `pausedDeposits()`, the HubPool's registry entry for every pinned chain, the HubPool's code and owner, `deployed-addresses.json`, `SpokePool.sol`, `V3SpokePoolInterface.sol` and Across's V5 integration notes.

## Limits

- SpokePools are UUPS proxies the HubPool's owner (a 3-of-5 Safe) can upgrade or re-point; the pins hold the addresses, the watch job reports an upgrade or a re-pointed registry entry, and the decoder refuses any call it does not know.
- A fill pays a contract recipient the wrapped native token instead of the native coin (only EOAs and EIP-7702 wallets are unwrapped to); the module cannot tell a contract recipient from here.
- A refund of a native-coin deposit is expected in the wrapped native token: Across's settlement pays refunds as ERC-20 transfers and never unwraps (read from the contract, not yet observed).
- The device bounds the price, it cannot verify it: the fee cap (`maxFeeBps`, and the app's `acrossPinsWith({maxFeeBps})`) and the per-asset floor. The floors are today's relayer market (2026-11-14); if relayers' prices rise past them a server could still name a fee no relayer takes, which ends in a refund after the fill deadline.
- Stablecoin transfers cost a few cents more than the relayer market (V5's own fixed overhead stands in F5); large ETH L2 → L2 transfers cost ~2.7 bps more than V5's own route, whose auction relayers take less than direct deposits are filled at. A funded test of a direct ETH deposit at V5's price would show whether that gap can close.
- `/suggested-fees` is Across's legacy relayer-fee quote; without it the pinned floor prices only the studied chains.
- A quote's minimum is its output: a relayer pays exactly `outputAmount`, so `toTokenAmountMin` equals `toTokenAmount`. The engine quotes again when it executes, so pass `minAmountOut` a few bps under the quote (`suggestSlippage` gives at least 5): with the quoted minimum itself, a new price a few base units lower refuses the swap (`tx-output-amount`). On 2026-11-15 a 1.9 USDC Base → Arbitrum quote came back 15 base units lower (0.8 bps) at execution.

## Gas estimate

Quotes carry no `gasEstimate`: no Across answer states the gas of the deposit this module builds. V5's `gasEstimates`
and `nextActions[].estimatedOriginGas` price V5's own route (its origin execution step at a flat 325 000 / 375 000
gas, then approve / send at a flat 70 000 / 100 000 for a token or 23 416–25 016 for a native send, `fixtures/api/quotes`), not a SpokePool `deposit`, and
`/suggested-fees` names no origin gas. The quote has no `txRequest.gasLimit` either: the wallet estimates the deposit.

## Checks

```
pnpm test        # codec on real calldata, pins against Across's files and the HubPool, a negative for every check,
                 # status on recorded receipts and fill statuses (filled, unfilled, expired), activity, refusal reasons,
                 # real V5 and /suggested-fees answers through the pricing rule, the engine and createSwap2Handler
ACROSS_LIVE=1 ACROSS_API_KEY=… pnpm test tests/live.test.ts   # live quotes, verified, built, preflighted (read-only)
pnpm verify:live # keyless: every pin on chain and /suggested-fees on nine corridors; with ACROSS_API_KEY: live quotes
                 # through the provider, acrossPins and the server handler (read-only)
node scripts/record-fixtures.mjs   # re-record the status and activity fixtures (read-only, public RPCs)
ACROSS_API_KEY=… node scripts/record-quotes.mjs   # re-record fixtures/api/quotes through the real provider (read-only)
```
