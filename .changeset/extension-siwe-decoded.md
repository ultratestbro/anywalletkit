---
"@forgewallet/extension-kit": patch
---

`personal_sign` runs the EIP-4361 checks on the decoded bytes whenever they are valid UTF-8, not on the hex fallback shown for unprintable text. A sign-in message carrying hidden control characters is refused.

Before, one DEL or form-feed byte turned a cross-site sign-in into an unchecked hex blob, with no cross-site, chain or expiry warning.
