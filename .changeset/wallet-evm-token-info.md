---
"@anywalletkit/wallet-evm": minor
---

`getTokenInfo(address)`: an ERC-20's decimals, symbol, name and total supply read from the contract (`bytes32` symbols decoded, strict UTF-8, no `TextDecoder`), and `upgradeable` when it sits behind an EIP-1967 / EIP-1822 / beacon / ZeppelinOS proxy. No code, an EIP-7702-delegated account or no `decimals()` throws `NotATokenError`; RPC failures are not mistaken for "not a token".
