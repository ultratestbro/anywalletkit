---
"@anywalletkit/protocol-swap2-cow": minor
---

Quotes carry `gasEstimate` with `gasEstimateSource: "model"`. A token sale (`gasless: true`) carries exactly `"0"`: the user sends no swap transaction; the approval to the vault relayer is still named in `providerData.approvalAddress` for the router to price. A native-coin (eth-flow) sale is the user's own `createOrder` transaction and carries the measured `ETH_FLOW_CREATE_GAS_USED` = 56,228 (exported): 11 measurements on 2026-11-28 (two mainnet receipts, nine `eth_simulateV1` runs on Ethereum, Base and Arbitrum) span 56,216–56,264 (`fixtures/gas/eth-flow-create-order.json`). Its `txRequest.gasLimit` stays 150,000 and `ownGasEstimate` is unchanged.
