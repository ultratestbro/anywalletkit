# @anywalletkit/protocol-swap2-across

## 0.1.3

### Patch Changes

- Updated dependencies [ef9b9d7]
  - @anywalletkit/protocol-swap2-core@0.16.0

## 0.1.2

### Patch Changes

- Updated dependencies [90eebd0]
  - @anywalletkit/protocol-swap2-core@0.15.1

## 0.1.1

### Patch Changes

- Updated dependencies [a096145]
- Updated dependencies [eba96eb]
- Updated dependencies [0d51c25]
- Updated dependencies [fb01615]
  - @anywalletkit/protocol-swap2-core@0.15.0
  - @anywalletkit/core@0.9.0
  - @anywalletkit/swap2-assets@0.3.0

## 0.1.0

### Minor Changes

- ff58fa1: New package: Across Protocol as a swap2 provider whose SpokePool deposit is built and verified on the device. EVM to EVM, the same asset on both sides (USDC, USDT / USDT0, ETH / WETH, WBTC) through a plain `deposit` on the SpokePools of 17 pinned chains, each checked against Across's deployment file and the HubPool's on-chain registry. The quote source only supplies numbers; the call is encoded locally, and depositor (the signing account, `QuoteParams.sender` — never a caller-named refund address, since an Across depositor can sign a speed-up that re-points the output), recipient, tokens, amounts, destination chain, fee (at least what relayers take on the asset — stablecoins 1 bp, ETH from Ethereum 0.7 bp, ETH from Optimism, Base or Arbitrum 4.5 bps, ETH from another L2 0.7 bp, WBTC 2.5 bps — and within the cap), empty message (the Across V5 witness prefix refused by name), quote time (never ahead), fill deadline and no exclusivity are held to the request at build time and right before signing, by one synchronous verifier that also backs `acrossPins` / `acrossPinsWith({maxFeeBps})`, together with the fees and `feeUsd` a quote shows (the engine's fee caps add them up). Pricing: Across API V5 (`POST /v1/quotes`, server-side key) is the price source and Across's keyless `/suggested-fees` the relayer need; the deposit leaves `max(V5's fee net of its own origin execution gas, the relayer fee)` — the relayer fee alone when V5 prices another rail (a fill estimate over a minute) — with a fill deadline two hours after the quote time and no exclusivity; a floor pinned from 24 h of fills stands in when `/suggested-fees` is gone (Ethereum, Optimism, Base, Arbitrum). V5's `nextActions` are never executed. `acrossProvider({apiKey})` runs on a server (under React Native an `apiKey` throws) and `acrossRemoteProvider({baseUrl})` in the app re-checks every deposit, holds its fee to Across's keyless relayer fee read on the device (`suggestedFeesUrl`), and checks it once more by its own clock right before signing; answers that came through a redirect are refused; V5 and `/suggested-fees` refusals carry CS-13 reasons (`details.amountLimits.side` read before the message). Ethereum as a destination is not priced yet. Status is read on chain: the intent's own deposit from the source receipt, its relay hash, and the destination's `fillStatuses`, with an unfilled deposit past its deadline reported as expired.

### Patch Changes

- Updated dependencies [3bf525f]
- Updated dependencies [b7cf66d]
  - @anywalletkit/protocol-swap2-core@0.14.0
