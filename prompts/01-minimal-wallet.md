Build a minimal self-custodial multichain wallet app with Expo (React Native, TypeScript, expo-router) on Any Wallet Kit, the `@anywalletkit/*` packages.

Before writing code, read the SDK reference for agents: AGENTS.md in github.com/ultratestbro/anywalletkit, then the guides at https://docs.anywallet.tech/llms-small.txt (the API reference is in llms-full.txt). Use only APIs that appear there.

What the app does:
- Onboarding: create a new 12-word recovery phrase (show it once, then ask for 3 of the words back) or import an existing phrase (validate it).
- Keys: `@anywalletkit/keyring` with `@anywalletkit/secure-storage-react-native` as its secret storage (Face ID / Touch ID with passcode fallback); account names and addresses in AsyncStorage. The phrase never leaves secure storage after onboarding.
- Home: account 0's addresses and native balances on Ethereum, Base, Solana, TON, Tron and Bitcoin, with pull to refresh. A failed read shows an error, never 0.
- Send: pick a chain, enter recipient and amount, show the network fee quote, confirm, send, show the transaction hash.
- Install the React Native / Hermes polyfills exactly as the reference says.

Rules: amounts are bigint base units (format for display without Number); all RPC URLs in one config file (public endpoints are fine); never log or store the phrase or keys anywhere else; wrap every write in the kit's policies with a confirm step.

Done when `npx tsc --noEmit` passes and `npx expo export --platform ios` bundles. Then tell me how to run it on a phone (a development or Release build; Expo Go cannot load the secure-storage native module).
