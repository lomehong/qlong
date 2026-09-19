import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newKeyPair } from '@qlong/core';
import { buildManifest, signManifest } from '../src/collab/artifact-manifest.js';
import { publishSignedArtifacts, pushSignedArtifacts } from '../src/collab/payload-git.js';
import { createGitArtifactCollector } from '../src/collab/artifact-collector.js';

/** e2d-3b:git→字节收集适配器——把 payload-git collectSignedArtifacts 包装成 DurableLead collectArtifacts 端口形状(§4.3/§5)。 */
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const NODE_ID = '55555555-5555-4555-8555-555555555555';

/** 独立 init 一个带根提交的 worktree(bare 共享仓 + main 种子提交,供 publishSignedArtifacts 推 HEAD)。 */
function seedWorktree(base: string, name: string): { repo: string; worktree: string } {
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

describe('git→字节收集适配器(createGitArtifactCollector)', () => {
  const bases: string[] = [];
  const mk = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); bases.push(d); return d; };
  afterAll(() => { for (const b of bases) rmSync(b, { recursive: true, force: true }); });

  it('按每-attempt 分支收取 → { ok, files:[{path,bytes}] } 字节精确、清单不计入、scratch 用后清理', async () => {
    const base = mk('qlong-colA-');
    const { repo, worktree } = seedWorktree(base, 'wt');
    const taskId = 'task-a';
    mkdirSync(join(worktree, 'dist'), { recursive: true });
    const body = Buffer.from('# deliverable body');
    writeFileSync(join(worktree, 'dist', 'report.md'), body);
    const { priv } = newKeyPair();
    const signed = signManifest(buildManifest(taskId, 1, NODE_ID, 3, [{ path: 'dist/report.md', bytes: body }]), priv);
    await publishSignedArtifacts(worktree, repo, signed, taskId, 1);

    const baseDir = mk('qlong-scratchA-');
    const collect = createGitArtifactCollector({ baseDir });
    const got = await collect(repo, taskId, `qlong/${taskId}/a1`);
    expect(got.ok).toBe(true);
    const report = got.files!.find((f) => f.path === 'dist/report.md')!;
    expect(report).toBeDefined();
    expect(Buffer.from(report.bytes)).toEqual(body);
    expect(got.files!.some((f) => f.path === 'qlong-manifest.json')).toBe(false); // 清单文件不计入 deliverable files
    // scratch 用后清理:baseDir 下无遗留 qlong-collect-* 子目录(仅本地暂存,绝不触碰 git 分支)
    expect(readdirSync(baseDir).filter((n) => n.startsWith('qlong-collect-'))).toEqual([]);
  });

  it('branch 缺省 → 回退单分支 qlong/<task>(向后兼容 pushSignedArtifacts 产物)', async () => {
    const base = mk('qlong-colB-');
    const { repo, worktree } = seedWorktree(base, 'wt');
    const taskId = 'task-b';
    writeFileSync(join(worktree, 'a.txt'), 'A');
    const { priv } = newKeyPair();
    const signed = signManifest(buildManifest(taskId, 1, NODE_ID, 3, [{ path: 'a.txt', bytes: Buffer.from('A') }]), priv);
    pushSignedArtifacts(worktree, repo, signed, taskId); // 单分支 qlong/task-b

    const collect = createGitArtifactCollector({ baseDir: mk('qlong-scratchB-') });
    const got = await collect(repo, taskId); // 无 branch 参数
    expect(got.ok).toBe(true);
    expect(got.files!.find((f) => f.path === 'a.txt')).toBeDefined();
  });

  it('分支/仓不存在 → { ok:false, reason }(绝不抛到 drain,牵头验收据此 fail-closed)', async () => {
    const base = mk('qlong-colC-');
    const { repo } = seedWorktree(base, 'wt'); // bare 仓无任何产物分支
    const collect = createGitArtifactCollector({ baseDir: mk('qlong-scratchC-') });
    const got = await collect(repo, 'nope', 'qlong/nope/a1');
    expect(got.ok).toBe(false);
    expect(typeof got.reason).toBe('string');
    expect(got.files).toBeUndefined();
  });

  it('二进制收取字节 sha256 与清单一致(端到端经 git 传输完整,可被牵头方重新哈希核对)', async () => {
    const base = mk('qlong-colD-');
    const { repo, worktree } = seedWorktree(base, 'wt');
    const taskId = 'task-d';
    const bin = Buffer.from([0, 1, 2, 255, 254, 0x0a, 0x00, 0x80]); // 含 NUL/高位字节
    writeFileSync(join(worktree, 'blob.bin'), bin);
    const { priv } = newKeyPair();
    const signed = signManifest(buildManifest(taskId, 1, NODE_ID, 3, [{ path: 'blob.bin', bytes: bin }]), priv);
    await publishSignedArtifacts(worktree, repo, signed, taskId, 1);

    const collect = createGitArtifactCollector({ baseDir: mk('qlong-scratchD-') });
    const got = await collect(repo, taskId, `qlong/${taskId}/a1`);
    expect(got.ok).toBe(true);
    const f = got.files!.find((x) => x.path === 'blob.bin')!;
    expect(f).toBeDefined();
    expect(sha(f.bytes)).toBe(signed.manifest.deliverables[0]!.sha256);
  });
});
