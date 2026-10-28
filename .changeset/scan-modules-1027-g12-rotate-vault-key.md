---
"@anywalletkit/extension-kit": minor
---

`Vault.rotateVaultKey(password)` replaces the vault key after a suspected compromise: a fresh DEK, every secret re-sealed under it and the DEK wrapped under the password with a fresh salt, written as one envelope (a failure leaves the old vault as it was; `rotatedAt` records when). It returns the new DEK — hand it to `session.unlock`, which overwrites the old one in `chrome.storage.session`. Passkeys are dropped, because their boxes hold the old DEK and cannot be re-wrapped without their PRF output; register them again. `setSecret` now refuses (`locked`) a DEK that does not open the vault's secrets, so a stale session cannot seal a new secret under a retired key. `changePassword` is unchanged and documented as not enough after a compromise (it re-wraps the same DEK).

**Breaking:** `setSecret` refuses (`locked`) a DEK that does not open the vault's secrets. An empty vault has nothing to check it against and accepts any DEK. Upgrade notes: https://docs.anywallet.tech/getting-started/upgrading/.
