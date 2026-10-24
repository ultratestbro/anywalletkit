---
"@anywalletkit/wallet-btc": minor
---

Before p2wpkh inputs are signed, every coin is checked against its full previous transaction. That transaction must hash to the claimed txid, and the output's amount and script must match. Otherwise the spend is refused (`UnsafeTransactionError` with code `prevout-mismatch`).

Why: BIP-143 commits each signature to the input's CLAIMED amount, so a lying indexer could combine two signing sessions into a tx with a hidden fee. Raw-hex fee checks now also refuse a previous transaction that does not hash to its id.

Taproot (BIP-341 commits to every amount) skips the extra requests.
