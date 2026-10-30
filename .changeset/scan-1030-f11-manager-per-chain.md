---
"@anywalletkit/kit": patch
---

`Wallet.getManager(chain)` guards the accounts it hands out for the chain it was asked for (scan 2026-10-30, F11). One guarded manager was cached per manager, so with a namespace registration `getManager('eip155:137')` after `getManager('eip155:1')` returned the chain-1 wrapper: a write meant for Polygon ran on Ethereum instead of being refused as a chain mismatch. There is now one guarded manager per requested chain; the same chain still returns the same object.
