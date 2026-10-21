---
"@forgewallet/wallet-solana": patch
---

`WalletAccountSolana.sign` refuses, with `MessageIsTransactionError`, any "message" whose bytes decode exactly (every byte consumed) as a legacy / v0 / v1 compiled transaction message, or as a wire transaction, that lists this account among its required signers — such a signature would be a valid on-chain transaction approved without transaction review. Everything else is signed raw exactly as before (text, nonces, `\xffsolana offchain`-prefixed messages, transactions where this key is not a required signer). New exports: `isSolanaTransactionPayload(bytes, signer)`, `classifySolanaMessage(bytes, signer)` (`'transaction' | 'offchain' | 'text' | 'binary'`, for approval UIs), `hasSolanaOffchainHeader`, `isReadableText`, `SOLANA_OFFCHAIN_MESSAGE_PREFIX`.
