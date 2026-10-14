import { randomBytes, timingSafeEqual } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { privateDirectory, readPrivateFile, replacePrivateFile, withPrivateFileLock } from './files.js';

/** Never generate credentials while reading them for a client request. */
export function readControlToken(directory: string): string | undefined {
  const auth = join(directory, 'auth');
  try {
    if (!lstatSync(auth).isDirectory()) throw new Error('Auth directory must not be a symlink.');
    const token = readPrivateFile(join(auth, 'token')).trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid control token; run wallfly token rotate.');
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Serialize creation/rotation and publish a complete token atomically. */
export function ensureControlToken(directory: string, rotate = false): string {
  privateDirectory(directory);
  privateDirectory(join(directory, 'auth'));
  const path = join(directory, 'auth', 'token');
  return withPrivateFileLock(path, () => {
    if (!rotate) {
      const existing = readControlToken(directory);
      if (existing !== undefined) return existing;
    }
    const token = randomBytes(32).toString('hex');
    replacePrivateFile(path, token + '\n');
    return token;
  });
}

/** Read on every request so rotation revokes old credentials without a restart. */
export function authorized(directory: string, header: string | undefined): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const supplied = header.slice(7);
  if (!/^[a-f0-9]{64}$/.test(supplied)) return false;
  try {
    const token = readControlToken(directory);
    return token !== undefined && timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(token, 'hex'));
  } catch { return false; }
}
