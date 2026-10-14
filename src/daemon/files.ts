import {
  chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!lstatSync(path).isDirectory()) throw new Error('Private directory must not be a symlink.');
  chmodSync(path, 0o700);
}

export function readPrivateFile(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('Expected a regular private file.');
    fchmodSync(fd, 0o600);
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

/** Replace with a fully written, private file; readers never see partial JSON. */
export function replacePrivateFile(path: string, data: string | Buffer): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, data, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    removeFile(temporary);
  }
}

export function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export function secureAuthFiles(directory: string): void {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (!lstatSync(path).isFile()) throw new Error('Auth entries must be regular files.');
    chmodSync(path, 0o600);
  }
}
