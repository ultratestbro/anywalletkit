---
"@anywalletkit/protocol-staking-native-monad": minor
---

Rewards left at a validator after a full exit stay visible. Positions came from `getDelegations` only, which drops a validator once the wallet's stake there is zero, so unclaimed rewards there vanished from `listPositions` / `getStakedBalance`. Positions now come from the delegations, the configured validators, the ones this instance unstaked from, and the new `listPositions({ validators })`; a validator with rewards > 0 is kept.
