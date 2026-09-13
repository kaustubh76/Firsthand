/**
 * Structured logger with mandatory redaction. Libraries accept an optional `Logger` and default to
 * `noopLogger`; apps construct one with `createLogger`. The redaction list below cannot be removed,
 * only extended — a log line is the easiest way to leak a key (SECURITY.md §3).
 */
export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  readonly level: LogLevel;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Returns a logger that merges `bindings` into every line. */
  child(bindings: LogFields): Logger;
}

/** Keys whose values are always replaced by `[REDACTED]`, matched case-insensitively as substrings. */
export const REDACT_KEYS: readonly string[] = [
  "prf",
  "prk",
  "secret",
  "privatekey",
  "private_key",
  "dek",
  "vaultkey",
  "vault_key",
  "scalar",
  "seed",
  "mnemonic",
  "password",
  "authorization",
  "cookie",
];

export const REDACTED = "[REDACTED]";

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export interface LoggerOptions {
  readonly level?: LogLevel;
  /** Emit one JSON object per line (production) instead of a readable line (development). */
  readonly json?: boolean;
  /** Additional redaction keys, merged with `REDACT_KEYS`. */
  readonly redact?: readonly string[];
  /** Sink override, mainly for tests. Defaults to stderr for warn/error and stdout otherwise. */
  readonly sink?: (level: Exclude<LogLevel, "silent">, line: string) => void;
  readonly clock?: () => Date;
}

function shouldRedact(key: string, keys: readonly string[]): boolean {
  const k = key.toLowerCase();
  return keys.some((r) => k.includes(r));
}

/** Deep-copies `value` replacing redacted keys and byte buffers; safe against cycles. */
export function redact(
  value: unknown,
  keys: readonly string[] = REDACT_KEYS,
  seen = new WeakSet<object>(),
): unknown {
  if (value === null || typeof value !== "object") {
    return typeof value === "bigint" ? value.toString() : value;
  }
  if (value instanceof Uint8Array) return `[bytes ${value.length}]`;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(redact({ ...value }, keys, seen) as object),
    };
  }
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, keys, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = shouldRedact(k, keys) ? REDACTED : redact(v, keys, seen);
  }
  return out;
}

function defaultSink(level: Exclude<LogLevel, "silent">, line: string): void {
  if (level === "warn" || level === "error") {
    process.stderr.write(`${line}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
}

class ConsoleLogger implements Logger {
  readonly level: LogLevel;
  readonly #json: boolean;
  readonly #keys: readonly string[];
  readonly #sink: NonNullable<LoggerOptions["sink"]>;
  readonly #clock: () => Date;
  readonly #bindings: LogFields;

  constructor(options: LoggerOptions, bindings: LogFields = {}) {
    this.level = options.level ?? "info";
    this.#json = options.json ?? false;
    this.#keys = [...REDACT_KEYS, ...(options.redact ?? []).map((k) => k.toLowerCase())];
    this.#sink = options.sink ?? defaultSink;
    this.#clock = options.clock ?? (() => new Date());
    this.#bindings = bindings;
    this.options = options;
  }

  private readonly options: LoggerOptions;

  debug(message: string, fields?: LogFields): void {
    this.emit("debug", message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.emit("info", message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.emit("warn", message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.emit("error", message, fields);
  }

  child(bindings: LogFields): Logger {
    return new ConsoleLogger(this.options, { ...this.#bindings, ...bindings });
  }

  private emit(level: Exclude<LogLevel, "silent">, message: string, fields?: LogFields): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.level]) return;
    const safe = redact({ ...this.#bindings, ...fields }, this.#keys) as Record<string, unknown>;
    const time = this.#clock().toISOString();
    if (this.#json) {
      this.#sink(level, JSON.stringify({ time, level, msg: message, ...safe }));
      return;
    }
    const extras = Object.keys(safe).length > 0 ? ` ${JSON.stringify(safe)}` : "";
    this.#sink(level, `${time} ${level.toUpperCase().padEnd(5)} ${message}${extras}`);
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  return new ConsoleLogger(options);
}

class NoopLogger implements Logger {
  readonly level: LogLevel = "silent";
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  child(): Logger {
    return this;
  }
}

export const noopLogger: Logger = new NoopLogger();
