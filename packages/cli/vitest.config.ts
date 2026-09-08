import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// exFAT 不支持 symlink → 不用 workspace:* 依赖,以路径别名接入兄弟包
export default defineConfig({
  test: { retry: 1 },
  resolve: {
    alias: {
      '@qlong/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
      '@qlong/registry': fileURLToPath(new URL('../registry/src/index.ts', import.meta.url)),
      '@qlong/gateway': fileURLToPath(new URL('../gateway/src/index.ts', import.meta.url)),
      '@qlong/node': fileURLToPath(new URL('../node/src/index.ts', import.meta.url)),
    },
  },
});
