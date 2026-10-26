// base64 for the JSON envelopes — `btoa`/`atob` exist in every extension context (service worker included).

export function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export function fromBase64(text: string): Uint8Array {
  const s = atob(text)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

export const utf8 = {
  encode: (text: string): Uint8Array => new TextEncoder().encode(text),
  decode: (bytes: Uint8Array): string => new TextDecoder().decode(bytes),
}

/** Copy into a fresh ArrayBuffer — WebCrypto rejects views over shared / offset buffers in some engines. */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

/**
 * {@link toArrayBuffer} for a secret (a key, a password, a plaintext): `fn` gets the copy, which is
 * zero-filled afterwards whatever happens. WebCrypto copies its input when called, so wiping after
 * the returned promise settles is safe.
 */
export async function withSecretBuffer<T>(bytes: Uint8Array, fn: (buffer: ArrayBuffer) => Promise<T>): Promise<T> {
  const buffer = toArrayBuffer(bytes)
  try {
    return await fn(buffer)
  } finally {
    new Uint8Array(buffer).fill(0)
  }
}
