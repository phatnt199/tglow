import type { Config } from 'drizzle-kit';

export default {
  schema: './src/core/cache/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
} satisfies Config;
