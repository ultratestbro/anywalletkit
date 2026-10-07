# @forgewallet/wallet-solana

Solana accounts at `m/44'/501'/i'/0'` (SLIP-10 ed25519 — Phantom / Solflare default),
pinned by golden vectors in `@forgewallet/conformance`.

Signing uses noble ed25519 over the compiled message bytes, so there is no
WebCrypto dependency: the same code runs in Node and in React Native Hermes
without the Ed25519 subtle polyfill.

```ts
import WalletManagerSolana from '@forgewallet/wallet-solana'

const wallet = new WalletManagerSolana(seedPhrase, { provider: ['https://rpc-a', 'https://rpc-b'] })
const account = await wallet.getAccount(0)
await account.transfer({ recipient: 'So1…', amount: 10_000_000n })                 // SOL (lamports)
await account.transfer({ token: USDC_MINT, recipient: 'So1…', amount: 1_000_000n }) // SPL, creates the ATA if missing
await account.sendTransaction(transactionMessage)                                  // any @solana/kit message
wallet.dispose()
```

## What you sign, what it costs, and when the wallet refuses

Every `transfer` / `sendTransaction` / `signTransaction` goes through one plan,
so the network is consulted once per fact and a failing step throws before the
key is used:

1. **Describe** — `account.describeTransaction(tx)` (or `describeTransaction(tx, {account})`,
   pure/offline) decodes System, Token, Token-2022, Associated-Token and
   Compute-Budget instructions and reports `kind` (`sol-transfer`,
   `spl-transfer`, `token2022-transfer`, `ata-create`, `program-call`, `mixed`)
   plus warnings: `unknown-program`, `sets-authority`, `closes-account`,
   `approves-delegate`, `unlimited-approve`, `foreign-fee-payer`,
   `missing-signers`, `unresolved-lookup-tables`, `burn-address`.
2. **Hard checks** — fee payer must be this wallet (`allowForeignFeePayer` to
   override), a provider transaction must not need other signatures
   (`MissingSignersError`), transfers to the System-program address are refused
   (`UnsafeTransactionError`, `allowBurn` to override).
3. **Compute budget** — by default the price is the 75th percentile of
   `getRecentPrioritizationFees` over the writable accounts (clamped by
   `minPriorityMicroLamports` / `maxPriorityMicroLamports`) and the unit limit is
   the simulated usage × 1.1. Set `priorityFee: {microLamports, computeUnitLimit}`
   for explicit values or `priorityFee: false` to add nothing; a budget the
   caller already put in the message is kept.
4. **Simulation** — `simulateTransaction` (`sigVerify: false`) runs before signing;
   a failure throws `SimulationError` with the program logs. `simulate: false` disables the gate.
5. **Fee quote** — `quoteSendTransaction` / `quoteTransfer` return
   `{fee, baseFee, priorityFee, microLamports, computeUnitLimit, tokenFee?}`;
   `transferMaxFee` / `transactionMaxFee` compare against `fee`.

```ts
const q = await account.quoteTransfer({ token: MINT, recipient, amount: 10_000n })
q.priorityFee  // lamports added by the compute budget
q.tokenFee     // Token-2022 transfer fee withheld by the mint (0 for plain SPL)
```

### Token-2022

`transfer` reads the mint once: owner program, decimals and (for Token-2022) the
`TransferFee` extension in force this epoch. Transfers use `transferChecked`
(mint and decimals verified on chain); fee-bearing mints use
`transferCheckedWithFee` so a changed fee makes the transaction fail instead of
silently taking more. The recipient's ATA is derived for the right program.

### Versioned transactions and provider wires

* `transfer({..., lookupTables: [table]})` / `sendTransaction({to, value, lookupTables})`
  fetch the tables and compress the v0 message.
* A swap or DeFi provider's base64 wire transaction is accepted directly:
  `signTransaction(base64)` / `sendTransaction(base64)` decode it, run the hard
  checks, simulate, add this wallet's signature (others are preserved) and
  return / broadcast the wire. The message bytes are never altered.
