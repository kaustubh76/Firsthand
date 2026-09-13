import { makeTsupConfig } from "../../tooling/tsup.base.ts";

// Dev-only package consumed by vitest and forge: ESM is sufficient, Node platform for fs access.
export default makeTsupConfig({
  entry: ["src/index.ts"],
  overrides: { platform: "node", format: ["esm"] },
});
