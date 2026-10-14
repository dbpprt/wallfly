import { homedir } from 'node:os';
import { join } from 'node:path';
import { readPrivateFile } from '../daemon/files.js';
import { validateSendOptions } from './index.js';
import type { SendOptions } from './index.js';

/** Missing config means both gates OFF; malformed or unsafe config fails startup. */
export function loadSendConfig(directory = join(homedir(), '.wallfly')): SendOptions {
  let raw: string;
  try { raw = readPrivateFile(join(directory, 'config.json')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid config.');
  const fields = value as SendOptions;
  validateSendOptions(fields);
  return {
    ...(fields.read_receipts === undefined ? {} : { read_receipts: fields.read_receipts }),
    ...(fields.presence === undefined ? {} : { presence: fields.presence }),
    ...(fields.maxBytes === undefined ? {} : { maxBytes: fields.maxBytes }),
    ...(fields.audit_rotations === undefined ? {} : { audit_rotations: fields.audit_rotations }),
  };
}
