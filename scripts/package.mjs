#!/usr/bin/env node
/**
 * 打包脚本:构建 CLI bundle + console bundle → dist-release/<版本>/ 与 dist-release/latest/。
 * 版本化(多版本安装):qlong server --dist-dir 可同时托管多个版本目录,
 * 安装脚本经 /releases/<版本>/<文件> 下载,默认 latest。
 * 用法: node scripts/package.mjs
 */
import { execSync } from 'node:child_process';
import { mkdirSync, copyFileSync, writeFileSync, readFileSync, readdirSync, statSync, chmodSync, rmSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist-release');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const VERSION = process.env.QLONG_RELEASE_VERSION ?? pkg.version ?? '0.0.0';

/** 构建产物到一个目录(CLI bundle + console + 安装脚本 + 入口页 + 版本信息 + 校验和) */
async function writeRelease(dir) {
  mkdirSync(dir, { recursive: true });
  const rel = (p) => join(dir, p);

  console.log('  >>> 构建 CLI bundle...');
  execSync(`node ../../node_modules/esbuild/bin/esbuild src/main.ts --bundle --outfile=${JSON.stringify(rel('qlong-cli.mjs'))} --format=esm --platform=node --alias:@qlong/core=../core/src/index.ts`, {
    cwd: join(ROOT, 'packages/cli'), stdio: 'inherit',
  });

  console.log('  >>> 构建 Console bundle...');
  execSync(`node ../../node_modules/esbuild/bin/esbuild src/main.tsx --bundle --outfile=${JSON.stringify(rel('console-bundle.js'))} --format=esm --jsx=automatic --loader:.css=empty`, {
    cwd: join(ROOT, 'packages/console'), stdio: 'inherit',
  });
  copyFileSync(join(ROOT, 'packages/console/index.html'), rel('console.html'));

  console.log('  >>> 携带安装脚本(版本与产物严格同源)...');
  copyFileSync(join(ROOT, 'scripts/install.sh'), rel('install.sh'));
  copyFileSync(join(ROOT, 'scripts/install.ps1'), rel('install.ps1'));

  console.log('  >>> 产出平台产物(评审 I-22:平台矩阵)...');
  const cliPath = rel('qlong-cli.mjs');
  let cli = readFileSync(cliPath, 'utf8');
  if (!cli.startsWith('#!')) cli = '#!/usr/bin/env node\n' + cli;
  writeFileSync(cliPath, cli);
  // unix:同一 bundle + shebang,按平台命名(需目标机 node ≥ 20)
  for (const name of ['qlong-linux-x64', 'qlong-linux-arm64', 'qlong-darwin-x64', 'qlong-darwin-arm64']) {
    const fp = join(dir, name);
    writeFileSync(fp, cli);
    chmodSync(fp, 0o755);
  }
  // windows:cmd 垫片(经 PATH 调用本机 node)
  writeFileSync(join(dir, 'qlong-win-x64.cmd'), '@echo off\r\nnode "%~dp0qlong-cli.mjs" %*\r\n');

  // 入口页(纪要 §4:https://qlong.qianji.io/install 的落地页;token 在控制台生成)
  writeFileSync(rel('install.html'), installHtml());

  console.log('  >>> 写入版本信息...');
  writeFileSync(rel('VERSION.txt'), `qlong v${VERSION}\nBuilt: ${new Date().toISOString()}\n`);

  console.log('  >>> 生成 SHA256SUMS.txt(发布物校验和,评审 I-16)...');
  const lines = [];
  for (const name of readdirSync(dir).sort()) {
    const fp = join(dir, name);
    if (!statSync(fp).isFile() || name === 'SHA256SUMS.txt') continue;
    const h = createHash('sha256').update(readFileSync(fp)).digest('hex');
    lines.push(`${h}  ${name}`);
  }
  writeFileSync(rel('SHA256SUMS.txt'), lines.join('\n') + '\n');
}

/** /install 落地页:三平台安装命令 + 邀请码替换(纪要 §4 流程的页面侧) */
function installHtml() {
  const unix = `curl -fsSL https://qlong.qianji.io/install.sh -o /tmp/qlong-install.sh && echo "<邀请码>" | sh /tmp/qlong-install.sh --enroll-stdin`;
  const win = `irm https://qlong.qianji.io/install.ps1 -OutFile "$env:TEMP\\qlong-install.ps1"; Install-Qlong -EnrollToken "<邀请码>"`;
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>群龙 · 安装节点</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:system-ui,sans-serif;max-width:880px;margin:48px auto;padding:0 20px;background:#0d1117;color:#c9d1d9}
code,pre{background:#161b22;border:1px solid #30363d;border-radius:6px;color:#7ee787}
pre{padding:14px;overflow-x:auto;white-space:pre-wrap}
h1 a{color:inherit;text-decoration:none}.token{width:340px;padding:8px;background:#161b22;border:1px solid #30363d;border-radius:6px;color:#c9d1d9}
button{padding:8px 14px;border:0;border-radius:6px;background:#238636;color:#fff;cursor:pointer}
p.hint{color:#8b949e;font-size:13px}</style></head><body>
<h1>🐉 群龙 · 安装节点 <a href="https://github.com/lomehong/qlong">ⓘ</a></h1>
<p>在下方填入邀请码(控制台 → 节点安装 → 生成邀请码),然后复制对应平台的命令到目标设备执行。</p>
<p><input class="token" id="tk" placeholder="粘贴邀请码(enroll token)"></p>
<h2>Linux / macOS</h2>
<pre id="c-unix">${unix}</pre>
<h2>Windows (PowerShell)</h2>
<pre id="c-win">${win}</pre>
<p class="hint">脚本会:下载产物 → SHA256 校验 → 注册入网 → 注册自启服务 → 验收入网状态。卸载:qlong --uninstall(含凭证清除)。</p>
<p class="hint">固定版本安装:命令中追加 <code>--version vX.Y.Z</code>(或环境变量 QLONG_VERSION)。</p>
<script>
const tk = document.getElementById('tk');
function refresh(){
  const t = tk.value.trim() || '<邀请码>';
  document.getElementById('c-unix').textContent = document.getElementById('c-unix').textContent.replace(/echo "[^"]*" \\|/, 'echo "' + t + '" |').replace('<邀请码>', t);
  document.getElementById('c-win').textContent = document.getElementById('c-win').textContent.replace(/-EnrollToken "[^"]*"/, '-EnrollToken "' + t + '"');
}
tk.addEventListener('input', refresh);
</script></body></html>`;
}

// ---- 主流程:产出到 <版本>/ 并镜像到 latest/(多版本共存,安装脚本按版本取) ----
mkdirSync(DIST, { recursive: true });
const versionDir = join(DIST, VERSION);
rmSync(versionDir, { recursive: true, force: true });
await writeRelease(versionDir);

const latestDir = join(DIST, 'latest');
rmSync(latestDir, { recursive: true, force: true });
cpSync(versionDir, latestDir, { recursive: true });

console.log(`>>> 打包完成: dist-release/${VERSION}/ 与 dist-release/latest/`);
console.log('  - qlong-cli.mjs / 平台产物(qlong-{linux,darwin}-{x64,arm64} / qlong-win-x64.cmd)');
console.log('  - console-bundle.js + console.html(控制台)');
console.log('  - install.sh / install.ps1 / install.html(书坊分发)');
console.log('  - VERSION.txt / SHA256SUMS.txt');
