/** Block-explorer links for the chains the app runs against; `null` where none exists (anvil). */
const EXPLORERS: Record<string, string> = { "10143": "https://testnet.monadexplorer.com" };

export function txUrl(chainId: bigint, hash: string): string | null {
  const base = EXPLORERS[chainId.toString()];
  return base ? `${base}/tx/${hash}` : null;
}

export function addressUrl(chainId: bigint, address: string): string | null {
  const base = EXPLORERS[chainId.toString()];
  return base ? `${base}/address/${address}` : null;
}

export const short = (hex: string, n = 10): string =>
  hex.length > 2 * n + 2 ? `${hex.slice(0, n + 2)}…${hex.slice(-n)}` : hex;
