import { EventEmitter } from "node:events";
import { ConfigError, TransportError, ValidationError } from "@firsthand/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CircuitBreaker } from "./circuitBreaker.js";
import { loadEnv } from "./env.js";
import { createLogger, noopLogger, REDACTED, redact } from "./logger.js";
import { MemoryTokenBucketLimiter } from "./rateLimit.js";
import { backoffDelay, sleep, withRetry } from "./retry.js";
import { ShutdownRegistry } from "./shutdown.js";
import { TTLStore } from "./ttlStore.js";

describe("logger", () => {
  it("redacts secret-looking keys, bytes, bigints, errors and cycles", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic["self"] = cyclic;
    const out = redact({
      prf: "aa",
      nested: { privateKey: "bb", DEK: "cc", fine: 1n },
      bytes: new Uint8Array(3),
      err: new Error("boom"),
      list: [{ vaultKey: "dd" }],
      cyclic,
    }) as Record<string, unknown>;
    expect(out["prf"]).toBe(REDACTED);
    expect(out["nested"]).toEqual({ privateKey: REDACTED, DEK: REDACTED, fine: "1" });
    expect(out["bytes"]).toBe("[bytes 3]");
    expect(out["err"]).toMatchObject({ name: "Error", message: "boom" });
    expect(out["list"]).toEqual([{ vaultKey: REDACTED }]);
    expect((out["cyclic"] as Record<string, unknown>)["self"]).toBe("[Circular]");
  });

  it("emits text or json lines above the configured level, with child bindings", () => {
    const lines: string[] = [];
    const clock = () => new Date(0);
    const text = createLogger({
      level: "info",
      sink: (_l, line) => lines.push(line),
      clock,
      redact: ["token"],
    });
    text.debug("hidden");
    text.child({ svc: "gw" }).warn("careful", { token: "x", n: 2 });
    expect(lines).toEqual([
      '1970-01-01T00:00:00.000Z WARN  careful {"svc":"gw","token":"[REDACTED]","n":2}',
    ]);
    lines.length = 0;
    const json = createLogger({
      level: "debug",
      json: true,
      sink: (_l, line) => lines.push(line),
      clock,
    });
    json.info("hello");
    json.error("bad", { prk: "zz" });
    expect(JSON.parse(lines[0] as string)).toEqual({
      time: "1970-01-01T00:00:00.000Z",
      level: "info",
      msg: "hello",
    });
    expect(JSON.parse(lines[1] as string)).toMatchObject({ level: "error", prk: REDACTED });
    expect(json.level).toBe("debug");
  });

  it("default sink writes to stdout/stderr and noopLogger is inert", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const log = createLogger({ level: "debug" });
    log.debug("d");
    log.error("e");
    expect(out).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledTimes(1);
    out.mockRestore();
    err.mockRestore();
    noopLogger.info("x");
    expect(noopLogger.child({}).level).toBe("silent");
  });
});

describe("withRetry", () => {
  const noSleep = () => Promise.resolve();

  it("retries retryable FirsthandErrors with backoff and gives up after `retries`", async () => {
    let calls = 0;
    const delays: number[] = [];
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new TransportError("FH_TRANSPORT", "flaky");
        },
        { retries: 2, sleep: noSleep, jitter: false, onRetry: (_e, _a, d) => delays.push(d) },
      ),
    ).rejects.toThrow("flaky");
    expect(calls).toBe(3);
    expect(delays).toEqual([100, 200]);
  });

  it("does not retry non-retryable errors and returns on success", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new ValidationError("nope");
        },
        { sleep: noSleep },
      ),
    ).rejects.toThrow(ValidationError);
    expect(calls).toBe(1);
    await expect(
      withRetry(
        async (attempt) =>
          attempt < 1 ? Promise.reject(new TransportError("FH_TRANSPORT", "x")) : "ok",
        { sleep: noSleep },
      ),
    ).resolves.toBe("ok");
  });

  it("honours abort signals and jitter bounds", async () => {
    const ctl = new AbortController();
    ctl.abort(new Error("stop"));
    await expect(withRetry(async () => "never", { signal: ctl.signal })).rejects.toThrow("aborted");
    expect(backoffDelay(3, { baseMs: 100, factor: 2, maxMs: 500, jitter: false })).toBe(500);
    expect(backoffDelay(1, { baseMs: 100, random: () => 0.5 })).toBe(100);
    await expect(sleep(1)).resolves.toBeUndefined();
    const ctl2 = new AbortController();
    const p = sleep(10_000, ctl2.signal);
    ctl2.abort();
    await expect(p).rejects.toThrow("aborted");
    await expect(sleep(1, ctl2.signal)).rejects.toThrow("aborted");
  });
});

