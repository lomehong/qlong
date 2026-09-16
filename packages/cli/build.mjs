import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

await build({
  entryPoints: [fileURLToPath(new URL('./src/main.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  target: 'node24',
  external: ['node:*'],
  format: 'esm',
  // 与 scripts/package.mjs 对齐:ws 等被捆绑的 CJS 依赖内部 require('events') 等
  // 裸内置模块,ESM 输出下需要真实 require(external 'node:*' 匹配不到裸名)
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
  outfile: fileURLToPath(new URL('./dist/cli.mjs', import.meta.url)),
  alias: { '@qlong/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)) },
});
console.log('cli bundled');