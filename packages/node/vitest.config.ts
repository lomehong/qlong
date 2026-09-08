import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// exFAT 不支持 symlink → 不用 workspace:* 依赖,以路径别名接入兄弟包
export default defineConfig({
  resolve: {
    alias: {
      '@qlong/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
      '@qlong/registry': fileURLToPath(new URL('../registry/src/index.ts', import.meta.url)),
      '@qlong/gateway': fileURLToPath(new URL('../gateway/src/index.ts', import.meta.url)),
    },
  },
  test: {
    // node 包大量真实子进程/网络测试,Windows 并行高负载下偶发抖动 → 失败自动重试一次
    retry: 1,
  },
});
