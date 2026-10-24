Create a new Any Wallet Kit protocol module as its own npm package in this directory: `@acme/protocol-lending-erc4626-evm`, a `LendingProtocol` for any ERC-4626 vault on an EVM chain.

Read the "Writing a protocol module" part of AGENTS.md in github.com/ultratestbro/anywalletkit, plus the guides at https://docs.anywallet.tech/llms-small.txt, first. Use only APIs that appear there. Use viem for ABI encoding and reads.

- Config: `{ vault, chainId }`, where `vault` is the vault's `0x…` address.
- `supply({ token, amount })`: `token` must be the vault's asset (refuse others). It sends an exact approve, then `deposit(assets, me)`.
- `withdraw({ token, amount })`: `amount` also accepts `'max'`. It calls `withdraw`, or `redeem` of every share for `'max'`.
- Each write has a `quote*` twin that signs nothing. `borrow` / `repay` (and their quotes) are unsupported and say so.
- Reads: `getPosition()` returns `{ shares, assets }`, and `getVault()` returns the asset address, its decimals, and the total assets.
- Writes refuse a read-only account. Amounts are bigint.
- `describeActivity` recognizes the vault's Deposit / Withdraw events ("Deposited 100 USDC · <vault name>") and returns null for anything else. Unit-test it with hand-built transactions.
- Run the SDK's conformance suite (`describeProtocolModule` from `@anywalletkit/conformance`) under Vitest.
- Package: ESM + CJS builds with types (tsup), a `module.json` registry manifest (tier `community`), and a README with usage.

Done when `npm test` passes, `npm run build` produces dist, and `npx tsc --noEmit` passes.
