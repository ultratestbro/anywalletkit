---
"@anywalletkit/protocol-swap2-core": patch
"@anywalletkit/swap2-assets": patch
---

package.json carried a second, empty `description` that overrode the real one, so npm showed the README badge line instead of the package description.
