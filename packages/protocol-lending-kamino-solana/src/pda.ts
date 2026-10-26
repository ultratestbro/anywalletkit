// Program-derived addresses, computed here so an API answer can be checked against what the
// program itself would derive (a kVault's shares mint is `["shares", vault]` under the kVault program).
import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { base58 } from '@scure/base'

const PDA_MARKER = new TextEncoder().encode('ProgramDerivedAddress')

/** `findProgramAddress`: the first off-curve `sha256(seeds ‖ bump ‖ program ‖ "ProgramDerivedAddress")`, bump 255 → 0. */
export function findProgramAddress(seeds: readonly Uint8Array[], programId: string): string {
  const program = base58.decode(programId)
  for (let bump = 255; bump >= 0; bump--) {
    const parts = [...seeds, Uint8Array.of(bump), program, PDA_MARKER]
    const buf = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
    let o = 0
    for (const p of parts) { buf.set(p, o); o += p.length }
    const hash = sha256(buf)
    try { ed25519.Point.fromBytes(hash) } catch { return base58.encode(hash) }
  }
  throw new Error('No program address found for these seeds.')
}

/**
 * The vanilla (plain lending) obligation of `user` in `market`: `[tag 0, id 0, user, market,
 * default key, default key]` under klend — the one `/ktx/klend/*` deposits go through. Other
 * obligation kinds (Multiply, Leverage…) live at other addresses.
 */
export function vanillaObligation(user: string, market: string, klendProgram = 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD'): string {
  const zero = new Uint8Array(32)
  return findProgramAddress([Uint8Array.of(0), Uint8Array.of(0), base58.decode(user), base58.decode(market), zero, zero], klendProgram)
}

/** A kVault's shares mint: `["shares", vault]` under the kVault program. */
export function vaultSharesMint(vault: string, kvaultProgram: string): string {
  return findProgramAddress([new TextEncoder().encode('shares'), base58.decode(vault)], kvaultProgram)
}
