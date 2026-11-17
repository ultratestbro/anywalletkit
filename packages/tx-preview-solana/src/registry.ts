import type { InstructionDecoder } from './types.js'

/**
 * Which decoder reads which program. One decoder per program address; registering a second one for the same program
 * throws unless `replace` is set, so a protocol's decoder never silently shadows a built-in.
 */
export class DecoderRegistry {
  private readonly byProgram = new Map<string, InstructionDecoder>()

  constructor(decoders: readonly InstructionDecoder[] = []) {
    for (const d of decoders) this.register(d)
  }

  register(decoder: InstructionDecoder, options: { replace?: boolean } = {}): this {
    if (!decoder || typeof decoder.programAddress !== 'string' || typeof decoder.decode !== 'function') throw new TypeError('tx-preview-solana: a decoder needs a programAddress and a decode function')
    if (this.byProgram.has(decoder.programAddress) && !options.replace) {
      throw new Error(`tx-preview-solana: a decoder for ${decoder.programAddress} is already registered (pass { replace: true } to swap it)`)
    }
    this.byProgram.set(decoder.programAddress, decoder)
    return this
  }

  get(programAddress: string): InstructionDecoder | undefined {
    return this.byProgram.get(programAddress)
  }

  has(programAddress: string): boolean {
    return this.byProgram.has(programAddress)
  }

  /** A copy with more decoders: the defaults stay as they are. */
  with(decoders: readonly InstructionDecoder[], options: { replace?: boolean } = {}): DecoderRegistry {
    const next = new DecoderRegistry([...this.byProgram.values()])
    for (const d of decoders) next.register(d, options)
    return next
  }

  get decoders(): readonly InstructionDecoder[] {
    return [...this.byProgram.values()]
  }
}
