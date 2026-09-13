import type { LockerSession } from "@firsthand/sdk/browser";
import { useState } from "react";

export function LockerView({ session }: { session: LockerSession }) {
  const [, rerender] = useState(0);
  const batches = session.batcher.flushed();
  return (
    <section>
      <h1>Locker</h1>
      <p>
        principal <code>{session.locker.principalId}</code> · epoch{" "}
        {session.locker.currentEpoch().toString()} · pending {session.batcher.pendingCount()}
      </p>
      <button
        type="button"
        onClick={async () => {
          await session.flush();
          rerender((n) => n + 1);
        }}
        disabled={session.batcher.pendingCount() === 0}
      >
        Anchor pending batch
      </button>
      <ul>
        {batches.map((b) => (
          <li key={b.root}>
            ns {b.ns} · epoch {b.epoch.toString()} · {b.passports.length} passports · root{" "}
            <code>{b.root}</code>
          </li>
        ))}
      </ul>
    </section>
  );
}
