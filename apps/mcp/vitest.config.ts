import { makeVitestConfig } from "../../tooling/vitest.base.ts";

export default makeVitestConfig({
  name: "mcp",
  coverageExclude: ["src/index.ts", "src/config.ts"],
});
