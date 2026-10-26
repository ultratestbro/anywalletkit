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

/** A kVault's shares mint: `["shares", vault]` under the kVault program. */
export function vaultSharesMint(vault: string, kvaultProgram: string): string {
  return findProgramAddress([new TextEncoder().encode('shares'), base58.decode(vault)], kvaultProgram)
}
