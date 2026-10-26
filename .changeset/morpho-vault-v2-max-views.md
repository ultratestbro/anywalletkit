---
"@anywalletkit/protocol-lending-morpho-evm": patch
---

Morpho Vault V2 supply and withdraw work. V2 answers 0 from `maxDeposit` / `maxMint` / `maxWithdraw` / `maxRedeem` for every address (verified on Base on the Steakhouse High Yield USDC V2 vault), so every V2 deposit was refused as "deposits are closed" and every V2 withdrawal as "only 0 withdrawable". For V2 the module now reads the transfer gates (`canReceiveShares` + `canSendAssets` on the way in, `canSendShares` + `canReceiveAssets` on the way out; a closed one is refused with `CannotReceiveShares` / `CannotSendAssets`) and leaves caps and liquidity to the `eth_call` proof it already runs before sending. `getPosition().withdrawable` on V2 is the whole position when redeeming it simulates cleanly, else the vault's idle assets. V1 is unchanged.
