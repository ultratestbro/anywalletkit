---
title: History
description: An activity list with readable titles across every chain, and the explorer and indexer APIs behind it.
sidebar:
  order: 7
---

**The job:** an activity list that reads "Swapped 100 USDC → 0.03 ETH" and "Staked 1 ETH",
not raw hashes and "Contract call".

**In the kit:**

- **History sources**, one per chain: `history-evm` for EVM networks, and sources built into
  `wallet-btc`, `wallet-solana`, `wallet-ton`, `wallet-tron`, `wallet-near` and
  `wallet-zcash`. Register them with `wallet.registerHistorySource(…)`.
- **The feed:** `kit` merges every chain into one list, newest first, with a cursor for
  paging.
- **Labels from the modules:** every protocol module recognizes its own transactions
  (`describeActivity`), so a Lido stake, an Aave supply or a CCTP bridge reads as what it is.
- **The intent journal:** record what the app meant when it broadcast, and a pending swap
  shows correctly before the explorer has indexed it.

## Sources per chain

| Chain | Source the package reads | Key |
|---|---|---|
| EVM | [Etherscan API v2](https://docs.etherscan.io), [Blockscout PRO](https://docs.blockscout.com/devs/pro-api), [Alchemy](https://www.alchemy.com) Transfers; keyless Blockscout and Routescan as fallbacks | Etherscan v2 refuses keyless requests; a free Etherscan key plus a free Blockscout PRO key cover most networks |
| Solana | JSON-RPC (`getSignaturesForAddress`, `getTransaction`), no indexer | Your RPC; public endpoints rate-limit quickly |
| TON | [tonapi](https://tonapi.io) events, toncenter v3 as fallback | Works keyless at a low rate |
| Tron | [TronGrid](https://www.trongrid.io) account endpoints | Key recommended |
| Bitcoin | Blockbook (Trezor's, [QuickNode's add-on](https://www.quicknode.com/docs/bitcoin), or your own) | Depends on the instance |
| NEAR | [nearblocks](https://nearblocks.io) API, archival RPC for single transactions | Keyless at a low rate |
| Zcash | [Blockchair](https://blockchair.com/api) | Key for volume |

Keys for explorers are secrets: put them behind your own proxy
([Your server](/build-a-wallet/your-server/)). `history-evm` takes a proxy URL instead of
the Etherscan endpoint for that.

## Gotchas

- **Spam.** Airdropped fake tokens and "address poisoning": tiny transfers from an address
  that looks like one the user sends to, so the user copies the wrong one from history. The
  feed hides rows the source flags as spam by default. Still, never offer "copy address" on
  an incoming row without a warning.
- **Cross-chain operations are two rows on two chains.** A bridge is a send on one chain and
  a receive on another, minutes later. The intent journal and the swap modules tie them into
  one item.
- **Explorers lag.** A transaction can be on-chain and missing from the explorer for a few
  seconds to minutes. Show your own pending row until the source has it.

:::caution[Check before you rely on a provider]
Explorer APIs change their free tiers and key rules often (Etherscan required keys in 2026).
We checked these links on 2026-10-23. Read each provider's current terms and keep a fallback
source. A listing here is not an endorsement.
:::
