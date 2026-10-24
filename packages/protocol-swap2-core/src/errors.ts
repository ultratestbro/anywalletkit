/**
 * Which stage of a swap failed: configuration, input validation, quote, execution, an unsupported
 * operation, a fee ceiling, or status tracking.
 */
export type Swap2ErrorCode =
  | "CONFIGURATION"
  | "VALIDATION"
  | "QUOTE"
  | "EXECUTION"
  | "UNSUPPORTED_OPERATION"
  | "FEE_LIMIT"
  | "STATUS";

/** Public, machine-readable error base shared by every contribution package. */
export class Swap2Error extends Error {
  constructor(message: string, readonly code: Swap2ErrorCode, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class Swap2ConfigurationError extends Swap2Error {
  constructor(message: string, options?: ErrorOptions) { super(message, "CONFIGURATION", options); }
}
export class Swap2ValidationError extends Swap2Error {
  constructor(message: string, options?: ErrorOptions) { super(message, "VALIDATION", options); }
}
export class Swap2QuoteError extends Swap2Error {
  constructor(message: string, options?: ErrorOptions) { super(message, "QUOTE", options); }
}
export class Swap2ExecutionError extends Swap2Error {
  constructor(message: string, options?: ErrorOptions) { super(message, "EXECUTION", options); }
}
export class Swap2UnsupportedOperationError extends Swap2Error {
  constructor(message: string, options?: ErrorOptions) { super(message, "UNSUPPORTED_OPERATION", options); }
}
export class Swap2FeeLimitError extends Swap2Error {
  constructor(message: string, options?: ErrorOptions) { super(message, "FEE_LIMIT", options); }
}
export class Swap2StatusError extends Swap2Error {
  constructor(message: string, options?: ErrorOptions) { super(message, "STATUS", options); }
}
/** An identical swap2() is still running on this account (double tap): nothing was sent for this call. */
export class Swap2InFlightError extends Swap2ExecutionError {}
/** The account cannot pay the source leg's gas (approvals + main call + value); nothing was signed. */
export class Swap2InsufficientGasError extends Swap2ExecutionError {}
/**
 * The source broadcast failed AFTER the transaction may have reached the node
 * (lost response, timeout). Do NOT retry: poll `getSwap2Status(id)` / the
 * chain for `hash`. The approval is left in place (the deposit may spend it).
 */
export class Swap2MaybeSentError extends Swap2ExecutionError {
  constructor(message: string, readonly hash?: string, readonly id?: string, options?: ErrorOptions) { super(message, options); }
}
