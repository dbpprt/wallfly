import { parseArgs } from 'node:util';
import type { ParseArgsConfig } from 'node:util';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { lstatSync, accessSync, constants } from 'node:fs';
import { JsonlStore } from '../store/index.js';
import type { Filters } from '../store/index.js';
import { SendError, validateRequest } from '../send/index.js';
import { directSend } from '../send/direct.js';
import { loadConfig, setConfig, configKey } from './config.js';
import { commands, usage } from './help.js';
import { foreground, lockPid, terminatePid } from './lifecycle.js';
import type { DaemonFactory } from './lifecycle.js';
import { auditEntries, exportRecords, tail } from './data.js';
import { NameCache, normalizedJid } from '../daemon/cache.js';

export interface CliDependencies {
  directory?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  daemonFactory?: DaemonFactory;
  directSend?: typeof directSend;
}
const string = { type: 'string' } as const;
const boolean = { type: 'boolean' } as const;
const dates = { from: string, to: string };
const options: Record<string, NonNullable<ParseArgsConfig['options']>> = {
  start: {}, stop: {}, status: {}, pair: {}, config: {}, chats: {}, who: {},
  send: { to: string, text: string, image: string, caption: string, document: string, direct: boolean },
  sends: { limit: string },
  search: { chat: string, sender: string, ...dates, regex: boolean, limit: string, json: boolean },
  tail: { n: { ...string, short: 'n' }, follow: { ...boolean, short: 'f' }, chat: string },
  export: { chat: string, ...dates, format: string, out: string },
};
function integer(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error('Expected a nonnegative integer.');
  return Number(raw);
}
function timestamp(raw: string): number {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(raw)
    || !Number.isSafeInteger(Date.parse(raw)) || Date.parse(raw) < 0) {
    throw new Error('Expected an ISO timestamp with timezone.');
  }
  const [year, month, day] = raw.slice(0, 10).split('-').map(Number);
  const calendar = new Date(`${raw.slice(0, 10)}T00:00:00Z`);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() + 1 !== month || calendar.getUTCDate() !== day
    || Number(raw.slice(11, 13)) > 23) throw new Error('Invalid calendar date.');
  return Date.parse(raw);
}

