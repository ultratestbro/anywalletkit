# @anywalletkit/protocol-swap2-across

[Across Protocol](https://across.to) for the swap2 engine, with **the SpokePool deposit built on the device and every argument verified before anything is signed**.

> **Status: quoting is not in this build.** Quotes will come from the Across API V5 (`https://api.across.to/v1`, a key from dashboard.across.to, kept server-side). Until that layer ships, the provider reports itself disabled — `enabled()` is `false` and `getQuote` refuses with `quote-unavailable` (`policy_refused`) — so no router or engine will route through it. What is here already: the pins, the deposit codec, the verifier, the builder, on-chain status, activity recognition and the remote pins.

An Across deposit is one call, `deposit(...)` on the source chain's SpokePool. Its arguments say everything — who is refunded, who is paid, in which token and how much, on which chain, by when, and what runs on arrival — and the SpokePool checks almost none of it: there is no route list on chain, no token pairing, and the `depositor` (refunds, speed-ups) is not bound to the sender. So this module never signs a transaction a quote source hands over. A quote source supplies only **numbers** (the output amount, the quote time, the fill deadline, the exclusivity terms); the call is encoded here from the pinned SpokePool and the user's own request, and checked again right before signing.

- EVM → EVM, exact input, the same asset on both sides: USDC, USDT / USDT0, ETH / WETH, WBTC, on 17 chains (below).
- One source transaction: `deposit` on the source SpokePool. An ERC-20 input is approved for exactly the input amount, to the pinned SpokePool; the native coin is sent as `value` and wrapped by the SpokePool.
- No provider SDK: `viem` for the ABI and hashing.

```ts
import {acrossProvider} from "@anywalletkit/protocol-swap2-across";
import {CrossChainRouter} from "@anywalletkit/protocol-swap2-router";

const across = acrossProvider({rpcUrls: {"eip155:8453": "https://…", "eip155:42161": "https://…"}}); // status only
const router = new CrossChainRouter([across /*, …other providers */]); // sits out until quoting ships
```

Standalone: `new AcrossSwap2Protocol(account, {fromChain: "eip155:8453"})`.

| option | |
|---|---|
| `rpcUrls` | JSON-RPC URL per CAIP-2 chain, for status: the source chain's to read the deposit, the destination's to read its fill. |
| `maxFeeBps` | The most a deposit may leave to relayers (input − output), in bps of the input. Default 1000, at most 5000. |
| `fetchImpl` | Your own `fetch`. |

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

- `depositor` is the request's sender (`tx-depositor`) — `refundAddress`, which the engine sets to the signing account unless the caller names another refund address; it is the address refunded on the source chain and the only one whose signature can speed the deposit up (redirect its output), so a refund address the user does not control must never be named; `recipient` is the user's recipient (`tx-recipient`); `destinationChainId` the requested chain (`tx-destination`);
- `inputToken` is the pinned token, the wrapped native token for the native coin (`tx-input-token`); `inputAmount` exactly the requested amount (`tx-input-amount`);
- `outputToken` is the same asset on the destination, the wrapped native token for the native coin (`tx-output-token`); `outputAmount` is above zero, at least the caller's floor, and not more than the input — a deposit asking relayers for more than it puts in is never filled (`tx-output-amount`); input − output is within `maxFeeBps` (`tx-fee`);
- `message` is empty: a message starting with Across's V5 witness prefix (`keccak256("AcrossV5MessagePrefix.V1")`) is refused as `tx-message-v5`, any other as `tx-message`;
- exclusivity: a relayer is named exactly when a window is; the window lasts at most an hour from now and ends at least 10 min before the fill deadline, so any relayer can still fill (`tx-exclusivity`);
- `quoteTimestamp` is at most 2 min ahead and at most 3600 − 300 s old — the SpokePool takes 3600 s, 300 s are kept for the deposit to land (`tx-quote-time`);
- `fillDeadline` is at least 30 min ahead and within the SpokePool's 6 h buffer (`tx-fill-deadline`);
- `value` is the input amount for the native coin and 0 otherwise (`tx-value`); an ERC-20 deposit approves the pinned SpokePool, a native one approves nothing (`tx-approval`).

**Around it**

- `buildAcrossDeposit(request, normalizedQuote)` encodes the call from the pins and the request and runs the verifier on its own result; `acrossQuoteOf` turns it into a swap2 `Quote` whose amounts are the deposit's (a relayer pays exactly `outputAmount`, so it is both the expected and the guaranteed output) and whose id names the calldata (`across:<from>:<to>:<digest>`).
- `buildDeposit` and `preflightDeposit` run the verifier again on the exact transaction about to be signed; `preflightDeposit` refuses typed data, a memo or a serialized transaction (`tx-shape`), and an Across speed-up signature by name (`speed-up`). `isAcrossSpeedUpTypedData` is exported for a wallet's signing guard.
- A quote priced without the user's addresses (a dry quote) is never built or signed.
- `acrossPins` gives `remoteProvider` the same checks on the client of a swap2 server: `callTargets` / `spenders` are the SpokePool, `verifyQuote` and `verifyBuild` run the verifier against the user's own request, plus the gas limit band (`quote-gas`), a quote life of at most five minutes plus clock skew (`quote-expiry`) and an id that names the deposit (`quote-intent`; a server's `~<tag>` suffix is accepted).

