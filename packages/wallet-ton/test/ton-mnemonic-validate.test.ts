import { describe, expect, it } from 'vitest'
import { mnemonicNew, mnemonicValidate } from '@ton/crypto'
import { WalletManagerTon } from '../src/index.js'

// Audit 2026-10-25 round 3, L3: fromTonMnemonic took any 24 words. A typo (or a BIP-39 phrase pasted
// into the TON-mnemonic import) derived another, empty wallet instead of failing. TON mnemonics
// carry their own check (@ton/crypto mnemonicValidate): a phrase that fails it is refused.
describe('fromTonMnemonic validates the phrase', () => {
  it('a valid TON mnemonic imports; one changed word, or a BIP-39 phrase, is refused', async () => {
    const words = await mnemonicNew(24)
    const m = await WalletManagerTon.fromTonMnemonic(words)
    expect(await (await m.getAccount()).getAddress()).toMatch(/^UQ/)
    m.dispose()
    // one word swapped (a word list neighbour that happens to pass the check, ~1 in 256, is skipped)
    let typo = [...words]
    for (const w of ['abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract']) {
      typo = [...words]; typo[5] = w
      if (w !== words[5] && !(await mnemonicValidate(typo))) break
    }
    await expect(WalletManagerTon.fromTonMnemonic(typo)).rejects.toThrow(/not a valid TON mnemonic/i)
    await expect(WalletManagerTon.fromTonMnemonic(`${'abandon '.repeat(23)}art`)).rejects.toThrow(/not a valid TON mnemonic/i)
  })
})
