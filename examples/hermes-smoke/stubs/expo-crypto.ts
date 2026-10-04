// Stand-in for expo-crypto, which @ton/crypto-primitives' react-native build
// requires at module load. A real RN app has the native module; the smoke only
// needs the shape. getRandomValues comes from shim-globals (test-only source).
export function getRandomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n)
  globalThis.crypto.getRandomValues(out)
  return out
}
export default { getRandomBytes }
