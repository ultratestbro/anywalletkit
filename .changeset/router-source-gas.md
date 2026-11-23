---
"@anywalletkit/protocol-swap2-router": minor
"@anywalletkit/protocol-swap2-core": minor
"@anywalletkit/protocol-swap2-omniston": patch
---

The router can rank routes net of the source gas (SDK-291). New option `sourceGasUsd` (also on `RouterSwap2Protocol`): the gas a quote's source transaction costs the user in USD, asked once per quote as it arrives and subtracted from its `valueUsd`. `evmSourceGas({prices, rpcUrl})` builds it for EVM sources from the quote (the venue's `txRequest.gasLimit` capped at 3M or 250k, a transfer for a deposit-address route, nothing for a gasless one, plus an ERC-20 approval unless the sender's allowance covers it) at the chain's `eth_gasPrice`. Gas comes off every quote of an auction or none: a quote whose estimate fails or takes over 3 s leaves the auction without gas, as before. `RankedQuote.gasUsd` / `Swap2Route.gasUsd` say what was subtracted. Without `sourceGasUsd` nothing changes.

`Quote.gasless` (protocol-swap2-core): the user signs the source leg and a third party sends it and pays its gas. The swap2 server seals it. Omniston sets it on EVM → TON orders, with the order protocol as `providerData.approvalAddress`.
