import {refusalNotes} from "@anywalletkit/protocol-swap2-core/errors";

/**
 * The reasons of the texts this package returns as strings (`nearIntentsChainRefusal`): `note` hands a text back
 * unchanged and remembers its reason, `reasonOf` reads it back for the provider's refusal. Bounded; a text always
 * gets the same reason.
 */
const notes = refusalNotes();

export const note = notes.note;
export const reasonOf = notes.reasonOf;
