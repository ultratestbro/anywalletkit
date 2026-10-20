---
title: Errors
description: The error classes every package throws, and the rule that refusals are named.
sidebar:
  order: 4
---

The SDK never answers "no" with a `null`. When a quote, a transaction or a route cannot be
used, you get an error whose class and message say why. Check errors with `instanceof`,
not by matching messages.

## From `@anywalletkit/core`

| Error | When | Extra fields |
|---|---|---|
| `InsufficientFundsError` | The account cannot cover amount + fee | `required`, `available` (base units) |
| `NetworkError` | An RPC or API call failed | `provider` (the endpoint) |
| `UserRejectedError` | An external signer or your `confirm` policy declined | |
| `SignerError` | The signer cannot sign: disposed, wrong curve, unsupported scheme | |
| `ReadOnlyAccountError` | A write method was called on a read-only account | |
| `NotImplementedError` | A protocol module does not implement an optional method | |

## From `@anywalletkit/kit`

| Error | When | Extra fields |
|---|---|---|
| `PolicyViolationError` | A [policy](/concepts/policies/) refused the write | `policy`: `'maxFee'`, `'allowlist'` or `'blocklist'` |

## From chain and protocol packages

Each package adds errors for its own refusals: a simulation that would revert, a fee above
the configured cap, an unsafe transaction shape, a swap quote that expired or whose route
changed. They are listed in each package's API reference.

```ts
import { InsufficientFundsError, UserRejectedError } from '@anywalletkit/core'
import { PolicyViolationError } from '@anywalletkit/kit'

try {
  await account.transfer({ recipient, amount })
} catch (e) {
  if (e instanceof UserRejectedError) return // the user cancelled: say nothing
  if (e instanceof InsufficientFundsError) return showTopUp(e.required - e.available)
  if (e instanceof PolicyViolationError) return showBlocked(e.policy)
  throw e
}
```
