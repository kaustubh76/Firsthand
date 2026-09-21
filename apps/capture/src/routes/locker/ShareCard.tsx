import { lockerLink } from "../../lib/requests.js";
import { Card, CopyButton } from "../../ui/index.js";
import type { LockerCtx } from "./types.js";

/** A buyer starts from this link: what you published (never the plaintext), and a way to ask. */
export function ShareCard({ ctx }: { ctx: LockerCtx }) {
  const link = lockerLink(location.origin, ctx.session.locker.principalId);
  return (
    <Card
      id="locker-share"
      icon="link"
      title="Share your locker"
      subtitle="Lists what you published — never the plaintext — and lets an agent ask for access."
      actions={<CopyButton text={link} label="Copy link" />}
    >
      <code className="hex locker-link" data-testid="locker-link">
        {link}
      </code>
      <p className="hint">
        <code>firsthand_request_access</code> in the MCP takes the principal id from it.
      </p>
    </Card>
  );
}
