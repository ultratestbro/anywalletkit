import { describe, expect, it } from 'vitest'
import {
  AccountRole, appendTransactionMessageInstructions, compileTransaction, compressTransactionMessageUsingAddressLookupTables, createTransactionMessage,
  getBase64EncodedWireTransaction, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
  type Address, type Instruction, type Transaction, type TransactionMessage,
} from '@solana/kit'
import { WalletManagerSolana, decodeStakeInstruction, decodeWireTransaction, type SolanaRpc } from '../src/index.js'

// 2026-10-27 key/signing scan: the exploit inputs from the report, refused before anything is signed.

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const ADDR0 = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk' as Address
const ATTACKER = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS' as Address
const STAKE_ACCOUNT = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo' as Address
const STAKE = 'Stake11111111111111111111111111111111111111' as Address
const CLOCK = 'SysvarC1ock11111111111111111111111111111111' as Address
const TABLE = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' as Address
const BLOCKHASH = '9sHcv6xwn9YkB8nxTUGKDwPwNnmqVp5oAXxU8Fdkm4J6'
const u32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]

function fakeRpc() {
  const sent: string[] = []
  const handlers: Record<string, (...a: unknown[]) => unknown> = {
    simulateTransaction: (_w: unknown, cfg: unknown) => ({ value: { err: null, unitsConsumed: 50_000n, logs: [], ...((cfg as { accounts?: { addresses: unknown[] } } | undefined)?.accounts ? { accounts: (cfg as { accounts: { addresses: unknown[] } }).accounts.addresses.map(() => null) } : {}) } }),
    getFeeForMessage: () => ({ value: 5_000n }),
    getLatestBlockhash: () => ({ value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100n } }),
    getRecentPrioritizationFees: () => [],
    getMultipleAccounts: (list: unknown, cfg: unknown) => ((cfg as { encoding?: string } | undefined)?.encoding === 'base64'
      ? { value: (list as unknown[]).map(() => null) }
      : { value: [{ data: { parsed: { info: { addresses: [CLOCK] }, type: 'lookupTable' }, program: 'address-lookup-table' }, owner: 'AddressLookupTab1e1111111111111111111111111', executable: false, lamports: 1n, rentEpoch: 0n, space: 0n }] }),
    sendTransaction: (wire) => { sent.push(wire as string); return 'B'.repeat(87) },
  }
  const rpc = new Proxy({} as SolanaRpc, { get: (_t, m: string) => (...args: unknown[]) => ({ send: async () => { const h = handlers[m]; if (!h) throw new Error(`unmocked ${m}`); return h(...args) } }) })
  return { rpc, sent }
}

describe('scan 2026-10-27 G13 (F13): AuthorizeChecked with the Clock sysvar loaded from a lookup table', () => {
  // AuthorizeChecked(Withdrawer): [stake, Clock, current authority (the wallet), new authority (the attacker, a signer)].
  const authorize: Instruction = {
    programAddress: STAKE,
    accounts: [
      { address: STAKE_ACCOUNT, role: AccountRole.WRITABLE }, { address: CLOCK, role: AccountRole.READONLY },
      { address: ADDR0, role: AccountRole.READONLY_SIGNER }, { address: ATTACKER, role: AccountRole.READONLY_SIGNER },
    ],
    data: Uint8Array.from([...u32(10), ...u32(1)]),
  }
  const message = compressTransactionMessageUsingAddressLookupTables(pipe(
    createTransactionMessage({ version: 0 }),
    (x) => setTransactionMessageFeePayer(ADDR0, x),
    (x) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: BLOCKHASH as never, lastValidBlockHeight: 100n }, x),
    (x) => appendTransactionMessageInstructions([authorize], x),
  ) as never, { [TABLE]: [CLOCK] }) as unknown as TransactionMessage
  const base64 = getBase64EncodedWireTransaction(compileTransaction(message as never) as Transaction)

  it('the decoder does not guess the layout when the layout-deciding account is unresolved', () => {
    expect(decodeStakeInstruction(authorize.data as Uint8Array, [STAKE_ACCOUNT, null, ADDR0, ATTACKER])).toMatchObject({ name: 'AuthorizeChecked' })
    expect(decodeStakeInstruction(authorize.data as Uint8Array, [STAKE_ACCOUNT, null, ADDR0, ATTACKER])!.newAuthority).toBeUndefined()
    expect(decodeStakeInstruction(authorize.data as Uint8Array, [STAKE_ACCOUNT, CLOCK, ADDR0, ATTACKER])!.newAuthority).toBe(ATTACKER)
  })

  it('sendTransaction, signTransaction and signCompiled refuse it (base64 and compiled forms); nothing is sent', async () => {
    const f = fakeRpc()
    const a = await new WalletManagerSolana(SEED, { provider: f.rpc, priorityFee: false }).getAccount(0)
    // The attacker, the new authority, has signed already (it must: AuthorizeChecked needs its signature).
    const unsigned = decodeWireTransaction(base64)
    const compiled = { ...unsigned, signatures: { ...unsigned.signatures, [ATTACKER]: new Uint8Array(64).fill(7) } } as typeof unsigned
    const presigned = getBase64EncodedWireTransaction(compiled as Transaction)
    for (const input of [presigned, compiled]) {
      // The attacker co-signs off-band; the wallet's signature is what the guard must withhold.
      await expect(a.signTransaction(input)).rejects.toMatchObject({ name: 'UnsafeTransactionError', code: 'sets-authority' })
      await expect(a.sendTransaction(input)).rejects.toThrow()
    }
    await expect(a.signCompiled(compiled)).rejects.toMatchObject({ name: 'UnsafeTransactionError', code: 'sets-authority' })
    expect(f.sent).toHaveLength(0)
  })
})
