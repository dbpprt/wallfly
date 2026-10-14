import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { WAMessage } from '@whiskeysockets/baileys';
import { NameCache } from '../src/daemon/cache.js';
import { LidMap, observeAuthMappings } from '../src/daemon/identity.js';

// Symbolic markers only: no actual phone numbers, people, or message content.
const lid = 'synthetic-person@lid';
const pn = 'synthetic-phone@s.whatsapp.net';
function directory(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'wallfly-identity-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function message(name: string, seconds: number, extra: Partial<WAMessage['key']> = {}): WAMessage {
  return { key: { remoteJid: lid, senderPn: pn, ...extra }, pushName: name, messageTimestamp: seconds };
}

test('LID map normalizes devices, persists forward/reverse auth pairs and deduplicates writes', (t) => {
  const root = directory(t);
  const map = new LidMap(root);
  const observe = (lid: string, pn: string): void => map.observe(lid, pn);
  observeAuthMappings({ 'synthetic-person': 'synthetic-phone', 'synthetic-phone_reverse': 'synthetic-person',
    'synthetic-null': null }, observe);
  assert.deepEqual(JSON.parse(readFileSync(map.path, 'utf8')), { v: 1, mappings: { [lid]: pn } });
  const before = statSync(map.path);
  map.observe('synthetic-person:3@lid', 'synthetic-phone:4@s.whatsapp.net');
  assert.equal(statSync(map.path).mtimeMs, before.mtimeMs);
  assert.equal(statSync(map.path).ino, before.ino);
  map.observe(lid, 'synthetic-new-phone@s.whatsapp.net');
  assert.equal(new LidMap(root).phoneJid(lid), 'synthetic-new-phone@s.whatsapp.net');
  assert.equal(new LidMap(root).phoneJid(pn), pn);
  assert.equal(statSync(map.path).mode & 0o777, 0o600);
  chmodSync(map.path, 0o644);
  new LidMap(root);
  assert.equal(statSync(map.path).mode & 0o777, 0o600);
});

test('LID map fails closed on invalid schema and unsafe files', (t) => {
  const root = directory(t);
  const path = join(root, 'lid-map.json');
  for (const data of ['{', '{"v":2,"mappings":{}}', '{"v":1,"mappings":{"synthetic@lid":42}}']) {
    writeFileSync(path, data);
    assert.throws(() => new LidMap(root));
  }
  rmSync(path);
  const target = join(root, 'synthetic-target');
  writeFileSync(target, '{}');
  symlinkSync(target, path);
  assert.throws(() => new LidMap(root));
});

test('pushnames bind both aliases, persist timestamps, and preserve newer names over old history', (t) => {
  const root = directory(t);
  const cache = new NameCache(root);
  cache.message(message('synthetic-old', 10));
  cache.message(message('synthetic-live', 20));
  cache.message(message('synthetic-history', 5));
  let saved = new NameCache(root);
  assert.equal(saved.get(lid), 'synthetic-live');
  assert.equal(saved.get(pn), 'synthetic-live');
  assert.equal(saved.identity(lid).pushnameTs, 20000);
  cache.contacts([{ id: lid, jid: pn, notify: 'synthetic-undated-history' }]);
  assert.equal(cache.identity(pn).pushname, 'synthetic-live');
  cache.message(message('synthetic-last-writer', 20));
  cache.message(message('synthetic-last-writer', 20));
  saved = new NameCache(root);
  assert.equal(saved.identity(pn).pushname, 'synthetic-last-writer');
  const data = JSON.parse(readFileSync(cache.path, 'utf8')) as { pushnames: Record<string, unknown> };
  assert.deepEqual(data.pushnames[lid], data.pushnames[pn]);
  assert.equal(statSync(cache.path).mode & 0o777, 0o600);
});

test('group metadata connects LID identities to phones, ranks, and shared groups; removals replace membership', (t) => {
  const root = directory(t);
  const cache = new NameCache(root);
  cache.message({ key: { remoteJid: lid }, pushName: 'synthetic-name', messageTimestamp: 10 });
  cache.groups([{ id: 'synthetic-group@g.us', subject: 'synthetic-group-name', participants: [
    { id: lid, jid: pn, lid, admin: 'admin' }, { id: lid, jid: pn, lid, admin: 'superadmin' },
    { id: 'synthetic-other@s.whatsapp.net' },
  ] }]);
  const identity = new NameCache(root).identity(pn);
  assert.equal(identity.phone, '+synthetic-phone');
  assert.equal(identity.pushname, 'synthetic-name');
  assert.deepEqual(identity.groups, [{ jid: 'synthetic-group@g.us', name: 'synthetic-group-name', rank: 'superadmin' }]);
  assert.deepEqual(cache.identity('synthetic-other@s.whatsapp.net').groups,
    [{ jid: 'synthetic-group@g.us', name: 'synthetic-group-name', rank: 'member' }]);
  cache.groups([{ id: 'synthetic-group@g.us', subject: 'synthetic-renamed' }]);
  assert.equal(cache.identity(lid).groups[0]?.name, 'synthetic-renamed');
  cache.groups([{ id: 'synthetic-group@g.us', participants: [] }]);
  assert.deepEqual(new NameCache(root).identity(lid).groups, []);
  assert.equal(new NameCache(root).identity(lid).phoneJid, pn);
});

test('v1 names survive migration and unrelated/protocol message identities cannot name recipients', (t) => {
  const root = directory(t);
  writeFileSync(join(root, 'contacts.json'), JSON.stringify({ v: 1, names: { 'synthetic-group@g.us': 'synthetic-old' } }));
  const cache = new NameCache(root);
  cache.message(message('synthetic-owner', 10, { fromMe: true, senderLid: 'synthetic-owner@lid', senderPn: 'synthetic-owner@s.whatsapp.net' }),
    'synthetic-owner@s.whatsapp.net');
  assert.equal(cache.identity(lid).phone, null);
  assert.equal(cache.identity(lid).pushname, null);
  cache.message(message('synthetic-group-sender', 30, { remoteJid: 'synthetic-group@g.us', participant: lid,
    participantPn: pn, senderPn: 'synthetic-unrelated@s.whatsapp.net' }));
  assert.equal(cache.identity(lid).phoneJid, pn);
  assert.equal(cache.get('synthetic-group@g.us'), 'synthetic-old');
  cache.message(message('synthetic-status', 50, { remoteJid: 'status@broadcast' }));
  assert.equal(new NameCache(root).identity(lid).pushname, 'synthetic-group-sender');
  assert.equal(JSON.parse(readFileSync(cache.path, 'utf8')).v, 2);
});
