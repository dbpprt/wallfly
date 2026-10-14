import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, constants, fchmodSync, fstatSync, linkSync, lstatSync, openSync, readSync, writeSync,
} from 'node:fs';
import { extname, join, resolve } from 'node:path';
import type { WAMessage } from '@whiskeysockets/baileys';
import type { MessageRecord } from '../store/schema.js';
import { validateMediaPath } from '../store/schema.js';
import { privateDirectory, removeFile } from './files.js';
import { contentOf } from './map.js';

export const MAX_MEDIA_BYTES = 64 * 1024 * 1024;
export type MediaDownload = (message: WAMessage) => Promise<AsyncIterable<Uint8Array>>;

const extensions: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/3gpp': '3gp', 'video/quicktime': 'mov',
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac',
  'application/pdf': 'pdf', 'text/plain': 'txt', 'application/zip': 'zip',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

function mediaExtension(message: WAMessage): string {
  const content = contentOf(message.message ?? {});
  const media = content.imageMessage ?? content.videoMessage ?? content.documentMessage
    ?? content.audioMessage ?? content.stickerMessage;
  if (!media) throw new Error('No downloadable media.');
  const mime = media.mimetype?.split(';')[0]?.trim().toLowerCase() ?? '';
  const filename = 'fileName' in media && typeof media.fileName === 'string' ? media.fileName : '';
  const suffix = extname(filename).slice(1).toLowerCase();
  const extension = extensions[mime] ?? (/^[a-z0-9]{1,10}$/.test(suffix) ? suffix : 'bin');
  const length = media.fileLength == null ? undefined : BigInt(media.fileLength.toString());
  if (length !== undefined && (length < 0n || length > BigInt(MAX_MEDIA_BYTES))) {
    throw new RangeError('Media exceeds 64 MiB.');
  }
  return extension;
}

function openMediaFile(path: string): number {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_MEDIA_BYTES) {
      throw new Error('Expected a regular archived media file of at most 64 MiB.');
    }
    fchmodSync(fd, 0o600);
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}

/** Stream into a private temporary file, then publish without overwriting any entry. */
export async function archiveMedia(directory: string, message: WAMessage,
  record: MessageRecord, download: MediaDownload): Promise<string> {
  const extension = mediaExtension(message);
  const month = new Date(record.ts).toISOString().slice(0, 7);
  // Preserve normal IDs; hash unsafe/overlong IDs instead of letting transport input form a path.
  const id = /^[A-Za-z0-9_-]{1,160}$/.test(record.messageId) ? record.messageId
    : createHash('sha256').update(record.messageId).digest('hex');
  const relative = `media/${month}/${id}-${extension}`;
  if (!validateMediaPath(relative)) throw new Error('Invalid media path.');
  privateDirectory(directory);
  privateDirectory(join(directory, 'media'));
  const destination = join(directory, 'media', month);
  privateDirectory(destination);
  const path = join(directory, relative);
  const temporary = join(destination, `.${randomUUID()}.tmp`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let size = 0;
  const digest = createHash('sha256');
  try {
    fchmodSync(fd, 0o600);
    const stream = await download(message);
    for await (const chunk of stream) {
      size += chunk.byteLength;
      if (size > MAX_MEDIA_BYTES) throw new RangeError('Media exceeds 64 MiB.');
      digest.update(chunk);
      let offset = 0;
      while (offset < chunk.byteLength) {
        const written = writeSync(fd, chunk, offset, chunk.byteLength - offset);
        if (written === 0) throw new Error('Incomplete media write.');
        offset += written;
      }
    }
    try { linkSync(temporary, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // History replay after restart may find an existing archive. Reuse only identical bytes.
      const existing = openMediaFile(path);
      try {
        if (fstatSync(existing).size !== size) throw new Error('Media filename collision.', { cause: error });
        const hash = createHash('sha256');
        const buffer = Buffer.alloc(64 * 1024);
        let count: number;
        while ((count = readSync(existing, buffer)) > 0) hash.update(buffer.subarray(0, count));
        if (hash.digest('hex') !== digest.digest('hex')) throw new Error('Media filename collision.', { cause: error });
      } finally { closeSync(existing); }
    }
    return relative;
  } finally {
    closeSync(fd);
    removeFile(temporary);
  }
}

/** Resolve an archive reference without following symlinks or executing its contents. */
export function localMediaPath(directory: string, relative: string): string {
  if (!validateMediaPath(relative)) throw new Error('Invalid media path.');
  const root = resolve(directory);
  const month = relative.split('/')[1]!;
  for (const path of [root, join(root, 'media'), join(root, 'media', month)]) {
    if (!lstatSync(path).isDirectory()) throw new Error('Media directories must not be symlinks.');
  }
  const path = join(root, relative);
  closeSync(openMediaFile(path));
  return path;
}
