---
"@forgewallet/protocol-swap2-omniston": patch
---

EVM → TON disclosure, third blocker: a live TON output position (tag 1, awaiting completion) carries a 29-bit root tail, while the validator only knew the settled / rolled-back layout (5 bits — the shape the fixtures were cut from), so every disclosure attempt inside the window was refused and every order rolled back. Both widths are accepted; every fund-critical field is still bound in the refs. Replayed on a saved live snapshot inside its window: passes.
