---
"@forgewallet/protocol-swap2-core": minor
"@forgewallet/extension-kit": minor
---

Swap2 status ids decode only under the current `awk1.` prefix. `getSwap2Status`, `claimSwap2` and the extension-kit swap tracker refuse any other prefix as a malformed id; an app still holding ids minted under an earlier prefix maps them to `awk1.` before calling.
