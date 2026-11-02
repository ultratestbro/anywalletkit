---
"@anywalletkit/wallet-tron": patch
---

A Tron broadcast is now a plain `Error` ("Broadcast failed: <code> <message>") only when java-tron answered one of the codes it returns before pushing a transaction to the network: `SIGERROR`, `CONTRACT_VALIDATE_ERROR`, `CONTRACT_EXE_ERROR`, `BANDWITH_ERROR`, `TAPOS_ERROR`, `TOO_BIG_TRANSACTION_ERROR`, `TRANSACTION_EXPIRATION_ERROR`, `SERVER_BUSY`, `NO_CONNECTION`, `NOT_ENOUGH_EFFECTIVE_CONNECTION`, `BLOCK_UNSOLIDIFIED`. Every other answer — an empty body, `result: false` with no code, a gateway `{ Error }` body, `OTHER_ERROR` or an unknown code — now throws `BroadcastUnknownError` (`maybeSent: true`, `hash` = the txID), because the transaction may still land. Treat it like a timeout: watch the hash, do not sign a new transaction for the same payment. `DUP_TRANSACTION_ERROR` is still read as accepted.
