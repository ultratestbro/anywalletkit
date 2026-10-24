---
"@anywalletkit/protocol-swap2-core": patch
---

The engine accepts the genesis-hash chain ids the wallet packages report (`solana:5eykt…`, `tron:0x2b6653dc`, `bip122:000000000019d6689c085ae165831e93`) as `fromChain`, `toChain` and the account's chain, and maps them to the swap2 ids (`solana:mainnet`, `tron:728126428`, `bitcoin:mainnet`). Previously `fromChain: account.chain` with a Solana, Tron or Bitcoin account found no route, and the short id failed the account-chain check, so an SDK account could not swap from those chains. `swap2ChainId()` and `SWAP2_CHAIN_ALIASES` are exported.
