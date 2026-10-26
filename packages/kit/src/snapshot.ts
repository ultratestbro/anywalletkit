/**
 * A deep copy of a write's arguments, taken once before the policies look at them (round 3, M2).
 * The rules, `confirm` and the signature all work from copies, so a getter that answers
 * differently on a later read, a `confirm` hook that edits what it was shown, or a timer that
 * edits the caller's object during an await cannot change what gets signed after it was judged.
 *
 * - Accessors are read once into plain values; functions are kept as they are.
 * - Typed arrays (a Node `Buffer` stays a `Buffer`), `ArrayBuffer`, `Date`, `Map` and `Set` are
 *   copied. Arrays and objects keep their prototype (a class instance such as a TON `Cell` stays
 *   usable) and their frozen / sealed state; cycles stay cycles.
 * - A class that keeps its state in `#private` fields does not survive the copy: its methods
 *   throw, so the write fails instead of signing something unchecked. Promises, weak collections
 *   and regular expressions are kept by reference (nothing a chain package signs).
 */
export function snapshot<T>(value: T): T {
  return copy(value, new Map()) as T
}

const TYPED_ARRAY_SLICE = (Object.getPrototypeOf(Uint8Array.prototype) as { slice: (this: ArrayBufferView) => ArrayBufferView }).slice

function copy(v: unknown, seen: Map<object, unknown>): unknown {
  if (typeof v !== 'object' || v === null) return v // primitives, bigints, functions
  if (seen.has(v)) return seen.get(v)
  let out: object
  if (ArrayBuffer.isView(v)) {
    out = v instanceof DataView ? new DataView(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)) : TYPED_ARRAY_SLICE.call(v)
    seen.set(v, out)
    return out
  }
  if (v instanceof ArrayBuffer) { out = v.slice(0); seen.set(v, out); return out }
  if (v instanceof Date) { out = new Date(v.getTime()); seen.set(v, out); return out }
  if (v instanceof Promise || v instanceof WeakMap || v instanceof WeakSet || v instanceof RegExp) return v
  if (v instanceof Map) {
    const m = new Map()
    seen.set(v, m)
    for (const [k, x] of v) m.set(copy(k, seen), copy(x, seen))
    return m
  }
  if (v instanceof Set) {
    const s = new Set()
    seen.set(v, s)
    for (const x of v) s.add(copy(x, seen))
    return s
  }
  const proto = Object.getPrototypeOf(v) as object | null
  out = Array.isArray(v) ? (proto === Array.prototype ? [] : Object.setPrototypeOf([], proto)) : Object.create(proto)
  seen.set(v, out)
  for (const key of Reflect.ownKeys(v)) {
    if (Array.isArray(v) && key === 'length') continue
    const d = Reflect.getOwnPropertyDescriptor(v, key)
    if (!d) continue
    // An accessor is read once, on the original, and becomes a plain value.
    const value = 'value' in d ? d.value : d.get ? d.get.call(v) : undefined
    Object.defineProperty(out, key, { value: copy(value, seen), writable: d.writable ?? true, enumerable: d.enumerable ?? true, configurable: d.configurable ?? true })
  }
  if (Array.isArray(v)) (out as unknown[]).length = v.length
  if (Object.isFrozen(v)) Object.freeze(out)
  else if (Object.isSealed(v)) Object.seal(out)
  else if (!Object.isExtensible(v)) Object.preventExtensions(out)
  return out
}
