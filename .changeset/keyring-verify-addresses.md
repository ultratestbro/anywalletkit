---
"@anywalletkit/keyring": patch
---

New: `keyring.verifyAddresses({ repair? })` re-derives every stored address from its key and returns the ones that differ (`{ accountId, chain, stored, derived }`). The stored addresses are public metadata in the app's storage, which may be unauthenticated (a browser extension's `chrome.storage.local`); an app should run this after unlock, before showing a Receive / QR address or exposing an address to a dApp. With `repair: true` the metadata is overwritten with the derived addresses; an address with nothing behind it (a source without a secret, or a chain a single key does not sign on) is removed. A secret store that fails (locked) aborts the check without changing anything. Nothing changes for apps that do not call it.
