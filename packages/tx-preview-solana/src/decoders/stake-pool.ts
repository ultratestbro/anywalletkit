import type { InstructionDecoder } from '../types.js'

export const SPL_STAKE_POOL_PROGRAM = 'SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy'

/** TODO: decoder in progress. */
export const stakePoolDecoder: InstructionDecoder = {
  programAddress: SPL_STAKE_POOL_PROGRAM,
  programName: 'SPL Stake Pool',
  decode: () => null,
}
