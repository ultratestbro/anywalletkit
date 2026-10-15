# @forgewallet/protocol-approvals-evm

**A simple package that lets [`@forgewallet/wallet-evm`](https://www.npmjs.com/package/@forgewallet/wallet-evm) accounts see and revoke the token approvals they have granted.**

Every swap, bridge, lending and staking module *creates* approvals (ERC-20 allowances to routers, Permit2 allowances, operator approvals on NFTs). None of them takes an approval back, and a wallet built on has no way to show its user "who can spend my USD₮". This module fills that gap: it discovers what an account has granted, flags the risky grants, and revokes them through the account's own methods, so a policy-governed account stays governed.

Supported on evm: ERC-20 allowances, ERC-721 per-token approvals, ERC-721 / ERC-1155 operator approvals (`setApprovalForAll`), Uniswap Permit2 allowances, and the account's EIP-7702 delegation.

## Install

```bash
npm install @forgewallet/protocol-approvals-evm
```

Peer: `@forgewallet/core >= 1.0.0-beta.13`. Runtime dependency: `viem`. Built with tsup (ESM + CJS + types in `dist/`); works on Node 20+ and React Native.

## Usage

The protocol is constructed directly:

```js
import WalletManagerEvm from '@forgewallet/wallet-evm'
import ApprovalsProtocolEvm from '@forgewallet/protocol-approvals-evm'

const wallet = new WalletManagerEvm(seed, { provider: 'https://ethereum-rpc.publicnode.com' })
const account = await wallet.getAccount(0)

const approvals = new ApprovalsProtocolEvm(account, {
  fromBlock: 21_000_000,   // where the wallet was created — a cold scan from 0 is slow
  blockRange: 10_000       // your RPC's eth_getLogs window (QuickNode: 10 000)
})

const { approvals: list, coverage } = await approvals.getApprovals()
for (const a of list) {
  console.log(a.standard, a.token, '→', a.spender, a.unlimited ? 'UNLIMITED' : a.amount, a.risks)
}
// erc20 0xdAC1…1ec7 → 0x1231…4EaE 0n []            (LI.FI, exact-amount, already consumed)
// erc20 0xdAC1…1ec7 → 0xD37B…7146 1000000000n []    (1 000 USD₮ still spendable)
// permit2 0xA0b8…eB48 → 0x3fC9…BB1c UNLIMITED ['unlimited']

await approvals.revoke(list[1])                       // account.approve({ amount: 0 })
await approvals.revokeAll(list.filter((a) => a.risks.length))
```

A read-only account (`WalletAccountReadOnlyEvm`, or anything with `getAddress()`) is enough for `getApprovals`; `revoke` / `revokeAll` need a full account.

### With the policy engine

Revokes are sent through `account.approve({amount: 0})`, `account.sendTransaction` and `account.revokeDelegation()`. Hand the module the account you get from the policy-governed wallet (not the raw wallet's) and the revokes are subject to the same rules as any other spend. The engine is default-deny, so a governed account needs rules that allow revokes. The package ships them:

```js
import { approvalsHygienePolicy } from '@forgewallet/protocol-approvals-evm/policies'

wallet.registerPolicy(approvalsHygienePolicy())
// allow-revoke:           approve with amount 0, revokeDelegation
// allow-revoke-calldata:  sendTransaction whose data is setApprovalForAll(false), approve(…, 0) or Permit2 lockdown
// deny-unlimited-approve: approve with amount >= 2^255
```

Conditions read `context.args`.

## How discovery works

1. **Candidates from events.** One `eth_getLogs` per block range asks for every approval-shaped event with the owner in `topic1` and no `address` filter: ERC-20 / ERC-721 `Approval` (told apart by topic count), `ApprovalForAll`, Permit2 `Approval` / `Permit` / `Lockdown`. A range the node refuses is halved and retried; a single block that stays refused becomes a gap and `coverage.complete` turns false rather than the call failing.
2. **Truth from state.** Candidates are verified in one Multicall3 `aggregate3` (with a per-call fallback where Multicall3 is missing): `allowance`, `isApprovedForAll` + `supportsInterface(ERC-1155)`, `getApproved` + `ownerOf`, Permit2 `allowance`. Zero, expired and revoked entries are dropped unless `includeZero` is set.
3. **Risk flags.** `unlimited` (≥ 2^255, or `MaxUint160` for Permit2), `eoa-spender` (spender has no code), `expired` (Permit2, with `includeZero`).
4. **EIP-7702.** The account's code is read; `0xef0100‖delegate` is reported as an `eip7702` approval and revoked with `account.revokeDelegation()`.

### Making it fast

A cold scan from block 0 through a 10 000-block RPC window is thousands of requests. Three knobs:

- `fromBlock` — the wallet's creation block. Wallets created by your app know it.
- `cache` — `{ get(key), set(key, entry) }`; the module stores `{ fromBlock, toBlock, candidates }` (plain JSON) per `chainId:owner` and rescans only new blocks next time.
- `source: new EtherscanSource({ chainId, apiKey })` — Etherscan V2, one key for every chain it indexes, **one request for the whole history** (every log with the owner in `topic1`; the parser drops the owner's transfers). The free tier covers Ethereum, Arbitrum, Polygon and others at 5 requests/s; Base, Optimism, BNB and Avalanche need a paid plan. Keep the key off the client: set `baseUrl` to your own proxy that appends it and `headers` for the proxy's auth.
- `source: new BlockscoutSource({ chainId })` — the same query against a public Blockscout instance, no key: **one request for the whole history** (every log with the owner in `topic1`; the parser drops the owner's transfers), no key. Keyless instances allow ~10 requests per window per instance and answer 429 with `x-ratelimit-reset`; the source waits for short resets and fails fast with the wait time for long ones. Pass `apiKey` (free at dev.blockscout.com) to lift the limit, `perTopic: true` to ask per event signature instead. Use it for the first scan of an imported wallet and let `RpcLogsSource` take over.

Measured on a real wallet on Ethereum (11 approval events over 4 M blocks): `RpcLogsSource` 398 requests / 121 s at a 10 000 window, `EtherscanSource` and `BlockscoutSource` 1 request / ~1 s.

### Spender labels

```js
import ApprovalsProtocolEvm, { EtherscanLabels } from '@forgewallet/protocol-approvals-evm'

const labels = new EtherscanLabels({ chainId: 1, apiKey, explorerUrl: 'https://etherscan.io' })
const approvals = new ApprovalsProtocolEvm(account, { labels })
// approval.spenderLabel → { name: 'THORChain_Router', url: 'https://etherscan.io/address/0xD37B…' }
```

`EtherscanLabels` resolves each unique spender once through `module=contract&action=getsourcecode` (a proxy is named after its implementation, so `0x6C96…` reads `OAdapterUpgradeable`, not `TransparentUpgradeableProxy`) and memoises the answer; pass `cache` to persist it. Unverified contracts and EOAs get no label. A label failure never fails the scan. Any object with `resolve(addresses) → { [lowercaseAddress]: { name, url? } }` works as `config.labels`.

Etherscan's own "Token Approvals" page lists the **original** allowance from the `Approval` event and does not read the current allowance; USDT does not emit `Approval` when a spender uses the allowance, so approvals fully consumed by a swap or deposit stay listed there. This module reports the on-chain `allowance()`; pass `includeZero: true` to see the consumed ones too.

## API

| Method | Account | Returns |
|---|---|---|
| `getSupportedStandards()` | read-only | `['erc20', 'erc721', 'erc721-token', 'erc1155', 'permit2', 'eip7702']` |
| `getApprovals(options?)` | read-only | `{ approvals: Approval[], coverage }` — `options`: `standards`, `tokens`, `spenders`, `includeZero`, `fromBlock`, `toBlock` |
| `quoteRevoke(approval)` | full | `{ fee }` via `account.quoteSendTransaction` |
| `revoke(approval)` | full | `{ hash, fee }` |
| `revokeAll(approvals)` | full | `RevokeResult[]` — Permit2 pairs fold into one `lockdown`; with `config.batch` every calldata revoke goes out as one `sendTransaction(tx[])` (ERC-4337 / 7702 accounts); a failed item carries `error` and the run continues |
| `buildRevokeTransaction(approval \| approvals[])` | none | `{ to, data, value }` for hosts that batch themselves |

`Approval`: `{ id, standard, chainId, token, spender, amount, unlimited, tokenId?, expiration?, grantedAt?, risks }`. `id` is `chainId:standard:token:spender[:tokenId]` and is stable across scans. Approval objects are plain (structured-clone safe), which the policy engine requires.

### Config

| Option | Default | Meaning |
|---|---|---|
| `provider` | account's | RPC URL or EIP-1193 provider |
| `chainId` | from RPC | skips `eth_chainId` |
| `fromBlock` | `0` | start of a cold scan |
| `blockRange` | `null` | pre-chunk `eth_getLogs`; null = whole range, split on refusal |
| `source` | `RpcLogsSource` | any `{ name, collect(owner, range) }` |
| `cache` | none | `{ get, set }` for incremental rescans |
| `multicall` | Multicall3 | address, or `false` for single calls |
| `batch` | `false` | account accepts `sendTransaction(tx[])` as one operation |
| `includeDelegation` | `true` | report the EIP-7702 delegation |
| `concurrency` | `4` | parallel RPC requests |

Errors are `ApprovalsError` with `reason` ∈ `account-required`, `provider-required`, `unsupported-standard`, `invalid-approval`, `source-failed`.

## Verification

```bash
pnpm test                                                            # vitest: 17 tests on an EIP-1193 double + the conformance suite
pnpm build && node scripts/verify-live.mjs …                        # the live script imports dist/
node scripts/verify-live.mjs 0x… https://rpc --chain 1 --range 10000 --from 22000000 [--include-zero]
LIVE_PK=0x… node scripts/verify-live.mjs 0x… https://rpc --revoke <approval id>   # real revoke + re-check
```

## Limitations

- Spender labels (which protocol an address belongs to) are out of scope; the id and address are enough to revoke.
- Discovery depends on events: an allowance granted by a contract that emits no `Approval` (rare, non-compliant tokens) is invisible. Pass it in `options.spenders` / `tokens` with a custom source if you know it.
- Only the owner's own approvals are listed. Allowances *received* by the account are not approvals it can revoke.
- The provider is taken from `account._config.provider` when not given — a private field, the same compromise the other community modules make.

## License

Apache-2.0

## Activity

`describeActivity(tx, { own })` labels approvals and revokes for a wallet's history, offline and synchronously, on every EVM chain (`eip155:*`). Recognized by 4-byte selector on any contract (the called contract is the token): ERC-20 / ERC-721 `approve(address,uint256)` — amount 0 → `revoke`, else `approve` (ERC-721 shares the selector, so a tokenId of 0 reads as a revoke — the one case the selector cannot tell apart offline); `setApprovalForAll(address,bool)` — false → `revoke`; Permit2 `approve(address,address,uint160,uint48)` — amount 0 → `revoke`; Permit2 `lockdown` → `revoke`. Calldata is needed for the spender and the amount; with a bare selector the item is still an `approve`. Titles read "Revoked USDT for 0x6c96…1dee" / "Approved USDC for Permit2" — pass `tokens` (lowercase address → `{ symbol }`) in the config to name tokens, well-known spenders (Permit2) are named by the module. Subtitle `"Token approval · <chain>"` or `"Permit2 · <chain>"`, `counterparty` the spender, no asset movements. Everything else yields null, so protocol calls fall through to the protocol modules.

Fixtures in `fixtures/activity/` are the test wallet's USDT revoke (the module's own 2026-09-14 run, `approve(spender, 0)`) and a USDC approve before a THORChain swap; `negatives/` holds a Lido submit and an SSV stake.
