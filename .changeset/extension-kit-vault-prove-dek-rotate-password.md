---
"@anywalletkit/extension-kit": patch
---

`Vault.unlock` and `Vault.unlockWithPasskey` now prove that the unwrapped key is the vault's own (its DEK check, or the first secret in an envelope written before the check existed) and fail with `wrong-password` otherwise. Before, a dek box or passkey box spliced in from another vault "unlocked" with the attacker's password or passkey and returned a foreign key; a wallet that used `unlock(password)` as a yes/no password check (for example before showing the seed phrase) accepted it. `changePassword` and `rotateVaultKey` refuse such a box too.

`rotateVaultKey(password, newPassword?)`: with `newPassword`, the fresh DEK is wrapped under the new password, so changing the password and retiring the old DEK is one step (one envelope write). Passkeys are dropped as before, since their boxes hold the old DEK.
