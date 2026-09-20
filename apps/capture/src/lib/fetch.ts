/**
 * `fetch` for the app's reads of the gateway. A read is idempotent, so two things are worth a
 * retry: a connection that dropped (a hosted edge timing out), and a 503/429 with `retry-after`
 * — what the gateway answers when the chain RPC behind it is rate-limiting. Bound to the global:
 * a stored `fetch` invoked with another `this` is refused by browsers ("Illegal invocation").
 */
const base: typeof fetch = fetch.bind(globalThis);

export const readFetch: typeof fetch = async (input, init) => {
  const method = (init?.method ?? "GET").toUpperCase();
  const idempotent = method === "GET" || method === "HEAD";
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await base(input, init);
    } catch (error) {
      if (!idempotent || attempt >= 2) throw error;
      await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
      continue;
    }
    if (idempotent && (res.status === 503 || res.status === 429) && attempt < 3) {
      const after = Number(res.headers.get("retry-after"));
      await new Promise((r) =>
        setTimeout(r, Math.min(5_000, (Number.isFinite(after) && after > 0 ? after : 2) * 1_000)),
      );
      continue;
    }
    return res;
  }
};
