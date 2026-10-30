/**
 * A deep copy of a write's arguments, taken once before the policies look at them (round 3, M2).
 * The rules, `confirm` and the signature all work from copies, so a getter that answers
 * differently on a later read, a `confirm` hook that edits what it was shown, or a timer that
 * edits the caller's object during an await cannot change what gets signed after it was judged.
 *
 * - Accessors are read once into plain values; functions are kept as they are. What an object inherits
 *   from a custom prototype (data and accessors, not methods) is read once too and becomes the copy's
 *   own value; a prototype that has no methods is not kept at all. A prototype with methods is kept (so
 *   `instanceof` holds), but the copy answers only with the methods it had then: a field or method added
 *   to the prototype later, or a method replaced, is not seen (reaudit 2026-10-30, #4).
 * - Typed arrays (a Node `Buffer` stays a `Buffer`), `ArrayBuffer`, `Date`, `Map` and `Set` are
 *   copied. Arrays and objects keep a prototype with methods (a class instance such as a TON `Cell` stays
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
  let proto = Object.getPrototypeOf(v) as object | null
  const plain = proto === null || proto === Object.prototype || proto === Array.prototype
  // A custom prototype: what it carries besides methods is read once, below (scan 2026-10-30 F15).
  const inherited = plain ? { list: [], methods: false, fns: new Map<string | symbol, unknown>() } : inheritedData(v, proto!)
  // A prototype with no methods is only data (`Object.create({ to })`): the copy drops it, so a field
  // added to it later is not read either. A class keeps its prototype, and with it its methods.
  if (!plain && !inherited.methods) proto = Array.isArray(v) ? Array.prototype : Object.prototype
  out = Array.isArray(v) ? (proto === Array.prototype ? [] : Object.setPrototypeOf([], proto)) : Object.create(proto)
  // The copy's own keys are filled in below; what it inherits is fixed to the methods captured now.
  const result = !plain && inherited.methods ? captured(out, inherited.fns, Array.isArray(v) ? Array.prototype : Object.prototype) : out
  seen.set(v, result)
  for (const key of Reflect.ownKeys(v)) {
    if (Array.isArray(v) && key === 'length') continue
    const d = Reflect.getOwnPropertyDescriptor(v, key)
    if (!d) continue
    // An accessor is read once, on the original, and becomes a plain value.
    const value = 'value' in d ? d.value : d.get ? d.get.call(v) : undefined
    Object.defineProperty(out, key, { value: copy(value, seen), writable: d.writable ?? true, enumerable: d.enumerable ?? true, configurable: d.configurable ?? true })
  }
  for (const { key, value, enumerable } of inherited.list) {
    Object.defineProperty(out, key, { value: copy(value, seen), writable: true, enumerable, configurable: true })
  }
  if (Array.isArray(v)) (out as unknown[]).length = v.length
  if (Object.isFrozen(v)) Object.freeze(out)
  else if (Object.isSealed(v)) Object.seal(out)
  else if (!Object.isExtensible(v)) Object.preventExtensions(out)
  return result
}

const hasOwn = (o: object, k: string | symbol) => Object.prototype.hasOwnProperty.call(o, k)

/**
 * `out` (which keeps its class prototype) seen through the prototype chain as it was at snapshot time: an own key
 * answers as itself, an inherited name only with the method captured then, anything else from the plain base
 * (`Object.prototype` / `Array.prototype`). A write lands on the copy, never on a setter added to the prototype.
 */
function captured(out: object, fns: Map<string | symbol, unknown>, base: object): object {
  return new Proxy(out, {
    get: (t, k, r) => (hasOwn(t, k) ? Reflect.get(t, k, r) : fns.has(k) ? fns.get(k) : Reflect.get(base, k, r)),
    has: (t, k) => hasOwn(t, k) || fns.has(k) || k in base,
    set: (t, k, val) => {
      if (hasOwn(t, k)) return Reflect.set(t, k, val)
      return Object.isExtensible(t) && Reflect.defineProperty(t, k, { value: val, writable: true, enumerable: true, configurable: true })
    },
  })
}

/**
 * What `v` inherits from a custom prototype chain (up to `Object.prototype` / `Array.prototype`), read once:
 * every data value that is not a function, and every accessor's answer (read on `v`), nearest first and
 * not shadowed by an own key. They become own values of the copy, so a prototype edited during an await or a
 * getter that answers differently later cannot change what gets signed. `methods`: the chain has functions;
 * `fns`: those functions, nearest first, as they are now.
 */
function inheritedData(v: object, proto: object): { list: Array<{ key: string | symbol; value: unknown; enumerable: boolean }>; methods: boolean; fns: Map<string | symbol, unknown> } {
  const list: Array<{ key: string | symbol; value: unknown; enumerable: boolean }> = []
  const fns = new Map<string | symbol, unknown>()
  const done = new Set<string | symbol>(Reflect.ownKeys(v))
  let methods = false
  for (let p: object | null = proto; p !== null && p !== Object.prototype && p !== Array.prototype; p = Object.getPrototypeOf(p) as object | null) {
    for (const key of Reflect.ownKeys(p)) {
      const d = Reflect.getOwnPropertyDescriptor(p, key)
      if (!d) continue
      if (done.has(key)) { if ('value' in d && typeof d.value === 'function') methods = true; continue }
      done.add(key)
      if ('value' in d && typeof d.value === 'function') { methods = true; fns.set(key, d.value); continue } // methods (and `constructor`), as they are now
      list.push({ key, value: 'value' in d ? d.value : d.get ? d.get.call(v) : undefined, enumerable: d.enumerable ?? false })
    }
  }
  return { list, methods, fns }
}
