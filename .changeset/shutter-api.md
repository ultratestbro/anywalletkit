---
"@anywalletkit/shutter-api": minor
---

New package (beta): Shutter API for wallets and apps — seal a message until a time and open it after (commit-reveal) with Shutter's threshold encryption. Encryption and decryption run on the device in pure TypeScript (BLS12-381 IBE over `@noble/curves`, no WASM or Buffer; byte-compatible with Shutter's published vectors), so it runs in React Native (Hermes). Every identity the API returns is re-derived from prefix and registrant, every decryption key is checked against the eon key by pairing, decryption verifies the ciphertext was not changed, and the ciphertext never leaves the device. Identities register through the API or from the user's own account on Gnosis (`registerCalldata`, `readRegistration`). Verified live on Gnosis mainnet and Chiado (`scripts/verify-live.mjs`).
