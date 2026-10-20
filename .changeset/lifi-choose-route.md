---
"@forgewallet/protocol-swap2-lifi": minor
---

`chooseRoute` hook: a cross-chain quote first reads `/advanced/routes`, hands the single-transaction candidates to the app and restricts `/quote` to its choice (allowBridges / denyBridges / order). Any failure, or a chosen bridge that disappears before `/quote`, falls back to LI.FI's default pick.
