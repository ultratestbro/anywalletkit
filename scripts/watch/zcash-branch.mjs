// Zcash consensus branch check: the branch id a mined v5 / v6 transaction carries in its header against the one
// @anywalletkit/wallet-zcash signs under for that height. NU7 (block 3 543 405, 2026-11-06) changed it and every
// send was refused with bad-tx-consensus-branch-id-mismatch until the table learned the new id.

export const hex32 = (n) => "0x" + (n >>> 0).toString(16).padStart(8, "0");

/** Version and consensus branch id of a raw transaction (v5 and later carry the id at bytes 8..12); null before v5. */
export function headerBranchId(raw) {
  const h = String(raw).toLowerCase();
  if (!/^(?:[0-9a-f]{2}){12,}$/.test(h)) throw new Error("not a raw transaction");
  const word = (at) => parseInt(h.slice(at * 2, at * 2 + 8).match(/../g).reverse().join(""), 16) >>> 0;
  const header = word(0);
  const version = header & 0x7fffffff;
  if (!(header & 0x80000000) || version < 5) return null;
  return {version, branchId: word(8)};
}

/**
 * Compares what the chain signs under at `height` with what the module would use. `mod` is the built package
 * (`branchIdForHeight`, `MAINNET_UPGRADES`). A mismatch is a problem, reported on every run until the table is fixed.
 */
export function checkBranch({height, txid, raw}, mod) {
  const got = headerBranchId(raw);
  if (!got) return null;
  const expected = mod.branchIdForHeight(height) >>> 0;
  const name = (id) => mod.MAINNET_UPGRADES.find((u) => u.branchId >>> 0 === id)?.name ?? "not in the table";
  const meta = {height, txid, version: got.version, branchId: hex32(got.branchId), upgrade: name(got.branchId), expected: hex32(expected), expectedUpgrade: name(expected)};
  const problems = got.branchId === expected ? [] : [`block ${height} signs under ${meta.branchId} (${meta.upgrade}), the module under ${meta.expected} (${meta.expectedUpgrade}): every send is refused`];
  return {meta, problems};
}
