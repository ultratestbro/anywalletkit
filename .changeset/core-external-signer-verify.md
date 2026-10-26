---
"@anywalletkit/core": minor
---

`externalSigner` verifies every signature against the signer's `publicKey` before returning it: ECDSA (compact and recoverable — a recoverable one must also recover to the key), BIP-340 schnorr (under the tweaked output key when a `tweak` is passed) and ed25519. A backend that answered with another key's signature, or bytes of the right length, used to get through: the chain rejected the transaction, or a recoverable signature named another sender. Such a result now throws `SignerError`.
