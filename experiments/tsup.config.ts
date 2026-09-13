import { makeTsupConfig } from "../tooling/tsup.base.ts";

export default makeTsupConfig({
  entry: ["src/cli.ts"],
  overrides: { platform: "node", format: ["esm"], dts: false },
});
