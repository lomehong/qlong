import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { retry: 1 },
  resolve: {
    alias: {
      '@qlong/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
    },
  },
});