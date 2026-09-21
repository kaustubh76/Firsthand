import type { Toast } from "../hooks/useToasts.js";
import { short } from "../lib/explorer.js";
import { CopyButton } from "./CopyButton.js";
import { Icon, type IconName } from "./Icon.js";

const ICON: Record<Toast["tone"], IconName> = {
  info: "info",
  success: "check",
  error: "alert",
  pending: "clock",
};

/**
 * The toast stack. The container ignores the pointer so a toast can never sit between a tap and
 * the button under it; only its own controls are interactive. Action labels stay free of the
 * words capture / locker / recall (the browser tier clicks nav buttons by those names unscoped).
 */
export function ToastHost({
  toasts,
  onDismiss,
}: {
  toasts: readonly Toast[];
  onDismiss: (id: number) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <section className="toasts" aria-live="polite" aria-label="Notifications">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="toast"
          data-tone={t.tone}
          role={t.tone === "error" ? "alert" : "status"}
        >
          {t.tone === "pending" ? (
            <span className="spinner icon" aria-hidden="true" />
          ) : (
            <Icon name={ICON[t.tone]} />
          )}
          <div className="toast-text">
            <span className="toast-title">{t.title}</span>
            {(t.detail || t.hash) && (
              <span className="toast-detail">
                {t.detail}
                {t.detail && t.hash ? " · " : ""}
                {t.hash && <code className="mono">{short(t.hash)}</code>}
              </span>
            )}
          </div>
          <div className="toast-actions">
            {t.hash && <CopyButton text={t.hash} label="Copy transaction hash" />}
            {t.action &&
              (t.action.href ? (
                <a
                  className="btn btn-inline"
                  href={t.action.href}
                  target="_blank"
                  rel="noreferrer"
                  onClick={t.action.onClick}
                >
                  {t.action.label}
                </a>
              ) : (
                <button type="button" className="btn btn-inline" onClick={t.action.onClick}>
                  {t.action.label}
                </button>
              ))}
            <button
              type="button"
              className="btn copy"
              aria-label="Dismiss notification"
              onClick={() => onDismiss(t.id)}
            >
              <Icon name="x" />
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}
