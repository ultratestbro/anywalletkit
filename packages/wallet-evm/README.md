# @anywalletkit/wallet-evm

EVM accounts for Any Wallet Kit, derived at `m/44'/60'/0'/0/i` — the same
path as MetaMask and ethers, pinned by golden vectors in `@anywalletkit/conformance`.

```ts
import WalletManagerEvm from '@anywalletkit/wallet-evm'

const wallet = new WalletManagerEvm(seedPhrase, { provider: ['https://rpc-a', 'https://rpc-b'] })
const account = await wallet.getAccount(0)
await account.transfer({ recipient: '0x…', amount: 10n ** 15n })                  // ETH
await account.transfer({ token: USDT, recipient: '0x…', amount: 1_000_000n })      // ERC-20
await account.approve({ token: USDT, spender: ROUTER, amount: 1_000_000n })
const sig = await account.signTypedData({ domain, types, message })               // EIP-712
wallet.dispose()                                                                  // zeroizes seed + keys
```

Offline signing: omit `provider`, pass `chainId` (or put it on the tx) and call
`signTransaction` with every field set — nothing touches the network.

## Safety layer

Every send goes through, in order: static refusals → simulation → fee cap → sign → broadcast.

- **What you sign.** `describeTransaction(tx, {chainId})` and `describeTypedData(typed, {chainId, account})`
  are pure, offline decoders for a confirmation screen: kind (`native-transfer`, `erc20-transfer`,
  `erc20-approve`, `contract-call`, `eip7702-delegation`, …; `permit`, `permit2`, `safe-tx`, `generic`),
  decoded fields, and warnings (`approve-unlimited`, `to-zero-address`, `chain-mismatch`,
  `deadline-passed`, `owner-mismatch`, `legacy-fee-fields`).
- **Hard refusals** before any signature: a tx or typed-data domain for another chain throws
  `ChainMismatchError` (override typed data with `allowCrossChainTypedData`); value to the zero
  address throws `UnsafeTransactionError` (override with `allowBurn`).
- **Simulation.** `simulateTransaction(tx)` runs `eth_call` + gas estimate and returns
  `{ok, gas, returnData}` or `{ok: false, reason, data}` with the decoded `Error(string)` / `Panic` /
  custom-error selector. `sendTransaction` / `transfer` / `approve` simulate first and throw
  `SimulationError` instead of broadcasting a revert; `simulate: false` opts out. The estimated gas
  is reused, so the network is asked once.
- **EIP-2612 permit.** `getPermitInfo(token)` reads `name/version/nonces/DOMAIN_SEPARATOR` and
  reports `supported` only when the rebuilt EIP-712 domain equals the contract's own;
  `signPermit({token, spender, value, deadline})` returns `{signature, v, r, s, nonce, deadline, typedData}`.
  DAI's legacy `permit(holder, spender, nonce, expiry, allowed)` is not supported.

```ts
const d = describeTransaction(tx, { chainId: await account.getChainId() })
if (d.warnings.some((w) => w.code === 'approve-unlimited')) ask(d)
const sim = await account.simulateTransaction(tx)
if (!sim.ok) show(sim.reason)
```
