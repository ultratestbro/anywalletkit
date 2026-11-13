// The reasons behind the texts this package's checks return as strings: `usdt0VerifyQuote`, `usdt0VerifyMeshSend` and
// the price-only check note each text with its reason (`Swap2RefusalReason`) where they produce it; `usdt0Pins.reasonOf`
// reads it back so a remote stub's refusal carries it, and the provider reads it for its own build's self-check.
import {refusalNotes} from "@anywalletkit/protocol-swap2-core/errors";

export const usdt0Notes = refusalNotes();

/** Hands `text` back unchanged, remembering its reason. */
export const note = usdt0Notes.note;
