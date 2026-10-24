Add a Swap screen to this Any Wallet Kit wallet, using the swap router `@anywalletkit/protocol-swap2-router`.

Read the "Swaps and bridges" part of https://docs.anywallet.tech/llms-small.txt (or AGENTS.md in github.com/ultratestbro/anywalletkit) first, and use only APIs that appear there.

- Source: the active account on any chain the wallet supports; destination: any chain and token from `@anywalletkit/swap2-assets` (same-chain and cross-chain).
- Providers that need no API key: LI.FI, NEAR Intents, Chainflip, CCTP, USDT0, Uniswap, Wrap, Jupiter. Put RPC URLs in the existing config.
- Routes stream in as each provider answers (`quoteSwap2Routes` with `onUpdate`), tagged best / fastest; the user picks one. Show "you receive at least" (`toTokenAmountMin`), fees and ETA.
- Slippage: Auto by default (`suggestSlippage`), with 0.1 / 0.5 / 1 / 3 % overrides; the same slippage for quoting and execution.
- Execute exactly the picked route with `minAmountOut = route.quote.toTokenAmountMin`, behind a review sheet in `reviewExecution` (amounts, minimum, recipient, approvals) and the execution phases as progress.
- Track the swap by its id until it reaches a final status; when the status is `action-required`, claim on the destination chain.
- Map the swap errors to user messages. `Swap2MaybeSentError` means the swap may already be on chain: show it as pending and never retry.

Done when `npx tsc --noEmit` passes and `npx expo export --platform ios` bundles.
