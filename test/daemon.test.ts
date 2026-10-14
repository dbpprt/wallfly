import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { BaileysEventMap, WAMessage } from '@whiskeysockets/baileys';
import { DaemonService, mapMessage, NameCache } from '../src/daemon/index.js';
import type { DaemonDependencies, DaemonOptions, ListenerSocket, SocketOptions } from '../src/daemon/index.js';
import type { ListenerEvent } from '../src/daemon/socket.js';
import { printPairingQr } from '../src/daemon/pair.js';
import { JsonlStore } from '../src/store/index.js';
import { SendService } from '../src/send/index.js';

// All identifiers, text, display names, and pairing input are synthetic markers.
class FakeSocket implements ListenerSocket {
  readonly emitter = new EventEmitter();
  user = { id: 'test-self:2@invalid' };
  closed = 0;
  saved = 0;
  readonly outgoingCalls: string[] = [];
  readonly outgoing = {
    message: async (): Promise<string> => { this.outgoingCalls.push('message'); return 'synthetic-sent-id'; },
    receipts: async (): Promise<void> => { this.outgoingCalls.push('receipts'); },
    presence: async (): Promise<void> => { this.outgoingCalls.push('presence'); },
  };
  readonly ev = {
    on: <K extends ListenerEvent>(event: K, callback: (data: BaileysEventMap[K]) => void): void => {
      this.emitter.on(event, callback);
    },
    off: <K extends ListenerEvent>(event: K, callback: (data: BaileysEventMap[K]) => void): void => {
      this.emitter.off(event, callback);
    },
  };
  async saveCredentials(): Promise<void> { this.saved++; }
  end(): void { this.closed++; }
  emit<K extends ListenerEvent>(event: K, value: BaileysEventMap[K]): void {
    this.emitter.emit(event, value);
  }
}

function directory(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'wallfly-daemon-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function message(overrides: Partial<WAMessage> = {}): WAMessage {
  return { key: { remoteJid: 'test-chat@invalid', id: 'test-id', fromMe: false },
    messageTimestamp: 123, pushName: 'synthetic-push', message: { conversation: 'synthetic-body' }, ...overrides };
}

function setup(t: TestContext, options: DaemonOptions = {}, dependencies: DaemonDependencies = {}) {
  const root = directory(t);
  const socket = new FakeSocket();
  const calls: SocketOptions[] = [];
  const logs: { event: string; details?: { attempt: number; delayMs: number } }[] = [];
  const service = new DaemonService({ directory: root, port: 0, ...options }, {
    socketFactory: async (value) => { calls.push(value); return socket; },
    pairingOutput: async () => {},
    log: (event, details) => logs.push({ event, ...(details ? { details } : {}) }),
    ...dependencies,
  });
  t.after(() => service.stop());
  return { root, socket, service, calls, logs };
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let iteration = 0; iteration < 200; iteration++) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail('Condition did not become true');
}

