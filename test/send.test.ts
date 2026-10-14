import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { bindSendTransport, SendService } from '../src/send/index.js';
import type { SendAuditRecord, SendOptions, SendTransport } from '../src/send/index.js';
import { loadSendConfig } from '../src/send/config.js';

// Synthetic identifiers, content, and bytes; no accounts or WhatsApp connections.
const jid = 'synthetic-chat@s.whatsapp.net';
const readKeys = [{ remoteJid: jid, id: 'synthetic-read-id', fromMe: false }];

function setup(t: TestContext, options: SendOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'wallfly-send-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const calls: string[] = [];
  const transport: SendTransport = {
    message: async () => { calls.push('message'); return 'synthetic-sent-id'; },
    receipts: async () => { calls.push('receipts'); },
    presence: async () => { calls.push('presence'); },
  };
  let connected: SendTransport | undefined = transport;
  const service = new SendService({ directory, ...options }, () => connected);
  return { directory, service, calls, transport,
    disconnect: () => { connected = undefined; },
    records: (): SendAuditRecord[] => readFileSync(service.auditPath, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as SendAuditRecord) };
}

test('syncs a private audit record before text transmission, preserving earlier records', async (t) => {
  const state = setup(t);
  state.transport.message = async (target, content) => {
    assert.equal(target, jid);
    assert.deepEqual(content, { text: 'synthetic-text' });
    const records = state.records();
    const record = records.at(-1)!;
    assert.equal(record.v, 1);
    assert.equal(record.kind, 'text');
    assert.equal(record.jid, jid);
    assert.equal(record.textSha256, createHash('sha256').update('synthetic-text').digest('hex'));
    assert.equal(record.mediaPath, null);
    assert.ok(Number.isSafeInteger(record.ts));
    assert.equal(readFileSync(state.service.auditPath, 'utf8').includes('synthetic-text'), false);
    assert.equal(statSync(state.directory).mode & 0o777, 0o700);
    assert.equal(statSync(state.service.auditPath).mode & 0o777, 0o600);
    return 'synthetic-sent-id';
  };
  assert.deepEqual(await state.service.send({ jid, text: 'synthetic-text' }), { messageId: 'synthetic-sent-id' });
  const first = readFileSync(state.service.auditPath, 'utf8');
  chmodSync(state.service.auditPath, 0o644);
  await state.service.send({ jid, text: 'synthetic-text' });
  assert.ok(readFileSync(state.service.auditPath, 'utf8').startsWith(first));
  assert.equal(state.records().length, 2);
});

test('image and document use local bytes and hash captions before execution', async (t) => {
  const state = setup(t);
  const file = join(state.directory, 'synthetic-media.bin');
  writeFileSync(file, Buffer.from('synthetic-bytes'));
  for (const kind of ['image', 'document'] as const) {
    state.transport.message = async (_, content) => {
      const record = state.records().at(-1)!;
      assert.equal(record.kind, kind);
      assert.equal(record.mediaPath, file);
      assert.equal(record.textSha256, createHash('sha256').update('synthetic-caption').digest('hex'));
      assert.deepEqual(content, kind === 'image'
        ? { image: Buffer.from('synthetic-bytes'), caption: 'synthetic-caption' }
        : { document: Buffer.from('synthetic-bytes'), caption: 'synthetic-caption',
          fileName: 'synthetic-media.bin', mimetype: 'application/octet-stream' });
      return null;
    };
    await state.service.send({ jid, [kind]: file, caption: 'synthetic-caption' });
  }
});

