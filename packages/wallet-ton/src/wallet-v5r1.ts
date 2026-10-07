/**
 * Wallet V5R1 (the contract Tonkeeper "W5" and Tonhub deploy) without
 * @ton/ton: state init, address, the signed-external body and its parser.
 *
 * Contract code and wire layout follow @ton/ton's WalletContractV5R1
 * (Copyright (c) Whales Corp., MIT) and the reference contract
 * https://github.com/ton-blockchain/wallet-contract-v5 (commit 4fab977,
 * build/wallet_v5.compiled.json). Only the parts a sending wallet needs are
 * here: extensions and the internal/extension auth paths are not implemented.
 */
import { Buffer } from 'buffer'
import {
  Address, Cell, SendMode, beginCell, contractAddress, external, loadOutList, storeMessage, storeOutList,
  type MessageRelaxed, type OutActionSendMsg, type StateInit,
} from '@ton/core'

// https://github.com/ton-blockchain/wallet-contract-v5/blob/4fab977f4fae3a37c1aac216ed2b7e611a9bc2af/build/wallet_v5.compiled.json
export const V5R1_CODE_HEX =
  'b5ee9c7241021401000281000114ff00f4a413f4bcf2c80b01020120020d020148030402dcd020d749c120915b8f6320d70b1f2082106578746ebd21821073696e74bdb0925f03e082106578746eba8eb48020d72101d074d721fa4030fa44f828fa443058bd915be0ed44d0810141d721f4058307f40e6fa1319130e18040d721707fdb3ce03120d749810280b99130e070e2100f020120050c020120060902016e07080019adce76a2684020eb90eb85ffc00019af1df6a2684010eb90eb858fc00201480a0b0017b325fb51341c75c875c2c7e00011b262fb513435c280200019be5f0f6a2684080a0eb90fa02c0102f20e011e20d70b1f82107369676ebaf2e08a7f0f01e68ef0eda2edfb218308d722028308d723208020d721d31fd31fd31fed44d0d200d31f20d31fd3ffd70a000af90140ccf9109a28945f0adb31e1f2c087df02b35007b0f2d0845125baf2e0855036baf2e086f823bbf2d0882292f800de01a47fc8ca00cb1f01cf16c9ed542092f80fde70db3cd81003f6eda2edfb02f404216e926c218e4c0221d73930709421c700b38e2d01d72820761e436c20d749c008f2e09320d74ac002f2e09320d71d06c712c2005230b0f2d089d74cd7393001a4e86c128407bbf2e093d74ac000f2e093ed55e2d20001c000915be0ebd72c08142091709601d72c081c12e25210b1e30f20d74a111213009601fa4001fa44f828fa443058baf2e091ed44d0810141d718f405049d7fc8ca0040048307f453f2e08b8e14038307f45bf2e08c22d70a00216e01b3b0f2d090e2c85003cf1612f400c9ed54007230d72c08248e2d21f2e092d200ed44d0d2005113baf2d08f54503091319c01810140d721d70a00f2e08ee2c8ca0058cf16c9ed5493f2c08de20010935bdb31e1d74cd0b4d6c35e'

let codeCell: Cell | undefined
/** The V5R1 contract code cell (parsed once). */
export function v5r1Code(): Cell {
  codeCell ??= Cell.fromBoc(Buffer.from(V5R1_CODE_HEX, 'hex'))[0]!
  return codeCell
}

export const V5R1_OP = {
  signedExternal: 0x7369676e,
  signedInternal: 0x73696e74,
  extension: 0x6578746e,
} as const

export const MAINNET_GLOBAL_ID = -239
export const TESTNET_GLOBAL_ID = -3
/** PAY_GAS_SEPARATELY | IGNORE_ERRORS — the mode every external-message action carries. */
export const DEFAULT_SEND_MODE = SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS
export const MAX_ACTIONS = 255

export interface V5R1WalletIdParts { networkGlobalId?: number; workchain?: number; subwalletNumber?: number }

/**
 * Serialized wallet_id (int32): `networkGlobalId XOR context`, where the client
 * context is {1 bit "client", int8 workchain, uint8 version (0 = v5r1), uint15 subwallet}.
 */
export function v5r1WalletId(parts: V5R1WalletIdParts = {}): bigint {
  const context = beginCell()
    .storeUint(1, 1)
    .storeInt(parts.workchain ?? 0, 8)
    .storeUint(0, 8)
    .storeUint(parts.subwalletNumber ?? 0, 15)
    .endCell().beginParse().loadInt(32)
  return BigInt(parts.networkGlobalId ?? MAINNET_GLOBAL_ID) ^ BigInt(context)
}

