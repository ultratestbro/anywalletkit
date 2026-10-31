---
"@anywalletkit/extension-kit": patch
---

An empty vault now tells its own key from any other. New envelopes carry `dekCheck`, a fixed value sealed under the vault key (written by `create`, `changePassword`, `rotateVaultKey` and the v1→v2 upgrade). Before, a vault with no secrets accepted any 32 bytes in `setSecret`: after `rotateVaultKey` and deleting the last secret, a session still holding the retired key could seal a secret that the password would never open again. Now `setSecret` refuses such a key with `locked`, and `addPasskey` works on an empty vault when given the vault's own key (a wrong one is `locked`). Vaults written by earlier versions open as before and get the check the next time the envelope is re-sealed (change the password or rotate the key to add it right away). Nothing else to change.
