import { generateMnemonic, mnemonicToSeed, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'

/** Normalise user input: trim, collapse whitespace, lowercase. */
export function normalizeMnemonic(mnemonic: string): string {
  return mnemonic.trim().toLowerCase().split(/\s+/).join(' ')
}

/**
 * A new BIP-39 English seed phrase from the platform's secure random source: 24 words (256 bits) by
 * default, or 12.
 */
export function getRandomSeedPhrase(words: 12 | 24 = 24): string {
  return generateMnemonic(wordlist, words === 24 ? 256 : 128)
}

/**
 * True when the phrase is valid BIP-39 English (known words, right length, checksum). Input is
 * normalised first, so extra spaces and capitals are fine.
 */
export function isValidSeedPhrase(mnemonic: string): boolean {
  return validateMnemonic(normalizeMnemonic(mnemonic), wordlist)
}

/** BIP-39 seed (64 bytes). Empty passphrase. */
export async function seedFromMnemonic(mnemonic: string, passphrase = ''): Promise<Uint8Array> {
  return mnemonicToSeed(normalizeMnemonic(mnemonic), passphrase)
}

/**
 * The 64-byte BIP-39 seed, computed synchronously. Blocks the thread for the PBKDF2 rounds; prefer
 * {@link seedFromMnemonic} on a UI thread. The caller owns the bytes and should {@link zeroize}
 * them.
 */
export function seedFromMnemonicSync(mnemonic: string, passphrase = ''): Uint8Array {
  return mnemonicToSeedSync(normalizeMnemonic(mnemonic), passphrase)
}

/** Overwrite a key buffer. Call from every `dispose()`. */
export function zeroize(...buffers: Array<Uint8Array | undefined>): void {
  for (const b of buffers) b?.fill(0)
}
