---
"@anywalletkit/wallet-solana": patch
---

The Stake guard judges every Stake instruction that names the wallet, whatever the wallet's position: the Stake program takes authorities from any signer and has a layout without sysvars (`[stake, authority]`, `[stake, recipient, authority]`), so an `Authorize` / `Withdraw` / `SetLockup` with the wallet at another index is no longer signed. The `Checked` forms read the new authority, staker and withdrawer in both layouts. A stake account the wallet only splits into is accepted with at most 0.005 SOL of the wallet's funding (its rent), since a split copies the source's authorities.
