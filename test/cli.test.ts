import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { archiveMedia } from '../src/daemon/media.js';
import { runCli } from '../src/cli/index.js';
import type { CliDependencies } from '../src/cli/index.js';
import { commands } from '../src/cli/help.js';
import { JsonlStore } from '../src/store/index.js';
import type { MessageRecord } from '../src/store/index.js';
import { SendService } from '../src/send/index.js';
import type { SendAuditRecord } from '../src/send/index.js';
import { handleSendRequest } from '../src/send/http.js';
import { directSend } from '../src/send/direct.js';
import { lockPid } from '../src/cli/lifecycle.js';
import type { ListenerSocket } from '../src/daemon/socket.js';
import { NameCache } from '../src/daemon/cache.js';
import { validJid } from '../src/daemon/identity.js';
import { validateRequest } from '../src/send/index.js';

// Every identifier, name, message, and media byte below is synthetic.
function setup(t: TestContext, seeded = true) {
  const directory = mkdtempSync(join(tmpdir(), 'wallfly-cli-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new JsonlStore({ directory, maxBytes: 500, keepRotations: 10 });
  const records: MessageRecord[] = Array.from({ length: 4 }, (_, i) => ({
    v: 1, ts: Date.UTC(2026, 0, i + 1), receivedAt: Date.UTC(2026, 0, i + 1),
    chatJid: i === 1 ? 'synthetic-b@invalid' : 'synthetic-a@invalid',
    chatName: 'synthetic-name', chatType: 'dm', fromMe: false,
    senderJid: i === 2 ? 'synthetic-other@invalid' : 'synthetic-sender@invalid',
    senderName: null, pushName: null, body: i === 3 ? 'synthetic,"quoted"\nline' : `synthetic-${i}`,
    mediaType: null, messageId: `synthetic-id-${i}`,
  }));
  if (seeded) for (const record of records) store.append(record);
  const run = async (args: string[], extra: CliDependencies = {}) => {
    let stdout = ''; let stderr = '';
    const code = await runCli(args, { directory, stdout: (s) => { stdout += s; }, stderr: (s) => { stderr += s; }, ...extra });
    return { code, stdout, stderr };
  };
  return { directory, store, records, run };
}
function jsonLines(text: string): unknown[] {
  return text.trim() ? text.trim().split('\n').map((line) => JSON.parse(line) as unknown) : [];
}
async function eventually(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(5); }
  assert.fail('Condition did not become true.');
}

test('global and every command help contain options, examples and exit codes', async (t) => {
  const { run } = setup(t, false);
  for (const args of [['--help'], ...commands.map((command) => [command, '--help'])]) {
    const result = await run(args);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Example: wallfly/);
    assert.match(result.stdout, /--help/);
    assert.match(result.stdout, /Exit codes:/);
  }
  for (const args of [[], ['unknown'], ['tail', '--unknown'], ['status', 'extra'], ['search'], ['config', 'set'], ['token'], ['token', 'unknown'], ['token', 'rotate', 'extra']]) {
    assert.equal((await run(args)).code, 1);
  }
});

test('search combines every filter across rotations and supports regex, limits and readable output', async (t) => {
  const { run, records: archived } = setup(t);
  const records = archived.map((record) => ({ ...record, senderName: record.senderJid }));
  const search = async (flags: string[]) => {
    const result = await run(['search', ...flags, '--json']);
    assert.equal(result.code, 0, result.stderr);
    return JSON.parse(result.stdout) as MessageRecord[];
  };
  assert.deepEqual(await search(['synthetic']), records);
  assert.deepEqual(await search(['synthetic', '--chat', 'synthetic-a@invalid']), [records[0], records[2], records[3]]);
  assert.deepEqual(await search(['synthetic', '--sender', 'synthetic-other@invalid']), [records[2]]);
  assert.deepEqual(await search(['synthetic', '--from', '2026-01-02T00:00:00Z', '--to', '2026-01-03T00:00:00Z']), records.slice(1, 3));
  assert.deepEqual(await search(['synthetic', '--chat', 'synthetic-a@invalid', '--sender', 'synthetic-other@invalid',
    '--from', '2026-01-03T01:00:00+01:00', '--to', '2026-01-03T00:00:00Z']), [records[2]]);
  assert.deepEqual(await search(['synthetic-[02]$', '--regex', '--limit', '1']), [records[0]]);
  assert.equal((await run(['search', 'SYNTHETIC'])).code, 3);
  assert.equal((await run(['search', 'synthetic', '--limit', '0'])).code, 3);
  assert.deepEqual(JSON.parse((await run(['search', 'absent', '--json'])).stdout), []);
  const readable = await run(['search', 'synthetic', '--limit', '2']);
  assert.equal(readable.code, 0);
  assert.equal(readable.stdout.trim().split('\n').length, 2);
  for (const flags of [['--regex'], ['--limit', '-1'], ['--limit', '1.5'], ['--limit', '9007199254740992'],
    ['--from', 'yesterday'], ['--from', '2026-02-30T00:00:00Z'], ['--to', '2026-01-01'], ['--from', '2026-01-04T00:00:00Z', '--to', '2026-01-01T00:00:00Z']]) {
    assert.equal((await run(['search', '[', ...flags])).code, 1);
  }
});

