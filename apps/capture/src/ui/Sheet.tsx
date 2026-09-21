import { type ReactNode, useEffect, useRef } from "react";
import { Icon } from "./Icon.js";

/**
 * A modal sheet on the native <dialog>: focus is trapped and returned by the browser, Escape and a
 * tap on the backdrop close it. Slides up from the bottom on a phone, centres on a laptop.
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      heading.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-labelledby="sheet-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      // A tap on the backdrop lands on the dialog element itself; Escape is the keyboard route.
      onPointerDown={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="sheet-head">
        <h2 id="sheet-title" ref={heading} tabIndex={-1}>
          {title}
        </h2>
        <button type="button" className="btn copy" aria-label="Close settings" onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      <div className="sheet-body">{open && children}</div>
    </dialog>
  );
}
