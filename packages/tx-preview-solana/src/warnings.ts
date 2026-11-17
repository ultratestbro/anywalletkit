import { ADDRESS_LOOKUP_TABLE_PROGRAM, STAKE_PROGRAM, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from './decoders/official.js'
import type { DecodedInstruction, DecodedTransaction, PreviewWarning } from './types.js'

/** Largest u64: a token approval of this amount is unlimited. */
export const MAX_U64 = 0xffffffffffffffffn

const isToken = (p: string) => p === TOKEN_PROGRAM || p === TOKEN_2022_PROGRAM
const account = (ix: DecodedInstruction, name: string) => ix.accounts.find((a) => a.name === name)?.address ?? null

/**
 * The facts a review screen shows about a decoded transaction. They describe; they do not judge (the verdict is a
 * separate layer). Each code appears once per instruction it is about.
 */
export function collectWarnings(tx: Omit<DecodedTransaction, 'warnings'>, signer?: string): PreviewWarning[] {
  const out: PreviewWarning[] = []
  const add = (code: PreviewWarning['code'], message: string, instruction?: number) => out.push({ code, message, ...(instruction !== undefined ? { instruction } : {}) })

  const unresolved = tx.lookupTables.filter((t) => !t.resolved).map((t) => t.address)
  if (unresolved.length) add('unresolved-lookup-tables', `Accounts from lookup table${unresolved.length > 1 ? 's' : ''} ${unresolved.join(', ')} are not resolved: those accounts are unknown.`)
  if (signer && tx.feePayer && tx.feePayer !== signer) add('foreign-fee-payer', `The fee payer is ${tx.feePayer}, not ${signer}.`)
  const missing = tx.signers.filter((s) => s.signed === false && s.address !== signer).map((s) => s.address)
  if (missing.length) add('missing-signers', `Still needs signatures from ${missing.join(', ')}.`)
  if (tx.lifetime.kind === 'durable-nonce') add('durable-nonce', 'Uses a durable nonce: the signature does not expire and can be broadcast at any later time, until the nonce advances.')

  for (const ix of tx.instructions) {
    const i = ix.index
    if (!ix.programName) { add('unknown-program', `Instruction ${i} calls ${ix.programAddress}, a program with no decoder: shown as raw accounts and data.`, i); continue }
    if (!ix.decoded) { add('undecoded-instruction', `Instruction ${i} for ${ix.programName} did not decode${ix.error ? ` (${ix.error})` : ''}.`, i); continue }
    const p = ix.programAddress
    if (isToken(p)) {
      if (ix.name === 'SetAuthority') add('sets-authority', `Changes an authority of ${account(ix, 'owned') ?? 'a token account or mint'}.`, i)
      if (ix.name === 'CloseAccount') add('closes-account', `Closes token account ${account(ix, 'account') ?? ''}; its rent goes to ${account(ix, 'destination') ?? 'another account'}.`.replace(' ;', ';'), i)
      if (ix.name === 'Approve' || ix.name === 'ApproveChecked') {
        add('approves-delegate', `Lets ${account(ix, 'delegate') ?? 'a delegate'} spend from ${account(ix, 'source') ?? 'a token account'}.`, i)
        if (ix.args.amount === MAX_U64) add('unlimited-approve', 'The approval is for an unlimited amount.', i)
      }
      if ((ix.name === 'Transfer' || ix.name === 'TransferChecked' || ix.name === 'TransferCheckedWithFee') && account(ix, 'destination') === SYSTEM_PROGRAM) {
        add('burn-address', 'A token transfer targets the all-zero address: the tokens are lost.', i)
      }
    }
    if (p === SYSTEM_PROGRAM) {
      if (ix.name === 'TransferSol' && account(ix, 'destination') === SYSTEM_PROGRAM) add('burn-address', 'A SOL transfer targets the all-zero address: the SOL is lost.', i)
      if (ix.name === 'Assign' || ix.name === 'AssignWithSeed') add('sets-authority', `Hands account ${account(ix, 'account') ?? ''} over to program ${String(ix.args.programAddress ?? '')}.`, i)
    }
    if (p === STAKE_PROGRAM && typeof ix.name === 'string' && ix.name.startsWith('Authorize')) add('sets-authority', `Changes the ${String(ix.args.stakeAuthorize ?? 'stake')} authority of stake account ${account(ix, 'stake') ?? ''}.`, i)
    if (p === ADDRESS_LOOKUP_TABLE_PROGRAM && ix.name === 'CloseLookupTable') add('closes-account', 'Closes an address lookup table.', i)
  }
  return out
}
