import type { ReactNode } from "react";
import { Icon } from "./Icon.js";

export type TimelineStatus =
  | "idle"
  | "running"
  | "done"
  | "failed"
  | "pending"
  | "chain"
  | "local"
  | "cut";

export interface TimelineItem {
  readonly id: string;
  readonly status: TimelineStatus;
  readonly title: ReactNode;
  readonly meta?: ReactNode;
  readonly body?: ReactNode;
  readonly testId?: string | undefined;
}

const MARK: Partial<Record<TimelineStatus, ReactNode>> = {
  done: <Icon name="check" />,
  chain: <Icon name="check" />,
  failed: <Icon name="x" />,
  cut: <Icon name="scissors" />,
};

/** Ordered events with a rail. `data-status` on each item is what the browser tier polls. */
export function Timeline({
  items,
  className,
  ...rest
}: {
  items: readonly TimelineItem[];
  className?: string | undefined;
  "data-testid"?: string | undefined;
}) {
  return (
    <ol className={className ? `timeline ${className}` : "timeline"} {...rest}>
      {items.map((item) => (
        <li key={item.id} className="tl-item" data-status={item.status} data-testid={item.testId}>
          <span className="tl-marker" aria-hidden="true">
            {MARK[item.status]}
          </span>
          <div className="tl-title">{item.title}</div>
          {item.meta && <div className="tl-meta">{item.meta}</div>}
          {item.body && <div className="tl-body">{item.body}</div>}
        </li>
      ))}
    </ol>
  );
}
