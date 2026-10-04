// Stand-in for react-native-fast-pbkdf2 (only used by @ton/crypto mnemonic
// helpers, which the SDK never calls — BIP-39 lives in @forgewallet/core).
export default { derive: async () => { throw new Error('pbkdf2 is not used by the smoke') } }
