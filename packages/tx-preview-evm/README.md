# @anywalletkit/tx-preview-evm

What an EVM transaction will do, before it is signed. It also handles an approve → call sequence. The output feeds a review screen:

- **decoded calls** — the recipient, the contract, the method;
- **approvals and transfers**;
- **simulated balance changes** at a pinned block (`eth_simulateV1` with transfer tracing, `eth_call` as the fallback);
- **a verdict** made of named checks: unlimited approval, unknown spender, value out, simulation failed…

```ts
import { previewEvmTx } from '@anywalletkit/tx-preview-evm'
```

Pure functions over an injected `rpc(method, params)`. The only dependency is viem.

```sh
pnpm add @anywalletkit/tx-preview-evm
```

Docs: [Transaction preview](https://docs.anywallet.tech/guides/tx-preview/)

Apache-2.0
