/** Collapses whitespace runs and trims — keeps hashes stable across export re-formatting. */
export function normaliseText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

export function toUnixSeconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
  }
  return null;
}
