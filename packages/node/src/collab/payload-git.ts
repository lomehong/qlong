/**
 * GitPayloadStore(§8.4 定稿:git 仓库内对象分发)。
 *
 * 设计(纪要 §8.4 / v0.2 D2 定稿):
 * - 共享仓库(bare)持有全部负载,每个负载 = 一个 blob,挂在 refs/heads/payloads
 *   的提交链上,路径 = payloads/<sha256>;
 * - 牵头方 store():plumbing 写入(hash-object → mktree → commit-tree → update-ref refs/payload/<sha>);
 *   每负载一个独立 ref + 独立根提交 —— fetch --depth 1 精确自足,互不影响
 * - 执行方 fetch():git fetch 共享仓库的 refs/payload/<sha> → cat-file blob → sha256/size 校验;
 * - PayloadRef 形状不变(01 §4.2 / R10):{repo, path, sha256, size},repo 指向共享仓库;
 * - 产物回传同理反向:执行方 pushArtifacts 写 worktree 提交并推送 qlong/<task> 分支,
 *   牵头方 collectArtifacts 按分支收取。
 *
 * R10 安全基线同样适用:repo 白名单(https 或本机路径,本机路径须节点策略放行)、size 预检、sha256 校验。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PayloadRef } from '../executor/fetcher.js';

export interface GitPayloadStoreOptions {
  /** 共享仓库:本地目录(bare 由本类自动 init)或 https 远端 URL(R10:私网须节点白名单) */
  repo: string;
  /** 单负载字节上限(默认 256MB) */
  maxBytes?: number;
  /** git 可执行(默认 git) */
  gitBin?: string;
}

const PAYLOAD_REF_PREFIX = 'refs/payload/';
const PAYLOAD_DIR = 'payloads';

export class GitPayloadError extends Error {}

/** git 可执行稳健解析:PATH 失败时回退常见 Windows 安装位置(缓存一次) */
let resolvedGit: string | null = null;
export function resolveGitBin(explicit?: string): string {
  if (explicit) return explicit;
  if (resolvedGit) return resolvedGit;
  const candidates = ['git', 'C:/Program Files/Git/cmd/git.exe', 'C:/Program Files/Git/mingw64/bin/git.exe'];
  for (const c of candidates) {
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore' });
      resolvedGit = c;
      return c;
    } catch {
      /* 尝试下一个 */
    }
  }
  resolvedGit = 'git';
  return resolvedGit;
}

export class GitPayloadStore {
  private readonly repo: string;
  private readonly maxBytes: number;
  private readonly gitBin: string;
  private inited = false;

  constructor(opts: GitPayloadStoreOptions) {
    if (!opts.repo) throw new GitPayloadError('repo 必填');
    this.repo = opts.repo;
    this.maxBytes = opts.maxBytes ?? 256 * 1024 * 1024;
    this.gitBin = resolveGitBin(opts.gitBin);
  }

