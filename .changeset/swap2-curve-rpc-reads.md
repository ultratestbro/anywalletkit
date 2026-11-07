---
"@anywalletkit/protocol-swap2-curve": patch
---

Curve preflight no longer refuses a sound swap over a busy RPC or an odd pool return.

- **A rate-limited batch is an RPC failure, not a pool off its pin.** QuickNode answers a burst with HTTP 200 and a `-32007 "50/second request limit reached"` error in each element; those were read as missing answers and the preflight said "pool X is not the pinned code" or "does not report its pinned coin k". Now only a revert (code 3, or an execution error such as "execution reverted") counts as an answer; any other element error, or a call left unanswered, sends the batch to the next endpoint, once more after a 1 s pause when the last refusal was for the request rate, and then refuses as `no RPC answered on chain N`. A pool whose code cannot be read says `could not read pool X over RPC`.
- **A return longer than one ABI word is read by its first word.** The Liquity factory metapool (`0xEd27…F0cA`, Ethereum) answers `coins(i)` with 4096 bytes, so every route through it was refused at preflight although the allowlist admitted it. Addresses now need only their upper 12 bytes zero in the first word (a recorded live return is a test fixture).
- `curveOnChain(…).checkPools(chainId, pools)` runs the preflight's pool check without a route; `scripts/verify-live.mjs` puts every allowlisted pool through it, so a pool the generator admits and the runtime refuses fails the live check.
