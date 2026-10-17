---
"@forgewallet/protocol-staking-lido-evm": minor
"@forgewallet/protocol-staking-ssv-evm": minor
"@forgewallet/protocol-lending-mellow-evm": minor
"@forgewallet/protocol-approvals-evm": minor
---

Ported from plain ESM on ethers v6 to TypeScript on viem, built with tsup (ESM + CJS + d.ts). Same exports, same calldata and typed data, same error messages; the `provider` option still takes an RPC url or an EIP-1193 object. Receipt waits now time out after 180 s (viem default) instead of waiting forever; the `./package` subpath export is gone (`./package.json` stays).
