import { createHash } from 'node:crypto';
import {
  closeSync, constants, fstatSync, openSync, readFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { AuthenticationState, WASocket, WAMessageKey } from '@whiskeysockets/baileys';
import { privateDirectory } from '../daemon/files.js';
import { validJid } from '../daemon/identity.js';
import { appendAudit } from './audit.js';

export interface SendRequest {
  jid: string;
  text?: string;
  image?: string;
  document?: string;
  caption?: string;
  /** Explicit keys to mark read during this send, if the config gate is enabled. */
  readKeys?: WAMessageKey[];
}

export interface SendAuditRecord {
  v: 1;
  ts: number;
  jid: string;
  kind: 'text' | 'image' | 'document';
  textSha256: string;
  mediaPath: string | null;
}

export type OutgoingContent = { text: string }
  | { image: Buffer; caption: string }
  | { document: Buffer; caption: string; fileName: string; mimetype: string };

/** The daemon carries this port but never invokes its outgoing operations. */
export interface SendTransport {
  message(jid: string, content: OutgoingContent): Promise<string | null>;
  receipts(keys: WAMessageKey[]): Promise<void>;
  presence(jid: string): Promise<void>;
}

/** All access to the Baileys outgoing API stays in this module. */
export function bindSendTransport(
  socket: Pick<WASocket, 'sendMessage' | 'readMessages' | 'sendPresenceUpdate'>,
  keys: Pick<AuthenticationState['keys'], 'set'>,
): SendTransport {
  return {
    message: async (jid, content) => {
      // Baileys does not invalidate this cache when a participant adds a device.
      // Its retry path performs the same reset before redistributing sender keys.
      if (jid.endsWith('@g.us')) {
        await keys.set({ 'sender-key-memory': { [jid]: null } });
      }
      return (await socket.sendMessage(jid, content))?.key.id ?? null;
    },
    receipts: (keys) => socket.readMessages(keys),
    presence: (jid) => socket.sendPresenceUpdate('available', jid),
  };
}

export class SendError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface SendOptions {
  directory?: string;
  read_receipts?: boolean;
  presence?: boolean;
  maxBytes?: number;
  audit_rotations?: number;
}

export function validateSendOptions(options: SendOptions): void {
  if (options.maxBytes !== undefined && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1)) {
    throw new RangeError('maxBytes must be a positive safe integer.');
  }
  if (options.audit_rotations !== undefined
    && (!Number.isSafeInteger(options.audit_rotations) || options.audit_rotations < 0)) {
    throw new RangeError('audit_rotations must be a nonnegative safe integer.');
  }
  for (const key of ['read_receipts', 'presence'] as const) {
    if (options[key] !== undefined && typeof options[key] !== 'boolean') {
      throw new TypeError(`${key} must be a boolean.`);
    }
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateRequest(value: unknown): SendRequest {
  const fail = (): never => { throw new SendError(400, 'Invalid send request.'); };
  if (!object(value) || !validJid(value.jid)
    || Object.keys(value).some((key) => !['jid', 'text', 'image', 'document', 'caption', 'readKeys'].includes(key))) return fail();
  const kinds = ['text', 'image', 'document'].filter((key) => value[key] !== undefined);
  if (kinds.length !== 1) return fail();
  for (const key of kinds) {
    if (typeof value[key] !== 'string' || !value[key].trim() || value[key].includes('\0')) return fail();
  }
  if (value.caption !== undefined && (typeof value.caption !== 'string' || value.text !== undefined)) return fail();
  if (value.readKeys !== undefined) {
    if (!Array.isArray(value.readKeys) || value.readKeys.length > 100) return fail();
    for (const key of value.readKeys) {
      if (!object(key) || key.remoteJid !== value.jid || typeof key.id !== 'string' || !key.id.trim()
        || (key.fromMe !== undefined && key.fromMe !== false)
        || (key.participant !== undefined && !validJid(key.participant))
        || (value.jid.endsWith('@g.us') && !validJid(key.participant))
        || Object.keys(key).some((name) => !['id', 'remoteJid', 'participant', 'fromMe'].includes(name))) return fail();
    }
  }
  // Snapshot caller-owned values before any asynchronous transport work.
  return { jid: value.jid, ...Object.fromEntries(kinds.map((key) => [key, value[key]])),
    ...(value.caption === undefined ? {} : { caption: value.caption as string }),
    ...(value.readKeys === undefined ? {} : { readKeys: (value.readKeys as WAMessageKey[]).map((key) => ({ ...key })) }) };
}

function localMedia(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size === 0 || stat.size > 64 * 1024 * 1024) {
      throw new Error('Media must be a nonempty regular file of at most 64 MiB.');
    }
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

/** A single send(request) path for explicit CLI/HTTP actions. No retries or auto-sends. */
export class SendService {
  readonly auditPath: string;
  private readonly directory: string;
  private readonly options: SendOptions;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(options: SendOptions, private readonly connectedTransport: () => SendTransport | undefined) {
    validateSendOptions(options);
    this.options = { ...options };
    this.directory = resolve(options.directory ?? join(homedir(), '.wallfly'));
    this.auditPath = join(this.directory, 'sends.jsonl');
  }

  send(value: unknown): Promise<{ messageId: string | null }> {
    return this.sendWithAudit(value).then(({ messageId }) => ({ messageId }));
  }

  sendWithAudit(value: unknown): Promise<{ messageId: string | null; audit: SendAuditRecord }> {
    let request: SendRequest;
    try { request = validateRequest(value); } catch (error) { return Promise.reject(error); }
    const result = this.pending.then(() => this.execute(request));
    this.pending = result.catch(() => {});
    return result;
  }

  async flush(): Promise<void> { await this.pending; }

  private async execute(request: SendRequest): Promise<{ messageId: string | null; audit: SendAuditRecord }> {
    const transport = this.connectedTransport();
    if (!transport) throw new SendError(503, 'WhatsApp is disconnected.');
    if (request.readKeys?.length && !this.options.read_receipts) {
      throw new SendError(400, 'Read receipts require read_receipts configuration.');
    }
    const mediaPath = request.image ?? request.document;
    const absolutePath = mediaPath === undefined ? null : resolve(mediaPath);
    const kind = request.image !== undefined ? 'image' : request.document !== undefined ? 'document' : 'text';
    const text = request.text ?? request.caption ?? '';
    let content: OutgoingContent;
    try {
      if (kind === 'text') content = { text };
      else {
        const bytes = localMedia(absolutePath!);
        content = kind === 'image' ? { image: bytes, caption: text }
          : { document: bytes, caption: text, fileName: basename(absolutePath!), mimetype: 'application/octet-stream' };
      }
    } catch { throw new SendError(400, 'Media must be a readable local regular file, 1 byte to 64 MiB.'); }
    const audit: SendAuditRecord = { v: 1, ts: Date.now(), jid: request.jid, kind,
      textSha256: createHash('sha256').update(text).digest('hex'), mediaPath: absolutePath };
    try {
      privateDirectory(this.directory);
      appendAudit(this.auditPath, audit, this.options.maxBytes ?? 10 * 1024 * 1024,
        this.options.audit_rotations ?? 10);
    } catch { throw new SendError(500, 'Audit append failed; send prevented.'); }
    // A disconnect/stop during side effects must never switch this request to another socket.
    const active = (): void => {
      if (this.connectedTransport() !== transport) throw new SendError(503, 'WhatsApp is disconnected.');
    };
    try {
      active();
      if (this.options.presence) { await transport.presence(request.jid); active(); }
      if (this.options.read_receipts && request.readKeys?.length) {
        await transport.receipts(request.readKeys); active();
      }
      return { messageId: await transport.message(request.jid, content), audit };
    } catch (error) {
      if (error instanceof SendError) throw error;
      throw new SendError(502, 'Outgoing operation failed; delivery may be uncertain. Check before retrying.');
    }
  }
}