function control(port: number, method: string, path: string, body?: string,
  headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
  return new Promise((accept, reject) => {
    const req = request({ hostname: '127.0.0.1', port, method, path, agent: false, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (part: string) => { body += part; });
      res.on('end', () => accept({ status: res.statusCode!, body: JSON.parse(body) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('maps schema v1 with cached names, timestamps, sync type, group sender, and own device JID', (t) => {
  const cache = new NameCache(directory(t));
  cache.contacts([{ id: 'test-chat@invalid', name: 'synthetic-chat' },
    { id: 'test-sender@invalid', name: 'synthetic-sender' }]);
  cache.groups([{ id: 'test-group@g.us', subject: 'synthetic-group' }]);
  const result = mapMessage(message(), 'notify', cache, 'test-self@invalid', 456000);
  assert.deepEqual(result, { v: 1, ts: 123000, receivedAt: 456000, chatJid: 'test-chat@invalid',
    chatName: 'synthetic-chat', chatType: 'dm', fromMe: false, senderJid: 'test-chat@invalid',
    senderName: 'synthetic-chat', pushName: 'synthetic-push', body: 'synthetic-body',
    mediaType: null, messageId: 'test-id', syncType: 'notify' });
  const group = message({ key: { remoteJid: 'test-group@g.us', participant: 'test-sender:3@invalid', id: 'test-group-id' },
    message: { ephemeralMessage: { message: { viewOnceMessageV2: { message: {
      imageMessage: { caption: 'synthetic-caption' },
    } } } } } });
  const mapped = mapMessage(group, 'append', cache, undefined, 456000)!;
  assert.equal(mapped.senderJid, 'test-sender@invalid');
  assert.equal(mapped.senderName, 'synthetic-sender');
  assert.equal(mapped.chatName, 'synthetic-group');
  assert.equal(mapped.body, 'synthetic-caption');
  assert.equal(mapped.mediaType, 'image');
  assert.equal(mapped.syncType, 'append');
  const own = mapMessage(message({ key: { id: 'test-own', remoteJid: 'test-chat@invalid', fromMe: true } }),
    'notify', cache, 'test-self:2@invalid')!;
  assert.equal(own.senderJid, 'test-self@invalid');
  assert.equal(own.fromMe, true);
  assert.equal(mapMessage({ ...group, key: { remoteJid: 'test-group@g.us', id: 'missing-sender' } },
    'notify', cache, undefined), null);
});

test('maps supported media and text wrappers; skips broadcasts, malformed and protocol-only events', (t) => {
  const cache = new NameCache(directory(t));
  const media: [NonNullable<WAMessage['message']>, string, string][] = [
    [{ videoMessage: { caption: 'synthetic-caption' } }, 'video', 'synthetic-caption'],
    [{ documentWithCaptionMessage: { message: { documentMessage: { caption: 'synthetic-caption' } } } }, 'document', 'synthetic-caption'],
    [{ audioMessage: {} }, 'audio', ''], [{ stickerMessage: {} }, 'sticker', ''],
  ];
  for (const [content, kind, body] of media) {
    const result = mapMessage(message({ message: content }), 'notify', cache, undefined)!;
    assert.equal(result.mediaType, kind);
    assert.equal(result.body, body);
  }
  const text = mapMessage(message({ message: { extendedTextMessage: { text: 'synthetic-extended' } },
    messageTimestamp: { toNumber: () => 789 } as NonNullable<WAMessage['messageTimestamp']> }), 'append', cache, undefined)!;
  assert.equal(text.body, 'synthetic-extended');
  assert.equal(text.ts, 789000);
  assert.equal(mapMessage(message({ messageTimestamp: null }), 'notify', cache, undefined, 1234)?.ts, 1234);
  for (const sample of [message({ key: { remoteJid: 'status@broadcast', id: 'status-test' } }),
    message({ key: {} }), message({ message: null }), message({ message: { protocolMessage: {} } }),
    message({ messageTimestamp: -1 }), message({ messageTimestamp: Infinity }),
    message({ key: { remoteJid: 'test-chat@invalid', id: 'test-own', fromMe: true } })]) {
    assert.equal(mapMessage(sample, 'notify', cache, undefined), null);
  }
});

test('name cache persists partial updates, enforces private permissions, ignores extra metadata', (t) => {
  const root = directory(t);
  const cache = new NameCache(root);
  cache.contacts([{ id: 'test-contact:1@invalid', notify: 'synthetic-notify', imgUrl: 'synthetic-extra' },
    { id: 'status@broadcast', name: 'synthetic-status' }]);
  cache.groups([{ id: 'test-group@g.us', subject: 'synthetic-old' }]);
  cache.contacts([{ id: 'test-contact@invalid' }]);
  cache.groups([{ id: 'test-group@g.us' }, { id: 'test-group@g.us', subject: 'synthetic-new' }]);
  assert.equal(new NameCache(root).get('test-contact@invalid'), 'synthetic-notify');
  assert.equal(new NameCache(root).get('test-group@g.us'), 'synthetic-new');
  assert.equal(new NameCache(root).get('status@broadcast'), null);
  assert.equal(readFileSync(cache.path, 'utf8').includes('synthetic-extra'), false);
  assert.equal(statSync(root).mode & 0o777, 0o700);
  assert.equal(statSync(cache.path).mode & 0o777, 0o600);
  chmodSync(cache.path, 0o644);
  new NameCache(root);
  assert.equal(statSync(cache.path).mode & 0o777, 0o600);
});

test('name cache fails closed on corrupt data and symlinks', (t) => {
  const root = directory(t);
  writeFileSync(join(root, 'contacts.json'), '{');
  assert.throws(() => new NameCache(root));
  rmSync(join(root, 'contacts.json'));
  const target = join(root, 'synthetic-target');
  writeFileSync(target, '{}');
  symlinkSync(target, join(root, 'contacts.json'));
  assert.throws(() => new NameCache(root));
});

test('daemon persists event and history mapping, contact/group updates, and credentials offline', async (t) => {
  const { service, socket, root, calls } = setup(t);
  await service.start();
  assert.deepEqual(calls, [{ authDirectory: join(root, 'auth'), markOnlineOnConnect: false }]);
  assert.equal(statSync(join(root, 'auth')).mode & 0o777, 0o700);
  socket.emit('connection.update', { connection: 'open' });
  socket.emit('contacts.upsert', [{ id: 'test-chat@invalid', name: 'synthetic-old' }]);
  socket.emit('contacts.update', [{ id: 'test-chat@invalid', name: 'synthetic-new' }]);
  socket.emit('groups.upsert', [{ id: 'test-group@g.us', subject: 'synthetic-old-group', owner: undefined,
    addressingMode: 'pn', participants: [] }]);
  socket.emit('groups.update', [{ id: 'test-group@g.us', subject: 'synthetic-new-group' }]);
  socket.emit('messages.upsert', { type: 'notify', messages: [message(),
    message({ key: { remoteJid: 'status@broadcast', id: 'test-status' } })] });
  socket.emit('messages.upsert', { type: 'append', messages: [message({ key: { remoteJid: 'test-group@g.us',
    participant: 'test-chat@invalid', id: 'test-group-id' } })] });
  socket.emit('messaging-history.set', { chats: [{ id: 'test-history-group@g.us', name: 'synthetic-history-group' }],
    contacts: [{ id: 'test-history@invalid', notify: 'synthetic-history' }],
    messages: [message({ key: { remoteJid: 'test-history@invalid', id: 'test-history-id' } })] });
  socket.emit('creds.update', {});
  await service.flush();
  const records = new JsonlStore({ directory: root }).filter().records;
  assert.equal(records.length, 3);
  assert.deepEqual(records.map((record) => record.syncType), ['notify', 'append', 'append']);
  assert.equal(records[0]?.chatName, 'synthetic-new');
  assert.equal(records[1]?.chatName, 'synthetic-new-group');
  assert.equal(records[2]?.senderName, 'synthetic-history');
  assert.equal(service.cache.get('test-history-group@g.us'), 'synthetic-history-group');
  assert.equal(service.status().recordedMessages, 3);
  assert.equal(socket.saved, 1);
  assert.deepEqual(socket.outgoingCalls, []);
});

test('control endpoint only exposes loopback status, stop, and send; unknown routes reject', async (t) => {
  const { service, socket } = setup(t);
  await service.start();
  const port = service.status().port!;
  assert.equal((await control(port, 'GET', '/status')).status, 200);
  for (const [method, path] of [['GET', '/send'], ['GET', '/stop'], ['POST', '/status'],
    ['GET', '/'], ['GET', '/status?extra=true']]) {
    assert.equal((await control(port, method!, path!)).status, 404);
  }
  socket.emit('connection.update', { connection: 'open' });
  await service.flush();
  const response = await control(port, 'GET', '/status');
  assert.equal((response.body as { connected: boolean }).connected, true);
  assert.equal((await control(port, 'POST', '/stop')).status, 200);
  await eventually(() => socket.closed === 1);
  assert.equal(service.status().state, 'stopped');
  assert.equal(service.status().port, null);
  assert.equal(socket.emitter.eventNames().length, 0);
});

test('rejects every non-127.0.0.1 bind and invalid options before creating files', (t) => {
  const root = join(directory(t), 'uncreated');
  for (const host of ['0.0.0.0', '::', '::1', 'localhost', '127.0.0.2', 'test-host.invalid']) {
    assert.throws(() => new DaemonService({ directory: root, host }), /127\.0\.0\.1/);
  }
  assert.throws(() => new DaemonService({ directory: root, read_receipts: 'true' as unknown as boolean }), /boolean/);
  assert.throws(() => new DaemonService({ directory: root, presence: 1 as unknown as boolean }), /boolean/);
  for (const options of [{ port: -1 }, { port: 65536 }, { port: 1.5 },
    { backoffBaseMs: 0 }, { backoffMaxMs: 2147483648 }, { backoffBaseMs: 20, backoffMaxMs: 10 }]) {
    assert.throws(() => new DaemonService({ directory: root, ...options }), RangeError);
  }
  assert.equal(existsSync(root), false);
});

test('retry backoff is logged, capped, recovers after failures, and cancels on stop', async (t) => {
  let attempts = 0;
  const socket = new FakeSocket();
  const { service, logs } = setup(t, { backoffBaseMs: 5, backoffMaxMs: 10 }, {
    socketFactory: async () => {
      if (++attempts <= 3) throw new Error('synthetic-sensitive-error');
      return socket;
    },
  });
  await service.start();
  assert.equal(service.status().state, 'reconnecting');
  await eventually(() => attempts === 4);
  assert.deepEqual(logs.filter((value) => value.event === 'connection.retry').map((value) => value.details?.delayMs), [5, 10, 10]);
  assert.equal(JSON.stringify(logs).includes('synthetic-sensitive-error'), false);
  socket.emit('connection.update', { connection: 'open' });
  await service.flush();
  assert.equal(service.status().reconnectAttempt, 0);
  socket.emit('connection.update', { connection: 'close' });
  await service.flush();
  assert.equal(service.status().state, 'reconnecting');
  await service.stop();
  await delay(20);
  assert.equal(attempts, 4);
});

test('closed sockets detach; stale events cannot append or schedule duplicate reconnects', async (t) => {
  const sockets: FakeSocket[] = [];
  const { service, root } = setup(t, { backoffBaseMs: 5, backoffMaxMs: 5 }, {
    socketFactory: async () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
  });
  await service.start();
  sockets[0]!.emit('connection.update', { connection: 'close' });
  sockets[0]!.emit('connection.update', { connection: 'close' });
  await service.flush();
  await eventually(() => sockets.length === 2);
  sockets[0]!.emit('messages.upsert', { type: 'notify', messages: [message()] });
  sockets[1]!.emit('messages.upsert', { type: 'notify', messages: [message({ key: { id: 'test-new', remoteJid: 'test-chat@invalid' } })] });
  await service.flush();
  assert.deepEqual(new JsonlStore({ directory: root }).filter().records.map((value) => value.messageId), ['test-new']);
  assert.equal(sockets[0]!.closed, 1);
});

test('logged-out sessions stop retrying and stay reachable for control', async (t) => {
  const { service, socket, calls } = setup(t, { backoffBaseMs: 5 });
  await service.start();
  socket.emit('connection.update', { connection: 'close', lastDisconnect: {
    date: new Date(0), error: Object.assign(new Error('synthetic-logout'), { output: { statusCode: 401 } }),
  } });
  await service.flush();
  await delay(20);
  assert.equal(service.status().state, 'logged-out');
  assert.equal(calls.length, 1);
  assert.equal((await control(service.status().port!, 'GET', '/status')).status, 200);
});

test('event failures are contained; later messages continue and shutdown drains queued appends', async (t) => {
  let count = 0;
  const { service, socket, logs } = setup(t, {}, {
    store: { append: () => { if (++count === 1) throw new Error('synthetic-sensitive-error'); } },
    pairingOutput: async () => { throw new Error('synthetic-sensitive-qr-error'); },
  });
  await service.start();
  socket.emit('connection.update', { qr: 'synthetic-qr-input' });
  socket.emit('messages.upsert', { type: 'notify', messages: [message(), message()] });
  await service.stop();
  assert.equal(count, 2);
  assert.equal(service.status().recordedMessages, 1);
  assert.equal(service.status().state, 'stopped');
  assert.deepEqual(logs.map((value) => value.event), ['connection.update.failed', 'message.append.failed', 'daemon.stopped']);
});

test('stop during socket creation closes the late socket and never registers its handlers', async (t) => {
  let release: ((socket: ListenerSocket) => void) | undefined;
  const { service } = setup(t, {}, { socketFactory: () => new Promise((accept) => { release = accept; }) });
  const starting = service.start();
  await eventually(() => release !== undefined);
  const stopping = service.stop();
  const socket = new FakeSocket();
  release!(socket);
  await Promise.all([starting, stopping]);
  assert.equal(socket.closed, 1);
  assert.equal(socket.emitter.eventNames().length, 0);
  assert.equal(service.status().state, 'stopped');
});

test('QR renderer prints a PNG path and terminal QR, enforces permissions, cleans after connect', async (t) => {
  const root = directory(t);
  const output: string[] = [];
  await printPairingQr('synthetic-pairing-input', root, (chunk) => { output.push(chunk); });
  assert.ok(output.join('').includes(join(root, 'pairing.png')));
  assert.ok(output.join('').includes('\u001b['));
  assert.equal(readFileSync(join(root, 'pairing.png')).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(statSync(join(root, 'pairing.png')).mode & 0o777, 0o600);
  const { service, socket } = setup(t, { directory: root }, { pairingOutput: printPairingQr });
  await service.start();
  socket.emit('connection.update', { connection: 'open' });
  await service.flush();
  assert.equal(existsSync(join(root, 'pairing.png')), false);
});

test('stop during control startup releases the pending listener without creating a socket', async (t) => {
  const { service, calls } = setup(t);
  const starting = service.start();
  const stopping = service.stop();
  await Promise.all([starting, stopping]);
  assert.equal(calls.length, 0);
  assert.equal(service.status().state, 'stopped');
  assert.equal(service.status().port, null);
  // Reusing the same service starts a fresh listener and connection normally.
  await service.start();
  assert.equal(calls.length, 1);
  assert.ok(service.status().port);
});

test('control bind failure does not create a socket or leave the daemon running', async (t) => {
  const first = setup(t);
  await first.service.start();
  const second = setup(t, { port: first.service.status().port! });
  await assert.rejects(second.service.start(), { code: 'EADDRINUSE' });
  assert.equal(second.calls.length, 0);
  assert.equal(second.service.status().state, 'stopped');
});

test('POST /send validates JSON, audits, sends only while connected, and defaults side effects OFF', async (t) => {
  const { service, socket, root } = setup(t);
  await service.start();
  const port = service.status().port!;
  const headers = { 'content-type': 'application/json' };
  const body = JSON.stringify({ jid: 'synthetic-chat@s.whatsapp.net', text: 'synthetic-send-text' });
  assert.equal((await control(port, 'POST', '/send', body, headers)).status, 503);
  assert.equal(existsSync(join(root, 'sends.jsonl')), false);
  socket.emit('connection.update', { connection: 'open' });
  await service.flush();
  assert.deepEqual(await control(port, 'POST', '/send', body, headers), {
    status: 200, body: { messageId: 'synthetic-sent-id',
      audit: JSON.parse(readFileSync(join(root, 'sends.jsonl'), 'utf8')) as unknown },
  });
  assert.deepEqual(socket.outgoingCalls, ['message']);
  assert.equal(JSON.parse(readFileSync(join(root, 'sends.jsonl'), 'utf8')).kind, 'text');
  assert.equal((await control(port, 'POST', '/send', '{', headers)).status, 400);
  assert.equal((await control(port, 'POST', '/send', '{}', headers)).status, 400);
  assert.equal((await control(port, 'POST', '/send', body)).status, 415);
  assert.equal((await control(port, 'POST', '/send', body, { ...headers, origin: 'https://synthetic.invalid' })).status, 403);
  assert.equal((await control(port, 'POST', '/send', body, { ...headers, host: 'synthetic.invalid' })).status, 403);
  assert.equal((await control(port, 'POST', '/send', JSON.stringify({ text: 'x'.repeat(1024 * 1024) }), headers)).status, 413);
  assert.deepEqual(socket.outgoingCalls, ['message']);
  socket.emit('connection.update', { connection: 'close' });
  await service.flush();
  assert.equal((await control(port, 'POST', '/send', body, headers)).status, 503);
});

test('enabled config gates cause no automatic effects; POST /send explicitly triggers them', async (t) => {
  const { service, socket } = setup(t, { read_receipts: true, presence: true });
  await service.start();
  socket.emit('connection.update', { connection: 'open' });
  socket.emit('messages.upsert', { type: 'notify', messages: [message()] });
  await service.flush();
  assert.deepEqual(socket.outgoingCalls, []);
  const body = JSON.stringify({ jid: 'synthetic-chat@s.whatsapp.net', text: 'synthetic-text',
    readKeys: [{ remoteJid: 'synthetic-chat@s.whatsapp.net', id: 'synthetic-read-id' }] });
  assert.equal((await control(service.status().port!, 'POST', '/send', body, { 'content-type': 'application/json' })).status, 200);
  assert.deepEqual(socket.outgoingCalls, ['presence', 'receipts', 'message']);
});

test('stop drains an in-flight send before closing its socket and rejects queued sends', async (t) => {
  const send = t.mock.method(SendService.prototype, 'sendWithAudit');
  const { service, socket, root } = setup(t);
  let release!: () => void;
  socket.outgoing.message = async () => {
    socket.outgoingCalls.push('message');
    await new Promise<void>((accept) => { release = accept; });
    return 'synthetic-sent-id';
  };
  await service.start();
  socket.emit('connection.update', { connection: 'open' });
  await service.flush();
  const port = service.status().port!;
  const headers = { 'content-type': 'application/json' };
  const body = JSON.stringify({ jid: 'synthetic-chat@s.whatsapp.net', text: 'synthetic-text' });
  const first = control(port, 'POST', '/send', body, headers);
  await eventually(() => release !== undefined);
  const second = control(port, 'POST', '/send', body, headers);
  await eventually(() => send.mock.callCount() === 2);
  const stopping = service.stop();
  assert.equal(socket.closed, 0);
  release();
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 503);
  await stopping;
  assert.deepEqual(socket.outgoingCalls, ['message']);
  assert.equal(socket.closed, 1);
  assert.equal(readFileSync(join(root, 'sends.jsonl'), 'utf8').trim().split('\n').length, 1);
});
