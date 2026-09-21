import type { HTMLAttributes, ReactNode } from "react";

export type PillTone = "neutral" | "ok" | "warn" | "bad" | "info" | "accent" | "pending";

/** A status word. Class `pill`, never `status` — the browser tier owns that class. */
export function Pill({
  tone = "neutral",
  dot = false,
  children,
  className,
  ...rest
}: {
  tone?: PillTone | undefined;
  dot?: boolean | undefined;
  children: ReactNode;
  className?: string | undefined;
} & Omit<HTMLAttributes<HTMLSpanElement>, "className" | "children">) {
  return (
    <span
      className={className ? `pill ${className}` : "pill"}
      data-tone={tone === "neutral" ? undefined : tone}
      {...rest}
    >
      {dot && <span className="pill-dot" aria-hidden="true" />}
      {children}
    </span>
  );
}
