---
"@anywalletkit/protocol-staking-spl-stake-pool-solana": patch
---

Delayed exits can no longer be blocked by pre-funding the slot addresses. They are predictable (wallet + seed), and SOL sent to one makes `CreateAccountWithSeed` fail there, so a few lamports sent to all eight made every delayed exit "slots are in use". Pre-funded addresses are now skipped without counting against `unstakeSlots`, the scan continues past them (up to `MAX_PREFUNDED_SLOTS` = 32 more indexes), exits placed past them are listed and claimable, and only beyond that bound is the exit refused, naming the cause and pointing to the instant mode.
