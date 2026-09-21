import type { HTMLAttributes, ReactNode } from "react";
import { Icon, type IconName } from "./Icon.js";

const ICON: Record<"info" | "warn" | "bad" | "ok", IconName> = {
  info: "info",
  warn: "alert",
  bad: "ban",
  ok: "check",
};

/**
 * A sentence with a tone. `bad` also carries the legacy `error` class: the browser tier reads
 * `.error` inside the activation card to check the out-of-gas wording.
 */
export function Notice({
  tone,
  children,
  className,
  ...rest
}: {
  tone: "info" | "warn" | "bad" | "ok";
  children: ReactNode;
  className?: string | undefined;
} & Omit<HTMLAttributes<HTMLDivElement>, "className" | "children">) {
  const classes = ["notice", tone === "bad" ? "error" : null, className ?? null]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={classes} data-tone={tone} role={tone === "bad" ? "alert" : undefined} {...rest}>
      <Icon name={ICON[tone]} />
      <div>{children}</div>
    </div>
  );
}
