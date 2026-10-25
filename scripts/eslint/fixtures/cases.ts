// Cases for no-number-bigint. A line ending in "// flagged" must be reported; every other line must not.
declare const amount: bigint
declare const maybe: bigint | undefined
declare const either: number | bigint
declare const n: number
declare const s: string

export const cases = [
  Number(amount), // flagged
  Number(maybe), // flagged
  Number(either), // flagged
  Number(amount * 10n), // flagged
  Number(amount >> 3n), // flagged
  Number(amount & 0xffn),
  Number(amount % 58n),
  Number(0xffn & amount),
  Number(amount & (2n ** 64n - 1n)), // flagged
  Number(n),
  Number(s),
  Number(amount.toString()),
]
