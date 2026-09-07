#!/usr/bin/env node
/**
 * 打包脚本:构建 CLI bundle + console bundle → dist/ 目录(供 GitHub Release 上传)。
 * 用法: node scripts/package.mjs
 */
import { execSync } from 'node:child_process';
import { mkdirSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist-release');
mkdirSync(DIST, { recursive: true });

console.log('>>> 构建 CLI bundle...');
execSync('node ../../node_modules/esbuild/bin/esbuild src/main.ts --bundle --outfile=../../dist-release/qlong-cli.mjs --format=esm --platform=node --alias:@qlong/core=../core/src/index.ts', {
  cwd: join(ROOT, 'packages/cli'), stdio: 'inherit',
});

console.log('>>> 构建 Console bundle...');
execSync('node ../../node_modules/esbuild/bin/esbuild src/main.tsx --bundle --outfile=../../dist-release/console-bundle.js --format=esm --jsx=automatic --loader:.css=empty', {
  cwd: join(ROOT, 'packages/console'), stdio: 'inherit',
});
copyFileSync(join(ROOT, 'packages/console/index.html'), join(DIST, 'console.html'));

console.log('>>> 生成 SHA256SUMS.txt(发布物校验和,评审 I-16)...');
{
  const { readdirSync, statSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const lines = [];
  for (const name of readdirSync(DIST).sort()) {
    const fp = join(DIST, name);
    if (!statSync(fp).isFile() || name === 'SHA256SUMS.txt') continue;
    const h = createHash('sha256').update(readFileSync(fp)).digest('hex');
    lines.push(`${h}  ${name}`);
  }
  writeFileSync(join(DIST, 'SHA256SUMS.txt'), lines.join('
') + '
');
}

console.log('>>> 写入版本信息...');
const pkg = JSON.parse(await import('node:fs').then(m => m.readFileSync(join(ROOT, 'package.json'), 'utf8')));
writeFileSync(join(DIST, 'VERSION.txt'), `qlong v${pkg.version ?? '0.2.0'}\nBuilt: ${new Date().toISOString()}\n`);

console.log('>>> 打包完成: dist-release/');
console.log('  - qlong-cli.mjs (CLI 单文件)');
console.log('  - console-bundle.js (控制台 JS)');
console.log('  - console.html (控制台入口)');
console.log('  - VERSION.txt');
console.log('  - SHA256SUMS.txt(安装脚本校验用)');