test('tail filters before taking the last N and follows appends through rotation without replay', async (t) => {
  const { run, records: archived, store } = setup(t);
  const records = archived.map((record) => ({ ...record, senderName: record.senderJid }));
  assert.deepEqual(jsonLines((await run(['tail', '-n', '2', '--chat', 'synthetic-a@invalid'])).stdout), records.slice(2));
  assert.deepEqual(jsonLines((await run(['tail', '-n', '10'])).stdout), records);
  assert.equal((await run(['tail', '-n', '0'])).code, 3);
  assert.equal((await run(['tail', '--chat', 'absent'])).code, 3);
  const controller = new AbortController();
  t.after(() => controller.abort());
  let output = '';
  const following = run(['tail', '-n', '0', '-f', '--chat', 'synthetic-a@invalid'], {
    signal: controller.signal, stdout: (s) => { output += s; },
  });
  await delay(20);
  store.append({ ...records[0]!, messageId: 'synthetic-next' });
  store.append({ ...records[0]!, chatJid: 'synthetic-b@invalid', messageId: 'synthetic-unmatched' });
  await eventually(() => output.includes('synthetic-next'));
  controller.abort();
  assert.equal((await following).code, 0);
  assert.equal(jsonLines(output).length, 1);
});

test('empty follow starts successfully and later prints the first record', async (t) => {
  const { run, store, records } = setup(t, false);
  const controller = new AbortController();
  t.after(() => controller.abort());
  let output = '';
  const following = run(['tail', '-f'], { signal: controller.signal, stdout: (s) => { output += s; } });
  await delay(20);
  store.append(records[0]!);
  await eventually(() => output.length > 0);
  controller.abort();
  assert.equal((await following).code, 0);
  assert.deepEqual(jsonLines(output), [{ ...records[0], senderName: records[0]!.senderJid }]);
});

test('export JSON and CSV preserve schema/content, filters, permissions and existing files', async (t) => {
  const { run, records, directory } = setup(t);
  const json = join(directory, 'export.json');
  const csv = join(directory, 'export.csv');
  assert.equal((await run(['export', '--chat', 'synthetic-a@invalid', '--from', '2026-01-03T00:00:00Z',
    '--to', '2026-01-04T00:00:00Z', '--format', 'json', '--out', json])).code, 0);
  assert.deepEqual(JSON.parse(readFileSync(json, 'utf8')), records.slice(2));
  assert.equal(statSync(json).mode & 0o777, 0o600);
  assert.equal((await run(['export', '--format', 'csv', '--out', csv])).code, 0);
  const content = readFileSync(csv, 'utf8');
  assert.match(content, /^v,ts,receivedAt,chatJid,/);
  assert.ok(content.includes('"synthetic,""quoted""\nline"'));
  assert.ok(content.endsWith('\r\n'));
  assert.equal((await run(['export', '--format', 'csv', '--out', csv])).code, 1);
  assert.equal(readFileSync(csv, 'utf8'), content);
  const empty = join(directory, 'empty.json');
  assert.equal((await run(['export', '--chat', 'absent', '--format', 'json', '--out', empty])).code, 3);
  assert.deepEqual(JSON.parse(readFileSync(empty, 'utf8')), []);
  for (const args of [['--format', 'xml', '--out', 'unused'], ['--format', 'json'], ['--out', 'unused']]) {
    assert.equal((await run(['export', ...args])).code, 1);
  }
});

