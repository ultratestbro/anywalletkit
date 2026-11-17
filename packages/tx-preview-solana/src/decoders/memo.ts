import type { InstructionDecoder } from '../types.js'
import { utf8ToString } from '../values.js'

/** SPL Memo v2 and v1: the data is the memo text (UTF-8); the accounts, if any, are signers that vouch for it. */
export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
export const MEMO_V1_PROGRAM = 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo'

function memoDecoder(programAddress: string, programName: string): InstructionDecoder {
  return {
    programAddress,
    programName,
    // Own UTF-8 reading: no TextDecoder needed under Hermes.
    decode: (ix) => ({ name: 'Memo', args: { text: utf8ToString(ix.data) }, accountNames: ix.accounts.map(() => 'signer') }),
  }
}

export const memoV2Decoder = memoDecoder(MEMO_PROGRAM, 'Memo Program')
export const memoV1Decoder = memoDecoder(MEMO_V1_PROGRAM, 'Memo Program v1')