describe("CircuitBreaker", () => {
  it("opens after the threshold, fails fast, half-opens after reset, and closes on success", async () => {
    let now = 0;
    const changes: string[] = [];
    const cb = new CircuitBreaker({
      name: "rpc",
      failureThreshold: 2,
      resetMs: 100,
      now: () => now,
      onStateChange: (f, t) => changes.push(`${f}->${t}`),
    });
    const fail = () =>
      cb.execute(async () => {
        throw new Error("down");
      });
    await expect(fail()).rejects.toThrow("down");
    await expect(fail()).rejects.toThrow("down");
    expect(cb.state).toBe("open");
    await expect(cb.execute(async () => 1)).rejects.toMatchObject({ code: "FH_CIRCUIT_OPEN" });
    now = 100;
    expect(cb.state).toBe("half-open");
    await expect(fail()).rejects.toThrow("down");
    expect(cb.state).toBe("open");
    now = 200;
    await expect(cb.execute(async () => 42)).resolves.toBe(42);
    expect(cb.state).toBe("closed");
    expect(cb.failures).toBe(0);
    expect(changes).toEqual([
      "closed->open",
      "open->half-open",
      "half-open->open",
      "open->half-open",
      "half-open->closed",
    ]);
    cb.reset();
    expect(cb.state).toBe("closed");
  });

  it("ignores errors the predicate excludes", async () => {
    const cb = new CircuitBreaker({
      name: "x",
      failureThreshold: 1,
      isFailure: (e) => !(e instanceof ValidationError),
    });
    await expect(
      cb.execute(async () => {
        throw new ValidationError("bad input");
      }),
    ).rejects.toThrow(ValidationError);
    expect(cb.state).toBe("closed");
  });
});

describe("ShutdownRegistry", () => {
  it("runs hooks LIFO once, tolerates failures, and supports unregister", async () => {
    const order: string[] = [];
    const reg = new ShutdownRegistry({ timeoutMs: 50 });
    reg.register("a", () => {
      order.push("a");
    });
    const unregB = reg.register("b", async () => {
      order.push("b");
      throw new Error("b failed");
    });
    reg.register("c", async () => {
      order.push("c");
    });
    reg.register("slow", () => new Promise(() => {}));
    unregB();
    unregB();
    expect(reg.size).toBe(3);
    const first = reg.run("test");
    const second = reg.run("again");
    expect(second).toBe(first);
    await expect(first).rejects.toThrow("timed out");
    expect(order).toEqual(["c", "a"]);
    expect(reg.size).toBe(0);
  });

  it("installs signal handlers that run hooks then exit", async () => {
    const reg = new ShutdownRegistry();
    let ran = "";
    reg.register("x", (reason) => {
      ran = reason;
    });
    const fake = new EventEmitter() as unknown as NodeJS.Process;
    const exit = vi.fn();
    (fake as unknown as { exit: unknown }).exit = exit;
    reg.installSignalHandlers(fake, 3);
    (fake as unknown as EventEmitter).emit("SIGTERM");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(3));
    expect(ran).toBe("SIGTERM");
  });
});

describe("MemoryTokenBucketLimiter", () => {
  it("enforces capacity, refills over time, and evicts beyond maxKeys", async () => {
    let now = 0;
    const rl = new MemoryTokenBucketLimiter({
      capacity: 2,
      refillPerSecond: 1,
      now: () => now,
      maxKeys: 2,
    });
    expect(await rl.consume("a")).toMatchObject({ allowed: true, remaining: 1 });
    expect(await rl.consume("a")).toMatchObject({ allowed: true, remaining: 0 });
    const denied = await rl.consume("a");
    expect(denied.allowed).toBe(false);
    expect(denied.resetAt).toBe(1000);
    now = 1500;
    expect(await rl.consume("a")).toMatchObject({ allowed: true, remaining: 0 });
    await rl.consume("b");
    await rl.consume("c");
    expect(rl.size).toBe(2);
    expect(() => new MemoryTokenBucketLimiter({ capacity: 0, refillPerSecond: 1 })).toThrow(
      RangeError,
    );
    const frozen = new MemoryTokenBucketLimiter({ capacity: 1, refillPerSecond: 0 });
    await frozen.consume("k");
    expect((await frozen.consume("k")).resetAt).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("TTLStore", () => {
  it("expires entries, bounds size, and supports delete", () => {
    let now = 0;
    const store = new TTLStore<number>({ defaultTtlMs: 100, maxEntries: 2, now: () => now });
    store.set("a", 1);
    store.set("b", 2, 1000);
    expect(store.get("a")).toBe(1);
    expect(store.has("b")).toBe(true);
    now = 100;
    expect(store.get("a")).toBeUndefined();
    expect(store.size).toBe(1);
    store.set("c", 3);
    store.set("d", 4);
    expect(store.size).toBe(2);
    expect(store.has("b")).toBe(false); // evicted as oldest
    expect(store.delete("c")).toBe(true);
    expect(store.delete("zz")).toBe(false);
  });
});

describe("loadEnv", () => {
  it("returns typed config or aggregates every problem into a ConfigError", () => {
    const schema = z.object({ PORT: z.coerce.number().int().min(1), RPC: z.string().url() });
    expect(loadEnv(schema, { PORT: "8080", RPC: "http://x" })).toEqual({
      PORT: 8080,
      RPC: "http://x",
    });
    try {
      loadEnv(schema, { PORT: "0", RPC: "nope" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).message).toContain("PORT");
      expect((e as ConfigError).message).toContain("RPC");
      expect(((e as ConfigError).context["problems"] as string[]).length).toBe(2);
    }
  });
});
