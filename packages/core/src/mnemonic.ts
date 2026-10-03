import { generateMnemonic, mnemonicToSeed, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'

/** Normalise user input: trim, collapse whitespace, lowercase. */
export function normalizeMnemonic(mnemonic: string): string {
  return mnemonic.trim().toLowerCase().split(/\s+/).join(' ')
}

export function getRandomSeedPhrase(words: 12 | 24 = 24): string {
  return generateMnemonic(wordlist, words === 24 ? 256 : 128)
}

export function isValidSeedPhrase(mnemonic: string): boolean {
  return validateMnemonic(normalizeMnemonic(mnemonic), wordlist)
}

/** BIP-39 seed (64 bytes). Empty passphrase. */
export async function seedFromMnemonic(mnemonic: string, passphrase = ''): Promise<Uint8Array> {
  return mnemonicToSeed(normalizeMnemonic(mnemonic), passphrase)
}

export function seedFromMnemonicSync(mnemonic: string, passphrase = ''): Uint8Array {
  return mnemonicToSeedSync(normalizeMnemonic(mnemonic), passphrase)
}

/** Overwrite a key buffer. Call from every `dispose()`. */
export function zeroize(...buffers: Array<Uint8Array | undefined>): void {
  for (const b of buffers) b?.fill(0)
}
