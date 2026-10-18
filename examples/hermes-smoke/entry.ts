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
import { deriveEd25519, deriveSecp256k1, seedFromMnemonicSync } from '@forgewallet/core'
import { derivationVectors } from '@forgewallet/conformance'
import { WalletManagerEvm, describeTransaction, describeTypedData, encodeApprove } from '@forgewallet/wallet-evm'
import { WalletManagerSolana, describeTransaction as describeSolana, ZERO_ADDRESS as SOL_ZERO } from '@forgewallet/wallet-solana'
import { getApproveInstruction } from '@solana-program/token'
import { appendTransactionMessageInstructions, createNoopSigner, createTransactionMessage, pipe, setTransactionMessageFeePayer, type Address } from '@solana/kit'
import { WalletManagerTon, describeTransaction as describeTon, parseV5R1Body, v5r1SigningMessage, v5r1PackUnsigned, v5r1WalletId } from '@forgewallet/wallet-ton'
import { beginCell, internal } from '@ton/core'
import { WalletManagerTron, describeTransaction as describeTron, ZERO_ADDRESS as TRON_ZERO } from '@forgewallet/wallet-tron'
import { WalletManagerBtc, selectCoins, INPUT_WEIGHT } from '@forgewallet/wallet-btc'
import { WalletManagerZcash, parseTx as parseZcashTx, txid as zcashTxid, sighashAll as zcashSighash, parseP2pkhScriptSig, conventionalFee as zcashFee, outputSize as zcashOutputSize } from '@forgewallet/wallet-zcash'
import { WalletManagerNear, describeTransaction as describeNear, encodeTransaction as encodeNearTx, decodeTransaction as decodeNearTx } from '@forgewallet/wallet-near'
import { smokeProtocols } from './protocols.js'
import { ensResolver, warningsFor, coinTypeFor, decodeBtcScript } from '@forgewallet/names-ens'
import { isNameLike, nameResolvers } from '@forgewallet/core'

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
  await smokeProtocols((what, ok, detail) => {
    if (!ok) throw new Error(`protocol check failed: ${what}${detail ? ` :: ${detail}` : ''}`)
    checks++
  })
  out(`HERMES_SMOKE_OK ${checks}`)
}

main().catch((e) => { out(`HERMES_SMOKE_FAIL ${e instanceof Error ? e.stack ?? e.message : String(e)}`) })
