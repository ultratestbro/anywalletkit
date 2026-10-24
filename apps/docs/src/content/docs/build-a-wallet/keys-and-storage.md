---
title: Keys and storage
description: Seed phrases, derivation, and keeping the seed safe on the device.
sidebar:
  order: 2
---

## Keys

**The job:** turn 12 or 24 words into keys for every chain, the same way other wallets do.
Otherwise a user who imports their MetaMask or Phantom phrase sees an empty wallet.

**In the kit:** `core`.

- `getRandomSeedPhrase(12 | 24)` creates a phrase; `isValidSeedPhrase()` checks the
  wordlist and the checksum.
- The phrase becomes a 64-byte seed, and keys are derived along the standard paths: BIP-32
  for secp256k1 chains (EVM, Bitcoin, Tron, Zcash), SLIP-10 for ed25519 chains (Solana, TON,
  NEAR).
- Paths are pinned by test vectors, so account `i` is the address MetaMask, Phantom,
  Tonkeeper, TronLink and MyNearWallet derive. See [Chain ids and derivation](/concepts/chain-ids/).

**Decisions you make:**

- **12 or 24 words.** Both are standard; 24 is the default.
- **A BIP-39 passphrase or not.** The SDK uses an empty one, like every major wallet. A
  passphrase changes every address, so a user who forgets it loses the funds.
- **Imports.** `keyring` imports a seed phrase, a single private key for one chain, and the
  24-word TON format of Tonkeeper, Tonhub and MyTonWallet. See the [Keyring guide](/guides/keyring/).

**Rules:**

- **Don't keep the phrase as a JS string longer than the onboarding screen.** A string
  cannot be wiped from memory. The SDK turns a phrase into the 64-byte seed the moment it
  gets it and keeps only the bytes; `dispose()` wipes them. Better still, keep the 64-byte
  seed in secure storage next to the phrase and unlock with it (`new Wallet(seedBytes)`):
  the words are then read only when the user opens "Show recovery phrase".
- **Logging an object never shows a key.** Seeds and private keys are not properties of any
  SDK object, so `console.log(account)`, `JSON.stringify(wallet)` or a crash report shows
  addresses and public keys only. The conformance suite checks this for every chain.
- **Never send the phrase or the seed anywhere.** That includes analytics, crash reports,
  logs and clipboard history.
- **Don't let the OS screenshot the phrase screen.** Block screenshots and the app-switcher
  preview while it is shown.

## Key storage

**The job:** keep the seed on the device, encrypted, unlocked only by the user.

**In the kit:**

- **Mobile:** nothing yet; a seed vault package is planned.
- **Browser extension:** `extension-kit` has an encrypted vault (password or passkey) and a
  session that locks after 15 minutes idle. See [dApp connection](/build-a-wallet/dapp-connection/).

**What to use on mobile:**

| Platform | Store | Notes |
|---|---|---|
| iOS | [Keychain Services](https://developer.apple.com/documentation/security/keychain-services) | Use an access control that asks for Face ID **or** the device passcode, so a user whose Face ID fails is not locked out |
| Android | [Android Keystore](https://developer.android.com/privacy-and-security/keystore) | Ask for biometrics with a device-credential fallback |
| Expo / React Native | [`expo-secure-store`](https://docs.expo.dev/versions/latest/sdk/securestore/) with `requireAuthentication`, [`expo-local-authentication`](https://docs.expo.dev/versions/latest/sdk/local-authentication/) | One API over both platforms |

**Backup:**

- Show the phrase once, then ask the user to confirm a few of the words.
- Never store the phrase in plain files, app storage or a screenshot.
- "Export private key" for one account goes behind the same authentication as the phrase.
  `keyring.exportPrivateKey` returns the key in the format the chain's other wallets import,
  checked against the account's address. See [Keyring](/guides/keyring/#back-up-and-remove).
- Encrypted cloud backup (iCloud Keychain, Google Drive) is planned for the SDK.

## Keys that never touch the phone

Any key that signs somewhere else works through `externalSigner()`: a hardware wallet, an
MPC service, a Safe, or a backend signer for bots. The account behaves the same; only the
`sign` call goes out. See [Custom signer](/guides/custom-signer/).
