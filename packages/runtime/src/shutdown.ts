import type { Logger } from "./logger.js";
import { noopLogger } from "./logger.js";

/**
 * LIFO shutdown registry: resources register in the order they start and are torn down in reverse.
 * A hook that throws does not stop the others; failures are logged and the first is rethrown.
 */
export type ShutdownHook = (reason: string) => Promise<void> | void;

export interface ShutdownOptions {
  readonly logger?: Logger;
  /** Per-hook timeout. Default 10 s. */
  readonly timeoutMs?: number;
}

export class ShutdownRegistry {
  readonly #hooks: { name: string; hook: ShutdownHook }[] = [];
  readonly #logger: Logger;
  readonly #timeoutMs: number;
  #running: Promise<void> | null = null;

  constructor(options: ShutdownOptions = {}) {
    this.#logger = options.logger ?? noopLogger;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  register(name: string, hook: ShutdownHook): () => void {
    const entry = { name, hook };
    this.#hooks.push(entry);
    return () => {
      const i = this.#hooks.indexOf(entry);
      if (i !== -1) this.#hooks.splice(i, 1);
    };
  }

  get size(): number {
    return this.#hooks.length;
  }

  /** Runs every hook once, most recent first. Concurrent calls share the same run. */
  run(reason: string): Promise<void> {
    if (this.#running === null) this.#running = this.execute(reason);
    return this.#running;
  }

  /** Wires SIGINT/SIGTERM (and unhandled errors) to `run`, then exits with the given code. */
  installSignalHandlers(proc: NodeJS.Process = process, exitCode = 0): void {
    const handle = (signal: string) => {
      this.run(signal)
        .catch(() => undefined)
        .finally(() => proc.exit(exitCode));
    };
    proc.once("SIGINT", () => handle("SIGINT"));
    proc.once("SIGTERM", () => handle("SIGTERM"));
  }

  private async execute(reason: string): Promise<void> {
    let firstError: unknown;
    for (const { name, hook } of [...this.#hooks].reverse()) {
      this.#logger.info("shutdown hook", { hook: name, reason });
      try {
        await Promise.race([
          hook(reason),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`shutdown hook ${name} timed out`)),
              this.#timeoutMs,
            ).unref?.(),
          ),
        ]);
      } catch (error) {
        this.#logger.error("shutdown hook failed", { hook: name, error });
        firstError ??= error;
      }
    }
    this.#hooks.length = 0;
    if (firstError !== undefined) throw firstError;
  }
}