export function v5r1StateInit(publicKey: Uint8Array, walletId: bigint = v5r1WalletId()): StateInit {
  if (publicKey.length !== 32) throw new Error('V5R1: public key must be 32 bytes')
  const data = beginCell()
    .storeUint(1, 1) // signature auth allowed
    .storeUint(0, 32) // seqno
    .storeInt(walletId, 32)
    .storeBuffer(Buffer.from(publicKey), 32)
    .storeBit(0) // no extensions
    .endCell()
  return { code: v5r1Code(), data }
}

export function v5r1Address(publicKey: Uint8Array, opts: { workchain?: number; walletId?: bigint } = {}): Address {
  return contractAddress(opts.workchain ?? 0, v5r1StateInit(publicKey, opts.walletId))
}

export interface V5R1Message { message: MessageRelaxed; mode?: number }

export interface V5R1SigningParams {
  walletId: bigint
  /** Unix seconds. */
  validUntil: number
  seqno: number
  messages: V5R1Message[]
}

/** The cell that gets hashed and signed: op | wallet_id | valid_until | seqno | out-list ref | no extended actions. */
export function v5r1SigningMessage(p: V5R1SigningParams): Cell {
  if (p.messages.length > MAX_ACTIONS) throw new Error(`V5R1: at most ${MAX_ACTIONS} messages per external (got ${p.messages.length})`)
  const actions: OutActionSendMsg[] = p.messages.map((m) => ({
    type: 'sendMsg',
    // Externals must carry IGNORE_ERRORS or the wallet contract rejects them.
    mode: (m.mode ?? DEFAULT_SEND_MODE) | SendMode.IGNORE_ERRORS,
    outMsg: m.message,
  }))
  const outList = actions.length ? beginCell().store(storeOutList(actions)).endCell() : null
  return beginCell()
    .storeUint(V5R1_OP.signedExternal, 32)
    .storeInt(p.walletId, 32)
    .storeUint(p.validUntil, 32)
    .storeUint(p.seqno, 32)
    .storeMaybeRef(outList)
    .storeUint(0, 1)
    .endCell()
}

/** Signature goes at the tail (V5R1 layout). */
export function v5r1PackSigned(signing: Cell, signature: Uint8Array): Cell {
  if (signature.length !== 64) throw new Error('V5R1: signature must be 64 bytes')
  return beginCell().storeSlice(signing.beginParse()).storeBuffer(Buffer.from(signature), 64).endCell()
}

/** Same body with a zero signature — what `estimateFee(ignore_chksig)` and emulation take. */
export function v5r1PackUnsigned(signing: Cell): Cell {
  return v5r1PackSigned(signing, new Uint8Array(64))
}

/** The external-in message (as a cell, ready for sendBoc) carrying `body` to the wallet, with `init` when it is not deployed yet. */
export function v5r1ExternalMessage(to: Address, body: Cell, init?: StateInit): Cell {
  return beginCell().store(storeMessage(external({ to, body, ...(init ? { init } : {}) }))).endCell()
}

export interface ParsedV5R1Body {
  op: number
  walletId: bigint
  validUntil: number
  seqno: number
  messages: Array<{ message: MessageRelaxed; mode: number }>
  /** True when the 64-byte tail signature is present (externals and internals carry one). */
  signed: boolean
}

/** Parse a signed (or zero-signed) V5R1 external body back into its messages. Returns null for anything else. */
export function parseV5R1Body(body: Cell): ParsedV5R1Body | null {
  try {
    const s = body.beginParse()
    const op = s.loadUint(32)
    if (op !== V5R1_OP.signedExternal && op !== V5R1_OP.signedInternal) return null
    const walletId = BigInt(s.loadInt(32))
    const validUntil = s.loadUint(32)
    const seqno = s.loadUint(32)
    const outList = s.loadMaybeRef()
    const hasExtended = s.loadBit()
    if (hasExtended) return null // extension management: not a plain send
    const messages: ParsedV5R1Body['messages'] = []
    if (outList) {
      for (const a of loadOutList(outList.beginParse())) {
        if (a.type !== 'sendMsg') return null
        messages.push({ message: a.outMsg, mode: a.mode })
      }
    }
    const signed = s.remainingBits >= 512
    return { op, walletId, validUntil, seqno, messages, signed }
  } catch {
    return null
  }
}
