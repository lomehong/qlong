/**
 * §8.4 工作区隔离:每个 task 一个临时目录或 git worktree。
 * D33:未携带 workspace 的远端任务 → 仅一次性临时目录,产物只经 payload_ref 回传,禁止读写既有路径。
 */
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { execSync } from 'node:child_process';
import { newId } from '@qlong/core';

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
