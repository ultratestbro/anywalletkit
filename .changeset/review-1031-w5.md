---
"@anywalletkit/wallet-ton": minor
---

A TON send no longer signs the seqno of a transfer that is still on its way. Two awaited `transfer()` / `sendTransaction()` calls before the first was in a block both signed the same seqno: both resolved, but the second could never execute. The account now runs its sends one at a time and remembers the last external it broadcast (accepted, or `BroadcastUnknownError`). Before signing the next one it waits until the wallet's seqno has moved past it, polling for up to `pendingSeqnoTimeoutMs` (new option, default 60 000 ms); if it has not moved by then the send throws "The previous transfer is still pending", and nothing is signed. An external whose `valid_until` passed without landing is forgotten and the chain seqno is used. `signTransaction()` alone does not hold the seqno. Apps that send several TON transactions in a row now see the second one wait for the first instead of silently failing; handle the "still pending" error by retrying later.
