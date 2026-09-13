import { makeTsupConfig } from "../../tooling/tsup.base.ts";

export default makeTsupConfig({
  entry: ["src/index.ts", "src/memory/index.ts"],
  overrides: { platform: "node" },
});
