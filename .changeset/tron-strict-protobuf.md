---
"@forgewallet/wallet-tron": patch
---

The Tron protobuf reader is now strict and canonical (scan F4): tags longer than 5 bytes or ≥ 2^32, non-minimal varints (tags, values, lengths), varints over 64 bits and repeated singular fields are refused as `raw-noncanonical`; a contract with a schema (transfers, TRC-10, TriggerSmartContract, stake v1/v2, delegation) must decode completely — an unknown field is a hard `raw-undecodable` — and must re-encode to exactly its `Any.value` bytes. Unknown fields in the `Contract` wrapper or the `Any` are refused. int64 values are decoded as signed (a 10-byte varint ending in 0x01 is a valid negative). Closes a gap where java-tron, which keeps only the low 32 bits of a tag, could read a hidden field the sheet showed as "not decoded". New exports: `NonCanonicalError`, `isDecodedContractType`.
