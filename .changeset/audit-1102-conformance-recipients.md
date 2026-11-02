---
"@anywalletkit/conformance": minor
---

`describeProtocolBehaviour` now checks who a swap plan's source call pays and which contracts it calls, not only the plan's own recipient fields and approvals. Two new fixture fields: `callTargets` (contracts the source call may go to; the declared `spender` and `sourceToken` count already) and `decode(source)` (the fixture's own reading of router calldata or a typed order, returning every address the output or refund goes to). `decode` is required whenever the source is a contract call that is not a plain token or native transfer, and for typed orders; each address it returns must be own or the declared deposit address. tx-preview's `contract-unknown`, `native-value`, `approval-unparsed` and `calldata-undecodable` warnings now fail the suite. Module authors: add `callTargets` and a `decode` to your behaviour fixtures (see the swap2 modules' tests in this repository for examples); a fixture without them now fails.