test('invalid arguments, missing/empty/nonregular/remote/symlink media fail without audit or sends', async (t) => {
  const state = setup(t);
  const empty = join(state.directory, 'empty');
  const link = join(state.directory, 'link');
  writeFileSync(empty, '');
  symlinkSync(empty, link);
  const invalid: unknown[] = [null, [], {}, { jid }, { jid, text: '' }, { jid, text: ' ' },
    { jid: 'status@broadcast', text: 'synthetic' }, { jid: 'synthetic', text: 'synthetic' },
    { jid, text: 'synthetic', caption: 'synthetic' }, { jid, text: 1 },
    { jid, text: 'synthetic', image: empty }, { jid, image: empty, document: empty },
    { jid, text: 'synthetic', extra: true }, { jid, image: empty }, { jid, image: link },
    { jid, document: state.directory }, { jid, image: join(state.directory, 'missing') },
    { jid, image: 'https://synthetic.invalid/media' }, { jid, text: 'synthetic', readKeys: [{}] },
    { jid, text: 'synthetic', readKeys: [{ ...readKeys[0], remoteJid: 'other@s.whatsapp.net' }] },
    { jid, text: 'synthetic', readKeys: [{ ...readKeys[0], fromMe: true }] }];
  for (const value of invalid) await assert.rejects(state.service.send(value), { status: 400 });
  assert.deepEqual(state.calls, []);
  assert.equal(existsSync(state.service.auditPath), false);
});

test('disconnected requests fail without creating audit records', async (t) => {
  const state = setup(t);
  state.disconnect();
  await assert.rejects(state.service.send({ jid, text: 'synthetic-text' }), { status: 503 });
  assert.deepEqual(state.calls, []);
  assert.equal(existsSync(state.service.auditPath), false);
});

test('unsafe or incomplete audit files prevent every outgoing operation', async (t) => {
  for (const kind of ['directory', 'symlink', 'incomplete'] as const) {
    const state = setup(t, { presence: true, read_receipts: true });
    if (kind === 'directory') mkdirSync(state.service.auditPath);
    if (kind === 'symlink') {
      const target = join(state.directory, 'synthetic-target');
      writeFileSync(target, 'synthetic-sentinel');
      symlinkSync(target, state.service.auditPath);
    }
    if (kind === 'incomplete') writeFileSync(state.service.auditPath, '{');
    await assert.rejects(state.service.send({ jid, text: 'synthetic-text', readKeys }), { status: 500 });
    assert.deepEqual(state.calls, []);
    if (kind === 'symlink') assert.equal(readFileSync(join(state.directory, 'synthetic-target'), 'utf8'), 'synthetic-sentinel');
  }
});

