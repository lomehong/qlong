import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, fsyncSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthError, AuthService } from '../src/auth.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    fsyncSync: vi.fn(actual.fsyncSync),
  };
});

describe('Auth 文件兼容层 fail closed(仅临时数据)', () => {
  let dir: string;
  let password: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qlong-auth-security-'));
    password = randomUUID();
  });
  afterEach(() => {
    vi.resetAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('首次初始化落盘并标记;重启仅允许登录,会话不持久化', () => {
    const auth = new AuthService({ persistDir: dir });
    expect(auth.needsInit).toBe(true);
    auth.register('test-owner', password);
    const session = auth.login('test-owner', password);
    expect(auth.users.get('test-owner')?.role).toBe('global_owner');
    expect(auth.session(session.sessionId)?.role).toBe('global_owner');
    const persisted = JSON.parse(readFileSync(join(dir, 'users.json'), 'utf8')) as Array<{ role?: unknown }>;
    expect(persisted.map((user) => user.role)).toEqual(['global_owner']);
    expect(existsSync(join(dir, 'initialized'))).toBe(true);
    const restored = new AuthService({ persistDir: dir });
    expect(restored.needsInit).toBe(false);
    expect(restored.login('test-owner', password).username).toBe('test-owner');
    expect(restored.session(session.sessionId)).toBeUndefined();
    expect(() => restored.register('other-owner', password)).toThrowError(AuthError);
  });

  it.each(['{', 'null', '{}', '[]', '[{}]'])('损坏/空 users 文件不能隐式重新 bootstrap (%s)', (contents) => {
    writeFileSync(join(dir, 'users.json'), contents);
    expect(() => new AuthService({ persistDir: dir })).toThrowError(AuthError);
  });

  it('完整校验全部用户,拒绝部分加载、重复用户名和坏 hash', () => {
    const source = new AuthService();
    source.register('test-owner', password);
    const user = source.users.get('test-owner')!;
    for (const users of [[user, {}], [user, user], [{ ...user, hash: 'not-a-hash' }]]) {
      writeFileSync(join(dir, 'users.json'), JSON.stringify(users));
      expect(() => new AuthService({ persistDir: dir })).toThrowError(AuthError);
    }
  });

  it.each([false, true])('旧版合法单管理员加载迁移为 global_owner(已有标记=%s)', (hasMarker) => {
    const source = new AuthService();
    source.register('test-owner', password);
    const { username, salt, hash, created_at } = source.users.get('test-owner')!;
    const contents = JSON.stringify([{ username, salt, hash, created_at }]);
    writeFileSync(join(dir, 'users.json'), contents);
    if (hasMarker) writeFileSync(join(dir, 'initialized'), 'initialized-v1\n');
    const restored = new AuthService({ persistDir: dir });
    expect(restored.needsInit).toBe(false);
    const session = restored.login('test-owner', password);
    expect(restored.users.get('test-owner')?.role).toBe('global_owner');
    expect(restored.session(session.sessionId)?.role).toBe('global_owner');
    expect(existsSync(join(dir, 'initialized'))).toBe(true);
    // 加载迁移不覆写源凭证文件,也不在断言失败时输出其内容。
    expect(readFileSync(join(dir, 'users.json'), 'utf8') === contents).toBe(true);
    expect(new AuthService({ persistDir: dir }).users.get('test-owner')?.role).toBe('global_owner');
  });

  it('多用户缺少明确角色时拒绝整个文件,不根据排列或部分角色静默提权', () => {
    const source = new AuthService();
    source.register('test-owner', password);
    const user = source.users.get('test-owner')!;
    const { username, salt, hash, created_at } = user;
    const legacy = { username, salt, hash, created_at };
    const other = { ...legacy, username: 'other-owner' };
    for (const users of [[legacy, other], [user, other], [legacy, { ...other, role: 'user' }]]) {
      const contents = JSON.stringify(users);
      writeFileSync(join(dir, 'users.json'), contents);
      expect(() => new AuthService({ persistDir: dir })).toThrowError(AuthError);
      expect(existsSync(join(dir, 'initialized'))).toBe(false);
      expect(readFileSync(join(dir, 'users.json'), 'utf8') === contents).toBe(true);
    }
  });

  it.each([null, '', 'owner', 'GLOBAL_OWNER', 0])('未知/无效持久化 role 失败关闭,不当作旧管理员(%s)', (role) => {
    const source = new AuthService();
    source.register('test-owner', password);
    writeFileSync(join(dir, 'users.json'), JSON.stringify([{ ...source.users.get('test-owner')!, role }]));
    expect(() => new AuthService({ persistDir: dir })).toThrowError(AuthError);
    expect(existsSync(join(dir, 'initialized'))).toBe(false);
  });

  it('显式角色原样保留:单个 user 和多个 user 均不自动提升为 global_owner', () => {
    const source = new AuthService();
    source.register('test-owner', password);
    const owner = source.users.get('test-owner')!;
    const user = { ...owner, username: 'test-user', role: 'user' as const };
    for (const users of [[user], [user, { ...user, username: 'other-user' }], [owner, user]]) {
      writeFileSync(join(dir, 'users.json'), JSON.stringify(users));
      const restored = new AuthService({ persistDir: dir });
      expect(restored.needsInit).toBe(false);
      expect([...restored.users.values()].map((u) => u.role)).toEqual(users.map((u) => u.role));
      const session = restored.login('test-user', password);
      expect(restored.session(session.sessionId)?.role).toBe('user');
      expect(() => restored.register('new-owner', password)).toThrowError(AuthError);
    }
  });

  it('会话每次使用当前用户权限,不信旧 global_owner 快照或返回对象上的角色', () => {
    const auth = new AuthService();
    auth.register('test-owner', password);
    const session = auth.login('test-owner', password);
    const snapshot = [...auth.sessions.values()][0]!;
    auth.users.get('test-owner')!.role = 'user';
    expect(snapshot.role).toBe('global_owner');
    expect(auth.session(session.sessionId)?.role).toBe('user');
    const current = auth.session(session.sessionId)!;
    current.role = 'global_owner';
    expect(auth.session(session.sessionId)?.role).toBe('user');
    auth.users.delete('test-owner');
    expect(auth.session(session.sessionId) === undefined).toBe(true);
  });

  it.each(['user', 'session'] as const)('运行时 %s 的未知/缺失角色拒绝认证', (record) => {
    const auth = new AuthService();
    auth.register('test-owner', password);
    const session = auth.login('test-owner', password);
    const target = record === 'user' ? auth.users.get('test-owner')! : [...auth.sessions.values()][0]!;
    for (const role of [undefined, null, 'owner']) {
      // 故意合成损坏记录,生产角色类型仍是严格白名单。
      Object.assign(target, { role });
      expect(() => auth.session(session.sessionId)).toThrowError(AuthError);
      if (record === 'user') expect(() => auth.login('test-owner', password)).toThrowError(AuthError);
      expect(auth.sessions.size).toBe(1);
    }
  });

  it('已初始化后 users 丢失/清空和损坏标记均拒绝启动', () => {
    const auth = new AuthService({ persistDir: dir });
    auth.register('test-owner', password);
    renameSync(join(dir, 'users.json'), join(dir, 'users.saved.json'));
    expect(() => new AuthService({ persistDir: dir })).toThrowError(AuthError);
    writeFileSync(join(dir, 'users.json'), '[]');
    expect(() => new AuthService({ persistDir: dir })).toThrowError(AuthError);
    writeFileSync(join(dir, 'users.json'), readFileSync(join(dir, 'users.saved.json')));
    writeFileSync(join(dir, 'initialized'), 'corrupt');
    expect(() => new AuthService({ persistDir: dir })).toThrowError(AuthError);
  });

  it('读取失败不是缺失:users 是目录时拒绝启动', () => {
    mkdirSync(join(dir, 'users.json'));
    expect(() => new AuthService({ persistDir: dir })).toThrowError(AuthError);
  });

  it('实际读取 EACCES/ENOENT 均不是可重新初始化信号', () => {
    writeFileSync(join(dir, 'users.json'), '[]');
    for (const code of ['EACCES', 'ENOENT']) {
      vi.mocked(readFileSync).mockImplementationOnce(() => { throw Object.assign(new Error('test read failure'), { code }); });
      expect(() => new AuthService({ persistDir: dir })).toThrowError(AuthError);
    }
  });

  it('users 写入中断后不发布用户,保留标记阻止重启重新 bootstrap', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    const auth = new AuthService({ persistDir: dir });
    vi.mocked(writeFileSync).mockImplementationOnce(actual.writeFileSync)
      .mockImplementationOnce(() => { throw new Error('test disk write failure'); });
    expect(() => auth.register('test-owner', password)).toThrowError(AuthError);
    expect(auth.users.size).toBe(0);
    expect(auth.sessions.size).toBe(0);
    expect(auth.needsInit).toBe(false);
    expect(existsSync(join(dir, 'initialized'))).toBe(true);
    expect(() => new AuthService({ persistDir: dir })).toThrowError(AuthError);
  });

  it('fsync 失败不发布内存成功且关闭认证', () => {
    const auth = new AuthService({ persistDir: dir });
    vi.mocked(fsyncSync).mockImplementationOnce(() => { throw new Error('test flush failure'); });
    expect(() => auth.register('test-owner', password)).toThrowError(AuthError);
    expect(auth.users.size).toBe(0);
    expect(auth.needsInit).toBe(false);
    expect(() => auth.login('test-owner', password)).toThrowError(AuthError);
    expect(() => auth.session('test-session')).toThrowError(AuthError);
  });

  it('写入失败不发布用户或会话;当前实例不能重试 bootstrap', () => {
    const auth = new AuthService({ persistDir: dir });
    mkdirSync(join(dir, 'users.json'));
    expect(() => auth.register('test-owner', password)).toThrowError(AuthError);
    expect(auth.users.size).toBe(0);
    expect(auth.sessions.size).toBe(0);
    expect(auth.needsInit).toBe(false);
    expect(() => auth.login('test-owner', password)).toThrowError(AuthError);
    expect(() => auth.register('other-owner', password)).toThrowError(AuthError);
  });

  it('标记写入失败同样拒绝发布内存成功', () => {
    const auth = new AuthService({ persistDir: dir });
    mkdirSync(join(dir, 'initialized'));
    expect(() => auth.register('test-owner', password)).toThrowError(AuthError);
    expect(auth.users.size).toBe(0);
    expect(existsSync(join(dir, 'users.json'))).toBe(false);
  });

  it('两个预先打开的实例只有一个可以初始化,不覆盖胜者', () => {
    const first = new AuthService({ persistDir: dir });
    const stale = new AuthService({ persistDir: dir });
    first.register('test-owner', password);
    expect(() => stale.register('other-owner', password)).toThrowError(AuthError);
    expect(stale.users.size).toBe(0);
    const restored = new AuthService({ persistDir: dir });
    expect(restored.login('test-owner', password).username).toBe('test-owner');
    expect(restored.users.has('other-owner')).toBe(false);
  });

  it('内存 users 清空不等于显式未初始化', () => {
    const auth = new AuthService();
    auth.register('test-owner', password);
    auth.users.clear();
    expect(auth.needsInit).toBe(false);
    expect(() => auth.register('other-owner', password)).toThrowError(AuthError);
  });
});