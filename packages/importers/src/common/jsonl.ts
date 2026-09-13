/** Splits JSON Lines text into parsed rows, skipping blanks; throws with the line number on error. */
export function* parseJsonl(text: string): Generator<unknown> {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] as string).trim();
    if (line === "") continue;
    try {
      yield JSON.parse(line);
    } catch (cause) {
      throw new Error(`jsonl: invalid JSON on line ${i + 1}`, { cause });
    }
  }
}
