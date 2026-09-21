import type { ReactNode } from "react";
import { useTx } from "../hooks/useTx.js";
import type { Failure } from "../lib/failures.js";
import { Button, Pill } from "../ui/index.js";

/**
 * Brand, the status strip, the pending-transaction count and whatever tools the frame adds (the
 * settings gear). The out-of-gas banner lives here because it concerns every screen.
 */
export function Header({
  status,
  tools,
  outOfGas,
  onDismissOutOfGas,
}: {
  status: ReactNode;
  tools?: ReactNode;
  outOfGas: Failure | null;
  onDismissOutOfGas: () => void;
}) {
  const tx = useTx();
  return (
    <header className="masthead">
      <div className="brand-block">
        <span className="brand">
          <span className="brand-mark" aria-hidden="true">
            F
          </span>
          FIRSTHAND
        </span>
        <span className="tagline">
          the data locker that can prove what's inside it — deposit · query · rescind
        </span>
      </div>
      <div className="masthead-tools">
        {tx.pendingCount > 0 && (
          <Pill tone="pending" dot>
            {tx.pendingCount} pending
          </Pill>
        )}
        {tools}
      </div>
      <div className="status-row">{status}</div>
      {outOfGas && (
        <p className="banner" role="alert" data-testid="out-of-gas">
          The venue's relayer is out of gas — nothing can be written on chain until its operator
          tops it up. Reading, verifying and the evidence still work.{" "}
          <Button variant="inline" onClick={onDismissOutOfGas}>
            dismiss
          </Button>
        </p>
      )}
    </header>
  );
}
