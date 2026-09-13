import { makeVitestConfig } from "../tooling/vitest.base.ts";

export default makeVitestConfig({ name: "experiments", coverageExclude: ["src/cli.ts"] });
