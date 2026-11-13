import {refusalNotes} from "@anywalletkit/protocol-swap2-core/errors";

/**
 * The reasons of the texts this package's checks return as strings (the Diamond calldata, the Solana bridge
 * transaction, a remote quote): `note` hands a text back unchanged and remembers its reason, `reasonOf` reads it back
 * for the provider's refusals and for `lifiPins.reasonOf`. Bounded; a text always gets the same reason.
 */
const notes = refusalNotes();

export const note = notes.note;
export const reasonOf = notes.reasonOf;
