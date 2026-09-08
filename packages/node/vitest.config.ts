import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// exFAT 不支持 symlink → 不用 workspace:* 依赖,以路径别名接入 @qlong/core
export default defineConfig({
  resolve: {
    alias: {
      '@qlong/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
    },
  },
});