// Robust .env loader — loads from a path derived from this file's own location,
// NOT from process.cwd(). Works identically under systemd, `node dist/*.js`, or
// `npm run`, regardless of the working directory.
//
// Import this FIRST, before any module that reads process.env at load time.
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

// At runtime this file lives in dist/, so ../.env points at worker-instructor/.env
const here = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(here, "..", ".env");

if (existsSync(envPath)) {
  const result = config({ path: envPath });
  if (result.error) console.error(`[env] failed to parse ${envPath}: ${result.error.message}`);
  else console.log(`[env] loaded ${envPath}`);
} else {
  console.warn(`[env] no .env at ${envPath} (relying on process environment)`);
}
