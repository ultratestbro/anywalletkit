---
"@anywalletkit/protocol-staking-native-monad": minor
---

Pending withdrawals are found in every slot. The default `'gap'` scan stopped 32 empty slots past the last used one, so a pending slot above a run of claimed ones (withdrawals 0–39 with 0–35 claimed) was never listed or claimed. The new default `withdrawScan: 'multicall'` reads every slot up to `maxWithdrawId` in one `eth_call` through Multicall3 (deployed on Monad; `multicallAddress` to override), falling back to one call per slot when that fails. `'gap'` stays as an explicit, documented trade-off. (Finding the slots from `Undelegate` logs was not an option: the Monad RPC caps `eth_getLogs` at 1 000 blocks, about 7 minutes.)
