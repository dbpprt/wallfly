import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { WAMessage } from '@whiskeysockets/baileys';
import { archiveMedia, localMediaPath, MAX_MEDIA_BYTES } from '../src/daemon/media.js';
import type { MediaDownload } from '../src/daemon/media.js';
import type { MessageRecord } from '../src/store/schema.js';

function setup(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'wallfly-media-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const record: MessageRecord = { v: 2, ts: Date.UTC(2026, 0, 31, 23, 59), receivedAt: Date.UTC(2026, 1, 1),
    chatJid: 'synthetic-chat@invalid', chatName: null, chatType: 'dm', fromMe: false,
    senderJid: 'synthetic-sender@invalid', senderName: null, pushName: null,
    body: '', mediaType: 'image', messageId: 'synthetic-id' };
  const message: WAMessage = { key: { id: record.messageId },
    message: { imageMessage: { mimetype: 'image/jpeg', fileLength: 9 } } };
  const download = t.mock.fn<MediaDownload>(async () => (async function* () {
    yield Buffer.from('synthetic');
  })());
  const archive = (sample = message, entry = record, fetch: MediaDownload = download) =>
    archiveMedia(directory, sample, entry, fetch);
  return { directory, record, message, download, archive };
}

test('mocked download streams to a private UTC-month path, with safe extensions and replay reuse', async (t) => {
  const { directory, message, download, archive } = setup(t);
  const relative = await archive();
  assert.equal(relative, 'media/2026-01/synthetic-id-jpg');
  assert.deepEqual(download.mock.calls[0]?.arguments, [message]);
  assert.equal(readFileSync(join(directory, relative), 'utf8'), 'synthetic');
  for (const path of [directory, join(directory, 'media'), join(directory, 'media/2026-01')]) {
    assert.equal(statSync(path).mode & 0o777, 0o700);
  }
  assert.equal(statSync(join(directory, relative)).mode & 0o777, 0o600);
  assert.equal(await archive(), relative);
  assert.equal(statSync(join(directory, relative)).nlink, 1);
  assert.deepEqual(readdirSync(join(directory, 'media/2026-01')), ['synthetic-id-jpg']);
  assert.equal(localMediaPath(directory, relative), join(directory, relative));
});

test('wrapped documents and unsafe IDs/filenames cannot escape the archive directory', async (t) => {
  const { directory, record, archive } = setup(t);
  const id = '../../synthetic-escape';
  const message: WAMessage = { key: { id }, message: { ephemeralMessage: { message: {
    documentWithCaptionMessage: { message: { documentMessage: {
      fileName: '../../synthetic-report.PDF', mimetype: 'application/octet-stream',
    } } },
  } } } };
  const relative = await archive(message, { ...record, messageId: id });
  assert.equal(relative, `media/2026-01/${createHash('sha256').update(id).digest('hex')}-pdf`);
  assert.equal(readFileSync(join(directory, relative), 'utf8'), 'synthetic');
});

test('declared oversize media rejects before download; streaming overflow cancels and removes partial data', async (t) => {
  const { directory, message, download, archive } = setup(t);
  await assert.rejects(archive({ ...message, message: { imageMessage: { fileLength: MAX_MEDIA_BYTES + 1 } } }), /64 MiB/);
  assert.equal(download.mock.callCount(), 0);
  assert.equal(existsSync(join(directory, 'media')), false);
  let cancelled = false;
  let chunks = 0;
  download.mock.mockImplementation(async () => (async function* () {
    try {
      const chunk = Buffer.alloc(1024 * 1024);
      for (let index = 0; index < 100; index++) { chunks++; yield chunk; }
    } finally { cancelled = true; }
  })());
  // A small declared length cannot bypass the limit on actual bytes.
  await assert.rejects(archive(), /64 MiB/);
  assert.equal(chunks, 65);
  assert.equal(cancelled, true);
  assert.deepEqual(readdirSync(join(directory, 'media/2026-01')), []);
});

test('the exact 64 MiB boundary is accepted with no declared size', async (t) => {
  const { directory, archive } = setup(t);
  const relative = await archive({ key: {}, message: { videoMessage: { mimetype: 'video/mp4' } } }, undefined,
    async () => (async function* () {
      const chunk = Buffer.alloc(1024 * 1024);
      for (let index = 0; index < 64; index++) yield chunk;
    })());
  assert.equal(statSync(join(directory, relative)).size, MAX_MEDIA_BYTES);
});

test('download and stream errors leave no final file or partial temporary file', async (t) => {
  const { directory, download, archive } = setup(t);
  download.mock.mockImplementation(async () => { throw new Error('synthetic-download-failure'); });
  await assert.rejects(archive(), /synthetic-download-failure/);
  download.mock.mockImplementation(async () => (async function* () {
    yield Buffer.from('synthetic-part');
    throw new Error('synthetic-stream-failure');
  })());
  await assert.rejects(archive(), /synthetic-stream-failure/);
  assert.deepEqual(readdirSync(join(directory, 'media/2026-01')), []);
});

test('archive and open refuse symlink directories and files and never overwrite collisions', async (t) => {
  const { directory, archive, download } = setup(t);
  const target = join(directory, 'synthetic-target');
  mkdirSync(target);
  const media = join(directory, 'media');
  symlinkSync(target, media);
  await assert.rejects(archive(), /symlink/);
  rmSync(media);
  mkdirSync(media);
  const month = join(media, '2026-01');
  symlinkSync(target, month);
  await assert.rejects(archive(), /symlink/);
  rmSync(month);
  mkdirSync(month);
  const relative = 'media/2026-01/synthetic-id-jpg';
  const file = join(directory, relative);
  const victim = join(target, 'synthetic-file');
  writeFileSync(victim, 'synthetic-untouched');
  symlinkSync(victim, file);
  await assert.rejects(archive());
  assert.throws(() => localMediaPath(directory, relative));
  assert.equal(readFileSync(victim, 'utf8'), 'synthetic-untouched');
  rmSync(file);
  await archive();
  download.mock.mockImplementation(async () => (async function* () { yield Buffer.from('different'); })());
  await assert.rejects(archive(), /collision/);
  assert.equal(readFileSync(file, 'utf8'), 'synthetic');
  for (const invalid of ['/tmp/synthetic', 'media/2026-01/../../synthetic', 'media/2026-13/id-jpg']) {
    assert.throws(() => localMediaPath(directory, invalid), /Invalid media path/);
  }
  rmSync(file);
  rmSync(month, { recursive: true });
  symlinkSync(target, month);
  assert.throws(() => localMediaPath(directory, relative), /symlink/);
});
