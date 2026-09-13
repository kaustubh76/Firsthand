import { makeTsupConfig } from "../tooling/tsup.base.ts";

export default makeTsupConfig({
  entry: ["abi/index.ts", "ts/deployments.ts"],
  overrides: { outDir: "dist", clean: true },
});
