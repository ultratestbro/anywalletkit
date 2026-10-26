---
"@anywalletkit/kit": patch
---

Policy-guarded writes now judge and sign one deep copy of their arguments, taken before any check, and `confirm` gets its own copy. A getter that answers differently later, a `confirm` hook that edits `intent.raw`, or code that edits the caller's object during an await can no longer change what is signed after it was checked. The account receives a copy, not the caller's object.
