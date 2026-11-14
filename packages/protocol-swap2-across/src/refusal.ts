import {withReason, type Swap2RefusalReason} from "@anywalletkit/protocol-swap2-core/errors";

/** Why a request, a deposit, a quote or an API answer was refused. One code per check; the message says what was found. */
export type AcrossRefusalCode =
  | "request-invalid"
  | "chain-unsupported"
  | "token-unsupported"
  | "pair-unsupported"
  | "native-unsupported"
  | "wrapped-native-destination"
  | "route-unpriced"
  | "quote-unavailable"
  | "quote-normalized"
  | "tx-shape"
  | "tx-chain"
  | "tx-target"
  | "tx-selector"
  | "tx-calldata"
  | "tx-depositor"
  | "tx-recipient"
  | "tx-input-token"
  | "tx-output-token"
  | "tx-input-amount"
  | "tx-output-amount"
  | "tx-fee"
  | "tx-destination"
  | "tx-message"
  | "tx-message-v5"
  | "tx-exclusivity"
  | "tx-quote-time"
  | "tx-fill-deadline"
  | "tx-value"
  | "tx-approval"
  | "speed-up"
  | "quote-shape"
  | "quote-amounts"
  | "quote-expiry"
  | "quote-gas"
  | "quote-intent"
  | "api-error"
  | "api-answer"
  | "relayer-price";

/**
 * `code` names the check; `reason` (a `Swap2RefusalReason` from `@anywalletkit/protocol-swap2-core`) is the stable
 * classification an app switches on. It is set where the refusal is raised, so one code can carry different reasons
 * (a fill deadline too far ahead is `policy_refused`, one already too close is `quote_expired`); a malformed request
 * from the caller (a programming error) carries none.
 */
export class AcrossRefusal extends Error {
  readonly code: AcrossRefusalCode;
  declare readonly reason?: Swap2RefusalReason;
  constructor(code: AcrossRefusalCode, detail: string, reason?: Swap2RefusalReason) {
    super(`across: ${detail} [${code}]`);
    this.name = "AcrossRefusal";
    this.code = code;
    if (reason !== undefined) withReason(this, reason);
  }
}
