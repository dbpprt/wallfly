import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { runCli } from '../src/cli/index.js';
import { setConfig } from '../src/cli/config.js';
import { DaemonService } from '../src/daemon/index.js';
import type { ListenerSocket } from '../src/daemon/socket.js';
import { authorized, ensureControlToken, readControlToken } from '../src/daemon/token.js';

function temporary(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'wallfly-security-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('first start generates 256 bits, preserves the token on restart, and tightens private permissions', async (t) => {
  const directory = temporary(t);
  assert.equal(readControlToken(directory), undefined);
  const service = new DaemonService({ directory, port: 0 }, {
    socketFactory: async () => { throw new Error('synthetic offline socket'); }, log: () => {},
  });
  t.after(() => service.stop());
  assert.equal(existsSync(join(directory, 'auth', 'token')), false);
  await service.start();
  const token = readControlToken(directory)!;
  assert.ok(/^[a-f0-9]{64}$/.test(token));
  assert.equal(Buffer.from(token, 'hex').length, 32);
  assert.equal(statSync(join(directory, 'auth')).mode & 0o777, 0o700);
  assert.equal(statSync(join(directory, 'auth', 'token')).mode & 0o777, 0o600);
  await service.stop();
  chmodSync(join(directory, 'auth'), 0o755);
  chmodSync(join(directory, 'auth', 'token'), 0o644);
  await service.start();
  assert.ok(readControlToken(directory) === token);
  assert.equal(statSync(join(directory, 'auth')).mode & 0o777, 0o700);
  assert.equal(statSync(join(directory, 'auth', 'token')).mode & 0o777, 0o600);
});

test('concurrent first starts persist a single token without exposing it', async (t) => {
  const directory = temporary(t);
  const script = 'import { ensureControlToken } from "./dist/src/daemon/token.js"; ensureControlToken(process.argv[1]);';
  const children = Array.from({ length: 4 }, () => spawn(process.execPath, ['--input-type=module', '-e', script, directory]));
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill(); });
  const exits = children.map((child) => once(child, 'exit'));
  assert.deepEqual(await Promise.all(exits), Array.from({ length: 4 }, () => [0, null]));
  const token = readControlToken(directory);
  assert.ok(token && ensureControlToken(directory) === token);
});

test('unsafe or malformed token files fail closed; rotation recovers without printing secrets', async (t) => {
  const directory = temporary(t);
  ensureControlToken(directory);
  const path = join(directory, 'auth', 'token');
  writeFileSync(path, 'invalid');
  assert.throws(() => ensureControlToken(directory), /Invalid control token/);
  assert.equal(authorized(directory, `Bearer ${randomBytes(32).toString('hex')}`), false);
  let output = '';
  assert.equal(await runCli(['token', 'rotate'], { directory, stdout: (s) => { output += s; } }), 0);
  assert.equal(output, '{"rotated":true}\n');
  const target = join(directory, 'sentinel');
  writeFileSync(target, 'synthetic-sentinel');
  rmSync(path);
  symlinkSync(target, path);
  assert.throws(() => readControlToken(directory));
  assert.equal(authorized(directory, `Bearer ${randomBytes(32).toString('hex')}`), false);
  assert.equal(readFileSync(target, 'utf8'), 'synthetic-sentinel');
  rmSync(path);
  mkdirSync(path);
  assert.throws(() => readControlToken(directory));
  const linked = temporary(t);
  symlinkSync(join(directory, 'auth'), join(linked, 'auth'));
  assert.throws(() => ensureControlToken(linked), /symlink/);
});

