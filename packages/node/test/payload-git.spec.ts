import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { GitPayloadStore, fetchPayloadGit, pushArtifacts, collectArtifacts, pushSignedArtifacts } from '../src/collab/payload-git.js';
import { newKeyPair } from '@qlong/core';
import { buildManifest, signManifest, verifyManifest } from '../src/collab/artifact-manifest.js';

/** §8.4 git 仓库内对象分发:store → fetch(roundtrip)+ 产物回传(push/collect) */
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

describe('GitPayloadStore / fetchPayloadGit', () => {
  let sharedRepo = '';
  let allow: { allowLocalRepo: boolean };

  beforeAll(() => {
    sharedRepo = mkdtempSync(join(tmpdir(), 'qlong-gitrepo-')) + '/shared.git';
    allow = { allowLocalRepo: true };
  });
  afterAll(() => rmSync(sharedRepo.slice(0, sharedRepo.lastIndexOf('/shared.git')), { recursive: true, force: true }));

  it('store → fetch roundtrip(sha256/size 校验通过)', async () => {
    const store = new GitPayloadStore({ repo: sharedRepo });
    const payload = Buffer.from('hello git payload');
    const ref = store.store(payload);
    expect(ref.repo).toBe(sharedRepo);
    expect(ref.path).toBe('payload-' + sha(payload));
    expect(ref.size).toBe(payload.length);
    const r = await fetchPayloadGit(ref, allow);
    if (!r.ok) console.log('FETCH-FAIL reason:', r.reason);
    expect(r.ok).toBe(true);
    expect(r.data?.toString()).toBe('hello git payload');
  });

  it('sha256 与 ref 不一致 → 内容寻址 ref 不存在,拉取即拒(篡改不可达)', async () => {
    const store = new GitPayloadStore({ repo: sharedRepo });
    const ref = store.store(Buffer.from('legit'));
    const r = await fetchPayloadGit({ ...ref, sha256: 'f'.repeat(64) }, allow);
    expect(r.ok).toBe(false);
    // git 本身内容寻址:篡改 sha256 → refs/payload/<假sha> 不存在 → fetch 拒绝
    expect(r.reason).toContain('git 拉取失败');
  });

  it('path 篡改 → cat-file 缺失 → 拒绝(防指向他人负载)', async () => {
    const store = new GitPayloadStore({ repo: sharedRepo });
    const a = store.store(Buffer.from('AAA'));
    const b = store.store(Buffer.from('BBB'));
    // 声明 A 的 sha(寻址到 A 的 ref)却要取 B 的 path → git 内不存在该路径
    const r = await fetchPayloadGit({ repo: a.repo, path: b.path, sha256: a.sha256, size: a.size }, allow);
    expect(r.ok).toBe(false);
  });

  it('本地仓库默认拒绝(R10),放行后可用', async () => {
    const store = new GitPayloadStore({ repo: sharedRepo });
    const ref = store.store(Buffer.from('private?'));
    const deny = await fetchPayloadGit(ref);
    expect(deny.ok).toBe(false);
    expect(deny.reason).toContain('R10');
    const ok = await fetchPayloadGit(ref, allow);
    expect(ok.ok).toBe(true);
  });

  it('多负载共存(提交链追加不覆盖)', async () => {
    const store = new GitPayloadStore({ repo: sharedRepo });
    const r1 = store.store(Buffer.from('first'));
    const r2 = store.store(Buffer.from('second'));
    expect((await fetchPayloadGit(r1, allow)).data?.toString()).toBe('first');
    expect((await fetchPayloadGit(r2, allow)).data?.toString()).toBe('second');
  });
});

