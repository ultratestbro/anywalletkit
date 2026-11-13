# @anywalletkit/protocol-swap2-relay

[Relay](https://relay.link) for the swap2 engine, talking to Relay's own API and **verifying the whole order on the device before anything is signed**.

A Relay deposit names an order by its hash. The hash commits to everything that matters — who is paid, on which chain, in which token, how much at least, and where a refund goes — but the deposit calldata itself shows none of it. This module asks Relay for the order behind the hash (`includeProtocolData: true`), recomputes the hash itself, checks the order against what the user asked for, and builds the deposit from its own pins. An API or a proxy that answers with someone else's order gets a named refusal, never a signature.

- EVM → EVM, exact input, native coin and ERC-20, 29 chains (below).
- One source transaction: `depositNative` / `depositErc20` on the chain's RelayDepository. An ERC-20 input is approved for exactly the input amount, to the pinned depository; the API's own `approve` step is never used.
- No provider SDK: `viem` for hashing and ABI, `@noble/curves` for signature recovery.
- No key needed for quotes today. `baseUrl` can point at your own proxy that adds one — the proxy needs no trust.

```ts
import {relayProvider} from "@anywalletkit/protocol-swap2-relay";
import {CrossChainRouter} from "@anywalletkit/protocol-swap2-router";

const relay = relayProvider({baseUrl: "https://your-backend.example/relay"}); // or nothing: https://api.relay.link
const router = new CrossChainRouter([relay /*, …other providers */]);
```

Standalone: `new RelaySwap2Protocol(account, {fromChain: "eip155:42161"})`.

| option | |
|---|---|
| `baseUrl` | Relay's API (default) or your proxy in front of it. Untrusted either way. |
| `apiKey` | Sent as `x-api-key`. Prefer a proxy: a key shipped in an app is public. |
| `quoteTtlMs` | Local lifetime of a quote, default 60 s, at most 5 min. |
| `fetchImpl` | Your own `fetch`. |
| `enabled` | Default `true`. |

## What is checked

Every check has a code; a refusal reads `relay: <what was found> [<code>]` and reaches `onRefusal`. Nothing returns a silent null. Next to the text, a refusal carries `reason`, a stable `Swap2RefusalReason` from `@anywalletkit/protocol-swap2-core` (on the thrown error, as `onRefusal`'s second argument, and through `relayPins.reasonOf` for the pins' texts): for example `recipient_mismatch` for an order paying or refunding someone else, `vault_mismatch` for a deposit or approval off the pinned depository, `price_check_failed` for a minimum under the floor or the slippage, `quote_expired` for an order older than ten minutes, and Relay's own answers by its `errorCode` or the HTTP status (`rate_limited` with `retryAfterMs`, `key_rejected`, `upstream_unavailable`). A malformed request from the caller carries none.

**The order is the one the deposit names**

- the envelope is Relay's `protocol.v2` on the `base` hub with an order and a signature (`protocol-data-missing`, `hub-type`);
- the order parses strictly — own keys only, exact field types, canonical decimal integers, hex of the stated length (`order-malformed`);
- the id recomputed here (`hashStruct` of the order, Relay's types, no domain) is the id the API states and the id in the calldata (`order-id-mismatch`, `tx-id`);
- `order.solver` on `order.solverChainId` is a pinned solver, and `orderSignature` (EIP-191 over the 32 id bytes) recovers to it (`solver-not-pinned`, `signature-invalid`).

**The order has the one shape this module reads**

- version `v1` (`order-version`); exactly one input (`order-inputs`) with a non-zero weight (`input-weight`); exactly one output payment (`order-payments`); no calls on the destination (`order-calls`); no extra fees charged by the order (`order-fees`).

**The order says what the user asked**

- input: the source chain by Relay's name for it, the token, and exactly the amount being sent (`input-chain`, `input-currency`, `input-amount`);
- output: the destination chain, the user's recipient, the requested token (`output-chain`, `output-recipient`, `output-currency`);
- `minimumAmount` is what the quote shows as the minimum and is never below the caller's own floor, nor further below the expected amount than the slippage asked for — the caller's `slippageBps`, or 2 % when none is named, which is also what the request to Relay always says (`slippageTolerance`); `expectedAmount` is only an estimate and is never enforced or shown as a guarantee (`output-minimum`, `output-expected`);
- deadlines are Relay's seven days from a quote issued within the last ten minutes — an old order is stale even when everything else fits (`output-deadline`, `refund-deadline`);
- there is a refund on the source chain to the sender in the token sent, and any refund on the destination chain goes to the recipient (or the sender); nobody else is named, on no other chain (`refund-missing`, `refund-chain`, `refund-recipient`, `refund-currency`);
- the API's own summary of the payment is there and describes the order's input on the pinned depository (`payment-details`).

**The transaction is that order's deposit and nothing else**

- `to` is the pinned depository of the source chain, on that chain (`tx-target`, `tx-chain`);
- the call is `depositNative(address,bytes32)` or `depositErc20(address,address,uint256,bytes32)` with canonical arguments and no trailing bytes; the whole-allowance `depositErc20(address,address,bytes32)` and everything unknown are refused (`tx-selector`, `tx-calldata`);
- the depositor is the sender's own address, never zero (`tx-depositor`); token and amount are the order's input (`tx-token`, `tx-amount`); `value` is the amount for the native coin and zero otherwise (`tx-value`);
- what is returned for signing is the call this module encoded, compared byte for byte with the one offered.

**Around it**

- `preflightDeposit` runs all of it again on the exact bytes about to be signed, against the request this instance issued the quote for; a refused preflight spends nothing.
- One deposit per order (`order-reused`): the ids cleared for signing are kept for the whole JS realm, across provider instances, for longer than an order can pass the age check. Pass `clearedStore` (`has` / `add`) to keep them on disk as well, so that an app restart inside those minutes does not forget; a store that fails refuses the signature.
- A quote that accounts for an app fee or a gas top-up is refused (`app-fee`, `gas-topup`): this module asks for neither.
- A quote priced without the user's addresses (a dry quote) is never built or signed.
- `relayPins` gives `remoteProvider` the same checks on the client of a swap2 server: `callTargets` / `spenders` are the depository, `verifyQuote` and `verifyBuild` run the verifier against the user's own request. On that path the client also holds the gas limit to the band this module itself sets (`quote-gas`), the quote's life to five minutes plus clock skew (`quote-expiry`) and the tracking id to the quote's own request id, and refuses a second build for the same order (`order-reused`).

**What the answering side can still do**

`baseUrl` (an app's proxy that adds the API key) or a swap2 server cannot get a deposit signed for another recipient, chain, token, refund address, or a minimum other than the one shown. It can make the quote *worse*: the solver signs whatever request reaches Relay, so a request forwarded with an app fee or a gas top-up comes back as a genuine order with a lower expected amount, and the fee line that gives it away can be stripped. The amounts shown are always the order's own. What bounds the price is the caller's `minAmountOut` or the other quotes in the router — that policy is the app's, not this module's. The fee, the ETA and the status of a request are the answering side's word and are display only.

## What is refused by design

- **Routes that first swap on the source chain** (an input Relay does not hold inventory in — e.g. ARB, POL, MNT, or HYPE out of Elysium). Their "deposit" calls a Relay router, not the depository; it is refused as `tx-target`.
- Non-EVM chains, same-chain swaps, exact-output, destination calls, chains without a pin.

## After the deposit

`trackIntent` reads `GET /intents/status/v3?requestId=` — display only; nothing is signed on its word.

| Relay | swap2 |
|---|---|
| `waiting`, `depositing`, `pending`, `submitted`, `delayed`, unknown | `pending` |
| `success` | `completed` (the fill's hash as `destTxHash`) |
| `refund`, `refunded` | `refunded` |
| `failure` | `refund-pending`; `failed` when Relay reports that the refund itself failed |

**If the order is not filled.** There is nothing to claim on chain and this module builds no claim transaction: the deposit sits in the RelayDepository, and money leaves it only on a withdrawal authorised by Relay's allocator. Relay refunds an unfilled or failed order on its own — to the sender on the source chain in the token sent, or to the recipient on the destination chain — which is why the verifier holds every refund entry of the order to those two addresses before the deposit is signed. A request that stays `refund-pending`, or turns `failed`, is a support case for Relay: give them the request id (the part of `intentId` after `relay:`) and the deposit transaction hash. The trust that remains after verification is this one: that Relay's solver fills the order it signed, or refunds.

Activity: the deposit is recognised (`Bridged USDC`, `Relay · Arbitrum`). The fill is not claimed — Relay's relayers pay with an ordinary transfer that names neither the order nor Relay, so it reads as an incoming transfer.

## Pins

Read on 2026-11-10 from `GET https://api.relay.link/chains` and on chain; `pnpm verify:live` re-reads all of it.

- RelayDepository `0x4cd00e387622c35bddb9b4c962c136462338bc31` on Ethereum, OP Mainnet, BNB Chain, Gnosis, Unichain, Polygon, Monad, Sonic, X Layer, zkSync Era, World Chain, HyperEVM, Morph, MegaETH, Robinhood Chain, Arc, Base, Plasma, Arbitrum, Celo, Avalanche, Ink, Berachain, Plume, Elysium, Scroll, Katana; `0x59916da825d2d2ec1bf878d71c88826f6633ecca` on Mantle and Linea.
- Solver signer `0xf70da97812cb96acdf810712aa562db8dfa3dbef` on `base`.
- Chain names inside an order come from `/chains[].protocol.v2.chainId`, which is not always the display name (`bnb`, `worldchain`).
- `watch.json` has the watch job read `/chains`, each depository's code, `allocator()` and `owner()`, the contract and order sources, and Relay's validation page.

## Limits

- The seven-day deadline rule is Relay's current constant; if Relay changes it, quotes are refused (`output-deadline`) until the pin is updated.
- An order that charges fees inside the order (`fees`) is refused; today's orders carry none.
- The contract a refund or fill is routed through (`extraData`) is Relay's choice and is not pinned; the recipients are.
- The memory of issued quotes is per provider instance; the record of cleared orders is per JS realm and in memory unless `clearedStore` is given. What Relay does with a second deposit for one order id was not tested.
- A caller may ask for up to 50 % slippage (`slippageBps` 5000); more is refused.
- `trackIntent` is not checked against the chains: a `completed` is Relay's statement, not a verified fill.

## Checks

```
pnpm test                 # unit: hash vectors, signature recovery, a negative for every check
RELAY_LIVE=1 pnpm test    # + live quotes through the provider and the router (read-only, keyless)
pnpm verify:live          # every pin against /chains and on chain, twelve live corridors (read-only)
```
