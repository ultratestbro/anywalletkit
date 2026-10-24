# @anywalletkit/conformance

Test suites every Any Wallet Kit chain and protocol module runs, and the pinned derivation vectors they check against.

| Export | Checks |
|---|---|
| `describeChainModule` | a chain package: derivation against `derivationVectors` (several seeds and account indexes), signing, read-only accounts that never write |
| `describeProtocolModule` | a protocol module's shape: required methods, a read-only account cannot write, a quote never sends |
| `describeProtocolBehaviour` | a swap2 module run to the review gate: only own or declared recipients, approvals exactly to the declared spender, amounts equal to the quote |
| `describeActivitySuite` | `describeActivity` recognizes the module's recorded real transactions |
| `namesSuite` | a `NameResolver` implementation |
| `createMockAccount` | a recording `IWalletAccount` for tests |
| `derivationVectors` | golden addresses, public keys and signatures per chain |

The suites run under [Vitest](https://vitest.dev):

```sh
pnpm add -D @anywalletkit/conformance vitest
```

Apache-2.0
