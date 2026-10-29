# @anywalletkit/tx-preview-evm

[![npm](https://img.shields.io/npm/v/@anywalletkit/tx-preview-evm?label=npm)](https://www.npmjs.com/package/@anywalletkit/tx-preview-evm)

What an EVM transaction will do, before it is signed. It also handles an approve → call sequence. The output feeds a review screen:

## Install

```sh
npm install @anywalletkit/tx-preview-evm
# or: pnpm add @anywalletkit/tx-preview-evm  ·  yarn add @anywalletkit/tx-preview-evm
```

On npm: [@anywalletkit/tx-preview-evm](https://www.npmjs.com/package/@anywalletkit/tx-preview-evm), published from the [release workflow](https://github.com/ultratestbro/anywalletkit/blob/main/RELEASING.md) with provenance.

- **decoded calls** — the recipient, the contract, the method;
- **approvals and transfers**: `approve`, `increaseAllowance` / `increaseApproval`, `setApprovalForAll`, EIP-2612 `permit` calls, Permit2 `approve` and `permit` (single and batch); a permit whose arguments can't be read is the `approval-unparsed` warning;
- **simulated balance changes** at a pinned block (`eth_simulateV1` with transfer tracing, `eth_call` as the fallback);
- **a verdict** made of named checks: unlimited approval, unknown spender, value out, simulation failed…

```ts
import { previewEvmTx } from '@anywalletkit/tx-preview-evm'
```

Pure functions over an injected `rpc(method, params)`. The only dependency is viem.


Docs: [Transaction preview](https://docs.anywallet.tech/guides/tx-preview/)

Apache-2.0
