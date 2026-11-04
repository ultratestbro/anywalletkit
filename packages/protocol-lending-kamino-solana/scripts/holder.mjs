// The live check's holder accounts, read before anything is simulated: a frozen token account makes
// every simulated transfer fail inside the Token program ("Account is frozen", custom error 0x11),
// which reads like a Kamino breakage but is the address's state (watch 2026-11-04).
import { base58 } from '@scure/base'

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
/** SPL `AccountState` at byte 108 of a token account (mint 0, owner 32, amount 64, delegate 72..108). */
const STATES = ['uninitialized', 'initialized', 'frozen']

/**
 * A token account's state and amount from its program owner and data. Anything that is not an
 * SPL / Token-2022 account of `mint` held by `owner` is refused, never read as a balance.
 */
export function decodeTokenAccount(programOwner, data, mint, owner) {
  if (programOwner !== TOKEN_PROGRAM && programOwner !== TOKEN_2022_PROGRAM) throw new Error(`Not a token account: owned by ${programOwner}.`)
  if (data.length < 165) throw new Error(`Not a token account: ${data.length} bytes.`)
  if (base58.encode(data.subarray(0, 32)) !== mint) throw new Error(`Token account holds another mint, not ${mint}.`)
  if (base58.encode(data.subarray(32, 64)) !== owner) throw new Error(`Token account belongs to another owner, not ${owner}.`)
  const state = STATES[data[108]]
  if (!state) throw new Error(`Unknown token account state ${data[108]}.`)
  return { state, amount: new DataView(data.buffer, data.byteOffset + 64, 8).getBigUint64(0, true) }
}

/** `{ state: 'missing' }` when the account does not exist, else its decoded state and amount. */
export async function readTokenAccount(rpcUrl, account, mint, owner, fetchImpl = fetch) {
  const res = await fetchImpl(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [account, { encoding: 'base64', commitment: 'confirmed' }] }),
  })
  if (!res.ok) throw new Error(`getAccountInfo ${account}: HTTP ${res.status}.`)
  const body = await res.json()
  if (body.error) throw new Error(`getAccountInfo ${account}: ${body.error.message ?? JSON.stringify(body.error)}`)
  const value = body.result?.value
  if (!value) return { state: 'missing', amount: 0n }
  return decodeTokenAccount(value.owner, Uint8Array.from(Buffer.from(value.data[0], 'base64')), mint, owner)
}

/**
 * Why the holder cannot back a simulation, or null when it can. A missing account is not a problem:
 * the holder then has no USDC, so the deposit steps skip themselves, and a withdraw's transaction
 * creates the account it pays into.
 */
export function holderProblem(account, { address, tokenAccount, symbol }) {
  if (account.state === 'frozen') return `holder's ${symbol} account is frozen, pass another address (${address}, token account ${tokenAccount})`
  if (account.state === 'uninitialized') return `holder's ${symbol} account is not initialized, pass another address (${address}, token account ${tokenAccount})`
  return null
}
