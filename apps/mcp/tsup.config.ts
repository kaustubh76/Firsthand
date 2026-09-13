import { makeTsupConfig } from "../../tooling/tsup.base.ts";

export default makeTsupConfig({
  entry: ["src/index.ts"],
  overrides: {
    platform: "node",
    format: ["esm"],
    dts: false,
    banner: { js: "#!/usr/bin/env node" },
  },
});
