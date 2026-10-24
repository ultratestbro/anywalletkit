# @anywalletkit/seed-vault

[![npm](https://img.shields.io/npm/v/@anywalletkit/seed-vault?label=npm)](https://www.npmjs.com/package/@anywalletkit/seed-vault)

An encrypted backup file for one wallet secret: a seed phrase or a private key, exactly as the keyring stores it. One file can be opened by one or more **protectors**:

## Install

```sh
npm install @anywalletkit/seed-vault
# or: pnpm add @anywalletkit/seed-vault  ·  yarn add @anywalletkit/seed-vault
```

On npm: [@anywalletkit/seed-vault](https://www.npmjs.com/package/@anywalletkit/seed-vault), published from the [release workflow](https://github.com/ultratestbro/anywalletkit/blob/main/RELEASING.md) with provenance.

| Protector | What opens it | Use it for |
|---|---|---|
| `password` | A password through Argon2id (19 MiB × 2 by default, at least 10 characters) | A file in iCloud Drive / Google Drive / anywhere. Works across platforms. |
| `key` | Any ≥32-byte secret held somewhere else | A passkey PRF output, a random key in iCloud Keychain / Google Block Store, a hardware key's hmac-secret |

```ts
import { sealBackup, openBackup, addProtector, encodeBackup, decodeBackup } from '@anywalletkit/seed-vault'

const secret = await secrets.get(sourceId)                       // the keyring's stored string
const meta = { type: source.type, fingerprint: source.fingerprint, label: source.label }
const file = encodeBackup(await sealBackup(secret, meta, [{ kind: 'password', password }]))

// later, on any device
const opened = await openBackup(decodeBackup(file), { kind: 'password', password })
if (opened.meta.fingerprint !== expected) …                      // compare before writing anything
await secrets.set(sourceId, opened.text())
opened.dispose()                                                 // zeroizes the bytes
```

## The format

- **Payload:** the secret is encrypted once with a random 32-byte data key (XChaCha20-Poly1305).
  - The header (format, version, created-at, `meta`) is authenticated as associated data.
  - Changing the fingerprint or label in the file makes it fail to open (`corrupted`).
- **Protectors:** each one wraps the same data key with its own key-encryption key, and its descriptor is authenticated.
  - Lowering the Argon2 cost in the file, or renaming a key, makes that protector fail.
- **Changing protectors:** `addProtector` / `removeProtector` change who can open the file without re-encrypting the secret. The last protector cannot be removed.
- **Decoding:** `decodeBackup` is strict.
  - It refuses an unknown format, version, cipher or KDF, and it rebuilds the object from known fields only.
  - It bounds Argon2 costs (≤ 1 GiB, t ≤ 16), so a malicious file can't exhaust the phone's memory.
- **Passwords:** NFKC-normalized, so the same passphrase typed on different keyboards opens the file.

## Speed on phones

Argon2id runs in pure JS by default, and that always works for opening a file.

| Engine | Seal or open (19 MiB × 2) |
|---|---|
| Hermes | about 6–15 s |
| V8 / Node | about 0.15 s |

Show a native spinner while it runs.

With a native Argon2id you get under a second and can afford a stronger cost. Pass `{ argon2id: nativeImpl, argon2: { m: 64 * 1024, t: 3, p: 1 } }`. The cost is stored in the file, so any device can still open it.

## What it is not

- It doesn't upload files. That is `backup-cloud`.
- It doesn't store secrets on the device. That is `@anywalletkit/secure-storage-react-native`.
- It doesn't split secrets into shares (Shamir). That is planned as an extra protector kind.
- It doesn't use keystore v3 (Ethereum JSON) files.
