import { closeSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { privateDirectory, readPrivateFile, removeFile } from '../daemon/files.js';
import { DaemonService } from '../daemon/index.js';
import type { DaemonOptions } from '../daemon/index.js';

export function readPid(directory: string): number | undefined {
  let raw: string;
  try { raw = readPrivateFile(join(directory, 'wallfly.pid')).trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) <= 1) {
    throw new Error('Invalid pidfile; inspect ~/.wallfly/wallfly.pid.');
  }
  return Number(raw);
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

/** Same exclusive lock for foreground and direct mode: never share auth writers. */
export function lockPid(directory: string): () => void {
  privateDirectory(directory);
  const path = join(directory, 'wallfly.pid');
  const previous = readPid(directory);
  if (previous !== undefined) {
    if (alive(previous)) throw new Error('A wallfly process is already running. Stop it first.');
    removeFile(path);
  }
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, `${process.pid}\n`); } finally { closeSync(fd); }
  return () => {
    if (readPid(directory) === process.pid) removeFile(path);
  };
}

export interface ForegroundService {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): { state: string };
}
export type DaemonFactory = (options: DaemonOptions) => ForegroundService;

export async function foreground(options: DaemonOptions & { directory: string },
  signal: AbortSignal, factory: DaemonFactory = (options) => new DaemonService(options)): Promise<void> {
  const unlock = lockPid(options.directory);
  let service: ForegroundService | undefined;
  let stopping: Promise<void> | undefined;
  const stop = (): void => {
    stopping ??= service?.stop();
    // Observe rejection immediately, then propagate it from the cleanup below.
    void stopping?.catch(() => {});
  };
  signal.addEventListener('abort', stop, { once: true });
  try {
    service = factory(options);
    if (signal.aborted) return;
    await service.start();
    if (signal.aborted) stop();
    while (!signal.aborted && service.status().state !== 'stopped') await delay(100);
  } finally {
    signal.removeEventListener('abort', stop);
    try { await (stopping ?? service?.stop()); } finally { unlock(); }
  }
}
