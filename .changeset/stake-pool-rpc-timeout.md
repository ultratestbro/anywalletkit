---
"@anywalletkit/protocol-staking-spl-stake-pool-solana": patch
---

Every RPC call has a timeout (`timeoutMs`, default 15 s): a silent endpoint used to hang the read for as long as the socket stayed open, and the next endpoint never got its turn. The account's own `@solana/kit` Rpc (the default provider) is now called as a kit Rpc: it answers every property with a method, `request` included, so it was taken for an EIP-1193-style `{ request }` and the read returned a pending-request object instead of the result.
