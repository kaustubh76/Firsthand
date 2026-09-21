import { Button, Icon, Notice } from "../ui/index.js";

export function Unlock({
  onUnlock,
  busy,
  error,
}: {
  onUnlock: () => void;
  busy: boolean;
  error: string | null;
}) {
  return (
    <section className="hero">
      <div className="screen-head">
        <span className="eyebrow">Unlock</span>
        <h1>Your locker is behind your passkey.</h1>
        <p className="lede">
          Keys derive from the passkey's PRF output on every unlock; nothing is stored but the
          credential id.
        </p>
        <div className="hero-actions">
          <Button
            variant="primary"
            icon="fingerprint"
            onClick={onUnlock}
            pending={busy}
            pendingLabel="Waiting for passkey…"
          >
            Tap passkey
          </Button>
        </div>
        {error && <Notice tone="bad">{error}</Notice>}
      </div>
      <ul className="hero-facts">
        <li>
          <Icon name="lock" />
          <span>Same passkey, same principal, same locker — on any device it syncs to.</span>
        </li>
        <li>
          <Icon name="shield" />
          <span>Verifying a manifest or a passport needs no unlock at all.</span>
        </li>
      </ul>
    </section>
  );
}
