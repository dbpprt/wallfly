import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { AuthenticationState, SocketConfig, WASocket, WAVersion } from '@whiskeysockets/baileys';
import type { createBaileysSocket } from '../src/daemon/socket.js';

type Dependencies = NonNullable<Parameters<typeof createBaileysSocket>[1]>;
type VersionResult = Awaited<ReturnType<Dependencies['fetchLatestBaileysVersion']>>;
const fetchedVersion: WAVersion = [2, 3000, 1234567890];
const bundledVersion: WAVersion = [2, 3000, 1000000000];
const overrideVersion: WAVersion = [2, 3000, 1111111111];

async function setup(t: TestContext) {
  const authDirectory = mkdtempSync(join(tmpdir(), 'wallfly-socket-test-'));
  t.after(() => rmSync(authDirectory, { recursive: true, force: true }));
  // A fresh module gives each test a separate process-version cache, without a reset API.
  const moduleUrl = new URL('../src/daemon/socket.js', import.meta.url);
  moduleUrl.searchParams.set('test', t.name);
  const { createBaileysSocket: create } = await import(moduleUrl.href) as typeof import('../src/daemon/socket.js');
  const rawSocket = { ev: new EventEmitter(), end: t.mock.fn(), user: undefined };
  const makeWASocket = t.mock.fn((options: Parameters<Dependencies['makeWASocket']>[0]) => {
    assert.ok(options.auth);
    return rawSocket as unknown as WASocket;
  });
  const fetchLatestBaileysVersion = t.mock.fn(async (
    options?: Parameters<Dependencies['fetchLatestBaileysVersion']>[0],
  ): Promise<VersionResult> => {
    assert.equal(options?.timeout, 10000);
    return { version: fetchedVersion, isLatest: true };
  });
  const dependencies: Dependencies = {
    makeWASocket, fetchLatestBaileysVersion,
    downloadMediaMessage: async () => { throw new Error('Unexpected download.'); },
    DEFAULT_CONNECTION_CONFIG: { version: bundledVersion } as SocketConfig,
    useMultiFileAuthState: async () => ({
      state: { creds: {}, keys: { set: async () => {} } } as unknown as AuthenticationState,
      saveCreds: async () => {},
    }),
  };
  const log = t.mock.fn((event: string) => { assert.equal(event, 'socket.version.fallback'); });
  const options = { authDirectory, markOnlineOnConnect: false as const, log };
  return { create, dependencies, options, log, makeWASocket, fetchLatestBaileysVersion, rawSocket };
}

test('SocketOptions.version reaches makeWASocket and skips discovery', async (t) => {
  const { create, options, dependencies, makeWASocket, fetchLatestBaileysVersion, log, rawSocket } = await setup(t);
  const socket = await create({ ...options, version: overrideVersion }, dependencies);
  assert.deepEqual(makeWASocket.mock.calls[0]?.arguments[0].version, overrideVersion);
  assert.equal(makeWASocket.mock.calls[0]?.arguments[0].markOnlineOnConnect, false);
  assert.equal(fetchLatestBaileysVersion.mock.callCount(), 0);
  assert.equal(log.mock.callCount(), 0);
  assert.equal(socket.ev, rawSocket.ev);
});

test('sockets request full history by default, including reconnects', async (t) => {
  const { create, options, dependencies, makeWASocket } = await setup(t);
  const first = await create(options, dependencies);
  first.end(undefined);
  await create(options, dependencies);
  assert.deepEqual(makeWASocket.mock.calls.map((call) => call.arguments[0].syncFullHistory), [true, true]);
});

test('discovery is shared during concurrent creation and cached across reconnects', async (t) => {
  const { create, options, dependencies, makeWASocket, fetchLatestBaileysVersion, log } = await setup(t);
  let release!: (value: VersionResult) => void;
  fetchLatestBaileysVersion.mock.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
  const first = create(options, dependencies);
  const second = create(options, dependencies);
  assert.equal(fetchLatestBaileysVersion.mock.callCount(), 1);
  assert.equal(makeWASocket.mock.callCount(), 0);
  release({ version: fetchedVersion, isLatest: true });
  const sockets = await Promise.all([first, second]);
  for (const socket of sockets) socket.end(undefined);
  await create(options, dependencies);
  assert.equal(fetchLatestBaileysVersion.mock.callCount(), 1);
  assert.deepEqual(fetchLatestBaileysVersion.mock.calls[0]?.arguments, [{ timeout: 10000 }]);
  assert.deepEqual(makeWASocket.mock.calls.map((call) => call.arguments[0].version),
    [fetchedVersion, fetchedVersion, fetchedVersion]);
  await create({ ...options, version: overrideVersion }, dependencies);
  assert.deepEqual(makeWASocket.mock.calls[3]?.arguments[0].version, overrideVersion);
  await create(options, dependencies);
  assert.deepEqual(makeWASocket.mock.calls[4]?.arguments[0].version, fetchedVersion);
  assert.equal(fetchLatestBaileysVersion.mock.callCount(), 1);
  assert.equal(log.mock.callCount(), 0);
});

test('a rejected version fetch falls back, logs only a category, and caches the bundled version', async (t) => {
  const { create, options, dependencies, makeWASocket, fetchLatestBaileysVersion, log } = await setup(t);
  fetchLatestBaileysVersion.mock.mockImplementation(async () => { throw new Error('synthetic-sensitive-error'); });
  await create(options, dependencies);
  await create(options, dependencies);
  assert.deepEqual(makeWASocket.mock.calls.map((call) => call.arguments[0].version), [bundledVersion, bundledVersion]);
  assert.equal(fetchLatestBaileysVersion.mock.callCount(), 1);
  assert.deepEqual(log.mock.calls.map((call) => call.arguments), [['socket.version.fallback']]);
});

