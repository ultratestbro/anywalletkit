---
"@anywalletkit/seed-vault": patch
---

`decodeBackup` / `openBackup` refuse a password protector whose Argon2id cost is below the floor `sealBackup` enforces (m 19 MiB, t 2, p 1) with `BackupError('invalid')`; they accepted m 8 KiB / t 1, so a planted or foreign file that is far cheaper to brute-force offline looked like a normal backup. Every file this SDK sealed meets the floor and still opens. Audit 2026-10-25 (post-release), M1.
