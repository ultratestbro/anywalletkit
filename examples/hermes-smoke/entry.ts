/**
 * Hermes smoke: derive + sign on every chain the way the SDK does, inside the
 * Hermes VM (no Node, no browser APIs). Checks derivation/signing vectors and
 * the offline safety layers, then prints HERMES_SMOKE_OK. Bundled by run.mjs.
 */
import './shim-globals.js'
import 'fastestsmallesttextencoderdecoder/EncoderDecoderTogether.min.js'
import './shim-runtime.js'
import { bytesToHex } from '@noble/hashes/utils.js'
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
import { WalletManagerNear, describeTransaction as describeNear, encodeTransaction as encodeNearTx, decodeTransaction as decodeNearTx } from '@forgewallet/wallet-near'
import { smokeProtocols } from './protocols.js'

declare const print: ((s: string) => void) | undefined
const out = (s: string) => (typeof print === 'function' ? print(s) : console.log(s))

let checks = 0
const eq = (what: string, a: unknown, b: unknown) => {
  if (a !== b) throw new Error(`${what}: ${String(a)} !== ${String(b)}`)
  checks++
}

async function main() {
  for (const [seedName, mnemonic] of Object.entries(derivationVectors.seeds)) {
    const seed = seedFromMnemonicSync(mnemonic)
    for (const chain of ['evm', 'btc', 'tron'] as const) {
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
  await smokeProtocols((what, ok, detail) => {
    if (!ok) throw new Error(`protocol check failed: ${what}${detail ? ` :: ${detail}` : ''}`)
    checks++
  })
  out(`HERMES_SMOKE_OK ${checks}`)
}

main().catch((e) => { out(`HERMES_SMOKE_FAIL ${e instanceof Error ? e.stack ?? e.message : String(e)}`) })
