// The id claimSwap2 returns for a claim the destination account saw succeed ends in `.ok`; it parses,
// and anything else in that place does not.
import { describe, expect, it } from 'vitest'
import { parseSwapId } from '../src/index.js'

describe('parseSwapId reads the confirmed-claim segment', () => {
  it('`.ok` after the claim hash is destTxConfirmed; the bare-hash id is unchanged', () => {
    expect(parseSwapId('awk1.cctp.42.0xsrc.0xclaim.ok')).toEqual({ provider: 'cctp', intentId: '42', sourceTxHash: '0xsrc', destTxHash: '0xclaim', destTxConfirmed: true })
    expect(parseSwapId('awk1.cctp.42.0xsrc.0xclaim')).toEqual({ provider: 'cctp', intentId: '42', sourceTxHash: '0xsrc', destTxHash: '0xclaim' })
  })
  it('another word, a sixth segment or no claim hash before it: not a swap id', () => {
    expect(parseSwapId('awk1.cctp.42.0xsrc.0xclaim.yes')).toBeNull()
    expect(parseSwapId('awk1.cctp.42.0xsrc.0xclaim.ok.ok')).toBeNull()
    expect(parseSwapId('awk1.cctp.42.0xsrc..ok')).toBeNull()
  })
})