test('chats aggregate recorded messages; empty reads and missing audit logs exit 3', async (t) => {
  const { run } = setup(t);
  const result = await run(['chats']);
  assert.equal(result.code, 0);
  const chats = jsonLines(result.stdout) as { jid: string; count: number; lastTs: number }[];
  assert.deepEqual(chats.map((chat) => chat.count), [3, 1]);
  assert.equal(chats[0]!.lastTs, Date.UTC(2026, 0, 4));
  const empty = setup(t, false);
  for (const command of ['chats', 'tail', 'sends']) assert.equal((await empty.run([command])).code, 3);
});

test('config persists all settings privately, validates types/ranges and defaults send gates OFF/media ON', async (t) => {
  const { directory, run } = setup(t, false);
  assert.equal((await run(['config', 'get', 'presence'])).stdout, 'false\n');
  assert.equal((await run(['config', 'get', 'media_archival'])).stdout, 'true\n');
  assert.equal((await run(['config', 'set', 'media_archival', 'false'])).code, 0);
  assert.equal((await run(['config', 'get', 'media_archival'])).stdout, 'false\n');
  assert.equal((await run(['config', 'set', 'media_archival', '1'])).code, 1);
  assert.equal((await run(['config', 'get', 'audit_rotations'])).stdout, '10\n');
  for (const [key, value] of [['read_receipts', 'true'], ['presence', 'true'], ['port', '8001'], ['maxBytes', '1000'], ['keepRotations', '0'], ['audit_rotations', '2']]) {
    assert.equal((await run(['config', 'set', key!, value!])).code, 0);
    assert.equal((await run(['config', 'get', key!])).stdout.trim(), value);
  }
  const path = join(directory, 'config.json');
  assert.equal(statSync(path).mode & 0o777, 0o600);
  chmodSync(path, 0o644);
  assert.equal((await run(['config', 'get'])).code, 0);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  const original = readFileSync(path, 'utf8');
  for (const [key, value] of [['unknown', '1'], ['presence', '1'], ['presence', '"true"'], ['port', '0'], ['port', '65536'],
    ['maxBytes', '0'], ['keepRotations', '-1'], ['keepRotations', '1.5'], ['audit_rotations', '-1'], ['audit_rotations', '1.5'], ['audit_rotations', 'true'], ['audit_rotations', '9007199254740992']]) {
    assert.equal((await run(['config', 'set', key!, value!])).code, 1);
    assert.equal(readFileSync(path, 'utf8'), original);
  }
  writeFileSync(path, '{');
  assert.equal((await run(['config', 'get'])).code, 1);
  assert.equal((await run(['start', '--help'])).code, 0);
});

test('HTTP send prints the exact audit entry, appended before mocked transport, and sends lists attempts', async (t) => {
  const { run, directory } = setup(t, false);
  let calls = 0;
  const transport = {
    message: async () => {
      calls++;
      const audit = jsonLines(readFileSync(join(directory, 'sends.jsonl'), 'utf8')) as SendAuditRecord[];
      assert.equal(audit.length, calls);
      assert.equal(audit.at(-1)!.textSha256, createHash('sha256').update('synthetic-send').digest('hex'));
      return 'synthetic-message-id';
    }, receipts: async () => assert.fail('Unexpected receipt'), presence: async () => assert.fail('Unexpected presence'),
  };
  const sender = new SendService({ directory }, () => transport);
  const server = createServer((req, res) => { void handleSendRequest(req, res, (value) => sender.sendWithAudit(value)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  await run(['config', 'set', 'port', String(address.port)]);
  for (let i = 0; i < 2; i++) {
    const result = await run(['send', '--to', 'synthetic-chat@s.whatsapp.net', '--text', 'synthetic-send']);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), jsonLines(readFileSync(join(directory, 'sends.jsonl'), 'utf8')).at(-1));
  }
  assert.equal(calls, 2);
  const result = await run(['sends', '--limit', '1']);
  assert.equal(result.code, 0);
  assert.equal(jsonLines(result.stdout).length, 1);
  assert.equal((await run(['sends', '--limit', '0'])).code, 3);
});

test('send validates arguments/media before HTTP, resolves paths, and maps server failures', async (t) => {
  const { run, directory } = setup(t, false);
  const media = join(directory, 'synthetic.bin'); writeFileSync(media, 'synthetic-bytes');
  const jid = 'synthetic-chat@s.whatsapp.net';
  let calls = 0;
  const http: typeof fetch = async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body)) as { image?: string; caption?: string };
    assert.equal(body.image, resolve(media)); assert.equal(body.caption, 'synthetic-caption');
    return new Response(JSON.stringify({ audit: { synthetic: true } }));
  };
  for (const flags of [[], ['--text', ''], ['--text', ' '], ['--caption', 'synthetic'], ['--image', media, '--document', media],
    ['--image', 'missing'], ['--document', directory], ['--image', media, '--text', 'synthetic', '--caption', 'synthetic']]) {
    assert.equal((await run(['send', '--to', jid, ...flags], { fetch: http })).code, 1);
  }
  assert.equal((await run(['send', '--to', 'invalid', '--text', 'synthetic'], { fetch: http })).code, 1);
  assert.equal(calls, 0);
  assert.equal((await run(['send', '--to', jid, '--image', media, '--text', 'synthetic-caption'], { fetch: http })).code, 0);
  assert.equal(calls, 1);
  for (const status of [400, 401, 403, 500, 502, 503]) {
    assert.equal((await run(['send', '--to', jid, '--text', 'synthetic'], {
      fetch: async () => new Response(JSON.stringify({ error: 'synthetic-failure' }), { status }),
    })).code, status === 401 ? 4 : status >= 500 ? 2 : 1);
  }
  assert.equal((await run(['send', '--to', jid, '--text', 'synthetic'], { fetch: async () => new Response('{}') })).code, 1);
});

