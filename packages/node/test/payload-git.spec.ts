import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { GitPayloadStore, fetchPayloadGit, pushArtifacts, collectArtifacts, pushSignedArtifacts, publishSignedArtifacts, GitPayloadError } from '../src/collab/payload-git.js';
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

/** e2d-2c:异步签名产物发布——每-attempt 分支 + 超时/字节预算 + 非快进拒绝(绝不 force) */
describe('异步签名产物发布(publishSignedArtifacts)', () => {
  const NODE_ID = '33333333-3333-4333-8333-333333333333';

  /** 独立 init 一个带根提交的 worktree(与任何其他 worktree 历史分叉)。 */
  function seed(base: string, name: string): { repo: string; worktree: string } {
    const repo = join(base, 'shared.git');
    const worktree = join(base, name);
    if (!existsSync(repo)) execFileSync('git', ['init', '--bare', '--quiet', repo]);
    execFileSync('git', ['init', '--quiet', worktree], { stdio: 'pipe' });
    execFileSync('git', ['checkout', '--quiet', '-b', 'main'], { cwd: worktree, stdio: 'pipe' });
    writeFileSync(join(worktree, 'README.md'), name);
    execFileSync('git', ['add', 'README.md'], { cwd: worktree, stdio: 'pipe' });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', name], { cwd: worktree, stdio: 'pipe' });
    return { repo, worktree };
  }

  /** 拉取指定分支并返回其文件树 + 清单内容(不依赖 collectArtifacts 的单分支约定)。 */
  function readBranch(repo: string, branch: string, outDir: string): { files: string[]; manifest: string } {
    execFileSync('git', ['init', '--quiet', outDir], { stdio: 'pipe' });
    execFileSync('git', ['fetch', '--quiet', '--depth', '1', repo, `refs/heads/${branch}:refs/heads/${branch}`], { cwd: outDir, stdio: 'pipe' });
    const files = execFileSync('git', ['ls-tree', '-r', '--name-only', branch], { cwd: outDir, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8').split('\n').filter(Boolean);
    const manifest = execFileSync('git', ['cat-file', 'blob', `${branch}:qlong-manifest.json`], { cwd: outDir, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8');
    return { files, manifest };
  }

  function signedFor(taskId: string, attempt: number, files: Array<{ path: string; bytes: Buffer }>) {
    const { priv, publicKey } = newKeyPair();
    return { signed: signManifest(buildManifest(taskId, attempt, NODE_ID, 3, files), priv), publicKey };
  }

  it('发布到每-attempt 分支 qlong/<task>/a<attempt>,清单+产物随分支幸存且可验签', async () => {
    const base = mkdtempSync(join(tmpdir(), 'qlong-pub-'));
    try {
      const { repo, worktree } = seed(base, 'wt');
      const taskId = 'task-pub';
      mkdirSync(join(worktree, 'dist'), { recursive: true });
      const reportBytes = Buffer.from('# async published body');
      writeFileSync(join(worktree, 'dist', 'report.md'), reportBytes);
      const { signed, publicKey } = signedFor(taskId, 1, [{ path: 'dist/report.md', bytes: reportBytes }]);

      const r = await publishSignedArtifacts(worktree, repo, signed, taskId, 1);
      expect(r.branch).toBe('qlong/task-pub/a1');
      expect(r.pushed).toContain('dist/report.md');

      const got = readBranch(repo, 'qlong/task-pub/a1', join(base, 'out'));
      expect(got.files).toContain('dist/report.md');
      const parsed = JSON.parse(got.manifest);
      expect(verifyManifest(parsed, publicKey)).toBe(true); // 签名经 git 传输幸存,独立验签通过
      expect(parsed.manifest.attempt).toBe(1);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('多 attempt 各占独立分支互不覆写(a1/a2 同时可取,清单 attempt 各异)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'qlong-pub2-'));
    try {
      const { repo, worktree } = seed(base, 'wt');
      const taskId = 'task-multi';
      mkdirSync(join(worktree, 'dist'), { recursive: true });
      const b1 = Buffer.from('attempt one');
      writeFileSync(join(worktree, 'dist', 'report.md'), b1);
      await publishSignedArtifacts(worktree, repo, signedFor(taskId, 1, [{ path: 'dist/report.md', bytes: b1 }]).signed, taskId, 1);
      const b2 = Buffer.from('attempt two');
      writeFileSync(join(worktree, 'dist', 'report.md'), b2);
      await publishSignedArtifacts(worktree, repo, signedFor(taskId, 2, [{ path: 'dist/report.md', bytes: b2 }]).signed, taskId, 2);

      const a1 = JSON.parse(readBranch(repo, `qlong/${taskId}/a1`, join(base, 'o1')).manifest);
      const a2 = JSON.parse(readBranch(repo, `qlong/${taskId}/a2`, join(base, 'o2')).manifest);
      expect(a1.manifest.attempt).toBe(1);
      expect(a2.manifest.attempt).toBe(2); // a1 未被 a2 覆写
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('同一 attempt 分叉重推 → 非快进被拒(绝不 force 覆写既有交付)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'qlong-pub3-'));
    try {
      const a = seed(base, 'wtA');
      const taskId = 'task-nff';
      mkdirSync(join(a.worktree, 'dist'), { recursive: true });
      const bytes = Buffer.from('first delivery');
      writeFileSync(join(a.worktree, 'dist', 'report.md'), bytes);
      await publishSignedArtifacts(a.worktree, a.repo, signedFor(taskId, 1, [{ path: 'dist/report.md', bytes }]).signed, taskId, 1);

      // 另一个独立 worktree(历史分叉)重推同一 attempt 分支 → 非快进
      const b = seed(base, 'wtB');
      mkdirSync(join(b.worktree, 'dist'), { recursive: true });
      const bytes2 = Buffer.from('divergent delivery');
      writeFileSync(join(b.worktree, 'dist', 'report.md'), bytes2);
      await expect(publishSignedArtifacts(b.worktree, b.repo, signedFor(taskId, 1, [{ path: 'dist/report.md', bytes: bytes2 }]).signed, taskId, 1))
        .rejects.toThrow();
      // 既有 a1 交付未被覆写:仍为首次内容
      const got = readBranch(a.repo, `qlong/${taskId}/a1`, join(base, 'out'));
      expect(JSON.parse(got.manifest).manifest.deliverables[0].size).toBe(bytes.length);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('声明总字节超预算 → 先于任何 git I/O 拒绝(GitPayloadError,不建分支)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'qlong-pub4-'));
    try {
      const { repo, worktree } = seed(base, 'wt');
      const taskId = 'task-budget';
      const big = Buffer.alloc(1024, 7);
      writeFileSync(join(worktree, 'big.bin'), big);
      const { signed } = signedFor(taskId, 1, [{ path: 'big.bin', bytes: big }]);
      await expect(publishSignedArtifacts(worktree, repo, signed, taskId, 1, { maxBytes: 16 }))
        .rejects.toBeInstanceOf(GitPayloadError);
      // 未推送:远端无该分支
      const ls = execFileSync('git', ['ls-remote', '--heads', repo], { stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8');
      expect(ls).not.toContain(`qlong/${taskId}/a1`);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('git I/O 超时预算 → 中止并抛错(不静默截断)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'qlong-pub5-'));
    try {
      const { repo, worktree } = seed(base, 'wt');
      const taskId = 'task-timeout';
      const bytes = Buffer.from('body');
      writeFileSync(join(worktree, 'a.txt'), bytes);
      const { signed } = signedFor(taskId, 1, [{ path: 'a.txt', bytes }]);
      await expect(publishSignedArtifacts(worktree, repo, signed, taskId, 1, { timeoutMs: 0 }))
        .rejects.toThrow();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
