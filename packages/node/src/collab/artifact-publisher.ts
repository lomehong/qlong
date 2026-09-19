/**
 * e2d-2d:ArtifactPublisher 端口的 git 适配器(ARTIFACT-ACCEPTANCE §4.2 执行侧生产半)。
 *
 * 执行器完成路径在 SQL 事务外调用 publish:本适配器据任务契约(offer.contract.deliverables)从已解析
 * 工作区(ctx.cwd)读取声明文件字节,构建并以节点登记私钥**单独签名** manifest,异步发布到共享产物仓的
 * **每-attempt 分支**(qlong/<task>/a<attempt>),返回注入了 body.artifacts 的新 outcome。执行器保持通用,
 * 真正的 git/文件 I/O 全在此;失败一律抛错 → 执行器据此干净 task.fail(artifact_publish_failed),绝不把
 * 未发布产物伪装成成功交付。
 *
 * 纪律:
 *  - aid(及任何非 project)→ 原样返回 outcome,绝不触碰 git;
 *  - 契约声明路径严格限定在工作区内(越界路径拒读),缺件不入清单(由牵头方核契约完整性判缺,fail-closed);
 *  - git I/O 全程异步(execFile promisify + AbortSignal.timeout,由 publishSignedArtifacts 承担超时/字节预算),
 *    不同步阻塞事件循环——租约续租/取消轮询在发布期间继续。
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { ArtifactPublisher, RunContext, RunFence, RunOutcome } from '../driver/run-handle.js';
import { buildManifest, signManifest } from './artifact-manifest.js';
import { publishSignedArtifacts, resolveGitBin, type PublishSignedOptions } from './payload-git.js';

const execFileAsync = promisify(execFile);

export interface GitArtifactPublisherOptions extends PublishSignedOptions {
  /** 共享产物仓(git remote URL 或本地路径);节点级配置,PROJECT 仅当此仓已配置时准入(执行器门控)。 */
  repo: string;
  /** 节点登记私钥(32 字节);与 task.result 信封署名同源,牵头方据登记公钥独立验签。 */
  privKey: Uint8Array;
  /** 署名钥标识(须 == 信封 from.node_id/key_epoch,否则牵头方防线①判失败)。 */
  nodeId: string;
  keyEpoch: number;
}

/** 契约声明的单条 deliverable path(仅取工作区内、字符串非空者)。 */
function declaredPaths(offer: Record<string, unknown>, cwd: string): string[] {
  const contract = offer.contract;
  if (typeof contract !== 'object' || contract === null) return [];
  const deliverables = (contract as Record<string, unknown>).deliverables;
  if (!Array.isArray(deliverables)) return [];
  const root = resolve(cwd);
  const out: string[] = [];
  for (const d of deliverables) {
    if (typeof d !== 'object' || d === null) continue;
    const p = (d as Record<string, unknown>).path;
    if (typeof p !== 'string' || p.length === 0) continue;
    // 路径安全:声明路径须严格落在工作区内(拒绝 ../ 越界与绝对路径),防契约诱导读取工作区外文件。
    const abs = resolve(join(root, p));
    const rel = relative(root, abs);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) continue;
    out.push(p);
  }
  return out;
}

export class GitArtifactPublisher implements ArtifactPublisher {
  constructor(private readonly opts: GitArtifactPublisherOptions) {}

  async publish(
    fence: Readonly<RunFence>,
    offer: Record<string, unknown>,
    ctx: RunContext | undefined,
    outcome: RunOutcome,
  ): Promise<RunOutcome> {
    // aid(及任何非 project):无产物交付语义,原样返回,绝不触碰 git。执行器已门控,此处防御性再判。
    if (offer.kind !== 'project') return outcome;
    const cwd = ctx?.cwd;
    if (typeof cwd !== 'string' || cwd.length === 0) {
      throw new Error('artifact-publisher: project 缺少已解析运行工作区(ctx.cwd),拒绝发布');
    }
    // 逐条读取工作区内的声明文件;缺件不入清单(由牵头方核契约完整性时判缺,绝不伪造成功)。
    const files: Array<{ path: string; bytes: Uint8Array }> = [];
    for (const p of declaredPaths(offer, cwd)) {
      const abs = join(cwd, p);
      if (existsSync(abs)) files.push({ path: p, bytes: readFileSync(abs) });
    }
    const signed = signManifest(
      buildManifest(fence.task_id, fence.attempt, this.opts.nodeId, this.opts.keyEpoch, files),
      this.opts.privKey,
    );
    // FencedWorkspace 只保证目录存在,未必是 git 仓:发布前确保已 init(异步,不阻塞事件循环)。
    await this.ensureRepo(cwd);
    const { branch } = await publishSignedArtifacts(cwd, this.opts.repo, signed, fence.task_id, fence.attempt, this.opts);
    return { kind: outcome.kind, body: { ...outcome.body, artifacts: [{ repo: this.opts.repo, manifest: signed, branch }] } };
  }

  /** 工作区尚未 init 为 git 仓时异步 init(publishSignedArtifacts 只做 add/commit/push)。 */
  private async ensureRepo(cwd: string): Promise<void> {
    if (existsSync(join(cwd, '.git'))) return;
    const bin = resolveGitBin(this.opts.gitBin);
    await execFileAsync(bin, ['init', '--quiet', cwd], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 120_000),
    });
  }
}