test('status and stop use saved loopback port; unavailable daemon exits 2', async (t) => {
  const { run } = setup(t, false);
  await run(['config', 'set', 'port', '8123']);
  for (const command of ['status', 'stop']) {
    const result = await run([command], { fetch: async (url, init) => {
      assert.equal(url, `http://127.0.0.1:8123/${command}`);
      assert.equal(init?.method, command === 'status' ? 'GET' : 'POST');
      return new Response('{"synthetic":true}');
    } });
    assert.equal(result.code, 0);
    assert.equal((await run([command], { fetch: async () => { throw new Error('offline'); } })).code, 2);
  }
});

test('foreground lifecycle owns private pidfile, loads saved options, cleans on stop/failure, and pair starts QR-capable daemon', async (t) => {
  const { run, directory } = setup(t, false);
  await run(['config', 'set', 'port', '8123']);
  await run(['config', 'set', 'maxBytes', '2048']);
  await run(['config', 'set', 'keepRotations', '2']);
  await run(['config', 'set', 'audit_rotations', '3']);
  for (const command of ['start', 'pair']) {
    const controller = new AbortController(); let started = false; let stopped = 0;
    const running = run([command], { signal: controller.signal, daemonFactory: (options) => {
      assert.equal(options.port, 8123); assert.equal(options.maxBytes, 2048); assert.equal(options.keepRotations, 2);
      assert.equal(options.audit_rotations, 3);
      assert.equal(options.presence, false); assert.equal(options.read_receipts, false);
      assert.equal(statSync(join(directory, 'wallfly.pid')).mode & 0o777, 0o600);
      return { start: async () => { started = true; }, stop: async () => { stopped++; }, status: () => ({ state: 'connected' }) };
    } });
    await eventually(() => started);
    assert.equal(readFileSync(join(directory, 'wallfly.pid'), 'utf8'), `${process.pid}\n`);
    assert.equal((await run(['start'])).code, 1);
    controller.abort();
    assert.equal((await running).code, 0); assert.equal(stopped, 1);
    assert.equal(existsSync(join(directory, 'wallfly.pid')), false);
  }
  assert.equal((await run(['start'], { daemonFactory: () => { throw new Error('synthetic failure'); } })).code, 1);
  assert.equal(existsSync(join(directory, 'wallfly.pid')), false);
});

test('stop uses authenticated HTTP even with a pidfile; rejection cannot signal a process', async (t) => {
  const { run, directory } = setup(t, false);
  writeFileSync(join(directory, 'wallfly.pid'), `${process.pid}\n`);
  let contacted = false;
  const result = await run(['stop'], { fetch: async () => {
    contacted = true;
    return new Response('{"error":"Authentication required"}', { status: 401 });
  } });
  assert.equal(result.code, 4);
  assert.ok(contacted);
});

