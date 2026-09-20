/**
 * Typed error model shared across packages. Every thrown error on a FIRSTHAND code path is a
 * `FirsthandError` with a stable machine-readable `code`; Solidity custom errors use the same
 * names so that a failure reads identically in a revert, a log line and an HTTP problem body.
 *
 * `context` must never contain key material: `CryptoError` in @firsthand/crypto constructs its
 * context from lengths and labels only, and the runtime logger redacts known secret keys anyway.
 */

export type ErrorCode =
  | "FH_VALIDATION"
  | "FH_NOT_FOUND"
  | "FH_CONFIG"
  | "FH_NOT_IMPLEMENTED"
  | "FH_REFUSED_ORIGIN"
  | "FH_REFUSED_DUPLICATE"
  | "FH_MERKLE_INVALID"
  | "FH_SIG_INVALID"
  | "FH_GRANT_NOT_LIVE"
  | "FH_GRANT_RESCINDED"
  | "FH_GRANT_FROZEN"
  | "FH_GRANT_EXPIRED"
  | "FH_RATE_LIMITED"
  | "FH_PAYMENT_REQUIRED"
  | "FH_PAYMENT_INVALID"
  | "FH_TRANSPORT"
  | "FH_BTX_UNAVAILABLE"
  | "FH_CIRCUIT_OPEN"
  | "FH_CHAIN"
  | "FH_INSUFFICIENT_FUNDS"
  | "FH_CRYPTO";

export interface FirsthandErrorOptions {
  readonly cause?: unknown;
  /** Whether a caller may reasonably retry the same operation. Defaults to false. */
  readonly retryable?: boolean;
  /** Structured, secret-free diagnostic data. */
  readonly context?: Readonly<Record<string, unknown>>;
}

export class FirsthandError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(code: ErrorCode, message: string, options: FirsthandErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.context = options.context ?? {};
  }

  /** JSON-safe representation; never includes `cause` (it may carry foreign data). */
  toJSON(): {
    name: string;
    code: ErrorCode;
    message: string;
    retryable: boolean;
    context: unknown;
  } {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      context: this.context,
    };
  }
}

/** Malformed input at a package boundary. */
export class ValidationError extends FirsthandError {
  constructor(message: string, options: FirsthandErrorOptions = {}) {
    super("FH_VALIDATION", message, options);
  }
}

/** A referenced passport, grant or blob does not exist on this gateway. */
export class NotFoundError extends FirsthandError {
  constructor(message: string, options: FirsthandErrorOptions = {}) {
    super("FH_NOT_FOUND", message, options);
  }
}

/** Missing or inconsistent configuration (env, addresses, chain ids). */
export class ConfigError extends FirsthandError {
  constructor(message: string, options: FirsthandErrorOptions = {}) {
    super("FH_CONFIG", message, options);
  }
}

export class NotImplementedError extends FirsthandError {
  constructor(feature: string, options: FirsthandErrorOptions = {}) {
    super("FH_NOT_IMPLEMENTED", `${feature} is not implemented yet`, options);
  }
}

/**
 * Deposit-time refusal — "the locker that turns data away" (README §7.1).
 * `FH_REFUSED_ORIGIN`: signature does not verify against an enrolled lineage.
 * `FH_REFUSED_DUPLICATE`: passportId already present in the batch or anchored.
 */
export class RefusalError extends FirsthandError {
  constructor(
    code: Extract<ErrorCode, "FH_REFUSED_ORIGIN" | "FH_REFUSED_DUPLICATE">,
    message: string,
    options: FirsthandErrorOptions = {},
  ) {
    super(code, message, options);
  }
}

/** Merkle or signature proof failure on the verify path. */
export class ProofError extends FirsthandError {
  constructor(
    code: Extract<ErrorCode, "FH_MERKLE_INVALID" | "FH_SIG_INVALID">,
    message: string,
    options: FirsthandErrorOptions = {},
  ) {
    super(code, message, options);
  }
}