test('all POST routes require auth, status redacts, CLI reads tokens, and rotation revokes immediately', async (t) => {
  const directory = temporary(t);
  const emitter = new EventEmitter();
  let messages = 0;
  let closed = 0;
  const socket: ListenerSocket = {
    ev: emitter, user: undefined, saveCredentials: async () => {}, end: () => { closed++; },
    outgoing: {
      message: async () => { messages++; return 'synthetic-id'; },
      receipts: async () => assert.fail('No receipts'), presence: async () => assert.fail('No presence'),
    },
  };
  const service = new DaemonService({ directory, port: 0 }, { socketFactory: async () => socket, log: () => {} });
  t.after(() => service.stop());
  await service.start();
  emitter.emit('connection.update', { connection: 'open' });
  await service.flush();
  const port = service.status().port!;
  setConfig(directory, 'port', String(port));
  const token = readControlToken(directory)!;
  const wrong = randomBytes(32).toString('hex');
  const url = `http://127.0.0.1:${port}`;
  for (const authorization of [undefined, `Bearer ${wrong}`, `Basic ${token}`, 'Bearer invalid']) {
    const headers = { ...(authorization === undefined ? {} : { Authorization: authorization }) };
    for (const path of ['/send', '/stop', '/unknown', '/status']) {
      const response = await fetch(url + path, { method: 'POST', headers });
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('www-authenticate'), 'Bearer');
      await response.json();
    }
    const response = await fetch(url + '/status', { headers });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { running: true });
  }
  assert.equal(messages, 0);
  assert.equal(closed, 0);
  assert.equal(existsSync(join(directory, 'sends.jsonl')), false);
  const run = async (args: string[], request = fetch, clientDirectory = directory) => {
    let stdout = ''; let stderr = '';
    const code = await runCli(args, { directory: clientDirectory, fetch: request,
      stdout: (s) => { stdout += s; }, stderr: (s) => { stderr += s; } });
    return { code, stdout, stderr };
  };
  const status = await run(['status']);
  assert.equal(status.code, 0);
  assert.deepEqual(JSON.parse(status.stdout), service.status());
  const send = ['send', '--to', 'synthetic-chat@s.whatsapp.net', '--text', 'synthetic-text'];
  assert.equal((await run(send)).code, 0);
  assert.equal(messages, 1);
  // A separate client directory models a missing/stale local credential.
  const client = temporary(t);
  setConfig(client, 'port', String(port));
  for (const hasToken of [false, true]) {
    if (hasToken) ensureControlToken(client);
    for (const args of [send, ['stop']]) {
      const result = await run(args, fetch, client);
      assert.equal(result.code, 4);
      assert.equal(result.stdout, '');
      assert.ok(!result.stderr.includes(token));
    }
  }
  assert.equal(messages, 1);
  assert.equal(closed, 0);
  assert.deepEqual(await run(['token', 'rotate']), { code: 0, stdout: '{"rotated":true}\n', stderr: '' });
  assert.ok(readControlToken(directory) !== token);
  const stale: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  };
  assert.equal((await run(send, stale)).code, 4);
  assert.equal((await run(['stop'], stale)).code, 4);
  assert.equal((await run(send)).code, 0);
  assert.equal(messages, 2);
  // Missing persisted credentials also revoke authorization; never regenerate per request.
  const current = readControlToken(directory)!;
  rmSync(join(directory, 'auth', 'token'));
  assert.equal((await fetch(url + '/stop', { method: 'POST', headers: { Authorization: `Bearer ${current}` } })).status, 401);
  assert.equal(existsSync(join(directory, 'auth', 'token')), false);
  ensureControlToken(directory);
  assert.equal((await run(['stop'])).code, 0);
  await service.stop();
  assert.equal(closed, 1);
});

test('bin entrypoint propagates authentication exit code 4', async (t) => {
  const home = temporary(t);
  const directory = join(home, '.wallfly');
  const service = new DaemonService({ directory, port: 0 }, {
    socketFactory: async () => { throw new Error('synthetic offline socket'); }, log: () => {},
  });
  t.after(() => service.stop());
  await service.start();
  setConfig(directory, 'port', String(service.status().port));
  rmSync(join(directory, 'auth', 'token'));
  for (const args of [['stop'], ['send', '--to', 'synthetic-chat@s.whatsapp.net', '--text', 'synthetic-text']]) {
    const child = spawn(process.execPath, ['bin/wallfly', ...args], { env: { ...process.env, HOME: home } });
    const exit = once(child, 'exit');
    t.after(() => { if (child.exitCode === null) child.kill(); });
    assert.deepEqual(await exit, [4, null]);
  }
});
