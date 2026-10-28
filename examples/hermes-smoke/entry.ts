/**
 * Hermes smoke: derive + sign on every chain the way the SDK does, inside the
 * Hermes VM (no Node, no browser APIs). Checks derivation/signing vectors and
  // names-ens: ENSIP-15 normalization, warnings and record decoding run offline in the VM (no RPC calls).
  {
    const ens = ensResolver({ rpcUrl: 'http://127.0.0.1:1' })
    eq('ens supports .eth', ens.supports('Vitalik.ETH'), true)
    eq('ens supports cb.id', ens.supports('alice.cb.id'), true)
    eq('ens leaves .sol', ens.supports('alice.sol'), false)
    eq('ens rejects address', ens.supports('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'), false)
    eq('ens rejects mixed script', ens.supports('p\u0430ypal.eth'), false)
    eq('isNameLike', isNameLike('vitalik.eth') && !isNameLike('0xabc'), true)
    eq('warn confusable', warningsFor('\u0441\u043e\u0441\u043e.eth')[0]?.code, 'confusable')
    eq('warn punycode', warningsFor('xn--80ak6aa92e.eth')[0]?.code, 'punycode')
    eq('warn none', warningsFor('vitalik.eth').length, 0)
    eq('coinType base', coinTypeFor('eip155:8453'), 2147492101n)
    eq('coinType sol', coinTypeFor('solana:mainnet'), 501n)
    const h20 = Uint8Array.from('751e76e8199196d454941c45d1b3a323f1433bd6'.match(/.{2}/g)!, (b) => parseInt(b, 16))
    eq('btc p2wpkh', decodeBtcScript(Uint8Array.from([0x00, 0x14, ...h20]), 'x'), 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')
    eq('btc p2pkh', decodeBtcScript(Uint8Array.from([0x76, 0xa9, 0x14, ...h20, 0x88, 0xac]), 'x'), '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH')
    eq('registry', nameResolvers([ens]).supports('nick.eth'), true)
  }
 * the offline safety layers, then prints HERMES_SMOKE_OK. Bundled by run.mjs.
 */
import './shim-globals.js'
import 'fastestsmallesttextencoderdecoder/EncoderDecoderTogether.min.js'
import './shim-runtime.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { deriveEd25519, deriveSecp256k1, seedFromMnemonicSync } from '@anywalletkit/core'
import { derivationVectors } from '@anywalletkit/conformance'
import { WalletManagerEvm, WalletAccountReadOnlyEvm, describeTransaction, describeTypedData, encodeApprove } from '@anywalletkit/wallet-evm'
import { WalletManagerSolana, WalletAccountReadOnlySolana, describeTransaction as describeSolana, ZERO_ADDRESS as SOL_ZERO, classifySolanaMessage, type SolanaRpc } from '@anywalletkit/wallet-solana'
import { getApproveInstruction } from '@solana-program/token'
import { appendTransactionMessageInstructions, createNoopSigner, createTransactionMessage, pipe, setTransactionMessageFeePayer, type Address } from '@solana/kit'
import { WalletManagerTon, describeTransaction as describeTon, parseV5R1Body, v5r1SigningMessage, v5r1PackUnsigned, v5r1WalletId } from '@anywalletkit/wallet-ton'
import { beginCell, internal } from '@ton/core'
import { WalletManagerTron, describeTransaction as describeTron, ZERO_ADDRESS as TRON_ZERO } from '@anywalletkit/wallet-tron'
import { WalletManagerBtc, selectCoins, INPUT_WEIGHT } from '@anywalletkit/wallet-btc'
import { WalletManagerZcash, parseTx as parseZcashTx, txid as zcashTxid, sighashAll as zcashSighash, parseP2pkhScriptSig, conventionalFee as zcashFee, outputSize as zcashOutputSize } from '@anywalletkit/wallet-zcash'
import { WalletManagerNear, describeTransaction as describeNear, encodeTransaction as encodeNearTx, decodeTransaction as decodeNearTx, toBase64 as nearToBase64 } from '@anywalletkit/wallet-near'
import { smokeProtocols } from './protocols.js'
import fastPbkdf2 from '@anywalletkit/runtime-hermes/fast-pbkdf2'
import { sealBackup, openBackup, encodeBackup, decodeBackup, isBackupError } from '@anywalletkit/seed-vault'
import { avatarUrl, ensResolver, warningsFor, coinTypeFor, decodeBtcScript } from '@anywalletkit/names-ens'
import { isNameLike, nameResolvers } from '@anywalletkit/core'
import { TOKEN_SYMBOL_MAX, TokensTable, assessToken, foldSymbol, inspectToken, memoryJsonStorage as tokensStorage, tokenText, type TokensState } from '@anywalletkit/tokens'
import { isTokenAddress, resolveAsset } from '@anywalletkit/swap2-assets'
import { NetworksTable, memoryJsonStorage, parseAddChainParams, checkRpcUrl, isPrivateHost, isPublicHttpsUrl, verifyNetwork, tonGlobalIdFromBoc, BUILTIN_NETWORKS, DEFAULT_TESTNETS, isAddChainError, type NetworksState } from '@anywalletkit/networks'

