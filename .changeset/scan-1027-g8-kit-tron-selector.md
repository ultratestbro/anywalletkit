---
"@anywalletkit/kit": patch
---

Tron contract calls are judged by the calldata the node signs: the first 4 bytes of keccak256 of the `functionSelector` text, then one word per parameter as wallet-tron encodes it. Recipients and spenders are decoded from those words with the EVM table, so a signature text that collides with `transfer(address,uint256)` (e.g. `join_tg_invmru_haha_fd06787(address,bool)`) is read as the transfer it is. A call whose parameters do not match the signature, or would not encode one strict word each, is `destinationUnknown`. `@noble/hashes` is now a dependency of the kit.
