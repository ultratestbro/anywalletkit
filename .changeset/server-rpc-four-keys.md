---
---

examples/server (not published): the RPC proxy rebuilds each call from `{ jsonrpc, id, method, params }` and refuses any other key, case variants such as `Method`/`PARAMS` included (Go JSON decoders match keys case-insensitively). `params` must be an array (absent = `[]`), `jsonrpc` must be `"2.0"`.
