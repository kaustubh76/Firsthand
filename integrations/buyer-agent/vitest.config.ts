import { makeVitestConfig } from "../../tooling/vitest.base.ts";

export default makeVitestConfig({
  name: "buyer-agent",
  // Below the measured floor (functions 42.9 %), not above it: the gate exists to stop this package
  // sliding back to the zero it sat at, not to claim a number it does not have. The chain-bound half
  // is proven by the browser tier, which imports these same functions — see the README.
  threshold: 40,
  coverageExclude: ["src/buy.ts"],
});
