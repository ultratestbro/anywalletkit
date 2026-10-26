---
"@anywalletkit/seed-vault": patch
---

`sealBackup` and `addProtector` refuse what `openBackup` / `decodeBackup` would refuse later: a key protector label over 256 characters, or a secret large enough to push the file past the 256 KB the decoder reads. Such backups used to seal fine and fail only at restore time.
