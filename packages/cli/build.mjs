import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

await build({
  entryPoints: [fileURLToPath(new URL('./src/main.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: fileURLToPath(new URL('./dist/cli.mjs', import.meta.url)),
  alias: { '@qlong/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)) },
});
console.log('cli bundled');