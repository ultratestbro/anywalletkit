---
"@anywalletkit/wallet-ton": patch
"@anywalletkit/keyring": patch
---

`WalletManagerTon.fromTonMnemonic` (and so `Keyring.importTonMnemonic`) checks the phrase with @ton/crypto's `mnemonicValidate`. Any 24 words were taken: a typo, or a BIP-39 phrase pasted into the TON-mnemonic import, opened a different, empty wallet. Such a phrase is now refused ("Not a valid TON mnemonic").
