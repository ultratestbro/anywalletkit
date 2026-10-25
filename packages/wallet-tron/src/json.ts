/**
 * `JSON.parse`, except that integers beyond ±(2^53 − 1) stay exact as decimal strings: full-node
 * JSON carries sun amounts (balances, frozen amounts) that `JSON.parse` would round. Hermes has no
 * reviver source access, so the literals are quoted before parsing; strings are skipped as they are.
 */
export function parseJsonExact(text: string): unknown {
  let out = ''
  let copied = 0
  const n = text.length
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i)
    if (c === 0x22) { // a string: skip to its closing quote
      for (i++; i < n && text.charCodeAt(i) !== 0x22; i++) if (text.charCodeAt(i) === 0x5c) i++
      continue
    }
    if (c !== 0x2d && (c < 0x30 || c > 0x39)) continue
    let j = i + (c === 0x2d ? 1 : 0)
    while (j < n && isDigit(text.charCodeAt(j))) j++
    const intEnd = j
    let integer = true
    if (text.charCodeAt(j) === 0x2e) { integer = false; j++; while (j < n && isDigit(text.charCodeAt(j))) j++ }
    if (text.charCodeAt(j) === 0x65 || text.charCodeAt(j) === 0x45) {
      integer = false
      j++
      if (text.charCodeAt(j) === 0x2b || text.charCodeAt(j) === 0x2d) j++
      while (j < n && isDigit(text.charCodeAt(j))) j++
    }
    if (integer && intEnd - i >= 16 && !Number.isSafeInteger(Number(text.slice(i, intEnd)))) {
      out += `${text.slice(copied, i)}"${text.slice(i, intEnd)}"`
      copied = intEnd
    }
    i = j - 1
  }
  return JSON.parse(copied === 0 ? text : out + text.slice(copied))
}

const isDigit = (c: number) => c >= 0x30 && c <= 0x39

/**
 * A sun amount from node JSON: a decimal string (kept exact by {@link parseJsonExact}) or a number
 * that is still a safe integer. A larger number already lost precision on the way in, so it is
 * refused rather than trusted.
 */
export function sunFromJson(v: unknown, what: string): bigint {
  if (v === undefined || v === null) return 0n
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v)
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v)
  throw new Error(`The node's ${what} (${String(v)}) is not a safe integer: precision was lost before it reached the wallet. Use a url provider, or a transport that keeps big integers as strings.`)
}

/** A sun amount for a node JSON body, which carries numbers: refused above 2^53 − 1 instead of rounded. */
export function sunToJson(v: bigint, what: string): number {
  if (v < 0n || v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`The ${what} ${v} sun is too large for the node's JSON API (above 2^53 − 1, a safe integer).`)
  return Number(v.toString())
}
