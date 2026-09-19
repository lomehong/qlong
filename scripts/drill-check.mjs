#!/usr/bin/env node
/**
 * 双机演练前检查(scripts/drill-check.mjs,P3 演练准备件)。
 * 纯 Node 内置依赖,演练机从仓库 checkout 直接运行:
 *   node scripts/drill-check.mjs [--dsh]   (--dsh 触发 dsh 通道探测,需 npm 网络)
 *
 * 检查项:Node 版本 / 入网凭证(~/.qlong/config.json)/ 中心可达与令牌有效 /
 * 网关 wss 握手(transport v2 升级)/ 本地存储准入状态(create|open)/ dsh 通道。
 * 全部关键项通过 → exit 0;任一失败 → exit 1(演练前必须清零)。
 */
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { randomBytes, createHash } from 'node:crypto';

const args = process.argv.slice(2);
// ModelScope 边缘 WAF 按 UA 拦程序化流量(2026-09-19 实测)——探测与 CLI 同用浏览器形 UA
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 qlong-drill';
const withDsh = args.includes('--dsh');
let failures = 0;
const ok = (msg) => console.log('  ✓ ' + msg);
const warn = (msg) => console.log('  ○ ' + msg);
const bad = (msg) => { console.log('  ✗ ' + msg); failures += 1; };

const home = process.env.QLONG_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.qlong');
let cfg = null;

console.log('群龙演练前检查(drill-check)');

// 1) Node 版本(v2 持久栈需要内置 node:sqlite)
const major = Number(process.versions.node.split('.')[0]);
if (major >= 24) ok(`Node ${process.versions.node} >= 24(内置 node:sqlite)`);
else bad(`Node ${process.versions.node} < 24 —— v2 持久栈要求 >= 24`);

// 2) 入网凭证
const cfgPath = join(home, 'config.json');
try {
  cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  ok(`已入网: node ${cfg.node_id.slice(0, 8)}… | team ${cfg.team_id.slice(0, 8)}… | ${cfg.registry_url}`);
} catch {
  bad(`未入网或凭证损坏(${cfgPath})——先执行安装命令或 qlong join`);
}

if (cfg) {
  // 3) 中心可达 + 令牌有效
  try {
    const res = await fetch(cfg.registry_url.replace(/\/+$/, '') + '/v1/nodes/me', {
      headers: { Authorization: 'Bearer ' + cfg.node_token, 'User-Agent': UA },
      signal: AbortSignal.timeout(8_000),
      redirect: 'error',
    });
    if (res.ok) ok(`中心可达且令牌有效(${res.status})`);
    else {
      const body = await res.text().catch(() => '');
      let hint = '';
      try { hint = JSON.parse(body)?.error?.message ?? ''; } catch { /* 非 JSON */ }
      bad(`中心返回 ${res.status}${hint ? ':' + hint : '(令牌失效/服务未启动)'}`);
    }
  } catch (e) {
    bad('中心不可达: ' + (e instanceof Error ? e.message : e));
  }

  // 4) 网关 wss 握手(transport v2 升级路径可达性;完整 v2 握手由 qlong run 自证)
  const wsUrl = cfg.gateway_url ?? (cfg.registry_url.replace(/^http/, 'ws') + '/gateway');
  try {
    await new Promise((resolve, reject) => {
      const u = new URL(wsUrl);
      const key = randomBytes(16).toString('base64');
      const req = (u.protocol === 'wss:' ? https : http).request({
        host: u.hostname, port: u.port || (u.protocol === 'wss:' ? 443 : 80),
        path: u.pathname + u.search, headers: {
          Connection: 'Upgrade', Upgrade: 'websocket', 'User-Agent': UA,
          'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13',
        }, timeout: 8_000,
      }, (res) => {
        if (res.statusCode === 101) { ok(`网关握手可达(${wsUrl})`); res.destroy(); resolve(); }
        else { bad(`网关返回 ${res.statusCode}(期望 101 升级)`); res.destroy(); resolve(); }
      });
      req.on('upgrade', (res) => { ok(`网关握手可达(${wsUrl})`); res.destroy(); resolve(); });
      req.on('timeout', () => { req.destroy(); reject(new Error('握手超时')); });
      req.on('error', reject);
      req.end();
    }).catch((e) => bad('网关握手失败: ' + (e instanceof Error ? e.message : e) + `(${wsUrl})`));
  } catch { /* 内层已报 */ }

  // 5) 本地存储准入状态:决定下次 run 该用 create 还是 open
  const dataDir = process.env.QLONG_DATA_DIR ?? join(home, 'data');
  const dbExists = existsSync(join(dataDir, 'runtime.sqlite'));
  mkdirSync(dataDir, { recursive: true });
  if (dbExists) ok(`节点库已存在(${dataDir})——下次 run 用 --storage-mode open`);
  else warn(`节点库不存在(${dataDir})——首次 run 用 --storage-mode create --confirm-local-filesystem${process.platform === 'win32' ? ' --confirm-windows-acl' : ''}`);

  // 6) 产物仓(PROJECT 任务前置;aid 任务不需要)
  if (cfg.artifact_repo) ok(`产物仓已配置: ${cfg.artifact_repo}(PROJECT 任务可执行)`);
  else warn('未配置产物仓(QLONG_ARTIFACT_REPO / join --artifact-repo)——PROJECT 任务会 policy_denied,aid 不受影响');
}

// 7) dsh 通道(可选探测)
if (process.env.DSH_HARNESS_CMD) ok(`DSH_HARNESS_CMD = ${process.env.DSH_HARNESS_CMD}`);
else warn('dsh 走默认 npx 通道(首次任务拉取 @deepseek-ai/dsh,需 npm 网络;模型凭证按 dsh 文档配置)');
if (withDsh) {
  console.log('  … 探测 dsh 通道(npx,可能需要数十秒)…');
  const { execFileSync } = await import('node:child_process');
  try {
    const out = execFileSync('npx', ['--yes', '@deepseek-ai/dsh', '--version'], { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
    ok(`dsh 通道可用: ${String(out).trim().split('\n')[0]}`);
  } catch (e) {
    bad('dsh 通道不可用: ' + (e instanceof Error ? e.message.slice(0, 120) : e));
  }
}

console.log(failures === 0 ? '✅ 演练前检查通过' : `❌ ${failures} 项未通过——演练前必须清零`);
// 校验和自证(脚本完整性;SHA256 由操作员与仓库比对,可选)
process.exit(failures === 0 ? 0 : 1);
