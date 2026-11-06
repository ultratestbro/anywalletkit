# @anywalletkit/protocol-lending-curve-evm

## 0.1.0

### Minor Changes

- eeeeae6: New module: Curve lending, starting with Savings crvUSD (scrvUSD) on Ethereum as a `LendingProtocol` (`ScrvUsdProtocolEvm`).
  
  - **The vault is pinned on-chain.** Before any read for a write: the read RPC is on Ethereum, the code at the scrvUSD address is exactly the EIP-1167 clone of the pinned Yearn VaultV3 implementation `0xd8063123…b00d`, that implementation's code hash is the pinned 3.0.4 one, `apiVersion()` is "3.0.4" and `asset()` is crvUSD. A mismatch is a `ScrvUsdVerificationError` (`check`, `expected`, `observed`); a failed read refuses the operation, never passes it. Addresses are never resolved through Curve's AddressProvider or API.
  - **Operations**: `supply` (exact approve of crvUSD to the vault, with a reset before raising a non-zero allowance, then `deposit(assets, me)`; `previewDeposit` for the shares), `withdraw` (`redeem(shares, to, me, max_loss = 0)` for `'max'`, `withdraw(assets, to, me, max_loss = 0)` for an amount — VaultV3's three-argument `redeem` would allow any loss). Every write has a `quote*` twin and is proven with `eth_call` first, with VaultV3's revert strings in plain words. `borrow` / `repay` throw `NotImplementedError`.
  - **Runtime gates**: deposits are refused when the vault is shut down (`VaultShutdownError`), lends to strategies (`totalDebt > 0`, code `StrategiesInUse`, unless `allowStrategies`) or would exceed `maxDeposit`; withdrawals stay open on shutdown, are bounded by `maxWithdraw(owner, 0)`, and `'max'` redeems the whole balance when the vault can pay it (VaultV3's `maxRedeem` rounds one unit short), else what `maxRedeem` allows, with `complete: false`.
  - **APY**: projected from the on-chain profit unlock (`profitUnlockingRate` × year / `totalSupply`, continuous compounding, 0 after `fullProfitUnlockDate`), read at one block; the Curve prices API's `proj_apy` is shown only within 0.5 pp / 10 % of it and clamped otherwise (`getApyDetails().source`). The API host must be https on curve.finance; curve.fi and others are refused. The README explains the 7-day profit unlock.
  - **Reads**: `getVault` (totalAssets / totalIdle / totalDebt, price per share, shutdown, unlock state, role manager), `getPosition` (shares, assets, withdrawable, redeemable shares), `getApy`, `getApyDetails`, `getStats`.
  - **Activity**: `describeActivity` labels scrvUSD deposits and withdrawals (every Vyper arity), the crvUSD approval to the vault, and deposits / withdrawals made through another contract (shares minted to / burned from the wallet).
  - `SCRVUSD_DEPLOYMENTS` (chain id → the pinned deployment) for the module watch, which also reads `isShutdown`, `apiVersion`, `role_manager`, `profitMaxUnlockTime`, `totalDebt` and `asset` on chain.
  - Checked on Ethereum mainnet: identity, APY against the API, a holder's redeem proof, and the module's deposit → redeem → withdraw calldata proven for an empty address under an `eth_call` state override (`scripts/verify-live.mjs`).
