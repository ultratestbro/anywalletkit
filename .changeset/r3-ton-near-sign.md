---
"@anywalletkit/wallet-ton": patch
"@anywalletkit/wallet-near": patch
"@anywalletkit/kit": patch
"@anywalletkit/extension-kit": patch
"@anywalletkit/core": patch
---

TON and NEAR `sign()` refuse a 32-byte message with `MessageIsTransactionError`: both chains sign transactions over a 32-byte digest (the V5R1 signing-cell hash, sha256(borsh(tx))), so a "message" of those bytes was a valid transaction signature the policies treated as harmless. TON accounts gain `signTonProof` and `signTonConnectData`, which build the TON Connect digests from the request and their own address; the kit treats both as message signatures. extension-kit's `tonProofMessage` / `tonSignDataMessage` are documented as verification helpers.
