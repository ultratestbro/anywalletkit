---
"@anywalletkit/wallet-evm": patch
---

Sends from one account go out one at a time. Two `sendTransaction` / `transfer` calls started together both read the `pending` nonce before either was broadcast and signed the same nonce: the second replaced the first or was refused. Prepare → sign → submit now runs in a per-account queue (the nonce floor then covers the next send); a failed send does not block the next.
