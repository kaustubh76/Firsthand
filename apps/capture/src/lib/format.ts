/** Small formatters the screens share; pure so they are unit-tested in Node. */

export function relativeTime(atMs: number, nowMs: number = Date.now()): string {
  const s = Math.round((nowMs - atMs) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d} d ago`;
  return new Date(atMs).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KiB`;
  return `${(n / 1_048_576).toFixed(1)} MiB`;
}

export function formatMon(n: number): string {
  if (n === 0) return "0 MON";
  if (n < 0.01) return `${n.toFixed(4)} MON`;
  return `${n.toFixed(2)} MON`;
}

export function pluralise(n: number, one: string, many: string = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A unix timestamp (seconds, as the chain gives it) as a short local time. */
export function blockTime(seconds: bigint | number | string): string {
  const n = typeof seconds === "bigint" ? Number(seconds) : Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return "";
  return new Date(n * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
