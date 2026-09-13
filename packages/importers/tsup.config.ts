import { makeTsupConfig } from "../../tooling/tsup.base.ts";

export default makeTsupConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  overrides: { platform: "node", banner: { js: "" } },
});
