/**
 * §8.4 payload 存储选型(定稿:git 仓库内对象)。
 * v0.1 临时 https 方案的升级版:payload 写入指定目录的文件树,通过 https 静态服务暴露;
 * §8.4 定稿后可替换为 git bundle 或对象存储。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { PayloadRef, FetchPolicy } from '../executor/fetcher.js';
import { fetchPayload } from '../executor/fetcher.js';

export interface PayloadStoreOptions {
  /** 存储根目录 */
  baseDir: string;
  /** 最大单文件字节 */
  maxBytes?: number;
}

export class LocalPayloadStore {
  private readonly baseDir: string;
  private readonly maxBytes: number;

  constructor(opts: PayloadStoreOptions) {
    this.baseDir = opts.baseDir;
    this.maxBytes = opts.maxBytes ?? 256 * 1024 * 1024;
    mkdirSync(this.baseDir, { recursive: true });
  }

  /** 写入 payload,返回 PayloadRef(含 sha256/size) */
  store(data: Buffer): PayloadRef {
    if (data.length > this.maxBytes) throw new Error('payload 超过上限 ' + this.maxBytes);
    const sha256 = createHash('sha256').update(data).digest('hex');
    const filePath = join(this.baseDir, sha256);
    if (!existsSync(filePath)) writeFileSync(filePath, data);
    return { ref_uri: 'file://' + filePath, sha256, size: data.length };
  }

  /** 读取 payload(sha256 校验) */
  read(ref: PayloadRef): Buffer {
    if (!ref.ref_uri) throw new Error('ref_uri 必填');
    const fp = ref.ref_uri.replace('file://', '');
    if (!existsSync(fp)) throw new Error('payload 不存在: ' + fp);
    const data = readFileSync(fp);
    const digest = createHash('sha256').update(data).digest('hex');
    if (digest !== ref.sha256.toLowerCase()) throw new Error('sha256 不符');
    if (data.length !== ref.size) throw new Error('size 不符');
    return data;
  }

  /** 清理过期 payload(超 maxAgeMs 未访问) */
  gc(maxAgeMs: number): number {
    let removed = 0;
    const cutoff = Date.now() - maxAgeMs;
    for (const f of readdirSync(this.baseDir)) {
      const fp = join(this.baseDir, f);
      const stat = require('node:fs').statSync(fp);
      if (stat.mtimeMs < cutoff) { rmSync(fp); removed++; }
    }
    return removed;
  }
}
