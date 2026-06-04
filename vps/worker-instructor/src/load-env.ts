// Robust .env loader — loads the worker's .env from a path derived from this
// file's own location, NOT from process.cwd(). This makes the worker work
// identically whether launched by systemd, `node dist/index.js`, or `npm start`,
// and regardless of the current working directory.
//
// Import this FIRST, before any module that reads process.env at load time
// (e.g. ./supabase.js).
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

// At runtime this file lives in dist/, so ../.env points at worker-instructor/.env
const here = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(here, "..", ".env");

if (existsSync(envPath)) {
  const result = config({ path: envPath });
  if (result.error) {
    console.error(`[env] failed to parse ${envPath}: ${result.error.message}`);
  } else {
    console.log(`[env] loaded ${envPath}`);
  }
} else {
  // systemd may already inject vars via EnvironmentFile — only warn.
  console.warn(`[env] no .env file at ${envPath} (relying on process environment)`);
}
