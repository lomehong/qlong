import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { newKeyPair } from '@qlong/core';
import { GitArtifactPublisher } from '../src/collab/artifact-publisher.js';
import { verifyManifest, verifyArtifactDelivery, type SignedManifest } from '../src/collab/artifact-manifest.js';
import type { RunFence, RunOutcome } from '../src/driver/run-handle.js';

/**
 * e2d-2d:GitArtifactPublisher 适配器——执行器完成路径事务外调用,读契约声明文件、构建并签署 manifest、
 * 异步发布到共享产物仓的每-attempt 分支,返回注入 body.artifacts 的新 outcome。真实 git + 真实文件 +
 * 真实 keypair:证明"真实子进程生成的文件能够形成可独立验签的交付,失败不伪装成功"(e2d-2 出口)。
 */
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const NODE_ID = randomUUID();

function fence(over: Partial<RunFence> = {}): RunFence {
  return { task_id: randomUUID(), attempt: 1, generation: 1, run_id: randomUUID(), ...over };
}

function bareRepo(base: string): string {
  const repo = join(base, 'shared.git');
  execFileSync('git', ['init', '--bare', '--quiet', repo], { stdio: 'pipe' });
  return repo;
}

/** 从指定分支导回产物字节(每-attempt 分支不被 collectArtifacts 的单分支覆盖)。 */
function readBranch(repo: string, branch: string, outDir: string): { files: string[]; bytes: (p: string) => Buffer } {
  mkdirSync(outDir, { recursive: true });
  const git = (a: string[]): Buffer =>
    execFileSync('git', a, { cwd: outDir, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['init', '--quiet', outDir], { stdio: 'pipe' });
  git(['fetch', '--quiet', '--depth', '1', repo, `refs/heads/${branch}:refs/heads/${branch}`]);
  const files = git(['ls-tree', '-r', '--name-only', branch]).toString('utf8').split('\n').filter(Boolean);
  return { files, bytes: (p: string) => git(['cat-file', 'blob', `${branch}:${p}`]) };
}

describe('GitArtifactPublisher(e2d-2d)', () => {
  it('T1: project + 真实产物文件 → 注入 artifacts(repo/signed manifest/每-attempt 分支),分支产物字节匹配、清单可独立验签', async () => {
    const base = mkdtempSync(join(tmpdir(), 'qlong-pub-'));
    try {
      const repo = bareRepo(base);
      const cwd = join(base, 'ws');
      mkdirSync(join(cwd, 'dist'), { recursive: true });
      const body = Buffer.from('# 真实子进程产物');
      writeFileSync(join(cwd, 'dist', 'report.md'), body);
      const { priv, publicKey } = newKeyPair();
      const pub = new GitArtifactPublisher({ repo, privKey: priv, nodeId: NODE_ID, keyEpoch: 3 });
      const f = fence();
      const outcome: RunOutcome = { kind: 'result', body: { status: 'done', summary: 'ok' } };

      const published = await pub.publish(f, {
        kind: 'project', summary: 'build', contract: { deliverables: [{ path: 'dist/report.md' }] },
      }, { cwd }, outcome);

      expect(published.kind).toBe('result');
      const artifacts = (published.body as { artifacts?: Array<{ repo: string; manifest: SignedManifest; branch: string }> }).artifacts;
      expect(artifacts).toHaveLength(1);
      expect(artifacts![0]!.repo).toBe(repo);
      expect(artifacts![0]!.branch).toBe(`qlong/${f.task_id}/a${f.attempt}`);
      // 清单以执行方私钥单独签名,登记公钥可独立验签(脱离信封/离线搬运仍成立)
      expect(verifyManifest(artifacts![0]!.manifest, publicKey)).toBe(true);
      expect(artifacts![0]!.manifest.manifest.node_id).toBe(NODE_ID);
      expect(artifacts![0]!.manifest.manifest.key_epoch).toBe(3);
      // 分支确实存在且产物字节经 git 传输后完整
      const got = readBranch(repo, artifacts![0]!.branch, join(base, 'out'));
      expect(got.files).toContain('dist/report.md');
      const collected = got.bytes('dist/report.md');
      expect(sha(collected)).toBe(artifacts![0]!.manifest.manifest.deliverables[0]!.sha256);
      expect(collected.toString()).toBe(body.toString());
      // 原 outcome.body 字段保留(仅追加 artifacts)
      expect(published.body).toMatchObject({ status: 'done', summary: 'ok' });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('T2: aid offer → outcome 原样返回,不做任何 git I/O(无分支推送)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'qlong-pub-aid-'));
    try {
      const repo = bareRepo(base);
      const { priv } = newKeyPair();
      const pub = new GitArtifactPublisher({ repo, privKey: priv, nodeId: NODE_ID, keyEpoch: 1 });
      const outcome: RunOutcome = { kind: 'result', body: { status: 'done' } };
      const published = await pub.publish(fence(), { kind: 'aid', summary: 'chat' }, { cwd: join(base, 'ws') }, outcome);
      expect(published).toEqual(outcome);
      expect((published.body as { artifacts?: unknown }).artifacts).toBeUndefined();
      // 远端仓无任何分支(aid 绝不触碰 git)
      const refs = execFileSync('git', ['ls-remote', '--heads', repo], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
      expect(refs.trim()).toBe('');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('T3: project 缺少 ctx.cwd → 抛错(拒绝发布,绝不伪造成功)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'qlong-pub-nocwd-'));
    try {
      const repo = bareRepo(base);
      const { priv } = newKeyPair();
      const pub = new GitArtifactPublisher({ repo, privKey: priv, nodeId: NODE_ID, keyEpoch: 1 });
      await expect(pub.publish(fence(), {
        kind: 'project', summary: 'build', contract: { deliverables: [{ path: 'a.md' }] },
      }, undefined, { kind: 'result', body: {} })).rejects.toThrow(/cwd|工作区/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('T4: 端到端独立性——牵头方从分支收取后 verifyArtifactDelivery 判定通过(可独立验签的交付)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'qlong-pub-e2e-'));
    try {
      const repo = bareRepo(base);
      const cwd = join(base, 'ws');
      mkdirSync(join(cwd, 'dist'), { recursive: true });
      const body = Buffer.from('deliverable bytes');
      writeFileSync(join(cwd, 'dist', 'report.md'), body);
      const { priv, publicKey } = newKeyPair();
      const pub = new GitArtifactPublisher({ repo, privKey: priv, nodeId: NODE_ID, keyEpoch: 2 });
      const f = fence();
      const contract = { deliverables: [{ path: 'dist/report.md' }] };
      const published = await pub.publish(f, { kind: 'project', summary: 'b', contract }, { cwd },
        { kind: 'result', body: { status: 'done' } });
      const art = (published.body as { artifacts: Array<{ manifest: SignedManifest; branch: string }> }).artifacts[0]!;

      // 牵头方独立收取(镜像验收路径:fetch 分支 → 读字节)
      const got = readBranch(repo, art.branch, join(base, 'lead'));
      const collected = got.files.filter((p) => p !== 'qlong-manifest.json')
        .map((p) => ({ path: p, bytes: new Uint8Array(got.bytes(p)) }));
      expect(verifyArtifactDelivery({
        signed: art.manifest, taskId: f.task_id, attempt: f.attempt, pub: publicKey,
        fromNodeId: NODE_ID, fromKeyEpoch: 2, collected, contract,
      })).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('T5: 契约声明的文件缺失 → 不入清单(不伪造);牵头方核契约完整性判 false(失败不伪装成功)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'qlong-pub-miss-'));
    try {
      const repo = bareRepo(base);
      const cwd = join(base, 'ws');
      mkdirSync(cwd, { recursive: true });
      // 声明 dist/report.md 但工作区并无该文件
      const { priv, publicKey } = newKeyPair();
      const pub = new GitArtifactPublisher({ repo, privKey: priv, nodeId: NODE_ID, keyEpoch: 1 });
      const f = fence();
      const contract = { deliverables: [{ path: 'dist/report.md' }] };
      const published = await pub.publish(f, { kind: 'project', summary: 'b', contract }, { cwd },
        { kind: 'result', body: { status: 'done' } });
      const art = (published.body as { artifacts: Array<{ manifest: SignedManifest; branch: string }> }).artifacts[0]!;
      // 清单不含缺失文件(缺件不入清单)
      expect(art.manifest.manifest.deliverables.map((d) => d.path)).not.toContain('dist/report.md');
      // 牵头方按契约核完整性 → false(少交即判失败,绝不据不完整交付判通过)
      const got = readBranch(repo, art.branch, join(base, 'lead'));
      const collected = got.files.filter((p) => p !== 'qlong-manifest.json')
        .map((p) => ({ path: p, bytes: new Uint8Array(got.bytes(p)) }));
      expect(verifyArtifactDelivery({
        signed: art.manifest, taskId: f.task_id, attempt: f.attempt, pub: publicKey,
        fromNodeId: NODE_ID, fromKeyEpoch: 1, collected, contract,
      })).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('T6: 契约路径越界工作区(../escape)→ 拒绝读取,仅收工作区内声明文件(路径安全)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'qlong-pub-esc-'));
    try {
      const repo = bareRepo(base);
      const cwd = join(base, 'ws');
      mkdirSync(cwd, { recursive: true });
      writeFileSync(join(base, 'escape.md'), 'SECRET OUTSIDE'); // 工作区外
      writeFileSync(join(cwd, 'inside.md'), 'INSIDE');
      const { priv } = newKeyPair();
      const pub = new GitArtifactPublisher({ repo, privKey: priv, nodeId: NODE_ID, keyEpoch: 1 });
      const f = fence();
      const published = await pub.publish(f, {
        kind: 'project', summary: 'b', contract: { deliverables: [{ path: '../escape.md' }, { path: 'inside.md' }] },
      }, { cwd }, { kind: 'result', body: {} });
      const art = (published.body as { artifacts: Array<{ manifest: SignedManifest; branch: string }> }).artifacts[0]!;
      const paths = art.manifest.manifest.deliverables.map((d) => d.path);
      expect(paths).toContain('inside.md');
      expect(paths.some((p) => p.includes('escape'))).toBe(false);
      // 越界内容绝未入分支
      const got = readBranch(repo, art.branch, join(base, 'lead'));
      expect(got.files.some((p) => p.includes('escape'))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
