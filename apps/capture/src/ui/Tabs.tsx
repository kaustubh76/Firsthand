import { Icon, type IconName } from "./Icon.js";

/** A segmented control with tab semantics; Left/Right arrows move between tabs. */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  "aria-label": ariaLabel,
}: {
  tabs: readonly { id: T; label: string; icon?: IconName | undefined }[];
  value: T;
  onChange: (id: T) => void;
  "aria-label": string;
}) {
  const move = (from: number, delta: number) => {
    const next = tabs[(from + delta + tabs.length) % tabs.length];
    if (next) onChange(next.id);
  };
  return (
    <div className="tabs" role="tablist" aria-label={ariaLabel}>
      {tabs.map((t, i) => (
        <button
          type="button"
          key={t.id}
          role="tab"
          className="tab"
          aria-selected={value === t.id}
          tabIndex={value === t.id ? 0 : -1}
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") move(i, 1);
            if (e.key === "ArrowLeft") move(i, -1);
          }}
        >
          {t.icon && <Icon name={t.icon} />}
          {t.label}
        </button>
      ))}
    </div>
  );
}
