export type SwidgeErrorCode =
  | "CONFIGURATION"
  | "VALIDATION"
  | "QUOTE"
  | "EXECUTION"
  | "UNSUPPORTED_OPERATION"
  | "FEE_LIMIT"
  | "STATUS";

/** Public, machine-readable error base shared by every contribution package. */
export class SwidgeError extends Error {
  constructor(message: string, readonly code: SwidgeErrorCode, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class SwidgeConfigurationError extends SwidgeError {
  constructor(message: string, options?: ErrorOptions) { super(message, "CONFIGURATION", options); }
}
export class SwidgeValidationError extends SwidgeError {
  constructor(message: string, options?: ErrorOptions) { super(message, "VALIDATION", options); }
}
export class SwidgeQuoteError extends SwidgeError {
  constructor(message: string, options?: ErrorOptions) { super(message, "QUOTE", options); }
}
export class SwidgeExecutionError extends SwidgeError {
  constructor(message: string, options?: ErrorOptions) { super(message, "EXECUTION", options); }
}
export class SwidgeUnsupportedOperationError extends SwidgeError {
  constructor(message: string, options?: ErrorOptions) { super(message, "UNSUPPORTED_OPERATION", options); }
}
export class SwidgeFeeLimitError extends SwidgeError {
  constructor(message: string, options?: ErrorOptions) { super(message, "FEE_LIMIT", options); }
}
export class SwidgeStatusError extends SwidgeError {
  constructor(message: string, options?: ErrorOptions) { super(message, "STATUS", options); }
}