**What a quote source can still do**

It cannot get a deposit signed for another recipient, depositor, chain, token, amount in, message or SpokePool, nor for an output under the caller's floor or a fee over the cap. It chooses the numbers within those bounds: a worse (but capped) output, a fill deadline or exclusivity window inside the limits above. A deposit nobody fills is refunded to the sender on the source chain after its fill deadline — money is delayed by hours, not lost.

## What is refused by design

- **Periphery routes**: origin swaps (`swapAndBridge*`), `depositNative` through the periphery, gasless deposits — their target is not the SpokePool (`tx-target`). The native coin goes straight to the SpokePool's own `deposit`.
- **CCTP and OFT routes** Across's API may return (Circle's TokenMessengerV2, USDT0 OFT): not a SpokePool (`tx-target`).
- **Destination actions and any non-empty message**, including the MulticallHandler routes Across uses even for some bridge-only quotes (WETH → WETH): the recipient must be the user and nothing may run.
- **Speed-ups** (`UpdateDepositDetails` under the `ACROSS-V2` domain): never produced, refused if offered.
- Integrator / app fees, non-EVM chains, same-chain swaps, exact-output.

## After the deposit

`trackIntent` reads the chains, not Across (with `rpcUrls` for both chains):

1. the source receipt: a reverted deposit is `failed`; the one `FundsDeposited` of the pinned SpokePool for this route is the deposit (a mined transaction without exactly one is `failed`: it is not this transfer);
2. the relay hash, computed as the destination SpokePool computes it (`keccak256(abi.encode(V3RelayData, destinationChainId))`);
3. the destination's `fillStatuses(relayHash)` at the latest block, with that block's time:

| on chain | swap2 |
|---|---|
| no receipt yet, or no source RPC | `pending` |
| deposit seen, no destination RPC | `pending` (deposit received) |
| `fillStatuses` 0 or 1, block time ≤ fill deadline | `pending` (deposit received) |
| `fillStatuses` 2 | `completed` |
| `fillStatuses` 0 or 1, block time > fill deadline | `refund-pending` — expired: no fill can land any more; Across refunds the depositor on the source chain through its settlement bundles, in hours |

A node that does not answer leaves the status `pending`; nothing is signed on what tracking reads. `trackAcrossDeposit` returns the deposit, the relay hash, the fill state (`unfilled`, `slow-fill-requested`, `filled`, `expired`) and the destination block alongside. The refund itself is not detected yet: the status stays `refund-pending`.

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
- The fee cap is the module's (`maxFeeBps`); what bounds the price beyond it is the caller's `minAmountOut` and the other quotes in the router.

## Checks

```
pnpm test        # codec on real calldata, pins against Across's files and the HubPool, a negative for every check,
                 # status on recorded receipts and fill statuses (filled, unfilled, expired), activity, refusal reasons
node scripts/record-fixtures.mjs   # re-record the status and activity fixtures (read-only, public RPCs)
```

Pending with the API layer: the V5 adapter (`api.ts` holds the request shape and the error mapping), live quotes, a live-verification script and the routes canary.
