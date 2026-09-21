import type { AppConfig } from "../lib/config.js";
import { describeFloat, describeRollover, type GatewayHealth, rolloverIn } from "../lib/health.js";
import { describeLiveness, type Liveness } from "../lib/liveness.js";
import { Button } from "../ui/index.js";

const hostOf = (url: string | null): string => {
  try {
    return url ? new URL(url).host : "no gateway";
  } catch {
    return url ?? "no gateway";
  }
};

/**
 * The venue, in one line on every screen, so nobody mistakes the offline demo for the chain. The
 * element keeps its class, its data attributes and its text order — `live · chain N · host …` —
 * because the browser tier reads exactly those; the dot before the words is empty.
 */
export function StatusStrip({
  config,
  connecting,
  liveness,
  health,
  now,
  onRetry,
}: {
  config: AppConfig | null;
  connecting: { attempt: number; of: number } | null;
  liveness: Liveness;
  health: GatewayHealth | null;
  now: bigint;
  onRetry: () => void;
}) {
  const float = describeFloat(health);
  const rollover = config ? rolloverIn(config.epochs, now) : null;
  const text =
    config === null || connecting
      ? `connecting to gateway…${
          connecting && connecting.attempt > 1 ? ` (${connecting.attempt}/${connecting.of})` : ""
        }`
      : config.live
        ? `live · chain ${config.chainId} · ${hostOf(config.gatewayUrl)}${
            liveness.kind === "unknown" ? "" : ` · ${describeLiveness(liveness)}`
          }${rollover === null ? "" : ` · ${describeRollover(rollover)}`}`
        : `offline · ${config.reason}`;
  return (
    <p
      className="status"
      data-live={config?.live ?? "loading"}
      data-liveness={liveness.kind}
      data-relayer={health?.relayer ? (health.relayer.low ? "low" : "ok") : "unknown"}
    >
      <span className="dot" aria-hidden="true" />
      <span className="status-text">
        {text}
        {float && (
          <span className="float" data-testid="relayer-float">
            {" "}
            · {float}
          </span>
        )}
        {config && !config.live && !connecting && (
          <>
            {" "}
            <Button variant="inline" onClick={onRetry}>
              retry
            </Button>
          </>
        )}
      </span>
    </p>
  );
}
