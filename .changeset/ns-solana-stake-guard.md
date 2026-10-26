---
"@anywalletkit/wallet-solana": patch
"@anywalletkit/protocol-staking-native-solana": patch
---

wallet-solana's signing guard reads the Stake program: it refuses a Stake `Authorize*` to another key, a `Withdraw` to anyone but the wallet, a `SetLockup*` with a foreign custodian or a lockup, and funding a stake account that the same transaction does not initialize (or split into) with the wallet as staker and withdrawer (`allowAuthorityChanges` overrides). It now signs taking back a pre-funded seed slot (`AllocateWithSeed` of a 200-byte Stake account the same transaction initializes for the wallet), so dust sent to every `stake:<i>` address no longer blocks native staking. `describeTransaction` names Stake instructions and what they set (`stake`, `withSeed` on program-call items); `decodeStakeInstruction` and `STAKE_PROGRAM_ADDRESS` are exported.
