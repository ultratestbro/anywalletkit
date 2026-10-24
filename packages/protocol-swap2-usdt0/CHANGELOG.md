# @anywalletkit/protocol-swap2-usdt0

## 0.1.1

### Patch Changes

- e4083a3: npm metadata for the first public release: repository (with the package directory), homepage, bugs and publishConfig { access: public, provenance: true }; LICENSE inside every package; READMEs for core, conformance, protocol-swap2-core, swap2-assets and tx-preview-evm; descriptions for protocol-swap2-core and swap2-assets.
- d08e37e: USDT0 no longer puts raw viem transport errors into refusal reasons or preflight errors. Those errors carry `URL: …`, which includes the key of a keyed RPC.
  
  - **USDT0:** an RPC failure becomes `usdt0: RPC for <chain> unavailable — try again`, and any other text loses its URLs.
  - **swap2-core:** new `redactUrls()`. Servers that forward refusal text to clients should pass it through this.
- Updated dependencies [4b6d97f]
- Updated dependencies [e4083a3]
- Updated dependencies [0d68fda]
- Updated dependencies [6568e08]
- Updated dependencies [06cecff]
- Updated dependencies [24b888a]
- Updated dependencies [bdc77c2]
- Updated dependencies [4fcb9b6]
- Updated dependencies [d08e37e]
  - @anywalletkit/core@0.3.0
  - @anywalletkit/protocol-swap2-core@0.3.0
  - @anywalletkit/swap2-assets@0.1.2

## 0.1.0

### Minor Changes

- 7004ecf: New package: USDT0 — Tether's LayerZero OFT for USDT — as a swap2 provider. USDT / USDT0 between 13 EVM chains (Ethereum adapter, Arbitrum, OP, Polygon, HyperEVM, Ink, Berachain, Unichain, Sei, Plasma, Monad, MegaETH, X Layer) in one source transaction: `quoteOFT` + `quoteSend` on the OFT itself, `send` with the LayerZero fee as `msg.value` (declared as `nativeFee`), approval only for the Ethereum adapter, every deployment bound on-chain (`token()`, `approvalRequired()`, `peers`), preflight against the live fee, status from LayerZero Scan (DELIVERED carries the destination hash), and the `lzReceive` retry of a stored payload as the engine's claim. The asset catalog gains USDT0 on HyperEVM and Unichain.
- 2d6c0f1: USDT0 on Mantle (eid 30181), Morph (30322) and Flare (30295) — 16 deployments, every one re-read on-chain (token, approvalRequired, sharedDecimals, endpoint, Arbitrum peer).

### Patch Changes

- 3ea8e2d: Activity: an OFT `send` folds the LayerZero messaging fee (the native value) into `fee` instead of listing it as an asset the owner swapped away, and names both ends when the calldata carries the destination ("Bridged USDT → USDT0", subtitle "USDT0 · Ethereum → HyperEVM").
- 5c02895: The sealed LayerZero fee carries 25 % headroom over the quote: the fee is paid at send time and moves with gas, so a quote a minute old failed preflight ("fee rose … re-quote"); the endpoint refunds the unused part to the trader in the same transaction. Preflight refuses only a fee past the headroom.
- Updated dependencies [bd4ea91]
- Updated dependencies [386615c]
- Updated dependencies [82464d8]
- Updated dependencies [412164a]
- Updated dependencies [f427dec]
- Updated dependencies [7004ecf]
- Updated dependencies [e0edbf6]
- Updated dependencies [29af9d6]
  - @anywalletkit/core@0.2.0
  - @anywalletkit/protocol-swap2-core@0.2.0
  - @anywalletkit/swap2-assets@0.1.1
