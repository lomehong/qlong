/**
 * §8.4 工作区隔离:每个 task 一个临时目录或 git worktree。
 * D33:未携带 workspace 的远端任务 → 仅一次性临时目录,产物只经 payload_ref 回传,禁止读写既有路径。
 */
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { execSync } from 'node:child_process';
import { isUuid, newId } from '@qlong/core';
import type { ExecutorWorkspace, RunContext, RunFence } from '../driver/run-handle.js';

export interface WorkspaceManagerOptions {
  /** 工作区根目录(默认 os.tmpdir()/qlong-workspaces) */
  baseDir?: string;
  /** 允许访问的基础目录(工作区外的路径一律拒绝) */
  allowedBase?: string;
}

export interface WorkspaceHandle {
  taskId: string;
  /** 执行方可以在其中安全读写的绝对路径 */
  rootPath: string;
  /** 是否为一次性临时目录(D33:offer 未携带 workspace 时 true) */
  isTempOnly: boolean;
  /** offer 携带的 git 引用(如果有) */
  repo?: string;
  baseRef?: string;
}

export class WorkspaceManager {
  private readonly baseDir: string;
  private readonly active = new Map<string, WorkspaceHandle>();

  constructor(opts: WorkspaceManagerOptions = {}) {
    this.baseDir = opts.baseDir ?? join(process.env['TMPDIR'] ?? '/tmp', 'qlong-workspaces');
    mkdirSync(this.baseDir, { recursive: true });
  }

  /**
   * 创建工作区。
   * offer.workspace 有值 → git worktree(需 git 可用);无值 → 一次性临时目录(D33)。
   * 返回 WorkspaceHandle;失败抛错(调用方转为闸5 拒绝)。
   */
  create(taskId: string, offer: Record<string, unknown>): WorkspaceHandle {
    if (this.active.has(taskId)) throw new Error('workspace: 任务 ' + taskId + ' 已有工作区');
    const ws = offer['workspace'] as { repo?: string; base_ref?: string } | undefined;
    const dir = join(this.baseDir, taskId);
    if (ws && typeof ws.repo === 'string' && ws.repo.length > 0) {
      // git worktree 模式
      const baseRef = typeof ws.base_ref === 'string' ? ws.base_ref : 'main';
      execSync('git clone --depth 1 --branch ' + JSON.stringify(baseRef) + ' ' + JSON.stringify(ws.repo) + ' ' + JSON.stringify(dir), { stdio: 'pipe', timeout: 30_000 });
      const handle: WorkspaceHandle = { taskId, rootPath: resolve(dir), isTempOnly: false, repo: ws.repo, baseRef };
      this.active.set(taskId, handle);
      return handle;
    }
    // D33:一次性临时目录
    mkdirSync(dir, { recursive: true });
    const handle: WorkspaceHandle = { taskId, rootPath: resolve(dir), isTempOnly: true };
    this.active.set(taskId, handle);
    return handle;
  }

  /** 路径安全检查:路径必须在工作区根目录内(D33:越界拒绝) */
  isWithinWorkspace(handle: WorkspaceHandle, targetPath: string): boolean {
    const rel = relative(resolve(handle.rootPath), resolve(targetPath));
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  }

  /** 清理工作区 */
  destroy(taskId: string): void {
    const handle = this.active.get(taskId);
    if (!handle) return;
    this.active.delete(taskId);
    if (existsSync(handle.rootPath)) rmSync(handle.rootPath, { recursive: true, force: true });
  }

  get size(): number { return this.active.size; }
}

export interface FencedWorkspaceOptions {
  /** 工作区根目录(默认 os.tmpdir()/qlong-workspaces;跨平台安全,不再误用 /tmp) */
  baseDir?: string;
}

/**
 * e2d-1:durable 执行器的 per-fence 隔离工作区(ExecutorWorkspace 端口实现)。
 * 目录名由精确 fence 派生(task_id + attempt + generation + run_id),故不同任务/attempt/
 * generation/run 天然不共享目录、不复用陈旧产物(跨 attempt 不串产物)。仅做目录级隔离,
 * 不等同容器沙箱(节点受信自托管;强隔离语义见 PROTOCOL-V2 / ARTIFACT-ACCEPTANCE)。
 * 生命周期归执行器:prepare/release 均在 SQL 事务外调用,按精确 fence 幂等;release 由
 * 派生路径直接定位,故跨进程重启后仍能清理上一进程遗留的工作区(不依赖内存表)。
 * 首期(e2d-1)只服务无 repo 的临时目录(aid);PROJECT 的 repo 克隆/异步 git I/O 与产物
 * 发布在 e2d-2 原子落地(届时 prepare 需自带 git 超时与资源预算,避免阻塞事件循环)。
 */
export class FencedWorkspace implements ExecutorWorkspace {
  private readonly baseDir: string;

  constructor(opts: FencedWorkspaceOptions = {}) {
    this.baseDir = resolve(opts.baseDir ?? join(tmpdir(), 'qlong-workspaces'));
  }

  async prepare(fence: Readonly<RunFence>, _offer: Record<string, unknown>): Promise<RunContext> {
    const dir = this.dirFor(fence);
    // recursive:true → 幂等附着;create 与 execute 之间可能重入,绝不清空既有内容。
    await mkdir(dir, { recursive: true });
    return { cwd: dir };
  }

  async release(fence: Readonly<RunFence>): Promise<void> {
    // force:true → 目录不存在时静默(幂等);maxRetries 吸收 Windows 句柄延迟释放(EBUSY/EPERM)。
    // 失败向上抛,由执行器按 best-effort 吞掉(清理失败是泄漏,绝不推翻已提交结果)。
    await rm(this.dirFor(fence), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  /**
   * 由精确 fence 派生唯一且路径安全的工作区目录。先校验 fence 字段(uuid/正整数),
   * 派生名仅含 uuid hex 与整数(无路径分隔符,构造上不可越界),再纵深防御断言其严格
   * 落在 baseDir 内。非法 fence → 抛(执行器转为 task.fail,失败关闭)。
   */
  private dirFor(fence: Readonly<RunFence>): string {
    if (!isUuid(fence.task_id) || !isUuid(fence.run_id) ||
        !Number.isSafeInteger(fence.attempt) || fence.attempt <= 0 ||
        !Number.isSafeInteger(fence.generation) || fence.generation <= 0) {
      throw new Error('workspace: 非法 fence,拒绝派生工作区');
    }
    const dir = resolve(join(this.baseDir, `${fence.task_id}__a${fence.attempt}__g${fence.generation}__${fence.run_id}`));
    const rel = relative(this.baseDir, dir);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new Error('workspace: 派生路径越界');
    return dir;
  }
}
