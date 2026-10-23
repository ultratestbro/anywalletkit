---
title: Review and safety
description: Showing what a transaction will do before it is signed, and protecting users from approvals, drainers and fake tokens.
sidebar:
  order: 8
---

## Review before signing

**The job:** before the key is used, show what will happen in words the user understands:
"You send 100 USDC, you get at least 0.03 ETH", "This site asks to spend ALL your USDT".

**In the kit:**

- `tx-preview-evm` decodes the calls and approvals, simulates the balance changes, and
  returns named checks (`approval-unlimited`, `simulation-reverted`, `recipient-foreign`…)
  that your app words its own way. See [Transaction preview](/guides/tx-preview/).
- `kit` [policies](/concepts/policies/) call your `confirm` step before **every** signature
  and broadcast, and refuse by fee cap, allowlist or blocklist. Wire the preview into
  `confirm` and nothing reaches the key unseen.
- Swap modules hand the exact plan to `reviewExecution` before the first approval. See
  [Swaps → Show a review screen](/guides/swaps/#show-a-review-screen).

**You bring:** an RPC that serves `eth_simulateV1` (see
[Networks and RPC](/build-a-wallet/networks-and-rpc/#choosing-a-provider)). Where a network
lacks it, the preview says so instead of guessing; show that state honestly.

**Design the sheet around three questions:** what leaves, what arrives, who gets permission.
Put the fee and the raw details below that.

## Safety

**The job:** protect users from the most common losses.

| Threat | What happens | In the kit |
|---|---|---|
| Unlimited approvals | A contract the user approved once can drain the token later | [Approvals](/guides/approvals/): find and revoke; `tx-preview-evm` warns before granting one |
| Permit / Permit2 phishing | A "free" signature authorizes a transfer | Policies treat Permit and Permit2 typed data as approvals: `confirm` sees the spender, the amount and `unlimited` |
| Known drainers | The recipient or spender is a scam address | Policies `blocklist`, checked for every recipient and spender |
| Address poisoning | The user copies a look-alike address from history | Spam flags in [History](/build-a-wallet/history/); warn on first sends |
| Fake tokens | Airdropped tokens with phishing names | Hide unknown tokens ([Balances](/build-a-wallet/balances-and-prices/#gotchas)) |
| Wrong network | Funds sent on a network the recipient doesn't watch | Say the network on receive and review screens |

**You bring:** blocklist data. Examples:
[MetaMask eth-phishing-detect](https://github.com/MetaMask/eth-phishing-detect) (phishing
domains for dApp connections), [ScamSniffer](https://scamsniffer.io) (scam addresses and
domains), [Chainalysis sanctions screening](https://www.chainalysis.com/free-cryptocurrency-sanctions-screening-tools/).
A risk-screening module for the SDK is planned.

:::caution[Check before you rely on a provider]
Blocklists differ in coverage, update speed and license. We checked these links on
2026-10-23. Read each source's terms before you ship it in an app, and refresh the data
often. A listing here is not an endorsement.
:::