test('direct CLI shares pid lock, invokes only explicit send module, and closes saved-auth socket after audit', async (t) => {
  const { run, directory } = setup(t, false);
  const jid = 'synthetic-chat@s.whatsapp.net';
  const unavailable: typeof fetch = async () => { throw new Error('offline'); };
  const unlock = lockPid(directory);
  assert.equal((await run(['send', '--to', jid, '--text', 'synthetic', '--direct'], { fetch: unavailable })).code, 1);
  unlock();
  assert.equal((await run(['send', '--to', jid, '--text', 'synthetic', '--direct'], { fetch: unavailable })).code, 2);
  mkdirSync(join(directory, 'auth')); writeFileSync(join(directory, 'auth', 'creds.json'), '{}');
  const emitter = new EventEmitter(); let closed = 0;
  const socket = { ev: emitter, user: undefined, saveCredentials: async () => {}, end: () => { closed++; },
    outgoing: { message: async () => {
      assert.equal(jsonLines(readFileSync(join(directory, 'sends.jsonl'), 'utf8')).length, 1);
      return 'synthetic-direct';
    }, receipts: async () => assert.fail('Unexpected receipt'), presence: async () => assert.fail('Unexpected presence') },
  } as ListenerSocket;
  const result = await run(['send', '--to', jid, '--text', 'synthetic', '--direct'], {
    fetch: unavailable,
    directSend: (request, options, signal) => directSend(request, options, signal, async () => {
      setImmediate(() => emitter.emit('connection.update', { connection: 'open' })); return socket;
    }),
  });
  assert.equal(result.code, 0, result.stderr); assert.equal(closed, 1);
  assert.equal((JSON.parse(result.stdout) as SendAuditRecord).kind, 'text');
  assert.equal(existsSync(join(directory, 'wallfly.pid')), false);
});

test('bin entrypoint runs as ESM with real process exit codes and isolated HOME', async (t) => {
  const { directory, store } = setup(t, false);
  const env = { ...process.env, HOME: directory };
  for (const [args, expected] of [[['--help'], 0], [['search'], 1], [['tail'], 3]] as const) {
    const result = spawnSync(process.execPath, ['bin/wallfly', ...args], { env, encoding: 'utf8' });
    assert.equal(result.status, expected, result.stderr);
  }
  assert.equal(store.tail(1).records.length, 0);
  const server = createServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  await new Promise<void>((accept) => server.close(() => accept()));
  spawnSync(process.execPath, ['bin/wallfly', 'config', 'set', 'port', String(address.port)], { env });
  const unavailable = spawnSync(process.execPath, ['bin/wallfly', 'status'], { env, encoding: 'utf8' });
  assert.equal(unavailable.status, 2, unavailable.stderr);
});

test('direct mode refuses pairing/disconnect and drains credential saves before closing', async (t) => {
  const { directory } = setup(t, false);
  mkdirSync(join(directory, 'auth')); writeFileSync(join(directory, 'auth', 'creds.json'), '{}');
  for (const mode of ['pairing', 'disconnected', 'credentials', 'save-failure']) {
    const emitter = new EventEmitter();
    const calls: string[] = [];
    const socket = { ev: emitter, user: undefined,
      saveCredentials: async () => {
        await delay(5);
        calls.push('saved');
        if (mode === 'save-failure') throw new Error('synthetic-save-error');
      },
      end: () => { calls.push('closed'); },
      outgoing: { message: async () => { calls.push('sent'); return null; },
        receipts: async () => {}, presence: async () => {} },
    } as ListenerSocket;
    const sending = directSend({ jid: 'synthetic-chat@s.whatsapp.net', text: 'synthetic' }, { directory },
      new AbortController().signal, async () => {
        setImmediate(() => {
          if (mode === 'pairing') emitter.emit('connection.update', { qr: 'synthetic-qr' });
          else {
            emitter.emit('creds.update', {});
            emitter.emit('connection.update', { connection: 'open' });
            if (mode === 'disconnected') emitter.emit('connection.update', { connection: 'close' });
          }
        });
        return socket;
      });
    if (mode === 'credentials') {
      await sending;
      assert.deepEqual(calls, ['saved', 'sent', 'closed']);
    } else {
      await assert.rejects(sending, { status: 503 });
      assert.equal(calls.includes('sent'), false);
      assert.equal(calls.at(-1), 'closed');
    }
    assert.equal(emitter.listenerCount('connection.update'), 0);
    assert.equal(emitter.listenerCount('creds.update'), 0);
  }
});

