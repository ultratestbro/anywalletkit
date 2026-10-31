---
"@anywalletkit/wallet-evm": minor
---

New `account.waitForTransaction(hash, timeoutMs?)` on the EVM signing account: resolves once the transaction is mined successfully, throws `TransactionRevertedError` (`code: 'reverted'`, with `hash` and `blockNumber`) when it reverted; when no receipt came within `timeoutMs` (default 180 s) or the RPC failed it throws viem's error without that code (the transaction may still land). swap2's engine already calls it, when the account has it, between an ERC-20 approval and the swap that spends the allowance, so EVM swaps that need an approval now wait for the approval to be mined before the swap is estimated and sent, instead of racing it. Nothing to change in apps; expect the approval step of a swap to take one block longer.
