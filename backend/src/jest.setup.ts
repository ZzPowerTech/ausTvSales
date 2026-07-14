import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import 'reflect-metadata';

// Load the local .env for tests that need a real database (e2e).
// We parse and assign via `process.env[k]` in JS (not process.loadEnvFile),
// because Jest's node test environment sandboxes `process.env` and the native
// loadEnvFile writes to the host process, which the test VM never sees.
// In CI there is no .env file — DATABASE_URL comes from the environment.
try {
  const content = readFileSync(join(__dirname, '..', '.env'), 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
} catch {
  // no .env present; rely on the ambient environment (CI)
}
