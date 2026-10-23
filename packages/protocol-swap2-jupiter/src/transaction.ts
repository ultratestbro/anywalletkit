/**
 * Assemble the v0 transaction from `/build` instructions: our compute budget (limit + capped price), Jupiter's setup,
 * swap, cleanup and other instructions, compressed with the lookup tables the response names, fee payer = the taker,
 * lifetime = the blockhash Jupiter fetched. Signatures stay empty; the account signs after its own guard.
 */
import {
  AccountRole, address, appendTransactionMessageInstructions, compileTransaction, compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage, getBase58Decoder, getBase64EncodedWireTransaction, pipe, setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash, type Address, type Blockhash, type Instruction,
} from "@solana/kit";
import {COMPUTE_BUDGET_PROGRAM} from "./config.js";
import {fromBase64, setComputeUnitLimit, setComputeUnitPrice} from "./codec.js";

export interface JupiterInstruction {
  programId: string;
  accounts: {pubkey: string; isSigner: boolean; isWritable: boolean}[];
  data: string;
}

export interface AssembleInput {
  taker: string;
  /** setup → swap → cleanup → other, in that order; compute-budget instructions are ours and come first. */
  instructions: JupiterInstruction[];
  computeUnitLimit: number;
  computeUnitPrice: bigint;
  blockhash: Uint8Array | string;
  lastValidBlockHeight: number | bigint;
  addressesByLookupTableAddress: Record<string, string[]> | null | undefined;
}

const role = (a: {isSigner: boolean; isWritable: boolean}): AccountRole =>
  a.isSigner ? (a.isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : a.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY;

const toInstruction = (ix: JupiterInstruction): Instruction => ({
  programAddress: address(ix.programId),
  accounts: ix.accounts.map((a) => ({address: address(a.pubkey), role: role(a)})),
  data: fromBase64(ix.data),
});

/** The unsigned transaction as base64 wire bytes (what `TxRequest.serializedTx` carries). */
export function assembleTransaction(input: AssembleInput): string {
  const budget: Instruction[] = [
    {programAddress: address(COMPUTE_BUDGET_PROGRAM), data: setComputeUnitLimit(input.computeUnitLimit)},
    {programAddress: address(COMPUTE_BUDGET_PROGRAM), data: setComputeUnitPrice(input.computeUnitPrice)},
  ];
  const blockhash = (typeof input.blockhash === "string" ? input.blockhash : getBase58Decoder().decode(input.blockhash)) as Blockhash;
  const tables: Record<Address, Address[]> = {};
  for (const [table, list] of Object.entries(input.addressesByLookupTableAddress ?? {})) tables[address(table)] = list.map((a) => address(a));
  const message = pipe(
    createTransactionMessage({version: 0}),
    (m) => setTransactionMessageFeePayer(address(input.taker), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({blockhash, lastValidBlockHeight: BigInt(input.lastValidBlockHeight)}, m),
    (m) => appendTransactionMessageInstructions([...budget, ...input.instructions.map(toInstruction)], m),
    (m) => (Object.keys(tables).length ? compressTransactionMessageUsingAddressLookupTables(m, tables) : m),
  );
  return getBase64EncodedWireTransaction(compileTransaction(message));
}
