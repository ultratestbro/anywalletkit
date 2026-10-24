Add an Earn tab to this Any Wallet Kit wallet.

Read the "Earn" part of https://docs.anywallet.tech/llms-small.txt (or AGENTS.md in github.com/ultratestbro/anywalletkit) first, and use only APIs that appear there.

Three products:
- Lido staking on Ethereum (ETH → stETH).
- Aave v3 USDC supply on Ethereum.
- The biggest Morpho USDC vault on Base, found with `MorphoApi`.

For each product:
- Show the APR / APY and the user's position, with a refresh.
- Deposit and withdraw with an amount field, a fee quote, then confirmation through the existing confirm flow.
- Lido withdrawals are two-phase: request first, then claim once the request is claimable. Show pending and claimable amounts.

Put the protocol registrations next to the wallet setup. Amounts stay bigint end to end.

Done when `npx tsc --noEmit` passes and `npx expo export --platform ios` bundles.