test('chats resolves archived unnamed DMs from current mappings, pushnames and group participants', async (t) => {
  const { run, directory, store, records } = setup(t, false);
  const { NameCache } = await import('../src/daemon/cache.js');
  const lid = 'synthetic-person@lid';
  const pn = 'synthetic-phone@s.whatsapp.net';
  const cache = new NameCache(directory);
  store.append({ ...records[0]!, chatJid: lid, senderJid: lid, chatName: null, pushName: null });
  store.append({ ...records[1]!, chatJid: 'synthetic-unresolved@lid', chatName: null });
  cache.groups([{ id: 'synthetic-shared@g.us', subject: 'synthetic-shared-name', participants: [{ id: pn, lid }] }]);
  const phoneOnly = jsonLines((await run(['chats'])).stdout)[0] as { name: string | null; phone: string };
  assert.equal(phoneOnly.name, lid);
  assert.equal(phoneOnly.phone, '+synthetic-phone');
  cache.message({ key: { remoteJid: 'synthetic-shared@g.us', participant: lid },
    pushName: 'synthetic-person-name', messageTimestamp: 100 });
  const result = await run(['chats']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(jsonLines(result.stdout), [
    { jid: lid, name: 'synthetic-person-name', phone: '+synthetic-phone', pushname: 'synthetic-person-name',
      type: 'dm', count: 1, lastTs: records[0]!.ts },
    { jid: 'synthetic-unresolved@lid', name: 'synthetic-unresolved@lid', phone: null, pushname: null, type: 'dm', count: 1, lastTs: records[1]!.ts },
  ]);
});

test('who reports aliases, phone, pushname timestamp and shared group ranks without a daemon', async (t) => {
  const { run, directory } = setup(t, false);
  const { NameCache } = await import('../src/daemon/cache.js');
  const cache = new NameCache(directory);
  const lid = 'synthetic-person@lid';
  const pn = 'synthetic-phone@s.whatsapp.net';
  cache.groups([{ id: 'synthetic-shared@g.us', subject: 'synthetic-shared-name', participants: [{ id: lid, jid: pn, lid, admin: 'admin' }] },
    { id: 'synthetic-unrelated@g.us', participants: [{ id: 'synthetic-other@s.whatsapp.net' }] }]);
  cache.message({ key: { remoteJid: lid, senderPn: pn }, pushName: 'synthetic-person-name', messageTimestamp: 100 });
  const result = await run(['who', 'synthetic-person:2@lid']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    jid: lid, aliases: [lid, pn], name: 'synthetic-person-name', phone: '+synthetic-phone', phoneJid: pn,
    pushname: 'synthetic-person-name', pushnameTs: 100000,
    groups: [{ jid: 'synthetic-shared@g.us', name: 'synthetic-shared-name', rank: 'admin' }], count: 0, lastTs: null,
  });
  const phone = await run(['who', pn]);
  assert.equal(JSON.parse(phone.stdout).groups.length, 1);
  assert.equal((await run(['who', 'synthetic-unknown@lid'])).code, 3);
  for (const args of [['who'], ['who', 'a', 'b'], ['who', 'invalid'], ['who', 'synthetic@lid', '--unknown']]) {
    assert.equal((await run(args)).code, 1);
  }
});

test('old archives provide pushname fallback for chats and who without mistaking owner names for recipients', async (t) => {
  const { run, store, records } = setup(t, false);
  const lid = 'synthetic-legacy@lid';
  store.append({ ...records[0]!, chatJid: lid, senderJid: lid, chatName: null, pushName: 'synthetic-peer' });
  store.append({ ...records[1]!, chatJid: lid, senderJid: 'synthetic-self@lid', fromMe: true, chatName: null, pushName: 'synthetic-self' });
  assert.equal((JSON.parse((await run(['who', lid])).stdout) as { pushname: string }).pushname, 'synthetic-peer');
  assert.equal((jsonLines((await run(['chats'])).stdout)[0] as { name: string }).name, 'synthetic-peer');
});

test('alias set/list/remove roundtrip is local, supports quoted names and survives fresh file reads', async (t) => {
  const { run, directory } = setup(t, false);
  const jid = 'synthetic-person@lid';
  const offline = { fetch: async () => assert.fail('Alias operation must never contact the daemon') };
  assert.equal((await run(['alias', 'list'], offline)).code, 3);
  const entry = { jid, name: 'Synthetic Display Name', manual: true };
  const set = await run(['alias', 'set', jid, entry.name], offline);
  assert.equal(set.code, 0, set.stderr);
  assert.deepEqual(JSON.parse(set.stdout), entry);
  assert.deepEqual(jsonLines((await run(['alias', 'list'], offline)).stdout), [entry]);
  assert.deepEqual(new NameCache(directory).listAliases(), [entry]);
  assert.equal(statSync(join(directory, 'contacts.json')).mode & 0o777, 0o600);
  assert.equal((await run(['alias', 'set', jid, 'synthetic-replaced'], offline)).code, 0);
  assert.equal((JSON.parse((await run(['who', jid])).stdout)).name, 'synthetic-replaced');
  assert.equal((await run(['who', jid])).code, 0);
  assert.equal((await run(['alias', 'remove', jid], offline)).code, 0);
  assert.equal((await run(['alias', 'remove', jid], offline)).code, 3);
  assert.equal((await run(['alias', 'list'], offline)).code, 3);
  assert.deepEqual(new NameCache(directory).listAliases(), []);
  assert.equal((await run(['who', jid])).code, 3);
});

