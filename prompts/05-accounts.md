Add multiple accounts and imports to this Any Wallet Kit wallet with `@anywalletkit/keyring`.

Read the "Keyring" part of https://docs.anywallet.tech/llms-small.txt (or AGENTS.md in github.com/ultratestbro/anywalletkit) first, and use only APIs that appear there.

- Account switcher: list every account with its name and short addresses. Add account (the next index of the same phrase), rename, hide or unhide, set active. Every screen follows the active account.
- Import another recovery phrase, with discovery of the accounts it has used (any balance counts as used).
- Import a private key for one chain: show the address it gives before saving.
- Import a Tonkeeper-style 24-word TON phrase.
- "Show recovery phrase" and "Export private key" sit behind a fresh biometric / passcode check every time. Block screenshots while either is shown.
- Remove a wallet, together with its accounts and its secret.
- All secrets go through `@anywalletkit/secure-storage-react-native`. Listing accounts never prompts for biometrics. Signing uses one short-lived account per action.

Done when `npx tsc --noEmit` passes and `npx expo export --platform ios` bundles.