test('Baileys non-latest fetch results use the bundled fallback and log the failure', async (t) => {
  const { create, options, dependencies, makeWASocket, fetchLatestBaileysVersion, log } = await setup(t);
  fetchLatestBaileysVersion.mock.mockImplementation(async () => ({
    version: fetchedVersion, isLatest: false, error: new Error('synthetic-sensitive-error'),
  }));
  await create(options, dependencies);
  assert.deepEqual(makeWASocket.mock.calls[0]?.arguments[0].version, bundledVersion);
  assert.deepEqual(log.mock.calls.map((call) => call.arguments), [['socket.version.fallback']]);
});

test('a failing lifecycle logger does not stop fallback socket creation', async (t) => {
  const { create, options, dependencies, makeWASocket, fetchLatestBaileysVersion, log } = await setup(t);
  fetchLatestBaileysVersion.mock.mockImplementation(async () => { throw new Error('synthetic-fetch-error'); });
  log.mock.mockImplementation(() => { throw new Error('synthetic-log-error'); });
  await create(options, dependencies);
  assert.equal(makeWASocket.mock.callCount(), 1);
  assert.deepEqual(makeWASocket.mock.calls[0]?.arguments[0].version, bundledVersion);
});

test('saved and newly written auth LID mappings reach identity persistence offline', async (t) => {
  const { create, options, dependencies, makeWASocket } = await setup(t);
  const { writeFileSync, readFileSync, statSync } = await import('node:fs');
  const observed: [string, string][] = [];
  writeFileSync(join(options.authDirectory, 'lid-mapping-synthetic-saved.json'), JSON.stringify('synthetic-phone'));
  writeFileSync(join(options.authDirectory, 'lid-mapping-synthetic-phone_reverse.json'), JSON.stringify('synthetic-saved'));
  const { LidMap } = await import('../src/daemon/identity.js');
  const map = new LidMap(options.authDirectory);
  await create({ ...options, version: overrideVersion, observeLidMapping: (lid, pn) => {
    observed.push([lid, pn]); map.observe(lid, pn);
  } }, dependencies);
  assert.equal(map.phoneJid('synthetic-saved@lid'), 'synthetic-phone@s.whatsapp.net');
  const auth = makeWASocket.mock.calls[0]!.arguments[0].auth;
  await auth.keys.set({ 'lid-mapping': { 'synthetic-new': 'synthetic-new-phone',
    'synthetic-new-phone_reverse': 'synthetic-new', 'synthetic-deleted': null } } as unknown as Parameters<typeof auth.keys.set>[0]);
  assert.deepEqual(observed, [
    ['synthetic-saved@lid', 'synthetic-phone@s.whatsapp.net'],
    ['synthetic-saved@lid', 'synthetic-phone@s.whatsapp.net'],
    ['synthetic-new@lid', 'synthetic-new-phone@s.whatsapp.net'],
    ['synthetic-new@lid', 'synthetic-new-phone@s.whatsapp.net'],
  ]);
  assert.equal(new LidMap(options.authDirectory).phoneJid('synthetic-new@lid'), 'synthetic-new-phone@s.whatsapp.net');
  assert.equal(readFileSync(map.path, 'utf8').includes('synthetic-deleted'), false);
  assert.equal(statSync(map.path).mode & 0o777, 0o600);
});


test('send transport resolves self through the supplied live LID cache', async (t) => {
  const { create, options, dependencies, rawSocket } = await setup(t);
  const owner = 'synthetic-owner@s.whatsapp.net';
  Object.assign(rawSocket, { user: { id: 'synthetic-owner:2@s.whatsapp.net' } });
  const { LidMap } = await import('../src/daemon/identity.js');
  const map = new LidMap(options.authDirectory);
  const socket = await create({ ...options, version: overrideVersion,
    observeLidMapping: (lid, pn) => map.observe(lid, pn),
    resolveLid: (jid) => map.aliases(jid).find((alias) => alias.endsWith('@lid')) }, dependencies);
  assert.equal(socket.outgoing.resolveJid!(owner), owner);
  map.observe('synthetic-owner@lid', owner);
  assert.equal(socket.outgoing.resolveJid!(owner), 'synthetic-owner@lid');
});

test('direct socket resolves self from the saved LID cache without an injected resolver', async (t) => {
  const { create, options, dependencies, rawSocket } = await setup(t);
  const owner = 'synthetic-owner@s.whatsapp.net';
  Object.assign(rawSocket, { user: { id: 'synthetic-owner:2@s.whatsapp.net' } });
  const { LidMap } = await import('../src/daemon/identity.js');
  new LidMap(options.authDirectory).observe('synthetic-owner@lid', owner);
  const socket = await create({ ...options, authDirectory: join(options.authDirectory, 'auth'),
    version: overrideVersion }, dependencies);
  assert.equal(socket.outgoing.resolveJid!(owner), 'synthetic-owner@lid');
});

test('media adapter requests a stream with a timeout and no reupload context', async (t) => {
  const { create, options, dependencies } = await setup(t);
  const { PassThrough } = await import('node:stream');
  const stream = new PassThrough();
  const download = t.mock.fn(async () => stream);
  const socket = await create({ ...options, version: overrideVersion }, { ...dependencies,
    downloadMediaMessage: download as Dependencies['downloadMediaMessage'] });
  const message = { key: { id: 'synthetic-media' }, message: { imageMessage: { url: 'https://synthetic.invalid/media' } } };
  assert.equal(await socket.downloadMedia!(message), stream);
  assert.deepEqual(download.mock.calls[0]?.arguments, [message, 'stream', { options: { timeout: 30000 } }]);
  stream.destroy();
});
