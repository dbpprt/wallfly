import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, mkdirSync, openSync,
  readSync, readdirSync, renameSync, unlinkSync, writeSync, chmodSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { validateRecord } from './schema.js';
import type { MessageRecord } from './schema.js';

export { validateRecord } from './schema.js';
export type { MessageRecord, ArchivedMessage, ReconciliationRecord } from './schema.js';

export interface StoreOptions {
  directory?: string;
  maxBytes?: number;
  keepRotations?: number;
  fsync?: boolean;
}

/** Opaque file identity plus the byte offset of the next line; JSON serializable. */
export interface Cursor {
  fileId: string;
  offset: number;
}

export interface Filters {
  chatJid?: string;
  senderJid?: string;
  from?: number;
  to?: number;
  text?: string | RegExp;
}

export interface ReadStats {
  corruptLines: number;
  cursor: Cursor | null;
}

export interface ReadOptions {
  cursor?: Cursor;
  filters?: Filters;
}

export interface StoreEntry {
  record: MessageRecord;
  cursor: Cursor;
}

export interface ReadResult extends ReadStats {
  records: MessageRecord[];
}

export type StoreIterator = Generator<StoreEntry, void, undefined> & { readonly stats: ReadStats };

export class CursorExpiredError extends Error {
  constructor() {
    super('Cursor file is no longer retained; restart reading without a cursor.');
    this.name = 'CursorExpiredError';
  }
}

interface Snapshot {
  fd: number;
  fileId: string;
  size: number;
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export function matchesRecord(record: MessageRecord, filters: Filters): boolean {
  if (filters.chatJid !== undefined && record.chatJid !== filters.chatJid) return false;
  if (filters.senderJid !== undefined && record.senderJid !== filters.senderJid) return false;
  if (filters.from !== undefined && record.ts < filters.from) return false;
  if (filters.to !== undefined && record.ts > filters.to) return false;
  if (typeof filters.text === 'string') return record.body.includes(filters.text);
  if (filters.text !== undefined) {
    // Each record gets the same regexp state, including for global/sticky patterns.
    return new RegExp(filters.text.source, filters.text.flags).test(record.body);
  }
  return true;
}

export function checkFilters(filters: Filters): void {
  for (const bound of [filters.from, filters.to]) {
    if (bound !== undefined && (!Number.isSafeInteger(bound) || bound < 0)) {
      throw new RangeError('Time bounds must be nonnegative Unix milliseconds.');
    }
  }
  if (filters.from !== undefined && filters.to !== undefined && filters.from > filters.to) {
    throw new RangeError('from must not exceed to.');
  }
}

/** Synchronous, single-writer JSONL store. Readers stream a fixed-size snapshot. */
export class JsonlStore {
  readonly directory: string;
  readonly path: string;
  private readonly maxBytes: number;
  private readonly keepRotations: number;
  private readonly sync: boolean;

  constructor(options: StoreOptions = {}) {
    this.directory = resolve(options.directory ?? join(homedir(), '.wallfly'));
    this.path = join(this.directory, 'messages.jsonl');
    this.maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
    this.keepRotations = options.keepRotations ?? 5;
    this.sync = options.fsync ?? false;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1) {
      throw new RangeError('maxBytes must be a positive safe integer.');
    }
    if (!Number.isSafeInteger(this.keepRotations) || this.keepRotations < 0) {
      throw new RangeError('keepRotations must be a nonnegative safe integer.');
    }
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
  }

  append(record: MessageRecord): Cursor {
    if (!validateRecord(record)) throw new TypeError('Invalid message record.');
    // Persist only schema fields; extra transport metadata must not leak to disk.
    const { v, ts, receivedAt, chatJid, chatName, chatType, fromMe, senderJid,
      senderName, pushName, body, mediaType, messageId, syncType, mediaPath } = record;
    const line = Buffer.from(`${JSON.stringify({ v, ts, receivedAt, chatJid, chatName,
      chatType, fromMe, senderJid, senderName, pushName, body, mediaType, messageId,
      ...(syncType === undefined ? {} : { syncType }),
      ...(mediaPath === undefined ? {} : { mediaPath }),
      ...(record.reconciliation === undefined ? {} : { reconciliation: record.reconciliation,
        targetMessageId: record.targetMessageId }) })}\n`);
    let fd = this.openWriter();
    try {
      let size = fstatSync(fd).size;
      let prefix = this.needsNewline(fd, size) ? '\n' : '';
      if (size > 0 && size + line.length + prefix.length > this.maxBytes) {
        // Keep the old inode alive until its replacement exists. With zero
        // retention, immediate inode reuse can alias a just-expired cursor on
        // filesystems whose birth timestamps have coarse resolution.
        const previous = fd;
        fd = -1;
        try {
          this.rotate();
          fd = this.openWriter();
        } finally { closeSync(previous); }
        size = 0;
        prefix = '';
      }
      const bytes = prefix ? Buffer.concat([Buffer.from(prefix), line]) : line;
      // O_APPEND and exactly one write call keep each record together.
      const written = writeSync(fd, bytes);
      if (written !== bytes.length) throw new Error('Incomplete JSONL append.');
      if (this.sync) fsyncSync(fd);
      const stat = fstatSync(fd, { bigint: true });
      return { fileId: `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`, offset: size + written };
    } finally {
      if (fd !== -1) closeSync(fd);
    }
  }

