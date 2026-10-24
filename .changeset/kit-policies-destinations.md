---
"@anywalletkit/kit": minor
---

The allow/block lists check every destination a write goes to, read per chain shape (scan F16/F17). `WriteIntent` gains `destinations` (each EVM call's `to`; the NEAR `receiverId`, also of a base64 borsh transaction; the Tron recipient / contract / resource receiver decoded from `raw_data_hex` — never the optional JSON copy —, a Tron `contractAddress`; every TON message; the recipients and programs of decoded Solana instructions; approvals: the spender; revokes: the contracts called) and `destinationUnknown` (part of the write could not be read). Addresses are compared in one canonical form per chain, both sides: EVM lowercase, Tron 41-hex (base58 and hex entries match), TON raw `wc:hex` (friendly and raw forms match). An unknown destination is refused only when the chain has a blocklist and no `confirm` hook is set; otherwise `confirm` sees `destinationUnknown`. An allowlist needs every destination listed. `intent.to` is unchanged.
