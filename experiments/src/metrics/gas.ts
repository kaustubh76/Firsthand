import type { AnchorRef } from "@firsthand/adapters";

/** H1 metric: anchor cost per 1k passports. Gas is only observable on real arms. */
export function anchorCostPer1k(
  anchors: readonly AnchorRef[],
  passportsPerBatch: number,
): number | null {
  const withGas = anchors.filter((a) => a.gasUsed !== null);
  if (withGas.length === 0) return null;
  const totalGas = withGas.reduce((sum, a) => sum + Number(a.gasUsed), 0);
  const passports = withGas.length * passportsPerBatch;
  return (totalGas / passports) * 1000;
}
