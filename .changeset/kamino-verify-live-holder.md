---
"@anywalletkit/protocol-lending-kamino-solana": patch
---

The README's Verify section describes the repository's live check as it now runs: `verify:live [address] [rpcUrl] [lendAddress]` also simulates a Lend withdraw for a wallet with USDC supplied on the main market, and stops with "holder's USDC account is frozen, pass another address" when the holder's USDC account is frozen, instead of failing inside the simulation. Its default holder moved to an unfrozen USDC account. No code in the package changed; nothing to do in apps.
