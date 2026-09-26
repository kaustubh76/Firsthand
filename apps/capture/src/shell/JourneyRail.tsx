import { useLocalStorage } from "../hooks/useLocalStorage.js";
import { type JourneyStep, journeyProgress } from "../lib/journey.js";
import { JUDGES_URL } from "../lib/links.js";
import { Button, Icon } from "../ui/index.js";
import { useNavigation } from "./navigation.js";

/**
 * Readme §19 as the way around the app: seven beats, lit by real state. A <section> with links —
 * never a <nav>, never buttons — because the browser tier treats <nav> as "unlocked" and clicks
 * nav buttons by name without scoping.
 */
export function JourneyRail({ steps }: { steps: readonly JourneyStep[] }) {
  const nav = useNavigation();
  const [collapsed, setCollapsed] = useLocalStorage<boolean>("firsthand.rail", false, (raw) =>
    typeof raw === "boolean" ? raw : null,
  );
  const progress = journeyProgress(steps);
  return (
    <section
      className="journey"
      aria-label="The three-minute script"
      data-collapsed={collapsed || undefined}
    >
      <div className="journey-head">
        <span>
          The script · {progress.done}/{progress.total}
        </span>
        {/* A progress counter for a script nobody has been told about orients no one. */}
        <span className="hint">
          deposit · query · rescind, in seven beats — each one lit by what has actually happened on
          chain, not by having clicked it.{" "}
          <a href={JUDGES_URL} target="_blank" rel="noreferrer">
            the walkthrough
          </a>
        </span>
        <Button
          variant="ghost"
          size="sm"
          icon="chevron"
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Show the script" : "Hide the script"}
          onClick={() => setCollapsed((c) => !c)}
        />
      </div>
      <ol className="journey-list">
        {steps.map((s, i) => {
          const reachable = s.route !== null && s.status !== "blocked";
          const inner = (
            <>
              <span className="beat-num" aria-hidden="true">
                {s.status === "done" ? <Icon name="check" /> : i + 1}
              </span>
              <span className="beat-text">
                <span className="beat-title">{s.title}</span>
                <span className="beat-hint">{s.blockedBy ?? s.hint}</span>
              </span>
            </>
          );
          return (
            <li key={s.id} className="beat" data-status={s.status}>
              {reachable && s.route ? (
                <a
                  href={`#${s.route}`}
                  aria-current={s.status === "current" ? "step" : undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    nav.go(s.route as NonNullable<typeof s.route>, s.target ?? undefined);
                  }}
                >
                  {inner}
                </a>
              ) : (
                <span aria-current={s.status === "current" ? "step" : undefined}>{inner}</span>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
