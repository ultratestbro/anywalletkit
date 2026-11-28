# @anywalletkit/protocol-swap2-cow

## 0.2.0

### Minor Changes

- dce6a13: Quotes carry `gasEstimate` with `gasEstimateSource: "model"`. A token sale (`gasless: true`) carries exactly `"0"`: the user sends no swap transaction; the approval to the vault relayer is still named in `providerData.approvalAddress` for the router to price. A native-coin (eth-flow) sale is the user's own `createOrder` transaction and carries the measured `ETH_FLOW_CREATE_GAS_USED` = 56,228 (exported): 11 measurements on 2026-11-28 (two mainnet receipts, nine `eth_simulateV1` runs on Ethereum, Base and Arbitrum) span 56,216–56,264 (`fixtures/gas/eth-flow-create-order.json`). Its `txRequest.gasLimit` stays 150,000 and `ownGasEstimate` is unchanged. The figure is set only on the chains it was measured on (Ethereum, Base, Arbitrum) with the canonical eth-flow contract: a chain added through `chains` (`cowDeployments(extra)`), or a shipped chain given another eth-flow there, carries no eth-flow estimate.

### Patch Changes

- 96e754d: README: `QuoteParams.blockNumber` is not supported by this provider (its price comes from an API, or is not a pool price compared across venues at one block); its quotes name no block. No code change.
- Updated dependencies [94fdfb0]
- Updated dependencies [dce6a13]
  - @anywalletkit/protocol-swap2-core@0.18.0

## 0.1.0

### Minor Changes

- 511659b: New package: CoW Protocol same-chain swaps as a swap2 provider on Ethereum, Base and Arbitrum. The account signs an order, solvers compete to fill it, and the network cost is taken from the sold token. Built from CoW's contracts and Order Book API — no CoW SDK dependency, public API, no key, no partner fee. **Off by default** (`enabled: true`, `enabledChains` to roll out chain by chain).
  
  - **Token sells are signed EIP-712 orders** — typed data only, never a signature over a bare order digest. The vault relayer's allowance comes from an EIP-2612 permit carried as the order's single appData pre-hook where the token has one (two signatures, no gas; needs `rpcUrls`), from one exact approval otherwise, and from nothing when the allowance already covers the order and the account's other open orders.
  - **Native-coin sells go through eth-flow**: one `createOrder` transaction with the input as its value, sent with the account's own gas estimate of that call (`ownGasEstimate`; on Arbitrum its L1 data counts as gas, so a fixed limit ran short). `claimSwap2` on the swap's id builds the refund (`invalidateOrder`) of an expired order.
  - **Cancellation**: a signed `OrderCancellations` request to the orderbook (free) or on chain — `GPv2Settlement.invalidateOrder` for a signed order, `CoWSwapEthFlow.invalidateOrder` for a native-coin one — through the engine's new `cancelSwap2`.
  - **Status** from the orderbook (open, filled with the executed amounts, expired, cancelled), and for eth-flow orders from the contract as well when `rpcUrls` are set.
  - **Fail closed**: the order is written on the device from the request and the quote is held to it — tokens, receiver, the whole input as `sellAmount`, `feeAmount` 0, `buyAmount` within the slippage and at or above the caller's minimum, `validTo` (20 minutes by default, the server clock may move it by 5), `kind`, plain ERC-20 balances, and `appData` equal to the hash of the document the module wrote. The UID the orderbook returns must equal the local one. GPv2Settlement, GPv2VaultRelayer, CoWSwapEthFlow, the wrapped natives and the EIP-712 domain are constants per chain.
  - `describeCowActivity` (eth-flow create / invalidate, settlement `invalidateOrder`), `CowSwap2Protocol` standalone, `config.chains` for chains CoW adds later.
  - Checked live, read-only (`scripts/verify-live.mjs`), on the three chains: code at every pinned contract, `domainSeparator()` and `vaultRelayer()` equal to the pins, eth-flow's settlement and wrapped native; executable and dry quotes through the provider; an order and a permit signed by a throwaway key and verified locally, the permit accepted by the token in a gas estimate of the exact hook call (on Arbitrum net of the L1 data part, read from the NodeInterface: the hook does not pay it); `createOrder` simulated with `eth_call`; a settled order from the chain's history read as completed. No order was placed.
  - Funded on Base (2026-11-23, `scripts/verify-mainnet.mjs`): an eth-flow sale, a permit sale (no gas), an approval sale, an off-chain and an on-chain cancellation — all filled or cancelled as expected, the vault relayer's allowance back at 0 after the fills. A price-only quote without any address is priced for a placeholder owner (a route list before the account is known), and the native coin's network cost is named `native`.
  - Orderbook refusals are classified like every provider's: HTTP 429 is `rate_limited` with the `Retry-After` wait (CoW limits quotes to 1 a second and ~500 an hour per IP), 5xx and an unreachable orderbook `upstream_unavailable`, reported through `onRefusal`.
  - Token sells are `gasless` quotes (a solver pays the settlement), naming the vault relayer as `providerData.approvalAddress` when no permit is offered, so the router's `sourceGasUsd` counts only the approval; eth-flow sells stay the user's transaction.

### Patch Changes

- Updated dependencies [6020956]
- Updated dependencies [ffe1564]
  - @anywalletkit/protocol-swap2-core@0.17.0