test('alias rejects exactly the same invalid JIDs as send and rejects invalid argument counts/names', async (t) => {
  const { run, directory } = setup(t, false);
  for (const jid of ['invalid', 'synthetic@invalid', 'synthetic@broadcast', 'synthetic:2@lid',
    'synthetic @lid', '@lid', 'synthetic@@lid', `${'x'.repeat(253)}@lid`]) {
    assert.equal(validJid(jid), false);
    assert.throws(() => validateRequest({ jid, text: 'synthetic' }));
    assert.equal((await run(['alias', 'set', jid, 'synthetic-name'])).code, 1);
    assert.equal((await run(['alias', 'remove', jid])).code, 1);
  }
  for (const jid of ['synthetic@lid', 'synthetic@g.us', 'synthetic@s.whatsapp.net']) {
    assert.equal(validJid(jid), true);
    assert.doesNotThrow(() => validateRequest({ jid, text: 'synthetic' }));
    assert.equal((await run(['alias', 'set', jid, 'synthetic-name'])).code, 0);
  }
  const before = readFileSync(join(directory, 'contacts.json'), 'utf8');
  for (const args of [['alias'], ['alias', 'unknown'], ['alias', 'list', 'extra'],
    ['alias', 'set', 'synthetic@lid'], ['alias', 'set', 'synthetic@lid', 'name', 'extra'],
    ['alias', 'remove'], ['alias', 'remove', 'synthetic@lid', 'extra'],
    ['alias', 'set', 'synthetic@lid', ''], ['alias', 'set', 'synthetic@lid', '  '],
    ['alias', 'set', 'synthetic@lid', 'synthetic\0name']]) {
    assert.equal((await run(args)).code, 1);
    assert.equal(readFileSync(join(directory, 'contacts.json'), 'utf8'), before);
  }
});

test('chats, who, search and tail prefer aliases and mark manual chat/sender labels without rewriting archives', async (t) => {
  const { run, directory, store, records } = setup(t, false);
  const jid = 'synthetic-person@lid';
  const pn = 'synthetic-phone@s.whatsapp.net';
  const group = 'synthetic-group@g.us';
  const cache = new NameCache(directory);
  cache.groups([{ id: group, subject: 'synthetic-group-derived', participants: [{ id: jid, jid: pn, lid: jid }] }]);
  const dm = { ...records[0]!, chatJid: jid, senderJid: jid,
    chatName: 'synthetic-archived-derived', senderName: 'synthetic-archived-derived', pushName: 'synthetic-archived-push' };
  const groupRecord = { ...records[1]!, chatJid: group, chatType: 'group' as const, senderJid: jid,
    chatName: 'synthetic-archived-group', pushName: 'synthetic-archived-push' };
  store.append(dm); store.append(groupRecord);
  // Archive pushnames precede even a current derived label.
  cache.contacts([{ id: jid, name: 'synthetic-current-derived' }]);
  for (const command of [['chats'], ['who', jid]]) {
    assert.equal((jsonLines((await run(command)).stdout)[0] as { name: string }).name, 'synthetic-archived-push');
  }
  cache.message({ key: { remoteJid: jid, senderPn: pn }, pushName: 'synthetic-current-push', messageTimestamp: 100 });
  for (const command of [['chats'], ['who', jid]]) {
    assert.equal((jsonLines((await run(command)).stdout)[0] as { name: string }).name, 'synthetic-current-push');
  }
  assert.equal((await run(['alias', 'set', pn, 'Synthetic Manual Person'])).code, 0);
  assert.equal((await run(['alias', 'set', group, 'Synthetic Manual Group'])).code, 0);
  const chats = jsonLines((await run(['chats'])).stdout) as { name: string; manual: boolean }[];
  assert.deepEqual(chats.map(({ name, manual }) => ({ name, manual })), [
    { name: 'Synthetic Manual Person', manual: true }, { name: 'Synthetic Manual Group', manual: true },
  ]);
  const who = JSON.parse((await run(['who', jid])).stdout);
  assert.equal(who.name, 'Synthetic Manual Person');
  assert.equal(who.manual, true);
  assert.equal(who.pushname, 'synthetic-current-push');
  assert.equal(who.groups[0].name, 'Synthetic Manual Group');
  assert.equal(who.groups[0].manual, true);
  for (const args of [['search', 'synthetic', '--json'], ['tail']]) {
    const result = await run(args);
    assert.equal(result.code, 0, result.stderr);
    const displayed = args[0] === 'search' ? JSON.parse(result.stdout) : jsonLines(result.stdout);
    assert.equal(displayed[0].chatJid, jid);
    assert.equal(displayed[0].chatName, 'Synthetic Manual Person');
    assert.equal(displayed[0].senderName, 'Synthetic Manual Person');
    assert.equal(displayed[1].chatName, 'Synthetic Manual Group');
    for (const record of displayed) {
      assert.equal(record.manual, true);
      assert.equal(record.chatManual, true);
      assert.equal(record.senderManual, true);
    }
  }
  const readable = await run(['search', 'synthetic']);
  assert.match(readable.stdout, /"Synthetic Manual Person" \[manual\]/);
  assert.match(readable.stdout, /"Synthetic Manual Group" \[manual\]/);
  assert.equal((await run(['alias', 'remove', pn])).code, 0);
  assert.equal(JSON.parse((await run(['who', jid])).stdout).name, 'synthetic-current-push');
  assert.deepEqual(store.filter().records, [dm, groupRecord]);
  const exported = join(directory, 'synthetic-export.json');
  assert.equal((await run(['export', '--format', 'json', '--out', exported])).code, 0);
  assert.deepEqual(JSON.parse(readFileSync(exported, 'utf8')), [dm, groupRecord]);
});


