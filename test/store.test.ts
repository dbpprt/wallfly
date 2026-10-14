import assert from 'node:assert/strict';
import fs, {
  appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { CursorExpiredError, JsonlStore, validateRecord } from '../src/store/index.js';
import type { ArchivedMessage, MessageRecord, ReconciliationRecord, StoreOptions } from '../src/store/index.js';
import { queryRecords } from '../src/store/reconciliation.js';

// Deliberately synthetic identifiers and marker strings, never captured chat data.
function record(overrides: Partial<ArchivedMessage> = {}): ArchivedMessage {
  return {
    v: 1, ts: 1000, receivedAt: 2000, chatJid: 'test-chat-a@invalid', chatName: null,
    chatType: 'dm', fromMe: false, senderJid: 'test-sender-a@invalid', senderName: null,
    pushName: null, body: 'synthetic-A', mediaType: null, messageId: 'test-id-a',
    ...overrides,
  };
}

function setup(t: TestContext, options: StoreOptions = {}): JsonlStore {
  const root = mkdtempSync(join(tmpdir(), 'wallfly-store-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return new JsonlStore({ ...options, directory: join(root, 'store') });
}

const ids = (records: MessageRecord[]): string[] => records.map((value) => value.messageId);

test('append roundtrip, schema-only serialization, reopen, and append-order tail', (t) => {
  const store = setup(t);
  assert.deepEqual(store.filter(), { records: [], corruptLines: 0, cursor: null });
  const first = record({ body: 'synthetic-\u03bb\n"\\' });
  const second = record({ messageId: 'test-id-b', ts: 500, chatType: 'group', fromMe: true,
    chatName: 'synthetic-group', senderName: 'synthetic-sender', pushName: 'synthetic-push',
    mediaType: 'image', syncType: 'append' });
  store.append({ ...first, ignoredMetadata: 'synthetic-extra' } as MessageRecord);
  const cursor = store.append(second);
  assert.deepEqual(store.filter(), { records: [first, second], corruptLines: 0, cursor });
  assert.deepEqual(store.tail(1).records, [second]);
  assert.deepEqual(store.tail(5).records, [first, second]);
  assert.deepEqual(store.tail(0).records, []);
  const lines = readFileSync(store.path, 'utf8').trimEnd().split('\n');
  assert.equal(lines.length, 2);
  assert.equal('ignoredMetadata' in JSON.parse(lines[0]!), false);
  assert.deepEqual(new JsonlStore({ directory: store.directory }).filter().records, [first, second]);
  for (const count of [-1, 1.5, NaN, Infinity]) assert.throws(() => store.tail(count), RangeError);
});

test('validator rejects missing fields, invalid types, versions, and timestamps', (t) => {
  const valid = record();
  assert.equal(validateRecord(valid), true);
  for (const key of Object.keys(valid)) {
    const incomplete: Record<string, unknown> = { ...valid };
    delete incomplete[key];
    assert.equal(validateRecord(incomplete), false, key);
  }
  for (const invalid of [null, [], 1, { ...valid, v: 3 }, { ...valid, ts: -1 },
    { ...valid, receivedAt: Infinity }, { ...valid, ts: 1.1 }, { ...valid, chatJid: '' },
    { ...valid, senderJid: '' }, { ...valid, messageId: '' }, { ...valid, chatType: 'other' },
    { ...valid, fromMe: 1 }, { ...valid, body: null }, { ...valid, mediaType: {} },
    { ...valid, chatName: 1 }, { ...valid, senderName: false }, { ...valid, pushName: [] },
    { ...valid, syncType: 'other' }, { ...valid, syncType: null }]) {
    assert.equal(validateRecord(invalid), false);
  }
  const store = setup(t);
  assert.throws(() => store.append({ ...valid, v: 3 } as unknown as MessageRecord), TypeError);
  assert.equal(existsSync(store.path), false);
});

test('all filters, inclusive ts bounds, combined conditions, and stateful regexes', (t) => {
  const store = setup(t);
  const samples = [record(), record({ messageId: 'test-id-b', ts: 2000, body: 'synthetic-B',
    chatJid: 'test-chat-b@invalid' }), record({ messageId: 'test-id-c', ts: 3000,
    body: 'SYNTHETIC-A', senderJid: 'test-sender-b@invalid' })];
  for (const sample of samples) store.append(sample);
  assert.deepEqual(ids(store.filter({ chatJid: 'test-chat-a@invalid' }).records), ['test-id-a', 'test-id-c']);
  assert.deepEqual(ids(store.filter({ senderJid: 'test-sender-a@invalid' }).records), ['test-id-a', 'test-id-b']);
  assert.deepEqual(ids(store.filter({ from: 2000 }).records), ['test-id-b', 'test-id-c']);
  assert.deepEqual(ids(store.filter({ to: 2000 }).records), ['test-id-a', 'test-id-b']);
  assert.deepEqual(ids(store.filter({ from: 2000, to: 2000 }).records), ['test-id-b']);
  assert.deepEqual(ids(store.filter({ text: 'synthetic-A' }).records), ['test-id-a']);
  assert.equal(store.filter({ text: '.*' }).records.length, 0);
  assert.equal(store.filter({ text: '' }).records.length, 3);
  const regex = /synthetic-[ab]/ig;
  regex.lastIndex = 100;
  assert.equal(store.filter({ text: regex }).records.length, 3);
  assert.equal(regex.lastIndex, 100);
  assert.equal(store.filter({ text: /^synthetic/y }).records.length, 2);
  assert.deepEqual(ids(store.filter({ chatJid: 'test-chat-a@invalid',
    senderJid: 'test-sender-b@invalid', from: 3000, to: 3000, text: /-A$/ }).records), ['test-id-c']);
  assert.equal(store.filter({ chatJid: 'missing@invalid' }).records.length, 0);
  for (const filters of [{ from: -1 }, { to: NaN }, { from: 2000, to: 1000 }]) {
    assert.throws(() => store.filter(filters), RangeError);
  }
});

test('iterator and tail resume exclusively using serializable byte cursors', (t) => {
  const store = setup(t);
  store.append(record({ body: 'synthetic-\u03bb' }));
  store.append(record({ messageId: 'test-id-b' }));
  const iterator = store.iterate();
  const first = iterator.next();
  assert.equal(first.done, false);
  if (first.done) throw new Error('Expected first record');
  const cursor = JSON.parse(JSON.stringify(first.value.cursor));
  iterator.return();
  assert.deepEqual(ids(store.filter({}, cursor).records), ['test-id-b']);
  assert.deepEqual(ids(store.tail(5, cursor).records), ['test-id-b']);
  const end = store.filter().cursor!;
  assert.deepEqual(store.filter({}, end).records, []);
  store.append(record({ messageId: 'test-id-c' }));
  assert.deepEqual(ids(store.filter({}, end).records), ['test-id-c']);
  const filtered = store.iterate({ filters: { text: 'absent-synthetic' }, cursor: end });
  assert.deepEqual([...filtered], []);
  assert.equal(filtered.stats.cursor?.offset, statSync(store.path).size);
  assert.throws(() => store.filter({}, { ...cursor, offset: 1 }), RangeError);
  assert.throws(() => store.filter({}, { ...cursor, offset: statSync(store.path).size + 1 }), RangeError);
  assert.throws(() => store.filter({}, { ...cursor, offset: -1 }), TypeError);
});

test('rotation retains N files, tails across files, resumes after rename, expires after pruning', (t) => {
  const store = setup(t, { maxBytes: 1, keepRotations: 2 });
  const first = store.append(record());
  store.append(record({ messageId: 'test-id-b' }));
  store.append(record({ messageId: 'test-id-c' }));
  assert.deepEqual(readdirSync(store.directory).sort(), ['messages.jsonl', 'messages.jsonl.1', 'messages.jsonl.2']);
  assert.deepEqual(ids(store.filter().records), ['test-id-a', 'test-id-b', 'test-id-c']);
  assert.deepEqual(ids(store.filter({}, first).records), ['test-id-b', 'test-id-c']);
  assert.deepEqual(ids(store.tail(2).records), ['test-id-b', 'test-id-c']);
  const snapshot = store.iterate();
  assert.equal(snapshot.next().value?.record.messageId, 'test-id-a');
  store.append(record({ messageId: 'test-id-d' }));
  // Open file descriptors retain a consistent snapshot even through deletion/rename.
  assert.deepEqual([...snapshot].map((entry) => entry.record.messageId), ['test-id-b', 'test-id-c']);
  assert.deepEqual(ids(store.filter().records), ['test-id-b', 'test-id-c', 'test-id-d']);
  assert.throws(() => store.filter({}, first), CursorExpiredError);
  assert.equal(JSON.parse(readFileSync(`${store.path}.1`, 'utf8')).messageId, 'test-id-c');
  assert.equal(JSON.parse(readFileSync(`${store.path}.2`, 'utf8')).messageId, 'test-id-b');
  const reduced = new JsonlStore({ directory: store.directory, maxBytes: 1, keepRotations: 0 });
  const discarded = reduced.filter().cursor!;
  reduced.append(record({ messageId: 'test-id-e' }));
  assert.deepEqual(readdirSync(store.directory), ['messages.jsonl']);
  assert.deepEqual(ids(reduced.filter().records), ['test-id-e']);
  assert.throws(() => reduced.filter({}, discarded), CursorExpiredError);
});

test('rotation uses UTF-8 bytes, does not rotate at exact limit, keeps oversized records intact', (t) => {
  const sample = record({ body: 'synthetic-\u03bb' });
  const bytes = Buffer.byteLength(JSON.stringify(sample) + '\n');
  const store = setup(t, { maxBytes: bytes * 2, keepRotations: 1 });
  store.append(sample);
  store.append(sample);
  assert.equal(statSync(store.path).size, bytes * 2);
  assert.equal(existsSync(`${store.path}.1`), false);
  store.append(record({ body: 'synthetic-'.repeat(bytes) }));
  assert.equal(statSync(`${store.path}.1`).size, bytes * 2);
  assert.equal(store.filter().records.length, 3);
});

test('corrupt JSON, invalid schema, unknown version, blank and invalid UTF-8 lines skip and count', (t) => {
  const store = setup(t);
  store.append(record());
  appendFileSync(store.path, 'invalid-json\n{}\n' + JSON.stringify({ ...record(), v: 3 }) + '\n\n');
  const invalidUtf8 = Buffer.from(JSON.stringify(record()) + '\n');
  invalidUtf8[invalidUtf8.indexOf('synthetic-A')] = 0xff;
  appendFileSync(store.path, invalidUtf8);
  store.append(record({ messageId: 'test-id-b' }));
  const result = store.filter();
  assert.deepEqual(ids(result.records), ['test-id-a', 'test-id-b']);
  assert.equal(result.corruptLines, 5);
  assert.equal(store.tail(1).corruptLines, 5);
  const iterator = store.iterate({ filters: { text: 'absent-synthetic' } });
  assert.deepEqual([...iterator], []);
  assert.equal(iterator.stats.corruptLines, 5);
  assert.equal(store.filter({}, result.cursor!).corruptLines, 0);
});

test('unfinished final lines retry on resume; subsequent append isolates the corrupt suffix', (t) => {
  const store = setup(t);
  const cursor = store.append(record());
  const next = JSON.stringify(record({ messageId: 'test-id-b' }));
  appendFileSync(store.path, next.slice(0, 10));
  const incomplete = store.filter({}, cursor);
  assert.equal(incomplete.corruptLines, 1);
  assert.deepEqual(incomplete.cursor, cursor);
  appendFileSync(store.path, next.slice(10) + '\n');
  assert.deepEqual(ids(store.filter({}, incomplete.cursor!).records), ['test-id-b']);
  const end = store.filter().cursor!;
  appendFileSync(store.path, 'synthetic-truncated');
  store.append(record({ messageId: 'test-id-c' }));
  const recovered = store.filter({}, end);
  assert.equal(recovered.corruptLines, 1);
  assert.deepEqual(ids(recovered.records), ['test-id-c']);
});

test('large UTF-8 records span read chunks and tail uses a bounded ring', (t) => {
  const store = setup(t);
  const large = record({ body: 'synthetic-\u03bb'.repeat(15000) });
  store.append(large);
  assert.deepEqual(store.filter().records, [large]);
  for (let index = 0; index < 10; index++) store.append(record({ messageId: `test-id-${index}` }));
  assert.deepEqual(ids(store.tail(3).records), ['test-id-7', 'test-id-8', 'test-id-9']);
});

test('snapshot excludes later appends, which resume from its final cursor', (t) => {
  const store = setup(t);
  store.append(record());
  store.append(record({ messageId: 'test-id-b' }));
  const iterator = store.iterate();
  iterator.next();
  store.append(record({ messageId: 'test-id-c' }));
  assert.deepEqual([...iterator].map((entry) => entry.record.messageId), ['test-id-b']);
  assert.deepEqual(ids(store.filter({}, iterator.stats.cursor!).records), ['test-id-c']);
});

test('directory/file permissions are private on create, reopen, and rotation', (t) => {
  const store = setup(t, { maxBytes: 1, keepRotations: 1 });
  store.append(record());
  assert.equal(statSync(store.directory).mode & 0o777, 0o700);
  assert.equal(statSync(store.path).mode & 0o777, 0o600);
  chmodSync(store.directory, 0o755);
  chmodSync(store.path, 0o644);
  const reopened = new JsonlStore({ directory: store.directory, maxBytes: 1, keepRotations: 1 });
  reopened.append(record());
  assert.equal(statSync(store.directory).mode & 0o777, 0o700);
  assert.equal(statSync(store.path).mode & 0o777, 0o600);
  assert.equal(statSync(`${store.path}.1`).mode & 0o777, 0o600);
});

test('append refuses a symlink store file', (t) => {
  const store = setup(t);
  const target = join(store.directory, 'synthetic-target');
  writeFileSync(target, 'synthetic-marker');
  symlinkSync(target, store.path);
  assert.throws(() => store.append(record()));
  assert.equal(readFileSync(target, 'utf8'), 'synthetic-marker');
});

test('one write call per append, optional fsync, and short-write errors', (t) => {
  const store = setup(t);
  const write = t.mock.method(fs, 'writeSync');
  const sync = t.mock.method(fs, 'fsyncSync');
  syncBuiltinESMExports();
  try {
    store.append(record());
    assert.equal(write.mock.callCount(), 1);
    assert.equal(sync.mock.callCount(), 0);
    new JsonlStore({ directory: store.directory, fsync: true }).append(record());
    assert.equal(write.mock.callCount(), 2);
    assert.equal(sync.mock.callCount(), 1);
    write.mock.mockImplementation(() => 0);
    assert.throws(() => store.append(record()), /Incomplete JSONL append/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('invalid rotation options reject without creating storage', (t) => {
  const store = setup(t);
  for (const options of [{ maxBytes: 0 }, { maxBytes: NaN }, { maxBytes: 1.1 },
    { keepRotations: -1 }, { keepRotations: 1.5 }]) {
    assert.throws(() => new JsonlStore({ directory: store.directory, ...options }), RangeError);
  }
});


test('mixed v1/v2 records read unchanged; v2 mediaPath persists and unsafe paths reject', (t) => {
  const store = setup(t);
  const legacy = record();
  const archived = record({ v: 2, messageId: 'test-v2', mediaType: 'image', mediaPath: 'media/2026-01/test-v2-jpg' });
  const plain = record({ v: 2, messageId: 'test-v2-plain' });
  for (const entry of [legacy, archived, plain]) store.append(entry);
  assert.deepEqual(new JsonlStore({ directory: store.directory }).filter().records, [legacy, archived, plain]);
  for (const mediaPath of [null, '', '/tmp/test', '../test', 'media/2026-01/../../test', 'media/2026-13/id-jpg', 'media/2026-01/id.jpg']) {
    assert.equal(validateRecord({ ...archived, mediaPath }), false);
  }
  assert.equal(validateRecord({ ...archived, v: 1 }), false);
});

test('v2 events append without changing original bytes, validate and serialize only schema fields', (t) => {
  const store = setup(t);
  const original = record();
  store.append(original);
  const prefix = readFileSync(store.path);
  const edit: ReconciliationRecord = { ...original, v: 2, reconciliation: 'edit',
    targetMessageId: original.messageId, messageId: 'synthetic-edit-id', body: 'synthetic-new',
    mediaPath: 'media/2026-01/synthetic-edit-id-jpg' };
  const revoke: ReconciliationRecord = { ...edit, reconciliation: 'revoke', body: '', messageId: 'synthetic-revoke-id' };
  assert.equal(validateRecord(edit), true);
  assert.equal(validateRecord(revoke), true);
  for (const invalid of [{ ...edit, targetMessageId: '' }, { ...edit, reconciliation: 'other' },
    { ...edit, v: 1 }, { ...revoke, body: 'synthetic-forbidden' }, { ...edit, body: null },
    { ...edit, mediaPath: '../synthetic-unsafe-path' }]) {
    assert.equal(validateRecord(invalid), false);
  }
  store.append({ ...edit, ignoredMetadata: 'synthetic-extra' } as unknown as MessageRecord);
  store.append(revoke);
  assert.deepEqual(readFileSync(store.path).subarray(0, prefix.length), prefix);
  assert.deepEqual(store.filter().records, [original, edit, revoke]);
  assert.deepEqual([...queryRecords(store)].map(({ record }) => record), [{ ...original, body: '[deleted]' }]);
});

test('reconciliation spans rotations, matches chat and target, handles early events and terminal revokes', (t) => {
  const store = setup(t, { maxBytes: 1, keepRotations: 12 });
  const original = record();
  const edit: ReconciliationRecord = { ...original, v: 2, reconciliation: 'edit',
    targetMessageId: original.messageId, messageId: 'synthetic-edit-id', body: 'synthetic-new', ts: 9000 };
  store.append(edit); // History can deliver the original after the update.
  store.append(original);
  const other = record({ chatJid: 'test-other@invalid' });
  store.append(other); // Same message ID in another chat must remain unchanged.
  const read = (filters = {}) => [...queryRecords(store, filters)].map(({ record }) => record);
  assert.deepEqual(read(), [{ ...original, body: 'synthetic-new [edited]' }, other]);
  assert.deepEqual(read({ text: 'synthetic-new', to: original.ts }), [{ ...original, body: 'synthetic-new [edited]' }]);
  assert.deepEqual(read({ text: 'synthetic-A', chatJid: original.chatJid }), []);
  store.append({ ...edit, messageId: 'synthetic-edit-2', body: 'synthetic-latest' });
  assert.equal(read()[0]!.body, 'synthetic-latest [edited]');
  store.append({ ...edit, reconciliation: 'revoke', messageId: 'synthetic-revoke', body: '' });
  store.append({ ...edit, messageId: 'synthetic-late-edit' });
  assert.equal(read()[0]!.body, '[deleted]');
  assert.deepEqual(read({ text: 'synthetic-latest' }), []);
  assert.deepEqual([...queryRecords(store, {}, true)].map(({ record }) => record), store.filter().records);
});
