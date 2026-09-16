import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { assertNodeRuntime, MIN_NODE_MAJOR } from '../src/runtime.js';

describe('Node 24 built-in SQLite runtime baseline', () => {
  it.each(['20.19.0', '22.16.0', '23.11.0', '', 'invalid', 'NaN.0.0'])('rejects %s', (version) => {
    expect(() => assertNodeRuntime(version)).toThrow('Node.js >=24');
  });
  it.each(['24.0.0', '24.15.0', '26.0.0'])('accepts %s', (version) => {
    expect(() => assertNodeRuntime(version)).not.toThrow();
  });
  it('aligns root engine, installers, container stages and both build entrypoints', () => {
    const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
    expect(MIN_NODE_MAJOR).toBe(24);
    expect(JSON.parse(read('package.json')).engines.node).toBe('>=24');
    expect(read('scripts/install.sh')).toContain('"$NODE_MAJOR" -lt 24');
    expect(read('scripts/install.ps1')).toContain('$nodeMajor -lt 24');
    expect(read('Dockerfile').match(/^FROM node:24-alpine/gm)?.length).toBe(2);
    for (const path of ['scripts/package.mjs', 'packages/cli/build.mjs']) {
      expect(read(path)).toContain("target: 'node24'");
      expect(read(path)).toContain("external: ['node:*']");
    }
  });
});