/** Command boundary; injected HTTP/socket/lifecycle ports keep all tests offline. */
export async function runCli(args: string[], dependencies: CliDependencies = {}): Promise<number> {
  const out = dependencies.stdout ?? ((text: string) => { process.stdout.write(text); });
  const err = dependencies.stderr ?? ((text: string) => { process.stderr.write(text); });
  const directory = dependencies.directory ?? join(homedir(), '.wallfly');
  const controller = new AbortController();
  const signal = dependencies.signal ?? controller.signal;
  const abort = (): void => controller.abort();
  const print = (value: unknown): void => out(JSON.stringify(value) + '\n');
  const command = args[0];
  if (!command || command === '--help' || command === '-h') { out(usage()); return command ? 0 : 1; }
  if (!commands.includes(command)) { err(`Unknown command: ${command}\n${usage()}`); return 1; }
  try {
    const parsed = parseArgs({ args: args.slice(1), strict: true, allowPositionals: true,
      options: { ...options[command], help: { ...boolean, short: 'h' } } });
    if (parsed.values.help) { out(usage(command)); return 0; }
    const values = parsed.values as Record<string, string | boolean | undefined>;
    const str = (name: string): string | undefined => values[name] as string | undefined;
    const positionals = parsed.positionals;
    if (command !== 'config' && positionals.length !== (command === 'search' || command === 'who' ? 1 : 0)) {
      throw new Error('Unexpected or missing positional argument.');
    }
    if (!dependencies.signal) {
      process.once('SIGINT', abort);
      process.once('SIGTERM', abort);
    }
    const config = loadConfig(directory);
    const request = async (path: string, body?: unknown): Promise<unknown> => {
      let response: Response;
      try {
        response = await (dependencies.fetch ?? fetch)(`http://127.0.0.1:${config.port}${path}`, {
          method: path === '/status' ? 'GET' : 'POST',
          ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(path === '/send' ? 60000 : 3000)]),
          redirect: 'error',
        });
      } catch { throw new SendError(503, 'Daemon unreachable; run wallfly start.'); }
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new SendError(response.status, result.error ?? 'Daemon request failed.');
      return result;
    };
    if (command === 'config') {
      const [action, key, value] = positionals;
      if (action === 'get' && positionals.length <= 2) {
        print(key === undefined ? config : config[configKey(key)]); return 0;
      }
      if (action === 'set' && positionals.length === 3 && key !== undefined && value !== undefined) {
        print(setConfig(directory, key, value)[configKey(key)]); return 0;
      }
      throw new Error('Use config get [KEY] or config set KEY VALUE.');
    }
    if (command === 'start' || command === 'pair') {
      await foreground({ ...config, directory }, signal, dependencies.daemonFactory); return 0;
    }
    if (command === 'status') { print(await request('/status')); return 0; }
    if (command === 'stop') {
      if (terminatePid(directory)) print({ stopping: true });
      else print(await request('/stop'));
      return 0;
    }
    if (command === 'send') {
      const image = str('image');
      const document = str('document');
      const text = str('text');
      const caption = str('caption');
      if ((image || document) && text !== undefined && caption !== undefined) {
        throw new Error('Use either --text or --caption for media.');
      }
      const send = validateRequest({ jid: str('to'),
        ...(image === undefined ? {} : { image: resolve(image) }),
        ...(document === undefined ? {} : { document: resolve(document) }),
        ...(image !== undefined || document !== undefined
          ? (caption ?? text) === undefined ? {} : { caption: caption ?? text }
          : { ...(text === undefined ? {} : { text }), ...(caption === undefined ? {} : { caption }) }),
      });
      for (const path of [send.image, send.document]) {
        if (path === undefined) continue;
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.size < 1 || stat.size > 64 * 1024 * 1024) throw new Error('Invalid media file.');
        accessSync(path, constants.R_OK);
      }
      let result: { audit?: unknown };
      if (values.direct) {
        const unlock = lockPid(directory);
        try {
          // Also reject daemons started through the legacy runner without a pidfile.
          let reachable = false;
          try { await request('/status'); reachable = true; }
          catch (error) { if (!(error instanceof SendError) || error.status !== 503) throw error; }
          if (reachable) throw new Error('Stop the running daemon before --direct.');
          result = await (dependencies.directSend ?? directSend)(send, { ...config, directory }, signal);
        } finally { unlock(); }
      } else result = await request('/send', send) as { audit?: unknown };
      if (!result.audit) throw new Error('Daemon returned no audit entry; update the daemon. Do not retry blindly.');
      print(result.audit); return 0;
    }
    if (command === 'sends') {
      const records = await auditEntries(directory, integer(str('limit'), 100));
      records.forEach(print); return records.length ? 0 : 3;
    }
    const filters: Filters = {
      ...(str('chat') === undefined ? {} : { chatJid: str('chat')! }),
      ...(str('sender') === undefined ? {} : { senderJid: str('sender')! }),
      ...(str('from') === undefined ? {} : { from: timestamp(str('from')!) }),
      ...(str('to') === undefined ? {} : { to: timestamp(str('to')!) }),
    };
    if (filters.from !== undefined && filters.to !== undefined && filters.from > filters.to) {
      throw new Error('--from must not exceed --to.');
    }
    const store = new JsonlStore({ ...config, directory });
    if (command === 'who') {
      const jid = positionals[0]!;
      if (!/^[^\s@]+@[^\s@]+$/.test(jid)) throw new Error('who requires a JID.');
      const identity = new NameCache(directory).identity(jid);
      let count = 0;
      let lastTs: number | null = null;
      let archivedName: string | null = null;
      let archivedPushname: string | null = null;
      let archivedPushnameTs = -1;
      for (const { record } of store.iterate()) {
        if (identity.aliases.includes(normalizedJid(record.chatJid))) {
          count++;
          lastTs = Math.max(lastTs ?? 0, record.ts);
          archivedName = record.chatName ?? archivedName;
        }
        if (!record.fromMe && identity.aliases.includes(normalizedJid(record.senderJid))
          && record.pushName && record.ts >= archivedPushnameTs) {
          archivedPushname = record.pushName;
          archivedPushnameTs = record.ts;
        }
      }
      print({ ...identity, name: identity.name ?? archivedName ?? archivedPushname,
        pushname: identity.pushname ?? archivedPushname,
        pushnameTs: identity.pushnameTs ?? (archivedPushnameTs < 0 ? null : archivedPushnameTs), count, lastTs });
      return count || identity.name || identity.phone || identity.groups.length || archivedPushname ? 0 : 3;
    }
    if (command === 'tail') return await tail(store, integer(str('n'), 10), filters, !!values.follow, signal, print);
    if (command === 'export') {
      const format = str('format');
      const path = str('out');
      if ((format !== 'json' && format !== 'csv') || !path) throw new Error('export requires --format json|csv --out FILE.');
      return exportRecords(store, filters, format, path);
    }
    if (command === 'chats') {
      const cache = new NameCache(directory);
      const chats = new Map<string, { jid: string; name: string | null; type: string; count: number; lastTs: number }>();
      const pushnames = new Map<string, { name: string; ts: number }>();
      for (const { record } of store.iterate()) {
        const chat = chats.get(record.chatJid) ?? { jid: record.chatJid, name: record.chatName,
          type: record.chatType, count: 0, lastTs: 0 };
        chat.count++; chat.lastTs = Math.max(chat.lastTs, record.ts);
        chat.name = record.chatName ?? chat.name;
        const sender = normalizedJid(record.senderJid);
        if (!record.fromMe && record.pushName && record.ts >= (pushnames.get(sender)?.ts ?? -1)) {
          pushnames.set(sender, { name: record.pushName, ts: record.ts });
        }
        chats.set(chat.jid, chat);
      }
      for (const chat of chats.values()) {
        const identity = cache.identity(chat.jid);
        const archivedPushname = identity.aliases.map((id) => pushnames.get(id))
          .filter((entry) => entry !== undefined).sort((a, b) => b.ts - a.ts)[0]?.name ?? null;
        print({ jid: chat.jid, name: identity.name ?? chat.name ?? archivedPushname,
          phone: identity.phone, pushname: identity.pushname ?? archivedPushname,
          type: chat.type, count: chat.count, lastTs: chat.lastTs });
      }
      return chats.size ? 0 : 3;
    }
    const query = positionals[0]!;
    filters.text = values.regex ? new RegExp(query) : query;
    const limit = integer(str('limit'), Number.MAX_SAFE_INTEGER);
    const records = [];
    let count = 0;
    if (limit > 0) for (const { record } of store.iterate({ filters })) {
      if (values.json) records.push(record);
      else out(`${new Date(record.ts).toISOString()} ${record.chatJid} ${record.senderJid} ${JSON.stringify(record.body)}\n`);
      if ((values.json ? records.length : ++count) >= limit) break;
    }
    if (values.json) { print(records); return records.length ? 0 : 3; }
    return count ? 0 : 3;
  } catch (error) {
    err(`${error instanceof Error ? error.message : 'Command failed.'}\n`);
    if (error instanceof SendError) return error.status >= 500 && error.status < 504 ? 2 : 1;
    return 1;
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}
