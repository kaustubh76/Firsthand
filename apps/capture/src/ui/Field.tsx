import { type ReactNode, useId } from "react";

/**
 * A labelled control. The child receives the id the label points at, so tapping the words
 * focuses the input and assistive tech reads the label.
 */
export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null | undefined;
  children: (id: string) => ReactNode;
  className?: string | undefined;
}) {
  const id = useId();
  return (
    <div className={className ? `field ${className}` : "field"}>
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      {children(id)}
      {hint && !error && (
        <span className="field-hint" id={`${id}-hint`}>
          {hint}
        </span>
      )}
      {error && (
        <span className="field-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