test('audit write/fsync failures prevent transmission; successful fsync precedes execution', async (t) => {
  const state = setup(t);
  const write = t.mock.method(fs, 'writeSync');
  const sync = t.mock.method(fs, 'fsyncSync');
  syncBuiltinESMExports();
  try {
    state.transport.message = async () => {
      assert.equal(write.mock.callCount(), 1);
      assert.equal(sync.mock.callCount(), 1);
      state.calls.push('message');
      return null;
    };
    await state.service.send({ jid, text: 'synthetic-text' });
    write.mock.mockImplementation(() => 0);
    await assert.rejects(state.service.send({ jid, text: 'synthetic-text' }), { status: 500 });
    write.mock.restore();
    sync.mock.mockImplementation(() => { throw new Error('synthetic-disk-error'); });
    syncBuiltinESMExports();
    await assert.rejects(state.service.send({ jid, text: 'synthetic-text' }), { status: 500 });
    assert.deepEqual(state.calls, ['message']);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('receipts/presence default OFF; enabled gates execute only on explicit sends, after audit', async (t) => {
  const defaults = setup(t);
  await defaults.service.send({ jid, text: 'synthetic-text' });
  assert.deepEqual(defaults.calls, ['message']);
  await assert.rejects(defaults.service.send({ jid, text: 'synthetic-text', readKeys }), { status: 400 });
  assert.equal(defaults.records().length, 1);
  for (const options of [{ presence: true }, { read_receipts: true }, { presence: true, read_receipts: true }]) {
    const state = setup(t, options);
    state.transport.presence = async () => { assert.equal(state.records().length, 1); state.calls.push('presence'); };
    state.transport.receipts = async (keys) => {
      assert.equal(state.records().length, 1); assert.deepEqual(keys, readKeys); state.calls.push('receipts');
    };
    await state.service.send({ jid, text: 'synthetic-text', ...(options.read_receipts ? { readKeys } : {}) });
    assert.deepEqual(state.calls, [...(options.presence ? ['presence'] : []), ...(options.read_receipts ? ['receipts'] : []), 'message']);
  }
});

test('transport failures retain audit, sanitize errors, and never retry', async (t) => {
  const state = setup(t);
  state.transport.message = async () => { state.calls.push('message'); throw new Error('synthetic-sensitive-error'); };
  await assert.rejects(state.service.send({ jid, text: 'synthetic-text' }), (error: unknown) => {
    assert.equal((error as { status: number }).status, 502);
    assert.equal(String(error).includes('synthetic-sensitive-error'), false);
    return true;
  });
  assert.equal(state.records().length, 1);
  assert.deepEqual(state.calls, ['message']);
});

test('serializes sends; caller mutation and disconnect cannot redirect queued work', async (t) => {
  const state = setup(t);
  let release!: () => void;
  state.transport.message = async () => {
    state.calls.push('message'); await new Promise<void>((accept) => { release = accept; }); return null;
  };
  const first = state.service.send({ jid, text: 'synthetic-first' });
  const request = { jid, text: 'synthetic-second' };
  const second = state.service.send(request);
  request.jid = 'other@s.whatsapp.net';
  await new Promise<void>((accept) => setImmediate(accept));
  assert.equal(state.records().length, 1);
  state.disconnect();
  const rejection = assert.rejects(second, { status: 503 });
  release();
  await first;
  await rejection;
  await state.service.flush();
  assert.deepEqual(state.calls, ['message']);
  assert.equal(state.records().length, 1);
});

test('disconnect during enabled presence prevents receipts and message execution', async (t) => {
  const state = setup(t, { presence: true, read_receipts: true });
  state.transport.presence = async () => { state.calls.push('presence'); state.disconnect(); };
  await assert.rejects(state.service.send({ jid, text: 'synthetic-text', readKeys }), { status: 503 });
  assert.deepEqual(state.calls, ['presence']);
  assert.equal(state.records().length, 1);
});

test('Baileys adapter forwards only the explicit outgoing operations', async () => {
  const calls: unknown[] = [];
  const transport = bindSendTransport({
    sendMessage: async (target, content) => { calls.push([target, content]); return undefined; },
    readMessages: async (keys) => { calls.push(keys); },
    sendPresenceUpdate: async (type, target) => { calls.push([type, target]); },
  });
  assert.equal(await transport.message(jid, { text: 'synthetic-text' }), null);
  await transport.receipts(readKeys);
  await transport.presence(jid);
  assert.deepEqual(calls, [[jid, { text: 'synthetic-text' }], readKeys, ['available', jid]]);
});

test('persisted config defaults OFF, accepts boolean opt-ins, and rejects malformed/unsafe values', (t) => {
  const { directory } = setup(t);
  assert.deepEqual(loadSendConfig(directory), {});
  const path = join(directory, 'config.json');
  writeFileSync(path, JSON.stringify({ read_receipts: true, presence: false }));
  assert.deepEqual(loadSendConfig(directory), { read_receipts: true, presence: false });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  for (const content of ['{', 'null', '[]', '{"presence":"true"}', '{"read_receipts":1}']) {
    writeFileSync(path, content);
    assert.throws(() => loadSendConfig(directory));
  }
  rmSync(path);
  const target = join(directory, 'synthetic-config');
  writeFileSync(target, '{}');
  symlinkSync(target, path);
  assert.throws(() => loadSendConfig(directory));
});

test('send snapshots the request before asynchronous execution', async (t) => {
  const state = setup(t, { read_receipts: true });
  const request = { jid, text: 'synthetic-original', readKeys: readKeys.map((key) => ({ ...key })) };
  state.transport.message = async (target, content) => {
    assert.equal(target, jid);
    assert.deepEqual(content, { text: 'synthetic-original' });
    return null;
  };
  state.transport.receipts = async (keys) => { assert.deepEqual(keys, readKeys); };
  const sending = state.service.send(request);
  request.jid = 'other@s.whatsapp.net';
  request.text = 'synthetic-mutated';
  request.readKeys[0]!.id = 'synthetic-mutated';
  await sending;
  assert.equal(state.records()[0]?.jid, jid);
});
