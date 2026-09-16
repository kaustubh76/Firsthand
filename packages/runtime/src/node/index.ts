/**
 * Node-only runtime helpers. Kept out of the root entry because the capture PWA imports
 * `@firsthand/runtime` in the browser, and a single `node:fs` import at module scope breaks the
 * bundle (the same trap as `@firsthand/adapters` root vs `/memory`).
 */
export type { LoadedEnv } from "./dotenv.js";
export { loadDotenv } from "./dotenv.js";
