/**
 * 牵头侧 git→字节收集适配器(E2 / ARTIFACT-ACCEPTANCE §4.3、§5)。
 *
 * 把 payload-git 的 `collectSignedArtifacts` 传输原语包装成 `DurableLead.collectArtifacts` 端口形状
 * `(repo, taskId, branch?) => Promise<{ ok, files?: {path,bytes}[], reason? }>`:
 * - **branch 缺省 → 单分支 `qlong/<task>`**(向后兼容旧 pushArtifacts/pushSignedArtifacts 产物);给定 →
 *   每-attempt 分支 `qlong/<task>/a<attempt>`(e2d-2 publisher 写入 artifacts[0].branch,牵头方据此精确收取);
 * - 每次收取派生**唯一 scratch 子目录**(os.tmpdir 缺省根),读完字节后 best-effort 清理——仅回收本地暂存,
 *   **绝不触碰共享仓 git 分支 / 在途产物**(约束 §1.8:分支 GC 只回收终态且过保留窗口的任务分支);
 * - 传输失败 / 超时 / 预算超限 → `{ ok:false, reason }`,**绝不抛到 drain**(牵头验收据此 fail-closed,不误判 done)。
 *
 * 与 GitArtifactPublisher(collab/artifact-publisher.ts)对称:publisher 是执行侧生产半,collector 是牵头侧消费半。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectSignedArtifacts, type CollectSignedOptions } from './payload-git.js';

/** DurableLead.collectArtifacts 端口形状(与 lead.ts DurableLeadOptions.collectArtifacts 一致)。 */
export type ArtifactCollectPort = (
  repo: string,
  taskId: string,
  branch?: string,
) => Promise<{ ok: boolean; files?: ReadonlyArray<{ path: string; bytes: Uint8Array }>; reason?: string }>;

export interface GitArtifactCollectorOptions extends CollectSignedOptions {
  /** scratch 根目录(默认 os.tmpdir());每次收取在其下派生唯一子目录,读完字节后清理。 */
  baseDir?: string;
}

/**
 * 构造一个 git→字节收集端口。node.ts 据节点级配置装配并注入 DurableLead(缺省 → PROJECT 无法预置判定 → fail-closed)。
 * opts 透传 collectSignedArtifacts 的 gitBin/timeoutMs/maxBytes;baseDir 仅供本适配器派生 scratch。
 */
export function createGitArtifactCollector(opts: GitArtifactCollectorOptions = {}): ArtifactCollectPort {
  return async (repo, taskId, branch) => {
    const ref = branch ?? `qlong/${taskId}`;
    const base = opts.baseDir ?? tmpdir();
    let scratch = '';
    try {
      scratch = mkdtempSync(join(base, 'qlong-collect-'));
      const { files } = await collectSignedArtifacts(scratch, repo, ref, opts);
      return { ok: true, files };
    } catch (e) {
      return { ok: false, reason: String(e instanceof Error ? e.message : e) };
    } finally {
      // best-effort 清理本地 scratch:字节已在内存,暂存目录用完即弃;清理失败绝不放大为收取失败。
      if (scratch) {
        try { rmSync(scratch, { recursive: true, force: true, maxRetries: 2, retryDelay: 20 }); } catch { /* 忽略 */ }
      }
    }
  };
}
