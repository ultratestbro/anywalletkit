---
"@anywalletkit/protocol-swap2-uniswap": minor
---

`uniswapPins` now carry `verifyQuote: uniswapVerifyQuote`, so a remote Uniswap route is opened on the device (scan 2026-10-28, F1). The pins used to pin only SwapRouter02: a compromised backend could write the swap's recipient, a zero minimum, or `pull` + `sweepToken`, and the engine sent it. The verifier decodes the router call and requires one `multicall(deadline, legs)` on the chain's pinned SwapRouter02 whose legs are exactly one `exactInputSingle` or `exactInput` (one or two pools), then `unwrapWETH9` for a native output; the source token (WETH for a native input, paid as exactly the input in `value`) sold for the destination token; `amountIn` the input and `amountOutMinimum` the quote's minimum; the recipient paid, or the output kept in the router and unwrapped to the recipient for that same minimum. Apps that spread `...uniswapPins` get it without other changes. The addresses module now also exports `ROUTER_ABI`.

**Breaking:** a remote Uniswap quote whose router call is anything else — `pull`, `sweepToken`, extra legs, another recipient, token, amount or minimum, a price limit, a deposit address — is refused. Upgrade notes: https://docs.anywallet.tech/getting-started/upgrading/.
