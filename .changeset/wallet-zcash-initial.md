---
"@forgewallet/wallet-zcash": minor
---

New chain package: Zcash transparent accounts (BIP-44 `m/44'/133'/0'/0/i`, `t1…`). v5 transactions (ZIP-225) with ZIP-244 txids and signature hashes — verified against mined mainnet transactions (round-trip, txid, every on-chain signature) — ZIP-317 conventional fees with own coin selection, ZIP-203 expiry (40 blocks) and anti-fee-sniping lock time, the consensus branch id picked from the tip height (NU6.3 today, overridable). Blockchair (public, CORS) and Zcash Blockbook transports with failover; Zcash message signing/verification; activity history over Blockchair. Shielded pools (Sapling/Orchard, unified addresses) are refused by name — transparent only.
