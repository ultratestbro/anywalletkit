---
"@anywalletkit/kit": patch
"@anywalletkit/wallet-evm": patch
"@anywalletkit/wallet-solana": patch
---

`policies.maxFee` reaches `approve` (EVM) and `sendSerialized` (Solana) too. It reached only `sendTransaction`, `signTransaction` and `transfer`; an approval or a provider-built Solana transaction paid whatever fee it carried. The kit now hands those two the tightest cap as `WriteOptions.maxFee` (second argument of `approve`, third of `sendSerialized`; a tighter caller cap stays), and the accounts hold it on what they sign: wallet-evm's `approve(options, writeOptions?)` passes it to each transaction it sends (the USDT reset too), wallet-solana's `sendSerialized(base64, guard, options?)` checks the proven fee against the tighter of `transactionMaxFee` and `options.maxFee`. The kit README now lists which writes the cap covers, and no longer calls raw `approve(spender, 0)` a revoke. Audit 2026-10-25 (post-release), L2.
