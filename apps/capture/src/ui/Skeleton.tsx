/** A shimmer where a chain read is still on its way. Hidden from assistive tech. */
export function Skeleton({
  lines = 1,
  width,
  height,
  inline = false,
}: {
  lines?: number | undefined;
  width?: string | undefined;
  height?: string | undefined;
  inline?: boolean | undefined;
}) {
  if (inline) {
    return <span className="skeleton inline" aria-hidden="true" style={{ width, height }} />;
  }
  return (
    <div className="skeleton" aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <span
          key={i}
          className="skeleton-line"
          style={{ width: i === lines - 1 && lines > 1 ? "60%" : width, height }}
        />
      ))}
    </div>
  );
}
