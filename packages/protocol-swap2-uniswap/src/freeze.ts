/**
 * The pinned per-chain tables frozen through their rows (review SEC-U4-R3-2). `Object.freeze` of a table alone leaves
 * every row writable, so code in the process could repoint a pinned router, quoter or SwapProxy — the app's pins and
 * the provider read the rows at call time. Each row is frozen in place (its fields are strings, numbers and booleans),
 * then the table. Internal: not exported from the package.
 */
export function frozenRows<T extends object>(table: Record<number, T>): Readonly<Record<number, Readonly<T>>> {
  for (const row of Object.values(table)) Object.freeze(row);
  return Object.freeze(table);
}