test('search/export surface mediaPath and open prints only an existing safe local path', async (t) => {
  const { directory, records, store, run } = setup(t, false);
  const record = { ...records[0]!, v: 2 as const, mediaType: 'image' };
  const mediaPath = await archiveMedia(directory, { key: {}, message: { imageMessage: { mimetype: 'image/jpeg' } } },
    record, async () => (async function* () { yield Buffer.from('synthetic-media'); })());
  store.append({ ...record, mediaPath });
  const path = join(directory, mediaPath);
  const readable = await run(['search', 'synthetic']);
  assert.equal(readable.code, 0);
  assert.ok(readable.stdout.includes(`mediaPath="${mediaPath}"`));
  const json = await run(['search', 'synthetic', '--json']);
  assert.equal((JSON.parse(json.stdout) as MessageRecord[])[0]!.mediaPath, mediaPath);
  const exported = join(directory, 'synthetic-media.json');
  const csv = join(directory, 'synthetic-media.csv');
  assert.equal((await run(['export', '--format', 'json', '--out', exported])).code, 0);
  assert.equal((JSON.parse(readFileSync(exported, 'utf8')) as MessageRecord[])[0]!.mediaPath, mediaPath);
  assert.equal((await run(['export', '--format', 'csv', '--out', csv])).code, 0);
  const content = readFileSync(csv, 'utf8');
  assert.ok(content.split('\r\n')[0]!.endsWith('mediaPath'));
  assert.ok(content.includes(mediaPath));
  assert.deepEqual(await run(['open', record.messageId]), { code: 0, stdout: path + '\n', stderr: '' });
  assert.equal((await run(['open', 'synthetic-absent'])).code, 3);
  assert.equal((await run(['open'])).code, 1);
  assert.equal((await run(['open', record.messageId, 'extra'])).code, 1);
  rmSync(path);
  const missing = await run(['open', record.messageId]);
  assert.equal(missing.code, 1);
  assert.equal(missing.stdout, '');
  symlinkSync(exported, path);
  assert.equal((await run(['open', record.messageId])).code, 1);
});

test('open reports no archived media for legacy/text or gate-disabled records', async (t) => {
  const { run, records, store } = setup(t);
  assert.equal((await run(['open', records[0]!.messageId])).code, 3);
  store.append({ ...records[0]!, v: 2, messageId: 'synthetic-unarchived', mediaType: 'video' });
  const result = await run(['open', 'synthetic-unarchived']);
  assert.equal(result.code, 3);
  assert.equal(result.stdout, '');
});
