import { defineConfig } from 'drizzle-kit';

// drizzle-kit runs outside the Nest runtime (CLI), so load .env manually.
// Optional: CI provides DATABASE_URL through the environment instead of a file.
try {
  process.loadEnvFile();
} catch {
  // no .env file — rely on the ambient environment
}

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    'DATABASE_URL is not set — copy .env.example to .env (or export it) before running drizzle-kit.',
  );
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url },
});
