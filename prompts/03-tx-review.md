Add a transaction review sheet to this Any Wallet Kit wallet with `@anywalletkit/tx-preview-evm`.

Read the "Transaction preview" and "Policies" parts of https://docs.anywallet.tech/llms-small.txt (or AGENTS.md in github.com/ultratestbro/anywalletkit) first, and use only APIs that appear there.

- Every EVM write is simulated before the user confirms: plain sends and contract calls through the kit's `policies.confirm`, swaps through the router's `reviewExecution` (preview the approvals and the source call as one sequence).
- The sheet shows the simulated balance changes ("-0.01 ETH", "+25.1 USDC"), every approval with its spender and amount, the recipient, and the network fee.
- A verdict from the preview's check codes: ok, warn or danger, each with one plain-language line. Danger (a revert, an unlimited approval) needs a second, explicit confirmation. "Simulation unavailable" is a warning, not a block.
- Non-EVM writes and signed messages still get a confirmation sheet, without a simulation.
- The user's own addresses count as "own" so moves between them aren't flagged as foreign.

Done when `npx tsc --noEmit` passes and `npx expo export --platform ios` bundles.