describe('产物回传(pushArtifacts / collectArtifacts)', () => {
  it('执行方提交产物分支 → 牵头方收取到本地', () => {
    const base = mkdtempSync(join(tmpdir(), 'qlong-art-'));
    const repo = base + '/shared.git';
    const worktree = base + '/worktree';
    const outDir = base + '/out';
    try {
      execFileSync('git', ['init', '--bare', '--quiet', repo]);
      execFileSync('git', ['init', '--quiet', worktree], { stdio: 'pipe' });
      require('node:child_process').execFileSync('git', ['checkout', '--quiet', '-b', 'main'], { cwd: worktree, stdio: 'pipe' });
      // 首提交(分支须存在才能推)
      writeFileSync(join(worktree, 'README.md'), 'seed');
      const git = (a: string[]) => execFileSync('git', a, { cwd: worktree, stdio: 'pipe' });
      git(['add', 'README.md']);
      git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'seed']);

      const taskId = 'task-1';
      mkdirSync(join(worktree, 'dist'), { recursive: true });
      writeFileSync(join(worktree, 'dist', 'report.md'), '# 产物');
      const r = pushArtifacts(worktree, repo, ['dist/report.md'], taskId);
      expect(r.pushed).toEqual(['dist/report.md']);
      expect(r.branch).toBe('qlong/task-1');

      const c = collectArtifacts(repo, taskId, outDir);
      expect(c.ok).toBe(true);
      expect(c.files).toContain('dist/report.md');
      expect(readFileSync(join(outDir, 'dist', 'report.md'), 'utf8')).toBe('# 产物');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('声明文件不存在 → 空 push,不报错', () => {
    const base = mkdtempSync(join(tmpdir(), 'qlong-art2-'));
    const worktree = join(base, 'wt');
    execFileSync('git', ['init', '--quiet', worktree], { stdio: 'pipe' });
    const r = pushArtifacts(worktree, base + '/r.git', ['nope.md'], 't');
    expect(r.pushed).toEqual([]);
    rmSync(base, { recursive: true, force: true });
  });
});

/** E2b:签名产物回传——清单随产物入 git 分支,牵头方收取后可独立验签 + 重新哈希(§4.2) */
describe('签名产物回传(pushSignedArtifacts / collectArtifacts 读回 manifest)', () => {
  const NODE_ID = '22222222-2222-4222-8222-222222222222';

  function seededWorktree(base: string): { repo: string; worktree: string } {
    const repo = base + '/shared.git';
    const worktree = base + '/worktree';
    execFileSync('git', ['init', '--bare', '--quiet', repo]);
    execFileSync('git', ['init', '--quiet', worktree], { stdio: 'pipe' });
    execFileSync('git', ['checkout', '--quiet', '-b', 'main'], { cwd: worktree, stdio: 'pipe' });
    writeFileSync(join(worktree, 'README.md'), 'seed');
    const git = (a: string[]): unknown => execFileSync('git', a, { cwd: worktree, stdio: 'pipe' });
    git(['add', 'README.md']);
    git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'seed']);
    return { repo, worktree };
  }

  it('执行方推签名清单 → 牵头方收回复验:manifest 幸存、验签通过、逐产物重新哈希匹配', () => {
    const base = mkdtempSync(join(tmpdir(), 'qlong-sig-'));
    try {
      const { repo, worktree } = seededWorktree(base);
      const outDir = base + '/out';
      const { priv, publicKey } = newKeyPair();
      const taskId = 'task-sig';
      mkdirSync(join(worktree, 'dist'), { recursive: true });
      const reportBytes = Buffer.from('# signed artifact body');
      writeFileSync(join(worktree, 'dist', 'report.md'), reportBytes);
      const manifest = buildManifest(taskId, 1, NODE_ID, 3, [{ path: 'dist/report.md', bytes: reportBytes }]);
      const signed = signManifest(manifest, priv);

      const r = pushSignedArtifacts(worktree, repo, signed, taskId);
      expect(r.branch).toBe('qlong/task-sig');
      expect(r.pushed).toContain('dist/report.md');

      const c = collectArtifacts(repo, taskId, outDir);
      expect(c.ok).toBe(true);
      expect(c.manifest).toBeDefined();
      // 签名随 git 传输幸存:牵头方用执行方登记公钥独立验签通过
      expect(verifyManifest(c.manifest!, publicKey)).toBe(true);
      expect(c.manifest!.manifest.deliverables.map((d) => d.path)).toEqual(['dist/report.md']);
      // 逐产物重新哈希匹配(端到端经 git 传输后字节完整)
      const collected = readFileSync(join(outDir, 'dist', 'report.md'));
      expect(sha(collected)).toBe(manifest.deliverables[0]!.sha256);
      expect(collected.length).toBe(reportBytes.length);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('签名清单本身随分支入仓(qlong-manifest.json 出现在收取文件树)', () => {
    const base = mkdtempSync(join(tmpdir(), 'qlong-sigfile-'));
    try {
      const { repo, worktree } = seededWorktree(base);
      const outDir = base + '/out';
      const { priv } = newKeyPair();
      writeFileSync(join(worktree, 'a.txt'), 'A');
      const signed = signManifest(buildManifest('t2', 1, NODE_ID, 3, [{ path: 'a.txt', bytes: Buffer.from('A') }]), priv);
      pushSignedArtifacts(worktree, repo, signed, 't2');
      const c = collectArtifacts(repo, 't2', outDir);
      expect(c.ok).toBe(true);
      expect(existsSync(join(outDir, 'qlong-manifest.json'))).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('分支无签名清单(旧 pushArtifacts)→ collectArtifacts manifest 为 undefined(向后兼容)', () => {
    const base = mkdtempSync(join(tmpdir(), 'qlong-nosig-'));
    try {
      const { repo, worktree } = seededWorktree(base);
      const outDir = base + '/out';
      mkdirSync(join(worktree, 'dist'), { recursive: true });
      writeFileSync(join(worktree, 'dist', 'plain.md'), 'plain');
      pushArtifacts(worktree, repo, ['dist/plain.md'], 'task-plain');
      const c = collectArtifacts(repo, 'task-plain', outDir);
      expect(c.ok).toBe(true);
      expect(c.files).toContain('dist/plain.md');
      expect(c.manifest).toBeUndefined();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
