import { makeTsupConfig } from "../../tooling/tsup.base.ts";

// `src/server.ts` is also a library entry: the demo app embeds the real gateway in-process rather
// than reimplementing its routes, so the demo can never drift from what the service actually serves.
export default makeTsupConfig({
  entry: ["src/index.ts", "src/server.ts"],
  overrides: { platform: "node", format: ["esm"] },
});
