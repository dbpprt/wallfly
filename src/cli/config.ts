import { join } from 'node:path';
import { privateDirectory, readPrivateFile, replacePrivateFile } from '../daemon/files.js';

export const defaults = {
  read_receipts: false,
  presence: false,
  media_archival: true,
  port: 7877,
  maxBytes: 10 * 1024 * 1024,
  keepRotations: 5,
  audit_rotations: 10,
};
export type Config = typeof defaults;
export type ConfigKey = keyof Config;

export function configKey(key: string): ConfigKey {
  if (!Object.hasOwn(defaults, key)) throw new Error(`Unknown config key: ${key}`);
  return key as ConfigKey;
}

function validate(key: ConfigKey, value: unknown): void {
  if (key === 'read_receipts' || key === 'presence' || key === 'media_archival') {
    if (typeof value !== 'boolean') throw new Error(`${key} must be true or false.`);
  } else if (typeof value !== 'number' || !Number.isSafeInteger(value)
    || value < (key === 'keepRotations' || key === 'audit_rotations' ? 0 : 1) || (key === 'port' && value > 65535)) {
    throw new Error(`Invalid integer for ${key}.`);
  }
}

export function loadConfig(directory: string): Config {
  let raw: string;
  try { raw = readPrivateFile(join(directory, 'config.json')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...defaults };
    throw error;
  }
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid config.');
  for (const [key, field] of Object.entries(value)) validate(configKey(key), field);
  return { ...defaults, ...value };
}

export function setConfig(directory: string, key: string, raw: string): Config {
  const name = configKey(key);
  const value: unknown = JSON.parse(raw);
  validate(name, value);
  const config = { ...loadConfig(directory), [name]: value };
  privateDirectory(directory);
  replacePrivateFile(join(directory, 'config.json'), JSON.stringify(config, null, 2) + '\n');
  return config;
}