  iterate(options: ReadOptions = {}): StoreIterator {
    const filters = { ...options.filters };
    const cursor = options.cursor ? { ...options.cursor } : undefined;
    checkFilters(filters);
    if (cursor && (typeof cursor.fileId !== 'string' || !Number.isSafeInteger(cursor.offset)
      || cursor.offset < 0)) throw new TypeError('Invalid store cursor.');
    const stats: ReadStats = { corruptLines: 0, cursor: cursor ?? null };
    return Object.assign(this.scan(filters, cursor, stats), { stats });
  }

  filter(filters: Filters = {}, cursor?: Cursor): ReadResult {
    const iterator = this.iterate({ filters, ...(cursor ? { cursor } : {}) });
    const records = Array.from(iterator, (entry) => entry.record);
    return { records, ...iterator.stats };
  }

  /** Last n retained records after cursor, in append order (not timestamp order). */
  tail(n: number, cursor?: Cursor): ReadResult {
    if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('n must be a nonnegative safe integer.');
    const iterator = this.iterate(cursor ? { cursor } : {});
    if (n === 0) return { records: [], ...iterator.stats };
    const records: MessageRecord[] = [];
    let next = 0;
    for (const { record } of iterator) {
      if (records.length < n) records.push(record);
      else {
        records[next] = record;
        next = (next + 1) % n;
      }
    }
    return { records: [...records.slice(next), ...records.slice(0, next)], ...iterator.stats };
  }

  private openWriter(): number {
    const fd = openSync(this.path, constants.O_CREAT | constants.O_APPEND | constants.O_RDWR
      | constants.O_NOFOLLOW, 0o600);
    try {
      if (!fstatSync(fd).isFile()) throw new Error('Store path must be a regular file.');
      fchmodSync(fd, 0o600);
      return fd;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  private needsNewline(fd: number, size: number): boolean {
    if (size === 0) return false;
    const byte = Buffer.alloc(1);
    readSync(fd, byte, 0, 1, size - 1);
    return byte[0] !== 10;
  }

  private rotate(): void {
    // Also prune older files if retention was reduced when reopening the store.
    for (const index of this.rotationIndices()) {
      if (index >= this.keepRotations) unlinkSync(`${this.path}.${index}`);
      else renameSync(`${this.path}.${index}`, `${this.path}.${index + 1}`);
    }
    if (this.keepRotations === 0) unlinkSync(this.path);
    else renameSync(this.path, `${this.path}.1`);
  }

  private rotationIndices(): number[] {
    return readdirSync(this.directory)
      .map((name) => /^messages\.jsonl\.([1-9]\d*)$/.exec(name)?.[1])
      .filter((index): index is string => index !== undefined)
      .map(Number).sort((a, b) => b - a);
  }

  private *scan(filters: Filters, cursor: Cursor | undefined, stats: ReadStats): Generator<StoreEntry> {
    const files: Snapshot[] = [];
    try {
      for (const path of [...this.rotationIndices().map((index) => `${this.path}.${index}`), this.path]) {
        let fd: number;
        try {
          fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        } catch (error) {
          if (missing(error)) continue;
          throw error;
        }
        try {
          const stat = fstatSync(fd, { bigint: true });
          if (!stat.isFile()) throw new Error('Store path must be a regular file.');
          files.push({ fd, fileId: `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`, size: Number(stat.size) });
        } catch (error) {
          closeSync(fd);
          throw error;
        }
      }
      const start = cursor ? files.findIndex((file) => file.fileId === cursor.fileId) : 0;
      if (start === -1) throw new CursorExpiredError();
      for (let index = start; index < files.length; index++) {
        const file = files[index]!;
        const offset = index === start ? cursor?.offset ?? 0 : 0;
        if (offset > file.size) throw new RangeError('Cursor offset exceeds file size.');
        if (offset > 0) {
          const byte = Buffer.alloc(1);
          readSync(file.fd, byte, 0, 1, offset - 1);
          if (byte[0] !== 10) throw new RangeError('Cursor must point to a line boundary.');
        }
        stats.cursor = { fileId: file.fileId, offset };
        yield* this.readLines(file, offset, filters, stats);
      }
    } finally {
      for (const file of files) closeSync(file.fd);
    }
  }

  private *readLines(file: Snapshot, offset: number, filters: Filters, stats: ReadStats): Generator<StoreEntry> {
    let position = offset;
    let lineStart = offset;
    let fragments: Buffer[] = [];
    let length = 0;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    while (position < file.size) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, file.size - position));
      const bytesRead = readSync(file.fd, chunk, 0, chunk.length, position);
      if (bytesRead === 0) throw new Error('Store file was truncated during reading.');
      let begin = 0;
      for (let end = 0; end < bytesRead; end++) {
        if (chunk[end] !== 10) continue;
        const line = Buffer.concat([...fragments, chunk.subarray(begin, end)], length + end - begin);
        const cursor = { fileId: file.fileId, offset: position + end + 1 };
        stats.cursor = cursor;
        let record: unknown;
        try {
          record = JSON.parse(decoder.decode(line));
        } catch {
          record = undefined;
        }
        if (!validateRecord(record)) stats.corruptLines++;
        else if (matchesRecord(record, filters)) yield { record, cursor };
        fragments = [];
        length = 0;
        begin = end + 1;
        lineStart = cursor.offset;
      }
      if (begin < bytesRead) {
        fragments.push(chunk.subarray(begin, bytesRead));
        length += bytesRead - begin;
      }
      position += bytesRead;
    }
    if (length > 0) {
      stats.corruptLines++;
      // Keep the cursor before an incomplete final line so a later read can retry it.
      stats.cursor = { fileId: file.fileId, offset: lineStart };
    }
  }
}
