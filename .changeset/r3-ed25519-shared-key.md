---
"@anywalletkit/wallet-solana": patch
"@anywalletkit/wallet-ton": patch
"@anywalletkit/wallet-near": patch
---

One external ed25519 key registered for several chains can no longer be made to sign another chain's transaction as a "message": TON and NEAR `sign()` refuse bytes that carry the account's public key (a Solana transaction names its signer's key), and Solana `sign()` on an external signer refuses 32-byte messages (a TON or NEAR transaction digest). TON Connect `signData` binary payloads accept whitespace in their base64, as `atob` does, and a non-integer `workChain` is refused.
