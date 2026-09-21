import { short } from "../lib/explorer.js";
import { CopyButton } from "./CopyButton.js";

/**
 * A 32-byte id, shortened, with the full value in `title` (the browser tier reads it from the
 * first `<code>` of a landed passport) and an optional copy button beside it.
 */
export function Hash({
  value,
  n = 10,
  copy = false,
  href,
}: {
  value: string;
  n?: number | undefined;
  copy?: boolean | undefined;
  href?: string | null | undefined;
}) {
  const code = (
    <code title={value} className="hex">
      {short(value, n)}
    </code>
  );
  if (!copy && !href) return code;
  return (
    <span className="hash">
      {href ? (
        <a href={href} target="_blank" rel="noreferrer">
          {code}
        </a>
      ) : (
        code
      )}
      {copy && <CopyButton text={value} />}
    </span>
  );
}
