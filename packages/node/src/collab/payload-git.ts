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
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import type { PayloadRef } from '../executor/fetcher.js';
import type { SignedManifest } from './artifact-manifest.js';

const execFileAsync = promisify(execFile);

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

/** E2:签名产物清单在产物分支内的固定文件名(ARTIFACT-ACCEPTANCE §4.2) */
export const MANIFEST_FILE = 'qlong-manifest.json';

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

/**
 * 签名产物回传(E2 / ARTIFACT-ACCEPTANCE §4.2):在 pushArtifacts 基础上,把执行方**单独签名**的
 * 产物清单(qlong-manifest.json)一并 commit 进 qlong/<task> 分支 —— 产物分支自描述、自验签,
 * 即使脱离 task.result 信封 / 离线搬运,牵头方仍可用执行方登记公钥独立验签(§1.2)。
 * 清单先落盘再连同存在的 deliverable 一并提交:缺件不入清单,由牵头方核契约完整性时判缺。
 */
export function pushSignedArtifacts(
  worktreeDir: string,
  repo: string,
  signed: SignedManifest,
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
  writeFileSync(join(worktreeDir, MANIFEST_FILE), JSON.stringify(signed));
  const existing = signed.manifest.deliverables.map((d) => d.path).filter((f) => existsSync(join(worktreeDir, f)));
  git(['add', MANIFEST_FILE, ...existing]);
  git(['commit', '--quiet', '-m', `artifacts ${taskId}`, '--', MANIFEST_FILE, ...existing]);
  git(['push', '--quiet', repo, `HEAD:refs/heads/qlong/${taskId}`]);
  return { branch: `qlong/${taskId}`, pushed: existing };
}

export interface PublishSignedOptions {
  /** git 可执行(默认稳健解析) */
  gitBin?: string;
  /** 每个 git 子进程调用的墙钟超时(ms);默认 120000。超时即中止并抛错,绝不静默截断。 */
  timeoutMs?: number;
  /** 全部 deliverable 声明字节总和上限;默认 256MB。超限先于任何 git I/O 拒绝。 */
  maxBytes?: number;
}

/**
 * e2d-2:异步签名产物发布(ARTIFACT-ACCEPTANCE §4.2 的执行侧生产半)。与同步 pushSignedArtifacts 不同:
 * - 全程异步(execFile promisify + AbortSignal.timeout),不同步阻塞事件循环——租约续租/取消轮询在发布期间继续;
 * - **每-attempt 分支** qlong/<task>/a<attempt>:多 attempt 互不覆写、可审计;
 * - 绝不 force:远端同分支已存在且历史分叉 → 非快进被拒(抛错),不覆写既有交付;
 * - 字节预算:清单声明 deliverable 总字节超限 → 先于任何 git I/O 拒绝(fail-fast)。
 * worktreeDir 须已是 git 仓(调用方/适配器负责 init);缺件不入清单,由牵头方核契约完整性时判缺。
 * 失败一律抛错——由执行器据此干净 task.fail(artifact_publish_failed),绝不把未发布产物伪装成成功。
 */
