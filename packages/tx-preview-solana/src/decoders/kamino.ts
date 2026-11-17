import type { InstructionDecoder } from '../types.js'

export const KAMINO_LEND_PROGRAM = 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD'

/** TODO: decoder in progress. */
export const kaminoLendDecoder: InstructionDecoder = {
  programAddress: KAMINO_LEND_PROGRAM,
  programName: 'Kamino Lend',
  decode: () => null,
}
