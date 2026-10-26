---
"@anywalletkit/extension-kit": patch
---

`SwapsStore` writes one after another. `add`, `update` and `remove` read the list, changed it and wrote it back with no ordering, so an alarm tick's `update` that read the list before a just-executed swap was added wrote the old list back: the new swap vanished and was never tracked. They now run in a queue (as `PermissionStore` does), each reading the list inside its turn. `parseSwapId` also reads the id `claimSwap2` returns, whose 4th segment is the claim hash (`destTxHash`).
