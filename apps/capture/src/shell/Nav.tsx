import { Icon } from "../ui/index.js";
import { ROUTES, type Route, useNavigation } from "./navigation.js";

/**
 * The one <nav> in the app, rendered only once the passkey has unlocked a session — the browser
 * tier treats its appearance as "unlocked". A bottom tab bar on a phone, a row on a laptop.
 */
export function Nav({ badges }: { badges?: Partial<Record<Route, number>> | undefined }) {
  const nav = useNavigation();
  return (
    <nav className="nav" aria-label="Sections">
      {ROUTES.map((r) => {
        const badge = badges?.[r.id] ?? 0;
        return (
          <button
            type="button"
            key={r.id}
            className="nav-btn"
            onClick={() => nav.go(r.id)}
            aria-current={nav.route === r.id}
          >
            <Icon name={r.icon} />
            <span>{r.label}</span>
            {badge > 0 && (
              <span className="nav-badge">
                {badge}
                <span className="visually-hidden"> waiting</span>
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
