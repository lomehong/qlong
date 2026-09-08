import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry, createRegistryServer } from '../src/index.js';

/** 书坊静态分发(纪要 §3 第三服务):/install.sh /install.ps1 /install /releases/<版本>/<文件>;路径穿越防护 */
describe('书坊分发(dist 静态服务)', () => {
  let srv: ReturnType<typeof createServer>;
  let baseUrl = '';
  let dist = '';

  beforeAll(async () => {
    dist = mkdtempSync(join(tmpdir(), 'qlong-dist-'));
    // latest/ 与 0.1.0/ 两个版本目录(多版本共存)
    for (const v of ['latest', '0.1.0']) {
      mkdirSync(join(dist, v), { recursive: true });
      writeFileSync(join(dist, v, 'install.sh'), '#!/bin/sh\necho v' + v);
      writeFileSync(join(dist, v, 'install.ps1'), 'Write-Host v' + v);
      writeFileSync(join(dist, v, 'install.html'), '<html>v' + v + '</html>');
      writeFileSync(join(dist, v, 'qlong-linux-x64'), '#!/usr/bin/env node\necho bin');
    }
    srv = createRegistryServer({ registry: new Registry({ now: () => Date.now() }), distDir: dist });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => srv.close(() => r()));
    rmSync(dist, { recursive: true, force: true });
  });

  const get = async (p: string): Promise<{ status: number; body: string; type: string }> => {
    const res = await fetch(baseUrl + p);
    return { status: res.status, body: await res.text(), type: res.headers.get('content-type') ?? '' };
  };

  it('latest 三入口:/install.sh、/install.ps1、/install(入口页)', async () => {
    expect((await get('/install.sh')).body).toContain('vlatest');
    expect((await get('/install.ps1')).status).toBe(200);
    const html = await get('/install');
    expect(html.status).toBe(200);
    expect(html.type).toContain('text/html');
  });

  it('多版本:/releases/0.1.0/ 与 /releases/latest/ 各自可达', async () => {
    expect((await get('/releases/0.1.0/install.sh')).body).toContain('v0.1.0');
    expect((await get('/releases/latest/install.sh')).body).toContain('vlatest');
    expect((await get('/releases/0.1.0/qlong-linux-x64')).type).toBe('application/octet-stream');
  });

  it('路径穿越防护:.. 逃逸 → 403/404(P12 失败关闭)', async () => {
    const r = await get('/releases/latest/../../../etc/passwd');
    expect([403, 404]).toContain(r.status);
  });

  it('不存在的版本/文件 → 404 人话', async () => {
    const r = await get('/releases/9.9.9/nope.sh');
    expect(r.status).toBe(404);
    expect(r.body).toContain('发布物不存在');
  });
});
