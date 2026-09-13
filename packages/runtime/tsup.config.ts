import { makeTsupConfig } from "../../tooling/tsup.base.ts";

export default makeTsupConfig({ entry: ["src/index.ts"], overrides: { platform: "node" } });
