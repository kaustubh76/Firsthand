import type { ReactNode } from "react";
import { Button } from "../ui/index.js";

/**
 * Verify and Evidence before any passkey: a buyer, a judge, anyone with a link. The back control is
 * a plain paragraph, never a <nav> — that element means "unlocked" to the browser tier.
 */
export function PublicFrame({ onBack, children }: { onBack: () => void; children: ReactNode }) {
  return (
    <main>
      <p className="crumbs">
        <Button variant="inline" onClick={onBack}>
          ← back
        </Button>
        <span>No passkey needed here.</span>
      </p>
      {children}
    </main>
  );
}
