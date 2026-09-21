import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Icon, type IconName } from "./Icon.js";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "inline";

/**
 * Every clickable action. `pending` swaps the label for `pendingLabel` (or the label itself)
 * behind a spinner and disables the button, so no tap is ever silent. Never emits `.error`.
 */
export function Button({
  children,
  variant = "secondary",
  size,
  pending = false,
  pendingLabel,
  icon,
  className,
  disabled,
  type = "button",
  ...rest
}: {
  children?: ReactNode;
  variant?: ButtonVariant | undefined;
  size?: "sm" | "md" | undefined;
  pending?: boolean | undefined;
  pendingLabel?: string | undefined;
  icon?: IconName | undefined;
  className?: string | undefined;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children">) {
  const classes = [
    "btn",
    `btn-${variant}`,
    size === "sm" ? "btn-sm" : null,
    icon && !children ? "btn-icon" : null,
    className ?? null,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type={type}
      className={classes}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      {...rest}
    >
      {pending ? <span className="spinner" aria-hidden="true" /> : icon && <Icon name={icon} />}
      {pending && pendingLabel ? pendingLabel : children}
    </button>
  );
}
