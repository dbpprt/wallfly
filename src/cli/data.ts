import { closeSync, openSync, writeSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Cursor, Filters, MessageRecord } from '../store/index.js';
import { JsonlStore } from '../store/index.js';
import { auditRotationIndices } from '../send/audit.js';

export function last<T>(items: Iterable<T>, count: number): T[] {
  if (count === 0) return [];
  const ring: T[] = [];
  let index = 0;
  for (const item of items) {
    if (ring.length < count) ring.push(item);
    else { ring[index] = item; index = (index + 1) % count; }
  }
  return [...ring.slice(index), ...ring.slice(0, index)];
}

export async function auditEntries(directory: string, limit: number): Promise<unknown[]> {
  const records: unknown[] = [];
  let index = 0;
  let indices: number[];
  try { indices = auditRotationIndices(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  for (const name of [...indices.map((n) => `sends.jsonl.${n}`), 'sends.jsonl']) {
    const input = createReadStream(join(directory, name), { encoding: 'utf8' });
    // Keep one bounded ring across all retained files, in append order.
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        const record: unknown = JSON.parse(line);
        if (limit === 0) continue;
        if (records.length < limit) records.push(record);
        else { records[index] = record; index = (index + 1) % limit; }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    } finally { lines.close(); input.destroy(); }
  }
  return [...records.slice(index), ...records.slice(0, index)];
}

export async function tail(store: JsonlStore, count: number, filters: Filters,
  follow: boolean, signal: AbortSignal, print: (record: MessageRecord) => void): Promise<number> {
  const initial = store.iterate({ filters });
  let records: MessageRecord[];
  if (count === 0) {
    // Consume the snapshot for its cursor without retaining any records.
    for (const entry of initial) { void entry; }
    records = [];
  } else records = last((function* () {
    for (const entry of initial) yield entry.record;
  })(), count);
  if (count !== 0) for (const record of records) print(record);
  let cursor: Cursor | null = initial.stats.cursor;
  if (!follow) return count !== 0 && records.length ? 0 : 3;
  while (!signal.aborted) {
    try { await delay(200, undefined, { signal }); }
    catch (error) { if (!signal.aborted) throw error; }
    if (signal.aborted) break;
    const next = store.iterate({ filters, ...(cursor ? { cursor } : {}) });
    for (const { record } of next) print(record);
    cursor = next.stats.cursor;
  }
  return 0;
}

const columns = ['v', 'ts', 'receivedAt', 'chatJid', 'chatName', 'chatType', 'fromMe',
  'senderJid', 'senderName', 'pushName', 'body', 'mediaType', 'messageId', 'syncType', 'mediaPath'] as const;
function csv(value: unknown): string {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
export function exportRecords(store: JsonlStore, filters: Filters, format: string, path: string): number {
  const fd = openSync(path, 'wx', 0o600);
  let count = 0;
  const write = (data: string): void => {
    const bytes = Buffer.from(data);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset);
      if (written === 0) throw new Error('Export write failed.');
      offset += written;
    }
  };
  try {
    write(format === 'json' ? '[' : columns.join(',') + '\r\n');
    for (const { record } of store.iterate({ filters })) {
      write(format === 'json' ? `${count ? ',' : ''}\n${JSON.stringify(record)}`
        : columns.map((key) => csv(record[key])).join(',') + '\r\n');
      count++;
    }
    if (format === 'json') write(`${count ? '\n' : ''}]\n`);
  } finally { closeSync(fd); }
  return count ? 0 : 3;
}