  /** 在仓库内执行 git 子命令(本地 bare 仓自动初始化) */
  private git(args: string[], cwd?: string): string {
    if (!this.inited && cwd === undefined) this.ensureLocalBare();
    return execFileSync(this.gitBin, args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      maxBuffer: 512 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString('utf8');
  }

  private ensureLocalBare(): void {
    this.inited = true;
    if (/^https:\/\//.test(this.repo)) return; // 远端仓库:假定已存在
    if (existsSync(this.repo)) return;
    mkdirSync(this.repo, { recursive: true });
    execFileSync(this.gitBin, ['init', '--bare', '--quiet', this.repo]);
  }

  /** 写入负载 → 返回 PayloadRef(repo + payloads/<sha256> 路径) */
  store(data: Buffer): PayloadRef {
    this.ensureLocalBare(); // 本地 bare 仓不存在时自动 init(否则后续以它为 cwd 会 ENOENT)
    if (data.length > this.maxBytes) {
      throw new GitPayloadError(`size ${data.length} 超过上限 ${this.maxBytes}`);
    }
    const sha256 = createHash('sha256').update(data).digest('hex');
    // mktree 单层条目不允许含斜杠 → 平铺命名 payload-<sha256>(PayloadRef.path 对消费方不透明)
    const relPath = `payload-${sha256}`;
    if (/^https:\/\//.test(this.repo)) {
      // 远端:经本地临时 worktree 走常规提交(服务端通常禁 plumbing 直推 ref)
      const tmp = mkdtempSync(join(tmpdir(), 'qlong-payload-'));
      try {
        this.git(['clone', '--quiet', this.repo, tmp]);
        writeFileSync(join(tmp, relPath), data);
        this.git(['add', relPath], tmp);
        this.git(['-c', 'user.name=qlong', '-c', 'user.email=qlong@local', 'commit', '--quiet', '-m', `payload ${sha256}`], tmp);
        this.git(['push', '--quiet', 'origin', `HEAD:refs/payload/${sha256}`], tmp);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    } else {
      // 本地 bare:plumbing 直写
      const blobSha = execFileSync(
        this.gitBin,
        ['hash-object', '-w', '--stdin'],
        { input: data, maxBuffer: 512 * 1024 * 1024, cwd: this.repo, stdio: ['pipe', 'pipe', 'pipe'] },
      ).toString('utf8').trim();
      const treeSha = execFileSync(
        this.gitBin,
        ['mktree'],
        { input: `100644 blob ${blobSha}\t${relPath}\n`, cwd: this.repo, stdio: ['pipe', 'pipe', 'pipe'] },
      ).toString('utf8').trim();
      // 每个负载 = 独立根提交:fetch --depth 1 永远自足,仓库不随负载增长历史
      const commitSha = execFileSync(
        this.gitBin,
        ['commit-tree', treeSha, '-m', `payload ${sha256}`],
        { input: '', cwd: this.repo, env: { ...process.env, GIT_AUTHOR_NAME: 'qlong', GIT_AUTHOR_EMAIL: 'qlong@local', GIT_COMMITTER_NAME: 'qlong', GIT_COMMITTER_EMAIL: 'qlong@local' }, stdio: ['pipe', 'pipe', 'pipe'] },
      ).toString('utf8').trim();
      // 每负载一个独立 ref:fetch --depth 1 精确取单个负载,旧负载互不影响
      this.git(['update-ref', `refs/payload/${sha256}`, commitSha], this.repo);
    }
    return { repo: this.repo, path: relPath, sha256, size: data.length };
  }
}

export interface GitFetchOptions {
  /** git 可执行(默认 git) */
  gitBin?: string;
  /** 本机路径/环回仓库的显式放行(R10:默认仅 https;节点策略可加本地仓库) */
  allowLocalRepo?: boolean;
  maxBytes?: number;
}

/** 从共享仓库按 PayloadRef 拉取负载(git fetch + cat-file),sha256/size 校验 */
export async function fetchPayloadGit(
  ref: PayloadRef,
  opts: GitFetchOptions = {},
): Promise<{ ok: boolean; reason?: string; data?: Buffer }> {
  if (!ref.repo || !ref.path) return { ok: false, reason: 'git 拉取需要 repo 与 path' };
  const isLocal = !/^https:\/\//.test(ref.repo);
  if (isLocal && !opts.allowLocalRepo) {
    return { ok: false, reason: `repo ${ref.repo} 非 https,且节点未放行本地仓库(R10)` };
  }
  if (!Number.isSafeInteger(ref.size) || ref.size < 0) return { ok: false, reason: 'size 非法' };
  if (opts.maxBytes !== undefined && ref.size > opts.maxBytes) {
    return { ok: false, reason: `size ${ref.size} 超过上限 ${opts.maxBytes}` };
  }
  const gitBin = resolveGitBin(opts.gitBin);
  let tmp: string | undefined;
  try {
    tmp = mkdtempSync(join(tmpdir(), 'qlong-fetch-'));
    execFileSync(gitBin, ['init', '--quiet', tmp], { stdio: 'pipe' });
    const payloadRef = `refs/payload/${ref.sha256.toLowerCase()}`;
    execFileSync(
      gitBin,
      ['fetch', '--quiet', '--depth', '1', ref.repo, `${payloadRef}`],
      { cwd: tmp, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const blob = execFileSync(
      gitBin,
      ['cat-file', 'blob', `FETCH_HEAD:${ref.path}`],
      { cwd: tmp, maxBuffer: 512 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    if (blob.length !== ref.size) {
      return { ok: false, reason: `size 不符:声明 ${ref.size},实际 ${blob.length}` };
    }
    const digest = createHash('sha256').update(blob).digest('hex');
    if (digest !== ref.sha256.toLowerCase()) {
      return { ok: false, reason: 'sha256 校验失败(payload_corrupt)' };
    }
    return { ok: true, data: blob };
  } catch (e) {
    return { ok: false, reason: 'git 拉取失败:' + String(e instanceof Error ? e.message : e) };
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * 产物回传(§8.4):执行方把工作区中 contract.deliverables 声明的产物
 * commit 到 qlong/<task> 分支并推送共享仓库;返回引用供 result.files 携带。
 */
export function pushArtifacts(
  worktreeDir: string,
  repo: string,
  files: string[],
  taskId: string,
  gitBin?: string,
): { branch: string; pushed: string[] } {
  const bin = resolveGitBin(gitBin);
  const git = (args: string[]): string =>
    execFileSync(bin, args, {
      cwd: worktreeDir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'qlong', GIT_AUTHOR_EMAIL: 'qlong@local',
        GIT_COMMITTER_NAME: 'qlong', GIT_COMMITTER_EMAIL: 'qlong@local',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString('utf8');
  const existing = files.filter((f) => existsSync(join(worktreeDir, f)));
  if (existing.length === 0) return { branch: `qlong/${taskId}`, pushed: [] };
  git(['add', ...existing]);
  git(['commit', '--quiet', '-m', `artifacts ${taskId}`, '--', ...existing]);
  git(['push', '--quiet', repo, `HEAD:refs/heads/qlong/${taskId}`]);
  return { branch: `qlong/${taskId}`, pushed: existing };
}

/** 牵头方收取产物:把 qlong/<task> 分支的产物树导出到本地目录 */
export function collectArtifacts(
  repo: string,
  taskId: string,
  outDir: string,
  gitBin?: string,
): { ok: boolean; files?: string[]; reason?: string } {
  gitBin = resolveGitBin(gitBin);
  const branch = `qlong/${taskId}`;
  try {
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    if (!existsSync(join(outDir, '.git'))) {
      execFileSync(gitBin, ['init', '--quiet', outDir], { stdio: 'pipe' });
    }
    execFileSync(gitBin, ['fetch', '--quiet', '--depth', '1', repo, `refs/heads/${branch}:refs/heads/${branch}`], {
      cwd: outDir,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const files = execFileSync(gitBin, ['ls-tree', '-r', '--name-only', branch], {
      cwd: outDir, stdio: ['pipe', 'pipe', 'pipe'],
    }).toString('utf8').split('\n').filter(Boolean);
    for (const f of files) {
      const data = execFileSync(gitBin, ['cat-file', 'blob', `${branch}:${f}`], {
        cwd: outDir, maxBuffer: 512 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
      });
      const out = join(outDir, f);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, data);
    }
    return { ok: true, files };
  } catch (e) {
    return { ok: false, reason: String(e instanceof Error ? e.message : e) };
  }
}
