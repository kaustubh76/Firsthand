import { makeTsupConfig } from "../../tooling/tsup.base.ts";

export default makeTsupConfig({
  entry: [
    "src/index.ts",
    "src/prf/index.ts",
    "src/kdf/index.ts",
    "src/sign/index.ts",
    "src/envelope/index.ts",
    "src/wrap/index.ts",
  ],
});
