---
"@anywalletkit/kit": patch
"@anywalletkit/keyring": patch
---

Security fixes from the 2026-10-25 audit.

- **kit: policies keyed by namespace apply.** `maxFee` / `allowlist` / `blocklist` rules under a namespace key (`eip155`) were documented to cover every chain of the family and were ignored for `eip155:1`. Rules are now looked up by namespace and by exact id, for the asked-for chain and the account's own: every matching fee cap is checked, a destination must be on every matching allowlist, any matching blocklist refuses. An account whose chain id stays unknown gets its namespace rules; an exact-id rule of its family refuses the write (`policy: 'chain'`), and rules of other families no longer refuse it.
- **keyring: `removeSource` cannot lose a key.** It deleted the secret before saving the metadata, so a failed save left a source without its secret. The metadata now goes first, with the id in the new `KeyringState.pendingSecretDeletes`; the secret is deleted after, and a failed or interrupted delete is finished by `Keyring.load`. An id still pending cannot be adopted. `SecretStorage.delete` must be idempotent.
- **keyring: parallel imports.** The duplicate check and the secret write ran outside the serialized state change, so two imports of one phrase at once could both land. They now run inside it; the second import fails with `duplicate`, and a secret written before a failed save is removed again.
