import { useClipboard } from "../hooks/useClipboard.js";
import { Icon } from "./Icon.js";

/**
 * One tap copies. The accessible name defaults to "Copy" and callers must keep it free of the
 * words capture / locker / recall — the browser tier clicks nav buttons by those names unscoped.
 */
export function CopyButton({
  text,
  label = "Copy",
  className,
}: {
  text: string;
  label?: string | undefined;
  className?: string | undefined;
}) {
  const { copy, copied } = useClipboard();
  return (
    <button
      type="button"
      className={className ? `btn copy ${className}` : "btn copy"}
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      data-copied={copied || undefined}
      onClick={() => void copy(text)}
    >
      <Icon name={copied ? "check" : "copy"} />
    </button>
  );
}
