import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
  assert.equal(JSON.parse(readFileSync(cache.path, 'utf8')).v, 3);
});

test('manual aliases persist privately, override transport labels, and follow observed LID pairs', (t) => {
  const root = directory(t);
  const cache = new NameCache(root);
  assert.deepEqual(cache.display(lid), { name: lid });
  cache.contacts([{ id: lid, name: 'synthetic-derived' }]);
  assert.deepEqual(cache.display(lid), { name: 'synthetic-derived' });
  cache.message(message('synthetic-push', 10));
  assert.deepEqual(cache.display(lid), { name: 'synthetic-push' });
  cache.setAlias(lid, 'Synthetic Manual Name');
  assert.deepEqual(new NameCache(root).display(pn), { name: 'Synthetic Manual Name', manual: true });
  assert.deepEqual(cache.identity(pn).manual, true);
  assert.deepEqual(cache.listAliases(), [{ jid: lid, name: 'Synthetic Manual Name', manual: true }]);
  const data = JSON.parse(readFileSync(cache.path, 'utf8'));
  assert.equal(data.v, 3);
  assert.deepEqual(data.aliases, { [lid]: { name: 'Synthetic Manual Name', manual: true } });
  assert.equal(statSync(cache.path).mode & 0o777, 0o600);
  assert.equal(statSync(root).mode & 0o777, 0o700);
  assert.equal(cache.removeAlias(lid), true);
  assert.equal(cache.removeAlias(lid), false);
  assert.deepEqual(new NameCache(root).listAliases(), []);
  assert.deepEqual(cache.display(lid), { name: 'synthetic-push' });
});

test('daemon cache sees external alias edits and preserves them on subsequent transport writes', (t) => {
  const root = directory(t);
  const daemon = new NameCache(root);
  daemon.groups([{ id: 'synthetic-group@g.us', subject: 'synthetic-subject' }]);
  new NameCache(root).setAlias(lid, 'synthetic-manual');
  assert.equal(daemon.get(lid), 'synthetic-manual');
  daemon.message(message('synthetic-live', 20));
  daemon.contacts([{ id: lid, name: 'synthetic-contact' }]);
  assert.equal(new NameCache(root).get(lid), 'synthetic-manual');
  new NameCache(root).removeAlias(lid);
  daemon.groups([{ id: 'synthetic-group@g.us', subject: 'synthetic-updated-subject' }]);
  assert.equal(new NameCache(root).get(lid), 'synthetic-live');
  assert.deepEqual(new NameCache(root).listAliases(), []);
  // A stale CLI instance must preserve facts written after it was constructed.
  const cli = new NameCache(root);
  daemon.message(message('synthetic-newest', 30));
  cli.setAlias(lid, 'synthetic-new-manual');
  assert.equal(new NameCache(root).identity(lid).pushname, 'synthetic-newest');
});

test('v2 caches migrate without losing names, pushnames or participants; malformed aliases fail closed', (t) => {
  const root = directory(t);
  const path = join(root, 'contacts.json');
  const legacy = { v: 2, names: { [lid]: 'synthetic-derived' },
    pushnames: { [lid]: { name: 'synthetic-push', ts: 10 } }, participants: {} };
  writeFileSync(path, JSON.stringify(legacy));
  new NameCache(root).setAlias(lid, 'synthetic-manual');
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(saved.v, 3);
  for (const key of ['names', 'pushnames', 'participants'] as const) assert.deepEqual(saved[key], legacy[key]);
  for (const aliases of [null, { [lid]: 'synthetic' }, { [lid]: { name: '', manual: true } },
    { [lid]: { name: 'synthetic', manual: false } }, { invalid: { name: 'synthetic', manual: true } }]) {
    writeFileSync(path, JSON.stringify({ ...saved, aliases }));
    assert.throws(() => new NameCache(root), /manual alias/i);
  }
});

test('concurrent alias processes and daemon writes preserve every manual entry and transport fact', async (t) => {
  const root = directory(t);
  const module = new URL('../src/daemon/cache.js', import.meta.url).href;
  const program = `
    import { NameCache } from ${JSON.stringify(module)};
    const [root, worker] = process.argv.slice(1);
    const cache = new NameCache(root);
    for (let i = 0; i < 20; i++) {
      if (worker === 'daemon') {
        cache.message({ key: { remoteJid: 'synthetic-person@lid' },
          pushName: 'synthetic-push-' + i, messageTimestamp: i });
      } else {
        cache.setAlias('synthetic-' + worker + '-' + i + '@lid', 'synthetic-manual-' + i);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
    }
  `;
  await Promise.all(['daemon', 'a', 'b'].map((worker) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', program, root, worker], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
    child.once('error', reject);
    child.once('exit', (code) => { if (code === 0) resolve(); else reject(new Error(stderr || `Worker exited ${code}`)); });
  })));
  const cache = new NameCache(root);
  assert.equal(cache.listAliases().length, 40);
  assert.equal(cache.identity(lid).pushname, 'synthetic-push-19');
  assert.equal(statSync(cache.path).mode & 0o777, 0o600);
});
