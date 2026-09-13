import { makeVitestConfig } from "../../tooling/vitest.base.ts";

export default makeVitestConfig({
  name: "sdk",
  threshold: 85,
  // Browser-only WebAuthn ceremony and RPC-backed readers are exercised by the capture PWA and
  // `test:testnet`, not by vitest (see README).
  coverageExclude: ["src/webauthn/**", "src/contracts/**", "src/browser.ts"],
});
