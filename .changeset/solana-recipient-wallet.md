---
"@anywalletkit/wallet-solana": minor
---

`transfer` (and `quoteTransfer`) refuse a recipient that is not a wallet: an account owned by Token / Token-2022 (a token account or a mint) or an executable program. An SPL transfer used to derive the recipient's associated token account from such an address and lock the tokens; SOL sent to a program or a mint is lost. An address with no account yet is still an ordinary wallet. The refusal is `UnsafeTransactionError` with code `recipient-not-wallet`.
