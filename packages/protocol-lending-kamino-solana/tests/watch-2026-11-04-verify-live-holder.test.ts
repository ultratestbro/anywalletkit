// Watch 2026-11-04: the live check's default USDC holder had its main USDC account frozen, so the
// first simulated deposit died in the Token program ("Account is frozen", 0x11) and read like a Kamino
// breakage. The script now reads the holder's USDC account first and names a frozen one.
import { base58 } from '@scure/base'
import { describe, expect, it } from 'vitest'
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM, decodeTokenAccount, holderProblem, readTokenAccount } from '../scripts/holder.mjs'
import { associatedTokenAddress } from '../src/pda.js'
import { USDC } from './fixture.js'

const OWNER = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9'
const OTHER = 'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS'
const RPC = 'https://rpc.test'

/** An SPL token account: mint, owner, amount, no delegate, the given AccountState byte. */
function tokenAccountBytes(mint: string, owner: string, amount: bigint, state: number): Uint8Array {
  const d = new Uint8Array(165)
  d.set(base58.decode(mint), 0)
  d.set(base58.decode(owner), 32)
  new DataView(d.buffer).setBigUint64(64, amount, true)
  d[108] = state
  return d
}

function rpcReturning(value: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value } }), { status })) as typeof fetch
}
const b64 = (d: Uint8Array) => Buffer.from(d).toString('base64')

describe('verify-live holder check (watch 2026-11-04)', () => {
  it('reads state and amount at the SPL offsets, for classic Token and Token-2022', () => {
    expect(decodeTokenAccount(TOKEN_PROGRAM, tokenAccountBytes(USDC, OWNER, 1_972_502_781_730n, 2), USDC, OWNER)).toEqual({ state: 'frozen', amount: 1_972_502_781_730n })
    expect(decodeTokenAccount(TOKEN_2022_PROGRAM, tokenAccountBytes(USDC, OWNER, 5n, 1), USDC, OWNER)).toEqual({ state: 'initialized', amount: 5n })
  })

  it('refuses what is not this owner\'s account of this mint', () => {
    expect(() => decodeTokenAccount('11111111111111111111111111111111', tokenAccountBytes(USDC, OWNER, 1n, 1), USDC, OWNER)).toThrow(/Not a token account/)
    expect(() => decodeTokenAccount(TOKEN_PROGRAM, tokenAccountBytes(USDC, OWNER, 1n, 1).subarray(0, 120), USDC, OWNER)).toThrow(/120 bytes/)
    expect(() => decodeTokenAccount(TOKEN_PROGRAM, tokenAccountBytes(USDC, OTHER, 1n, 1), USDC, OWNER)).toThrow(/another owner/)
    expect(() => decodeTokenAccount(TOKEN_PROGRAM, tokenAccountBytes(OTHER, OWNER, 1n, 1), USDC, OWNER)).toThrow(/another mint/)
    expect(() => decodeTokenAccount(TOKEN_PROGRAM, tokenAccountBytes(USDC, OWNER, 1n, 7), USDC, OWNER)).toThrow(/Unknown token account state 7/)
  })

  it('reads the account over RPC; a missing one is a zero balance, not an error', async () => {
    const ata = associatedTokenAddress(OWNER, USDC, TOKEN_PROGRAM)
    expect(await readTokenAccount(RPC, ata, USDC, OWNER, rpcReturning(null))).toEqual({ state: 'missing', amount: 0n })
    const frozen = { owner: TOKEN_PROGRAM, lamports: 2039280, data: [b64(tokenAccountBytes(USDC, OWNER, 9n, 2)), 'base64'] }
    expect(await readTokenAccount(RPC, ata, USDC, OWNER, rpcReturning(frozen))).toEqual({ state: 'frozen', amount: 9n })
    await expect(readTokenAccount(RPC, ata, USDC, OWNER, rpcReturning(null, 429))).rejects.toThrow(/HTTP 429/)
    const failing = (async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid param' } }))) as typeof fetch
    await expect(readTokenAccount(RPC, ata, USDC, OWNER, failing)).rejects.toThrow(/Invalid param/)
  })

  it('names a frozen holder instead of letting the simulation fail', () => {
    const at = { address: OWNER, tokenAccount: 'FzbcyEZ9m8xjtergWgWDq7mfPoHEbboBF791B6cTpzbq', symbol: 'USDC' }
    expect(holderProblem({ state: 'frozen', amount: 1n }, at)).toBe(`holder's USDC account is frozen, pass another address (${OWNER}, token account ${at.tokenAccount})`)
    expect(holderProblem({ state: 'uninitialized', amount: 0n }, at)).toMatch(/not initialized, pass another address/)
    expect(holderProblem({ state: 'initialized', amount: 1n }, at)).toBeNull()
    expect(holderProblem({ state: 'missing', amount: 0n }, at)).toBeNull()
  })
})