export class GrantError extends FirsthandError {
  constructor(
    code: Extract<
      ErrorCode,
      | "FH_GRANT_NOT_LIVE"
      | "FH_GRANT_RESCINDED"
      | "FH_GRANT_FROZEN"
      | "FH_GRANT_EXPIRED"
      | "FH_RATE_LIMITED"
    >,
    message: string,
    options: FirsthandErrorOptions = {},
  ) {
    super(code, message, options);
  }
}

export class PaymentError extends FirsthandError {
  constructor(
    code: Extract<ErrorCode, "FH_PAYMENT_REQUIRED" | "FH_PAYMENT_INVALID">,
    message: string,
    options: FirsthandErrorOptions = {},
  ) {
    super(code, message, options);
  }
}

/** Network / RPC / adapter failures. Usually retryable. */
export class TransportError extends FirsthandError {
  constructor(
    code: Extract<ErrorCode, "FH_TRANSPORT" | "FH_BTX_UNAVAILABLE" | "FH_CIRCUIT_OPEN">,
    message: string,
    options: FirsthandErrorOptions = {},
  ) {
    super(code, message, { retryable: code === "FH_TRANSPORT", ...options });
  }
}

/**
 * On-chain state disagreed with expectations (revert, reorg, unknown root). `FH_INSUFFICIENT_FUNDS`
 * names the one chain failure that is nobody's bug but the operator's: the paying key is out of gas
 * — a judge reads "the relayer needs a top-up", not "submission failed".
 */
export class ChainError extends FirsthandError {
  constructor(
    message: string,
    options: FirsthandErrorOptions & {
      readonly code?: Extract<ErrorCode, "FH_CHAIN" | "FH_INSUFFICIENT_FUNDS">;
    } = {},
  ) {
    const { code, ...rest } = options;
    super(code ?? "FH_CHAIN", message, rest);
  }
}

/** Cryptographic operation failed. Context carries lengths and labels only — never bytes. */
export class CryptoError extends FirsthandError {
  constructor(message: string, options: FirsthandErrorOptions = {}) {
    super("FH_CRYPTO", message, options);
  }
}

export function isFirsthandError(value: unknown): value is FirsthandError {
  return value instanceof FirsthandError;
}

/** RFC 9457 problem-details body plus the HTTP status the gateway should use. */
export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly code: ErrorCode;
  readonly retryable: boolean;
}

const STATUS_BY_CODE: Readonly<Record<ErrorCode, number>> = {
  FH_VALIDATION: 400,
  FH_NOT_FOUND: 404,
  FH_CONFIG: 500,
  FH_NOT_IMPLEMENTED: 501,
  FH_REFUSED_ORIGIN: 422,
  FH_REFUSED_DUPLICATE: 409,
  FH_MERKLE_INVALID: 422,
  FH_SIG_INVALID: 422,
  FH_GRANT_NOT_LIVE: 403,
  FH_GRANT_RESCINDED: 403,
  FH_GRANT_FROZEN: 403,
  FH_GRANT_EXPIRED: 403,
  FH_RATE_LIMITED: 429,
  FH_PAYMENT_REQUIRED: 402,
  FH_PAYMENT_INVALID: 402,
  FH_TRANSPORT: 502,
  FH_BTX_UNAVAILABLE: 503,
  FH_CIRCUIT_OPEN: 503,
  FH_CHAIN: 502,
  FH_INSUFFICIENT_FUNDS: 503,
  FH_CRYPTO: 500,
};

export function toProblemDetails(error: unknown): ProblemDetails {
  if (isFirsthandError(error)) {
    return {
      type: `urn:firsthand:error:${error.code.toLowerCase()}`,
      title: error.name,
      status: STATUS_BY_CODE[error.code],
      detail: error.message,
      code: error.code,
      retryable: error.retryable,
    };
  }
  return {
    type: "about:blank",
    title: "InternalError",
    status: 500,
    detail: "internal error",
    code: "FH_CONFIG",
    retryable: false,
  };
}
