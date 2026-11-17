import { jupiterDecoder } from './decoders/jupiter.js'
import { kaminoLendDecoder } from './decoders/kamino.js'
import { memoV1Decoder, memoV2Decoder } from './decoders/memo.js'
import { officialDecoders } from './decoders/official.js'
import { stakePoolDecoder } from './decoders/stake-pool.js'
import { DecoderRegistry } from './registry.js'
import type { InstructionDecoder } from './types.js'

/** Every decoder this package ships. */
export const defaultDecoders: readonly InstructionDecoder[] = [
  ...officialDecoders,
  memoV2Decoder,
  memoV1Decoder,
  stakePoolDecoder,
  jupiterDecoder,
  kaminoLendDecoder,
]

/** The registry {@link decodeTransaction} uses unless told otherwise. Extend it with `defaultRegistry.with([...])`. */
export const defaultRegistry: DecoderRegistry = new DecoderRegistry(defaultDecoders)
