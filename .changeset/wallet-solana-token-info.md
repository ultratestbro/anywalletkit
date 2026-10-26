---
"@anywalletkit/wallet-solana": minor
---

`getTokenInfo(mint)`: decimals, symbol, name, supply and holder-relevant flags read from the chain, for tokens a user adds by address. Name and symbol come from the Token-2022 metadata extension, else the Metaplex metadata account. Flags: a live mint or freeze authority, and the Token-2022 extensions that let someone move any balance (permanent delegate), tax transfers (non-zero transfer fee), run a hook, freeze new accounts, pause transfers or make the token non-transferable. Anything that is not an initialized Token / Token-2022 mint throws `NotATokenError`. Checked against mainnet USDC, PYUSD, BONK, JUP and a fee-bearing Token-2022 mint.
