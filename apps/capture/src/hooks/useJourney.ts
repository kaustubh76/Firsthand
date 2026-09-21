import { useMemo } from "react";
import { deriveJourney, type JourneyInputs, type JourneyStep } from "../lib/journey.js";

/** The journey as state; callers memoise the inputs (the journal snapshot changes on every save). */
export function useJourney(inputs: JourneyInputs): readonly JourneyStep[] {
  return useMemo(() => deriveJourney(inputs), [inputs]);
}
