import {refusalNotes, withReason, type Swap2RefusalInfo, type Swap2RefusalReason} from "@anywalletkit/protocol-swap2-core/errors";

/**
 * The reason of each refusal text the checks hand back as a string (`checkRoute`, `curveVerifyQuote`, a sealed quote's
 * on-chain check, `curveRemotePins` `verifyBuild`), remembered by the text: the provider reads it right after a check
 * refuses, and the pins answer `reasonOf` from it. Bounded: the last 256 texts.
 */
export const notes = refusalNotes(256);

/** `text` as it is, its reason remembered when it has one. */
export function noted(text: string, info: Swap2RefusalReason | Swap2RefusalInfo | undefined): string {
  return info === undefined ? text : notes.note(text, info);
}

/** The error with its reason when there is one (its class and text as they are). */
export function tagged<E extends Error>(error: E, info: Swap2RefusalReason | Swap2RefusalInfo | undefined): E {
  return info === undefined ? error : withReason(error, info);
}
