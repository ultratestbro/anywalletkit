# @forgewallet/protocol-swap2-cctp

[Circle CCTP V2](https://developers.circle.com/cctp) as a swap2 provider:
native USDC between EVM chains by **burn-and-mint** — no spread, no
aggregator fee; Fast Transfer costs the fee Circle publishes per pair (around
1 bps), Standard is free and waits for source finality.

CCTP is **two-phase**. `depositForBurn` on the source chain burns the USDC;
Circle's attestation service signs the message; `receiveMessage(message,
attestation)` on the destination mints — and that second transaction is the
user's own, paid in the destination chain's gas. The swap2 engine learned
this with the package:

```ts
import {cctpProvider} from "@forgewallet/protocol-swap2-cctp/provider";
import {RouterSwap2Protocol} from "@forgewallet/protocol-swap2-router/swap2/router";

const swap2 = new RouterSwap2Protocol(baseAccount, {fromChain: "eip155:8453", providers: [cctpProvider({rpcUrls})]});
const res = await swap2.swap2({fromToken: "USDC", toToken: "USDC", toChain: 42161, fromTokenAmount: 10_000_000n, minAmountOut: 9_998_570n});
// … poll …
const status = await swap2.getSwap2Status(res.id);   // "pending" → "action-required" once Circle attested
if (status.status === "action-required") {
  const {hash} = await swap2.claimSwap2(res.id, arbitrumAccount);   // receiveMessage on Arbitrum, signed there
}
```

`claimSwap2(id, destinationAccount)` is on every swap2 protocol (router or
single-provider); providers opt in with `buildClaim(ref)`, which returns the
destination transaction or `null` while the attestation is pending.
`IntentStatus.claim = {chain, ready}` tells the app which chain the claim
lives on. The remote provider forwards it as the `claim` action.

## What the provider does

- **Mode** `auto` (default) takes Fast when the pair offers it and Circle's
  Fast allowance covers the amount, else Standard; `fast` / `standard` force
  one. Fees come from `GET /v2/burn/USDC/fees/{src}/{dst}` (bps), the
  allowance from `GET /v2/fastBurn/USDC/allowance`.
- **Output is guaranteed**: `maxFee` in the calldata = published fee + a 10 %
  buffer (`feeBufferPct`), and Circle can deduct at most `maxFee`; the quote's
  `minDestAmount` is `amount − maxFee`. The unused buffer is never charged.
- **Calldata is sealed in the quote** (recipient, native USDC of the source
  domain, destination domain, `maxFee`, finality threshold) and the engine
  executes exactly that; `approvalAddress` is the TokenMessengerV2.
- **Preflight with an RPC** (`rpcUrls`): the TokenMessengerV2 the calldata
  targets must point at the expected MessageTransmitterV2, whose
  `localDomain()` must be the source domain, and `getMinFeeAmount(amount)`
  must fit `maxFee`. Without an RPC the on-chain check is skipped.
- **Tracking**: `GET /v2/messages/{src}?transactionHash=` → `pending` while
  confirmations accrue, `action-required` once `status: complete` with the
  attestation, `completed` once the destination's `usedNonces(nonce)` is set
  (needs the destination RPC; otherwise a recorded claim hash counts).
- **Claim**: `receiveMessage(message, attestation)` on the destination
  MessageTransmitterV2; the attested message must belong to the route's
  domains. An expired Fast message (`expirationBlock` passed) is sent to
  `POST /v2/reattest/{nonce}` and reported not-ready until Circle re-signs.
- **Domains**: 17 EVM chains (Ethereum, Avalanche, OP, Arbitrum, Base,
  Polygon, Unichain, Linea, Sonic, World Chain, Monad, Sei, HyperEVM, Ink,
  Plume, Plasma, X Layer), the same TokenMessengerV2 / MessageTransmitterV2 on
  all of them, and each domain's **native** USDC. Chains whose catalog USDC
  is not Circle's (BSC, Gnosis USDC.e) are refused. Solana (domain 5) is not
  executed here yet: the engine runs calldata on EVM only.

## Tests

`pnpm test` — provider tests over a fake Circle API + fake JSON-RPC (fee
maths, calldata binding, mode fallbacks, preflight refusals, the whole
pending → action-required → completed lifecycle, claim building, expiry /
re-attestation) and the conformance suite; the engine's `claimSwap2` has its
own tests in `protocol-swap2-core`. `pnpm verify:live` quotes USDC Base →
Arbitrum $10 in both modes against the live API and preflights on Base.

## Status

2026-10-10: built, tests green, live quote + preflight verified. No funded
transfer yet (plan: $10 USDC Base → Arbitrum, Fast and Standard, with the
claim from the phone).
