import { defineConfig } from 'drizzle-kit';

// drizzle-kit runs outside the Nest runtime (CLI), so load .env manually.
// Optional: CI provides DATABASE_URL through the environment instead of a file.
try {
  process.loadEnvFile();
} catch {
  // no .env file — rely on the ambient environment
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL as string,
  },
});
