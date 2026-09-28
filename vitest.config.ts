import { defineConfig } from 'vitest/config';
export default defineConfig({
  resolve: { alias: { 'server-only': new URL('./tests/server-only.ts', import.meta.url).pathname } },
  test: { include: ['tests/**/*.test.ts'], fileParallelism: false, testTimeout: 30000, hookTimeout: 60000 },
});
