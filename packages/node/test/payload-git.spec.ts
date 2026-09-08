import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { GitPayloadStore, fetchPayloadGit, pushArtifacts, collectArtifacts } from '../src/collab/payload-git.js';

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
