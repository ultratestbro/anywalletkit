import {refusalNotes, type Swap2RefusalInfo, type Swap2RefusalReason} from "@anywalletkit/protocol-swap2-core/errors";

/**
 * The reason of each refusal text the checks in `verify.ts` hand back as a string (`symbiosisRequest`,
 * `symbiosisInspectQuote`, `symbiosisVerifyQuote`, `symbiosisVerifyBuild`), remembered by the text: the provider reads
 * it right after a check refuses, and the pins answer `reasonOf` from it. Bounded: the last 256 texts.
 */
export const notes = refusalNotes(256);

/** `text` as it is, its reason remembered when it has one. */
export function noted(text: string, info: Swap2RefusalReason | Swap2RefusalInfo | undefined): string {
  return info === undefined ? text : notes.note(text, info);
}