declare const print: ((s: string) => void) | undefined
const out = (s: string) => (typeof print === 'function' ? print(s) : console.log(s))

let checks = 0
/** Mainnet v5 transparent tx 7376c5f1… (block 3 521 984, 2026-10-18), 1 input / 2 outputs, fee 10 000. */
const ZCASH_FIXTURE_HEX = '050000800a27a7265b16a537b5bd3500e8bd350001ffb855f48b8f3b2b1e3a1e31ff8484e8465661aa23c767833c3ee24384971f07010000006a47304402207ff1a36ccaa4fc96415a6cf3d49e412483b81130e50b883744a45a48d691f02502201b3f924c82fd38c42de6b6e9f298ce9d3b30879b54c8751aba526a196596dbb201210274b1b3cfb199edbd76131532f90d28fa94d552cbbb32cde3688bffd46e866c9efeffffff02e6dc8a0d000000001976a914a51a52f9c1d6da295422655017880bb0900e696e88ac7017fa00000000001976a9147f65aa1ba1b2ef40280c0ebae761b306c1315ff688ac000000'
const eq = (what: string, a: unknown, b: unknown) => {
  if (a !== b) throw new Error(`${what}: ${String(a)} !== ${String(b)}`)
  checks++
}

async function main() {
  // runtime-hermes/fast-pbkdf2: the JS drop-in Metro resolves react-native-fast-pbkdf2 to (TON 24-word mnemonics).
  eq('fast-pbkdf2 sha-512', await fastPbkdf2.derive('d29yZA==', 'c2FsdA==', 100, 64, 'sha-512'),
    'jqyWaRVO0QAaw1rL0CiSWdeZ5jsR5HHPyI4U2wm7fiomRC8me/6+5vb4mSpqSf+9zuE1aDtRanPEkgzC8fd2jQ==') // node:crypto pbkdf2Sync
  for (const [seedName, mnemonic] of Object.entries(derivationVectors.seeds)) {
    const seed = seedFromMnemonicSync(mnemonic)
    for (const chain of ['evm', 'btc', 'tron', 'zcash'] as const) {
      for (const v of derivationVectors.vectors[chain][seedName]!.accounts) eq(`${chain} pub`, bytesToHex(deriveSecp256k1(seed, v.path).publicKey), v.publicKey)
    }
    for (const chain of ['ton', 'solana', 'near'] as const) {
      for (const v of derivationVectors.vectors[chain][seedName]!.accounts) eq(`${chain} pub`, bytesToHex(deriveEd25519(seed, v.path).publicKey), v.publicKey)
    }
    const evm = new WalletManagerEvm(mnemonic)
    for (const v of derivationVectors.vectors.evm[seedName]!.accounts) {
      const a = await evm.getAccount(v.index)
      eq('evm address', await a.getAddress(), v.address)
      eq('evm sign', await a.sign(derivationVectors.message), v.signMessage)
      const tx = derivationVectors.evmTx as Record<string, string | number>
      eq('evm signTransaction', await a.signTransaction({ ...tx, value: BigInt(tx.value!), gasLimit: BigInt(tx.gasLimit!), maxFeePerGas: BigInt(tx.maxFeePerGas!), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas!) } as never), v.signTransaction)
      eq('evm signTypedData', await a.signTypedData(derivationVectors.evmTypedData as never), v.signTypedData)
    }
    evm.dispose()
    // "What you sign" — offline decode + warnings must run under Hermes too.
    {
      const unlimited = describeTransaction({ to: '0xdAC17F958D2ee523a2206206994597C13D831ec7', data: encodeApprove('0x000000000000000000000000000000000000bEEF', 2n ** 256n - 1n), chainId: 1 }, { chainId: 1 })
      eq('evm describe kind', unlimited.kind, 'erc20-approve')
      eq('evm describe warning', unlimited.warnings.map((w) => w.code).join(','), 'approve-unlimited')
      const permit = describeTypedData({
        domain: { name: 'USD Coin', version: '2', chainId: 1, verifyingContract: '0xdAC17F958D2ee523a2206206994597C13D831ec7' },
        types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
        message: { owner: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', spender: '0x000000000000000000000000000000000000bEEF', value: 1n, nonce: 0n, deadline: 2n ** 40n },
      }, { chainId: 1, account: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266' })
      eq('evm describeTypedData kind', permit.kind, 'permit')
      eq('evm describeTypedData warnings', permit.warnings.length, 0)
    }
    const sol = new WalletManagerSolana(mnemonic)
    for (const v of derivationVectors.vectors.solana[seedName]!.accounts) {
      const a = await sol.getAccount(v.index)
      eq('solana address', await a.getAddress(), v.address)
      eq('solana sign', await a.sign(derivationVectors.message), v.signMessage)
      // scan F1/F2: a compiled legacy message naming this key as signer is refused, not signed
      const txMsg = Uint8Array.from([1, 0, 1, 2, ...a.publicKey, ...new Uint8Array(32), ...new Uint8Array(32).fill(7), 1, 1, 1, 0, 0])
      eq('solana message kind tx', classifySolanaMessage(txMsg, a.publicKey), 'transaction')
      eq('solana sign refuses tx', await a.sign(txMsg).then(() => 'signed', (e: Error) => e.name), 'MessageIsTransactionError')
      eq('solana message kind nonce', classifySolanaMessage(new Uint8Array(32).fill(0xfe), a.publicKey), 'binary')
    }
    sol.dispose()
    const ton = new WalletManagerTon(mnemonic)
    for (const v of derivationVectors.vectors.ton[seedName]!.accounts) {
      const a = await ton.getAccount(v.index)
      eq('ton address', await a.getAddress(), v.address)
      eq('ton sign', await a.sign(derivationVectors.message), v.signMessage)
    }
    ton.dispose()
    const near = new WalletManagerNear(mnemonic)
    for (const v of derivationVectors.vectors.near[seedName]!.accounts) {
      const a = await near.getAccount(v.index)
      eq('near address', await a.getAddress(), v.address)
      eq('near sign', await a.sign(derivationVectors.message), v.signMessage)
      eq('near verify', await a.verify(derivationVectors.message, v.signMessage), true)
    }
    near.dispose()
    const tron = new WalletManagerTron(mnemonic)
    for (const v of derivationVectors.vectors.tron[seedName]!.accounts) {
      const a = await tron.getAccount(v.index)
      eq('tron address', await a.getAddress(), v.address)
      eq('tron sign', await a.sign(derivationVectors.message), v.signMessage)
    }
    tron.dispose()
    const btc = new WalletManagerBtc(mnemonic, { network: 'bitcoin' })
    for (const v of derivationVectors.vectors.btc[seedName]!.accounts) {
      const a = await btc.getAccount(v.index)
      eq('btc address', await a.getAddress(), v.address)
      eq('btc sign', await a.sign(derivationVectors.message), v.signMessage)
    }
    btc.dispose()
    const zec = new WalletManagerZcash(mnemonic)
    for (const v of derivationVectors.vectors.zcash[seedName]!.accounts) {
      const a = await zec.getAccount(v.index)
      eq('zcash address', await a.getAddress(), v.address)
      eq('zcash sign', await a.sign(derivationVectors.message), v.signMessage)
    }
    zec.dispose()
  }
  // ── Safety layers, offline (one pass; seed-independent) ───────────────────
  {
    const me = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk' as Address
    const msg = pipe(createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayer(me, m),
      (m) => appendTransactionMessageInstructions([getApproveInstruction({ source: me, delegate: 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS' as Address, owner: createNoopSigner(me), amount: 0xffffffffffffffffn })], m))
    const d = describeSolana(msg as never, { account: me })
    eq('solana describe approve', d.items[0]?.type === 'token-approve' && d.warnings.some((w) => w.code === 'unlimited-approve'), true)
    const burn = describeSolana({ to: SOL_ZERO, value: 1n }, { account: me })
    eq('solana describe burn', burn.kind === 'sol-transfer' && burn.warnings[0]?.code === 'burn-address', true)
  }
  {
    const to = 'UQAockb65N9NqreZHrYfhipG94Q_gZYTBkV0mvaopLEEzOgi'
    const bodyBoc = beginCell().storeUint(0xabcdef01, 32).endCell().toBoc().toString('base64')
    const d = describeTon([{ to, value: 1n, body: 'hi' }, { to, value: 1n, bodyBoc }])
    eq('ton describe', d.items[0]!.comment === 'hi' && d.warnings.some((w) => w.code === 'non-bounceable-contract-call'), true)
    const signing = v5r1SigningMessage({ walletId: v5r1WalletId(), validUntil: 123, seqno: 9, messages: [{ message: internal({ to, value: 5n }) }] })
    const p = parseV5R1Body(v5r1PackUnsigned(signing))
    eq('ton v5r1 body', !!p && p.seqno === 9 && p.validUntil === 123 && p.messages.length === 1, true)
  }
  {
    const ap = describeTron({ contractAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', functionSelector: 'approve(address,uint256)', parameters: [{ type: 'address', value: 'TSeJkUh4Qv67VNFwY8LaAxERygNdy6NQZK' }, { type: 'uint256', value: (1n << 256n) - 1n }] })
    eq('tron describe approve', ap.kind === 'trc20-approve' && ap.warnings[0]?.code === 'unlimited-approve', true)
    {
      const ft = describeNear({ receiverId: 'usdt.tether-token.near', actions: [{ functionCall: { methodName: 'ft_transfer', args: { receiver_id: 'alice.near', amount: '1500000' }, gas: 30n * 10n ** 12n, deposit: 1n } }] })
      eq('near describe ft', ft.kind === 'ft-transfer' && ft.to === 'alice.near' && ft.amount === 1500000n, true)
      const key = describeNear({ receiverId: 'x.near', actions: [{ addKey: { publicKey: { keyType: 'ed25519', data: new Uint8Array(32) }, accessKey: { nonce: 0n, permission: { fullAccess: {} } } } }] })
      eq('near describe addKey', key.kind === 'add-key' && key.warnings.some((w) => w.code === 'full-access-key'), true)
      const tx = { signerId: 'a.near', publicKey: { keyType: 'ed25519' as const, data: new Uint8Array(32).fill(1) }, nonce: 7n, receiverId: 'b.near', blockHash: new Uint8Array(32).fill(2), actions: [{ transfer: { deposit: 10n ** 24n } }] }
      const back = decodeNearTx(encodeNearTx(tx))
      eq('near borsh round-trip', back.nonce === 7n && back.receiverId === 'b.near' && 'transfer' in back.actions[0]! && back.actions[0].transfer.deposit === 10n ** 24n, true)
      // Hermes' TextDecoder (the RN polyfill) must keep a BOM, and a BOM'd method name is refused (scan 2026-10-27 F7/F8).
      const bom = { ...tx, receiverId: 'usdt.tether-token.near', actions: [{ functionCall: { methodName: '\uFEFFft_transfer', args: { receiver_id: 'drainer.near', amount: '1' }, gas: 30n * 10n ** 12n, deposit: 1n } }] }
      const bomBack = decodeNearTx(encodeNearTx(bom)).actions[0]!
      eq('near borsh keeps a BOM', 'functionCall' in bomBack && bomBack.functionCall.methodName === '\uFEFFft_transfer', true)
      const nm = new WalletManagerNear(derivationVectors.seeds['bip39-abandon-12']!)
      const na = await nm.getAccount(0)
      let refused = ''
      try { await na.buildTransaction(nearToBase64(encodeNearTx({ ...bom, signerId: na.address, publicKey: na.publicKey }))) } catch (e) { refused = (e as { code?: string }).code ?? String(e) }
      eq('near BOM method refused', refused === 'invalid-method' || refused === 'non-canonical', true)
      nm.dispose()
    }
    const burn = describeTron({ to: TRON_ZERO, value: 1n })
    eq('tron describe zero-address', burn.kind === 'trx-transfer' && burn.warnings[0]?.code === 'zero-address', true)
  }
  {
    const tr = new WalletManagerBtc(derivationVectors.seeds['bip39-abandon-12']!, { addressType: 'p2tr' })
    eq('btc p2tr vector', await (await tr.getAccount(0)).getAddress(), 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr')
    tr.dispose()
    const sel = selectCoins({ utxos: [{ txid: 'a'.repeat(64), vout: 0, value: 100_000n, height: 1 }], targets: [{ value: 48_000n, vbytes: 31 }], feeRate: 10n, inputWeight: INPUT_WEIGHT.p2wpkh, changeVBytes: 31, changeDust: 294n })
    eq('btc coinselect fee', sel.fee, 1_410n)
  }
  {
    // Zcash v5 / ZIP-244 in the VM: a mined mainnet transaction (block 3 521 984) round-trips, its txid matches and its signature verifies for the spent output.
    const tx = parseZcashTx(ZCASH_FIXTURE_HEX)
    eq('zcash txid', zcashTxid(tx), '7376c5f1aac539eb420587007c83d864d3668a3cef7f180f21960aaaa48c37cb')
    const sig = parseP2pkhScriptSig(tx.inputs[0]!.scriptSig)!
    const spent = [{ value: 243_604_326n, script: hexToBytes('76a9143898635cac98262fce2d990ee099d45cc775173e88ac') }]
    eq('zcash zip-244 sighash verifies', secp256k1.verify(sig.signature, zcashSighash(tx, 0, spent), sig.publicKey, { prehash: false, format: 'der' }), true)
    eq('zcash zip-317 fee', zcashFee([36 + 1 + tx.inputs[0]!.scriptSig.length + 4], tx.outputs.map((o) => zcashOutputSize(o.script))), 10_000n)
  }
  // tokens a user adds: look-alike folding (no String.normalize needed), the table, the catalog helpers, and token info
  // decoded by wallet-evm (bytes32 symbol, UTF-8 by hand) and wallet-solana (USDC's mainnet mint bytes, PDA via subtle digest) over offline providers.
  {
    eq('tokens fold look-alikes', [foldSymbol('USD\u0421'), foldSymbol('\uFF35\uFF33\uFF24\uFF23'), foldSymbol('U$D\u20AE'), foldSymbol('US\u200BDC')].join(','), 'USDC,USDC,USDT,USDC')
    const fake = { address: '0x6982508145454Ce325dDbE47a25d4ec3d2311933', standard: 'erc20', decimals: 18, symbol: 'USD\u0421', name: 'x', flags: [] as never[] }
    eq('tokens impersonation is danger', assessToken(fake, 'eip155:1').level, 'danger')
    // scan 2026-10-27 modules F28/F36: what is stored is what is assessed; ASCII and accented look-alikes; another script is danger
    eq('tokens symbol cut before assessing', tokenText(`USDC${' '.repeat(124)}X`, TOKEN_SYMBOL_MAX), 'USDC')
    eq('tokens fold ascii and accents', [foldSymbol('DAl'), foldSymbol('USDl'), foldSymbol('\u00D0AI'), foldSymbol('USD\u00C7')].join(','), 'DAI,USDI,DAI,USDC')
    eq('tokens cyrillic symbol is danger', assessToken({ ...fake, symbol: '\u0420\u0415\u0420\u0415' }).risks.some((r) => r.code === 'odd-characters' && r.level === 'danger'), true)
    eq('tokens emoji symbol is a caution', assessToken({ ...fake, symbol: 'PEPE\u{1F438}' }).risks.find((r) => r.code === 'odd-characters')?.level, 'caution')
    // 2026-10-28 review: hiding controls and tag characters, more look-alike blocks (astral too), ™ a caution, fold after NFKD
    const level = (symbol: string) => assessToken({ ...fake, symbol }).risks.find((r) => r.code === 'odd-characters')?.level
    eq('tokens hiding and look-alike rules', [level('US\u0000DC'), level('US\u{E0041}DC'), level('\u216FE\u216FE'), level('USD\u{10415}'), level('\u{1F164}\u{1F162}\u{1F153}\u{1F152}'), level('PEPE\u2122'), level('\u0645\u06CC\u200C\u0634\u0648\u062F')].join(','), 'danger,danger,danger,danger,danger,caution,caution')
    eq('tokens fold sees spacing accents', foldSymbol('USDC\u00B4'), 'USDC')
    eq('tokens base58 mint check', isTokenAddress('solana:mainnet', 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263') && !isTokenAddress('solana:mainnet', '11111111111111111111111111111111'), true)
    eq('tokens catalog wins', resolveAsset('eip155:1', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', { allowUnlisted: true, decimals: 18 })?.decimals, 6)
    const word = (v: bigint) => v.toString(16).padStart(64, '0')
    const evmNode = { request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_getCode') return '0x6080'
      if (method === 'eth_getStorageAt') return '0x' + '0'.repeat(64)
      if (method === 'eth_call') {
        const sel = String((params![0] as { data: string }).data).slice(0, 10)
        if (sel === '0x313ce567') return '0x' + word(18n)
        if (sel === '0x95d89b41') return '0x' + '4d4b52'.padEnd(64, '0')                                 // bytes32 "MKR"
        if (sel === '0x06fdde03') return '0x' + word(32n) + word(3n) + 'e282ae'.padEnd(64, '0')        // string "₮"
        if (sel === '0x18160ddd') return '0x' + word(10n ** 24n)
      }
      throw new Error('offline: ' + method)
    } }
    const evmInfo = await new WalletAccountReadOnlyEvm('0x8AbE813577E47415A3CD0Bbc68c7ABCa2c4c55bA', { provider: evmNode as never, chainId: 1 }).getTokenInfo('0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2')
    eq('evm token info (bytes32 symbol, UTF-8 name)', `${evmInfo.symbol}|${evmInfo.name}|${evmInfo.decimals}|${evmInfo.totalSupply}`, 'MKR|\u20AE|18|1000000000000000000000000')
    const USDC_MINT = 'AQAAAJj+huiNm+Lqi8HMpIeLKYjCQPUrhCS/tA7Rot3LXhmbbCqgDFWAGwAGAQEAAABicKqKWcWUBbRShshncubNEm6bil06OFNtN/e0FOi2Zw=='
    const solRpc = new Proxy({} as SolanaRpc, { get: (_t, m: string) => (...args: unknown[]) => ({ send: async () => {
      if (m !== 'getAccountInfo') throw new Error('offline: ' + m)
      return { value: String(args[0]) === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' ? { data: [USDC_MINT, 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', executable: false, lamports: 1n, rentEpoch: 0n, space: 82n } : null }
    } }) })
    const sol = new WalletAccountReadOnlySolana('9bhvajVaz6ECMoa93J8p699zkrrH14hoTN1EcPVd1Pzp', { provider: solRpc })
    const solInfo = await sol.getTokenInfo('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
    eq('solana token info (USDC mint bytes)', `${solInfo.standard}|${solInfo.decimals}|${solInfo.flags.join('+')}`, 'spl|6|mint-authority+freeze-authority')
    const table = new TokensTable(tokensStorage<TokensState>())
    await table.load()
    const found = await inspectToken({ chain: 'eip155:1', getTokenInfo: async () => ({ ...fake, symbol: 'PEPE', name: 'Pepe' }) }, '0x6982508145454Ce325dDbE47a25d4ec3d2311933')
    if (!found.listed) await table.add(found.token)
    eq('tokens table add + list', table.list('eip155:1').map((t) => t.symbol).join(','), 'PEPE')
  }
  // networks: the table, the URL policy, EIP-3085 parsing and a scripted verifyNetwork run in the VM (no network calls).
  {
    const table = new NetworksTable(memoryJsonStorage<NetworksState>())
    eq('networks builtin count', (await table.list()).length, BUILTIN_NETWORKS.length)
    eq('networks testnets off', DEFAULT_TESTNETS.every((n) => !n.enabled), true)
    await table.addRpc('eip155:8453', 'https://my.base.rpc')
    eq('networks user rpc first', (await table.rpcUrlsFor('eip155:8453'))[0], 'https://my.base.rpc')
    eq('networks fallback kept', (await table.rpcUrlsFor('eip155:8453')).length, 4)
    await table.setOnlyOwnRpc('eip155:8453', true)
    eq('networks onlyOwnRpc', (await table.rpcUrlsFor('eip155:8453')).join(','), 'https://my.base.rpc')
    eq('networks usesUserRpc', await table.usesUserRpc('eip155:8453'), true)
    let refused = false
    try { await table.remove('eip155:1') } catch { refused = true }
    eq('networks builtin undeletable', refused, true)
    eq('url https ok', checkRpcUrl('https://rpc.example.org').ok, true)
    eq('url http public refused', checkRpcUrl('http://rpc.example.org').ok, false)
    eq('url http local needs opt-in', checkRpcUrl('http://192.168.1.5:8545').ok, false)
    eq('url http local with opt-in', checkRpcUrl('http://192.168.1.5:8545', { allowHttpLocal: true }).ok, true)
    eq('private host', isPrivateHost('172.20.0.1') && !isPrivateHost('172.32.0.1'), true)
    // scan 2026-10-27 modules F37: every IPv4 spelling, CGNAT / link-local, mapped IPv6; gateway and avatar URLs
    eq('private host spellings', ['127.1', '2130706433', '0x7f.0.0.1', '100.64.0.1', '169.254.169.254', '::ffff:127.0.0.1', 'fe80::1%en0'].every(isPrivateHost) && !isPrivateHost('8.8.8.8') && !isPrivateHost('2001:4860:4860::8888'), true)
    eq('public https url', isPublicHttpsUrl('https://gw.example/{sender}/{data}.json') && !isPublicHttpsUrl('http://192.168.1.1/x') && !isPublicHttpsUrl('https://{data}.example/'), true)
    eq('private host idna and 6to4', isPrivateHost('127.0.0.\uFF11') && isPrivateHost('127\u30020\u30020\u30021') && isPrivateHost('2002:7f00:1::') && !isPrivateHost('xn--bcher-kva.example'), true)
    eq('ens avatar ipfs gateway origin', avatarUrl('ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG', 'https://gw.example'), 'https://gw.example/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG')
    eq('ens avatar filtered', [avatarUrl('https://192.168.1.1/a.png'), avatarUrl('https://example.org/a.png')].join(','), ',https://example.org/a.png')
    const added = parseAddChainParams([{ chainId: '0x2105', chainName: 'Base', rpcUrls: ['https://mainnet.base.org'] }], { origin: 'https://app.example.org', now: () => 1 })
    eq('eip3085 parse', !isAddChainError(added) && added.caip2 === 'eip155:8453' && typeof added.source === 'object' && added.source.origin === 'https://app.example.org', true)
    eq('eip3085 unknown chain', isAddChainError(parseAddChainParams([{ chainId: '0x7a69', rpcUrls: ['https://x'] }])) , true)
    eq('ton global id boc', tonGlobalIdFromBoc('te6cckEBAQEABgAACP////0sxAxZ'), -3)
    const fetchFake = async (_url: string, init?: { body?: string }) => {
      const method = init?.body ? (JSON.parse(init.body) as { method: string }).method : ''
      return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: method === 'eth_chainId' ? '0x2105' : '0x10' }) }
    }
    const v = await verifyNetwork({ caip2: 'eip155:8453', family: 'evm', rpcs: ['https://x'] }, { fetch: fetchFake })
    eq('verify evm ok', v.ok && v.tip === 16, true)
    const bad = await verifyNetwork({ caip2: 'eip155:1', family: 'evm', rpcs: ['https://x'] }, { fetch: fetchFake })
    eq('verify evm mismatch', !bad.ok && (bad.error ?? '').indexOf('chain-id-mismatch') === 0, true)
  }
  {
    // seed-vault: the real default Argon2id (19 MiB × 2) and XChaCha20-Poly1305 on Hermes, a key protector, tamper refusal.
    const secret = JSON.stringify({ type: 'mnemonic', mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about' })
    const meta = { type: 'mnemonic', fingerprint: '73c5da0a', label: 'Main' }
    const kek = new Uint8Array(32).fill(5)
    const t0 = Date.now()
    const env = decodeBackup(encodeBackup(await sealBackup(secret, meta, [{ kind: 'password', password: 'violet harbor anchor lantern' }, { kind: 'key', id: 'passkey:x', key: kek }])))
    const t1 = Date.now()
    const byPw = await openBackup(env, { kind: 'password', password: 'violet harbor anchor lantern' })
    out(`[note] seed-vault argon2id 19MiB×2: seal ${t1 - t0} ms, open ${Date.now() - t1} ms`)
    eq('backup open by password', byPw.text(), secret)
    byPw.dispose()
    eq('backup dispose zeroizes', byPw.bytes.every((b) => b === 0), true)
    eq('backup open by key', (await openBackup(env, { kind: 'key', id: 'passkey:x', key: kek })).text(), secret)
    let wrong = ''
    try { await openBackup(env, { kind: 'key', id: 'passkey:x', key: new Uint8Array(32).fill(6) }) } catch (e) { wrong = isBackupError(e) ? e.code : String(e) }
    eq('backup wrong key', wrong, 'wrong-key')
    let tampered = ''
    try { await openBackup({ ...env, meta: { ...meta, fingerprint: 'deadbeef' } }, { kind: 'key', id: 'passkey:x', key: kek }) } catch (e) { tampered = isBackupError(e) ? e.code : String(e) }
    eq('backup meta authenticated', tampered, 'corrupted')
  }
  // runtime-hermes structuredClone polyfill (round 3, L21): bigints of both signs, look-alike strings,
  // typed arrays, Map and Date survive the VM's clone (the JSON trick broke each of them).
  {
    const src = { n: -5n, s: '100n', b: Uint8Array.of(1, 2), m: new Map([['k', 3n]]), d: new Date(5) }
    const c = structuredClone(src)
    eq('structuredClone -5n', c.n, -5n)
    eq('structuredClone "100n"', c.s, '100n')
    eq('structuredClone bytes', c.b instanceof Uint8Array && c.b !== src.b && c.b[1] === 2, true)
    eq('structuredClone map', c.m instanceof Map && c.m.get('k') === 3n, true)
    eq('structuredClone date', c.d instanceof Date && c.d.getTime() === 5, true)
  }
  await smokeProtocols((what, ok, detail) => {
    if (!ok) throw new Error(`protocol check failed: ${what}${detail ? ` :: ${detail}` : ''}`)
    checks++
  })
  out(`HERMES_SMOKE_OK ${checks}`)
}

main().catch((e) => { out(`HERMES_SMOKE_FAIL ${e instanceof Error ? e.stack ?? e.message : String(e)}`) })
