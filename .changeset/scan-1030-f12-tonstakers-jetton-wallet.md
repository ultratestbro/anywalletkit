---
"@anywalletkit/protocol-staking-tonstakers-ton": minor
---

The account's tsTON jetton wallet — where `requestWithdrawal` sends the 1.05 GRAM unstake reserve, and where `getTokenBalance` / `getStakedBalance` / `quoteRequestWithdrawal` read — is derived on the device from the minter's pinned jetton-wallet code (StateInit hash of the code and the wallet's initial data), and the minter's `get_wallet_address` must name the same address; a node naming any other address is refused and nothing is sent. It used to take the getter's answer unchecked. The mainnet and testnet minters' codes ship in the new `TONSTAKERS_JETTON_WALLET_CODES` (verified live 2026-10-30 against the minter's getter and real holders' wallets), with `deriveTonstakersJettonWallet(owner, minter, code)`. Testnet now ships its tsTON minter in `TONSTAKERS_ADDRESS_MAP['-3'].jetton`.

**Breaking:** a custom `addresses.jetton` (or a pool reporting a minter) with no pinned code is refused; pass its `jettonWalletCode` (a Cell or base64 BOC), or `allowUnverifiedJettonWallet: true` to keep trusting the node's answer.
