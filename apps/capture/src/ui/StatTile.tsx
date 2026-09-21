import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon.js";
import { Skeleton } from "./Skeleton.js";

export function StatTile({
  label,
  value,
  hint,
  tone,
  icon,
  loading = false,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "neutral" | "ok" | "warn" | "bad" | "accent" | undefined;
  icon?: IconName | undefined;
  loading?: boolean | undefined;
}) {
  return (
    <div className="tile" data-tone={tone && tone !== "neutral" ? tone : undefined}>
      <span className="tile-label">
        {icon && <Icon name={icon} />}
        {label}
      </span>
      <span className="tile-value">
        {loading ? <Skeleton inline width="4rem" height="1.2em" /> : value}
      </span>
      {hint && <span className="tile-hint">{hint}</span>}
    </div>
  );
}
