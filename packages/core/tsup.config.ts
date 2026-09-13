import { makeTsupConfig } from "../../tooling/tsup.base.ts";

export default makeTsupConfig({
  entry: [
    "src/index.ts",
    "src/errors.ts",
    "src/authority/index.ts",
    "src/split/index.ts",
    "src/merkle/index.ts",
    "src/passport/index.ts",
    "src/epoch/index.ts",
    "src/grant/index.ts",
    "src/schemas/index.ts",
  ],
});
