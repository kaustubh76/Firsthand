import { makeVitestConfig } from "../../tooling/vitest.base.ts";

export default makeVitestConfig({
  name: "importers",
  threshold: 85,
  coverageExclude: ["src/cli.ts"],
});
