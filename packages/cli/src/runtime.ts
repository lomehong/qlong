/** Keep CLI/doctor/installer requirements aligned with the built-in SQLite baseline. */
export const MIN_NODE_MAJOR = 24;

export function assertNodeRuntime(version: string): void {
  const match = /^(\d+)\.\d+\.\d+(?:[-+].*)?$/.exec(version);
  if (!match || Number(match[1]) < MIN_NODE_MAJOR) {
    throw new Error('群龙需要 Node.js >=24（内置 SQLite）；请先升级运行时');
  }
}