/** Minimal JSON-RPC client for node-control methods viem does not wrap (anvil mining, txpool). */
export class JsonRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | undefined,
    message: string,
  ) {
    super(`${method}: ${message}`);
    this.name = "JsonRpcError";
  }
}

let nextId = 1;

export async function jsonRpc<T = unknown>(
  url: string,
  method: string,
  params: unknown[] = [],
  fetchFn: typeof fetch = fetch,
): Promise<T> {
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  const body = (await res.json()) as {
    result?: T;
    error?: { code?: number; message?: string };
  };
  if (body.error) throw new JsonRpcError(method, body.error.code, body.error.message ?? "error");
  return body.result as T;
}

/** True when the endpoint is an anvil node (the only one whose mining the harness may drive). */
export async function isAnvil(url: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    await jsonRpc(url, "anvil_nodeInfo", [], fetchFn);
    return true;
  } catch {
    return false;
  }
}
