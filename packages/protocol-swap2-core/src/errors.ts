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
