import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, openSync, readSync,
  readdirSync, renameSync, unlinkSync, writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { SendAuditRecord } from './index.js';

export function auditRotationIndices(directory: string): number[] {
  return readdirSync(directory)
    .map((name) => /^sends\.jsonl\.([1-9]\d*)$/.exec(name)?.[1])
    .filter((index): index is string => index !== undefined)
    .map(Number).sort((a, b) => b - a);
}

function openAudit(path: string, create = true): number {
  const fd = openSync(path, (create ? constants.O_CREAT | constants.O_APPEND : 0) | constants.O_RDWR
    | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('Audit must be a regular file.');
    fchmodSync(fd, 0o600);
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}

function rotate(path: string, keep: number): void {
  const indices = auditRotationIndices(dirname(path));
  // Reject unsafe archives before changing retention; never follow symlinks.
  for (const index of indices) closeSync(openAudit(`${path}.${index}`, false));
  for (const index of indices) {
    if (index >= keep) unlinkSync(`${path}.${index}`);
    else renameSync(`${path}.${index}`, `${path}.${index + 1}`);
  }
  if (keep === 0) unlinkSync(path);
  else renameSync(path, `${path}.1`);
}

/** Validate the final line before rotation; append and sync before outgoing calls. */
export function appendAudit(path: string, record: SendAuditRecord, maxBytes: number, keep: number): void {
  let fd = openAudit(path);
  try {
    const size = fstatSync(fd).size;
    if (size > 0) {
      const last = Buffer.alloc(1);
      if (readSync(fd, last, 0, 1, size - 1) !== 1 || last[0] !== 10) {
        throw new Error('Audit has an incomplete final record.');
      }
    }
    const data = Buffer.from(JSON.stringify(record) + '\n');
    if (size > 0 && size + data.length > maxBytes) {
      rotate(path, keep);
      closeSync(fd);
      fd = -1;
      fd = openAudit(path);
    }
    if (writeSync(fd, data) !== data.length) throw new Error('Incomplete audit append.');
    fsyncSync(fd);
  } finally { if (fd !== -1) closeSync(fd); }
}
