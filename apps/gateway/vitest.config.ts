import { makeVitestConfig } from "../../tooling/vitest.base.ts";

export default makeVitestConfig({ name: "gateway", coverageExclude: ["src/index.ts"] });
