import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon.js";

export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon: IconName;
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <Icon name={icon} className="empty-icon" />
      <p className="empty-title">{title}</p>
      {hint && <p className="empty-hint">{hint}</p>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}
