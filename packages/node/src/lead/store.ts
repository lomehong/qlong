import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface CheckpointStore {
  save(taskId: string, blob: string): void;
  load(taskId: string): string | undefined;
  list(): string[];
  delete(taskId: string): void;
}

export class MemoryStore implements CheckpointStore {
  private map = new Map<string, string>();
  save(taskId: string, blob: string): void {
    this.map.set(taskId, blob);
  }
  load(taskId: string): string | undefined {
    return this.map.get(taskId);
  }
  list(): string[] {
    return [...this.map.keys()];
  }
  delete(taskId: string): void {
    this.map.delete(taskId);
  }
}

/**
 * JSON 文件存储(原子写:tmp + rename)。
 * 选型说明:计划原列 better-sqlite3 候选;当前仓库盘为 exFAT(原生模块构建/链接受限),
 * M1 检查点为单值 blob,文件存储即满足;sqlite 候选留给 M2 注册中心(多表真正需要时)。
 */
export class JsonFileStore implements CheckpointStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  private file(taskId: string): string {
    return join(this.dir, `${taskId}.cp.json`);
  }

  save(taskId: string, blob: string): void {
    const tmp = `${this.file(taskId)}.tmp`;
    writeFileSync(tmp, blob, 'utf8');
    renameSync(tmp, this.file(taskId));
  }

  load(taskId: string): string | undefined {
    try {
      return readFileSync(this.file(taskId), 'utf8');
    } catch {
      return undefined;
    }
  }

  list(): string[] {
    try {
      return readdirSync(this.dir)
        .filter((f) => f.endsWith('.cp.json'))
        .map((f) => f.slice(0, -'.cp.json'.length));
    } catch {
      return [];
    }
  }

  delete(taskId: string): void {
    try {
      rmSync(this.file(taskId));
    } catch {
      /* 已不存在 */
    }
  }
}