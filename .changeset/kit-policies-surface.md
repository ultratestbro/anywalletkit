---
"@forgewallet/kit": minor
---

Policies guard every signing surface, not a fixed list: `signTypedData`, `signPermit`, `approve`, Tron `signRaw`, NEAR `signNep413` / `signBuilt` join the known writes, and any account method named `sign*` / `send*` / `approve*` / `revoke*` / `transfer*` is guarded unless listed in `UNGUARDED_WRITES`. Approvals (`approve`, `signPermit`, EIP-2612 and Permit2 typed data) are checked against the spender — a blocklisted or non-allowlisted spender is refused — and `confirm` receives `kind: 'approval'` with `unlimited` and `deadline`. Other typed data is `kind: 'typedData'` (confirm only). `WriteIntent` gains `kind`; `isGuardedWrite` is exported.
