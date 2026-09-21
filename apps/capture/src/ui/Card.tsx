import type { HTMLAttributes, ReactNode } from "react";
import { Icon, type IconName } from "./Icon.js";

export type Tone = "neutral" | "ok" | "warn" | "bad" | "accent";

/**
 * A titled surface. With an `id` it is also a jump target: the journey rail scrolls to it and
 * moves focus (tabIndex -1), so keyboard users land where the rail said they would.
 */
export function Card({
  title,
  subtitle,
  icon,
  actions,
  tone,
  id,
  compact,
  children,
  className,
  ...rest
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  icon?: IconName | undefined;
  actions?: ReactNode;
  tone?: Tone | undefined;
  id?: string | undefined;
  compact?: boolean | undefined;
  children?: ReactNode;
  className?: string | undefined;
} & Omit<HTMLAttributes<HTMLElement>, "title" | "className" | "id">) {
  const classes = ["card", compact ? "compact" : null, className ?? null].filter(Boolean).join(" ");
  return (
    <section
      className={classes}
      data-tone={tone && tone !== "neutral" ? tone : undefined}
      id={id}
      tabIndex={id ? -1 : undefined}
      {...rest}
    >
      {(title || actions) && (
        <header className="card-head">
          <div>
            {title && (
              <h2 className="card-title">
                {icon && <Icon name={icon} />}
                {title}
              </h2>
            )}
            {subtitle && <p className="card-sub">{subtitle}</p>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      <div className="card-body">{children}</div>
    </section>
  );
}
