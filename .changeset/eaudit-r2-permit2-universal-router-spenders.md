---
"@anywalletkit/wallet-evm": patch
---

`describeTypedData` no longer puts `spender-unknown` on a Permit2 grant to Uniswap's Universal Router:

- New pinned table `UNISWAP_UNIVERSAL_ROUTERS` (chain id → deployments with `address`, `version`, `source`): 65 Universal Router addresses on 19 chains, taken from Uniswap's deployment files, SDK table and documentation and each checked on-chain. `permit2KnownSpender(chainId, spender)` is the lookup, `PERMIT2_ADDRESS` and `UNISWAP_UNIVERSAL_ROUTER_LABEL` the constants.
- A Permit2 grant (any primary type) whose verifying contract is Permit2 and whose spender is a router listed for the chain in the signed domain comes back with `spenderLabel: "Uniswap Universal Router"` and without the warning. The same address on a chain where it is not listed, any other spender, a domain without a chain id, another verifying contract and EIP-2612 / DAI token permits keep the warning. Other warnings (`approve-unlimited`, `deadline-passed`, `chain-mismatch`) are unchanged.
- `knownSpenders` keeps working and its label takes precedence. Only the Universal Router is built in; no other protocol.