export async function publishSignedArtifacts(
  worktreeDir: string,
  repo: string,
  signed: SignedManifest,
  taskId: string,
  attempt: number,
  opts: PublishSignedOptions = {},
): Promise<{ branch: string; pushed: string[] }> {
  if (!Number.isSafeInteger(attempt) || attempt <= 0) throw new GitPayloadError(`attempt 非法:${attempt}`);
  const bin = resolveGitBin(opts.gitBin);
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const maxBytes = opts.maxBytes ?? 256 * 1024 * 1024;
  const branch = `qlong/${taskId}/a${attempt}`;
  // 字节预算:先于任何 git I/O 拒绝,不浪费带宽/磁盘(清单是权威声明集)。
  const total = signed.manifest.deliverables.reduce((n, d) => n + d.size, 0);
  if (total > maxBytes) throw new GitPayloadError(`产物总字节 ${total} 超过预算 ${maxBytes}`);
  const git = async (args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync(bin, args, {
      cwd: worktreeDir,
      env: {
        ...process.env, GIT_TERMINAL_PROMPT: '0',
        GIT_AUTHOR_NAME: 'qlong', GIT_AUTHOR_EMAIL: 'qlong@local',
        GIT_COMMITTER_NAME: 'qlong', GIT_COMMITTER_EMAIL: 'qlong@local',
      },
      maxBuffer: 512 * 1024 * 1024,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return stdout;
  };
  await writeFile(join(worktreeDir, MANIFEST_FILE), JSON.stringify(signed));
  const existing = signed.manifest.deliverables.map((d) => d.path).filter((f) => existsSync(join(worktreeDir, f)));
  await git(['add', MANIFEST_FILE, ...existing]);
  await git(['commit', '--quiet', '-m', `artifacts ${taskId} a${attempt}`, '--', MANIFEST_FILE, ...existing]);
  // 每-attempt 分支 + 绝不 force:非快进冲突由 git 拒绝并抛错。
  await git(['push', '--quiet', repo, `HEAD:refs/heads/${branch}`]);
  return { branch, pushed: existing };
}

/** 牵头方收取产物:把 qlong/<task> 分支的产物树导出到本地目录 */
export function collectArtifacts(
  repo: string,
  taskId: string,
  outDir: string,
  gitBin?: string,
): { ok: boolean; files?: string[]; manifest?: SignedManifest; reason?: string } {
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
    // E2:读回签名清单(若分支携带);清单文件本身不计入 deliverable files。
    // 清单损坏/不可解析 → manifest 缺席,由牵头方验收器 fail-closed(绝不据坏清单伪造验收)。
    let manifest: SignedManifest | undefined;
    if (files.includes(MANIFEST_FILE)) {
      try {
        const parsed = JSON.parse(readFileSync(join(outDir, MANIFEST_FILE), 'utf8')) as SignedManifest;
        if (parsed && parsed.alg === 'ed25519' && parsed.manifest && typeof parsed.sig === 'string') manifest = parsed;
      } catch { /* 清单不可解析 → 缺席,验收 fail-closed */ }
    }
    return { ok: true, files: files.filter((f) => f !== MANIFEST_FILE), manifest };
  } catch (e) {
    return { ok: false, reason: String(e instanceof Error ? e.message : e) };
  }
}

export interface CollectSignedOptions {
  /** git 可执行(默认稳健解析) */
  gitBin?: string;
  /** 每个 git 子进程调用的墙钟超时(ms);默认 120000。超时即中止并抛错,绝不静默截断。 */
  timeoutMs?: number;
  /** 收取产物字节总和上限;默认 256MB。超限即中止并抛错。 */
  maxBytes?: number;
}

/**
 * e2d-3:异步签名产物收取(ARTIFACT-ACCEPTANCE §4.3 的牵头侧生产半)。镜像 publishSignedArtifacts:
 * - 全程异步(execFile promisify + AbortSignal.timeout),不同步阻塞事件循环——牵头方自身租约续租/
 *   取消轮询/心跳在大产物 fetch 期间继续,避免事件循环阻塞导致租约误过期→误 reclaim;
 * - 按**显式 branch**收取(每-attempt 分支 qlong/<task>/a<attempt>);branch 命名策略由调用方(适配器)决定;
 * - 逐文件 cat-file blob 以 **buffer 编码**回读原始字节(二进制产物不经 utf8 损坏),牵头方据此重新哈希核对清单;
 * - 读回 qlong-manifest.json → SignedManifest(损坏/不可解析 → manifest 缺席,验收 fail-closed);
 *   清单文件本身不计入返回 files(与同步 collectArtifacts 一致);
 * - 字节预算:收取总字节超 maxBytes → 先于返回中止并抛错(绝不静默截断)。
 * scratchDir 由调用方(适配器)派生并在收取后清理;本函数只负责 init-if-needed + fetch + 回读。
 * 失败一律抛错——由适配器转 {ok:false, reason},牵头方验收 fail-closed。
 */
export async function collectSignedArtifacts(
  scratchDir: string,
  repo: string,
  branch: string,
  opts: CollectSignedOptions = {},
): Promise<{ files: Array<{ path: string; bytes: Uint8Array }>; manifest?: SignedManifest }> {
  const bin = resolveGitBin(opts.gitBin);
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const maxBytes = opts.maxBytes ?? 256 * 1024 * 1024;
  // buffer 编码:cat-file 回读的是原始产物字节,绝不能按 utf8 解码(否则二进制产物损坏)。
  // encoding:'buffer' 保证运行时 stdout 为 Buffer;TS 重载可能仍标 string,故显式收敛为 Buffer。
  const git = async (args: string[], cwd?: string): Promise<Buffer> => {
    const { stdout } = await execFileAsync(bin, args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      maxBuffer: 512 * 1024 * 1024,
      signal: AbortSignal.timeout(timeoutMs),
      encoding: 'buffer',
    });
    return stdout as unknown as Buffer;
  };
  if (!existsSync(scratchDir)) mkdirSync(scratchDir, { recursive: true });
  if (!existsSync(join(scratchDir, '.git'))) await git(['init', '--quiet', scratchDir]);
  await git(['fetch', '--quiet', '--depth', '1', repo, `refs/heads/${branch}:refs/heads/${branch}`], scratchDir);
  const names = (await git(['ls-tree', '-r', '--name-only', branch], scratchDir)).toString('utf8').split('\n').filter(Boolean);
  const files: Array<{ path: string; bytes: Uint8Array }> = [];
  let manifest: SignedManifest | undefined;
  let total = 0;
  for (const name of names) {
    const bytes = await git(['cat-file', 'blob', `${branch}:${name}`], scratchDir);
    total += bytes.length;
    if (total > maxBytes) throw new GitPayloadError(`产物收取总字节超过预算 ${maxBytes}`);
    if (name === MANIFEST_FILE) {
      try {
        const parsed = JSON.parse(bytes.toString('utf8')) as SignedManifest;
        if (parsed && parsed.alg === 'ed25519' && parsed.manifest && typeof parsed.sig === 'string') manifest = parsed;
      } catch { /* 清单不可解析 → 缺席,验收 fail-closed */ }
      continue; // 清单文件不计入 deliverable files
    }
    files.push({ path: name, bytes: new Uint8Array(bytes) });
  }
  return { files, manifest };
}
