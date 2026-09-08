import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@qlong/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
      '@qlong/registry': fileURLToPath(new URL('../registry/src/index.ts', import.meta.url)),
    },
  },
});