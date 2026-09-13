# @firsthand/runtime

Node-side infrastructure shared by services. No protocol logic.

| | |
|---|---|
| Responsibility | Redacting structured logger, `withRetry` (backoff + jitter), `CircuitBreaker`, LIFO `ShutdownRegistry`, `RateLimiter` port + memory token bucket, `TTLStore`, `loadEnv` (zod → aggregated `ConfigError`). |
| Holds secrets? | **No** — and its logger refuses to print keys named like secrets. |
| Runtime deps | `@firsthand/core`, `zod` |
