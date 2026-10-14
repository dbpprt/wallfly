import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { BaileysEventMap, WAMessage } from '@whiskeysockets/baileys';
import { JsonlStore } from '../store/index.js';
import { SendError, SendService, validateSendOptions } from '../send/index.js';
import { handleSendRequest } from '../send/http.js';
import type { MessageRecord } from '../store/index.js';
import { NameCache } from './cache.js';
import { privateDirectory, removeFile } from './files.js';
import { mapMessage } from './map.js';
import { printPairingQr } from './pair.js';
import type { PairingOutput } from './pair.js';
import { createBaileysSocket } from './socket.js';
import type { ListenerEvent, ListenerSocket, SocketFactory } from './socket.js';

export { NameCache } from './cache.js';
export { mapMessage } from './map.js';
export type { ListenerSocket, SocketFactory, SocketOptions } from './socket.js';

export interface DaemonOptions {
  directory?: string;
  host?: string;
  port?: number;
  maxBytes?: number;
  keepRotations?: number;
  /** Explicit opt-ins; both default OFF and only apply during explicit sends. */
  read_receipts?: boolean;
  presence?: boolean;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

export interface DaemonDependencies {
  socketFactory?: SocketFactory;
  pairingOutput?: PairingOutput;
  store?: { append(record: MessageRecord): unknown };
  log?: (event: string, details?: { attempt: number; delayMs: number }) => void;
}

export interface DaemonStatus {
  state: 'stopped' | 'connecting' | 'pairing' | 'connected' | 'reconnecting' | 'logged-out';
  connected: boolean;
  reconnectAttempt: number;
  recordedMessages: number;
  port: number | null;
}

function validateOptions(options: DaemonOptions): void {
  if (options.host !== undefined && options.host !== '127.0.0.1') {
    throw new Error('Control endpoint must bind to 127.0.0.1 only.');
  }
  const port = options.port ?? 7877;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError('Invalid control port.');
  validateSendOptions(options);
  const base = options.backoffBaseMs ?? 1000;
  const max = options.backoffMaxMs ?? 60000;
  if (!Number.isSafeInteger(base) || base < 1 || !Number.isSafeInteger(max)
    || max < base || max > 2147483647) throw new RangeError('Invalid reconnect backoff.');
}

/** One listener and one writer per directory. Lifecycle failures stay inside the service. */
export class DaemonService {
  readonly directory: string;
  readonly authDirectory: string;
  readonly cache: NameCache;
  private readonly options: DaemonOptions;
  private readonly factory: SocketFactory;
  private readonly pairing: PairingOutput;
  private readonly store: { append(record: MessageRecord): unknown };
  private readonly logger: NonNullable<DaemonDependencies['log']>;
  private readonly sender: SendService;
  private server: Server | undefined;
  private socket: ListenerSocket | undefined;
  private removeListeners: (() => void)[] = [];
  private running = false;
  private retry: NodeJS.Timeout | undefined;
  private pendingConnection: Promise<void> = Promise.resolve();
  private pendingListen: Promise<void> = Promise.resolve();
  private events: Promise<void> = Promise.resolve();
  private stopping: Promise<void> | undefined;
  private state: DaemonStatus['state'] = 'stopped';
  private attempt = 0;
  private recorded = 0;

  constructor(options: DaemonOptions = {}, dependencies: DaemonDependencies = {}) {
    validateOptions(options);
    this.options = { ...options };
    this.directory = resolve(options.directory ?? join(homedir(), '.wallfly'));
    this.sender = new SendService({ ...options, directory: this.directory },
      () => this.running && this.state === 'connected' ? this.socket?.outgoing : undefined);
    this.authDirectory = join(this.directory, 'auth');
    privateDirectory(this.directory);
    privateDirectory(this.authDirectory);
    this.cache = new NameCache(this.directory);
    this.store = dependencies.store ?? new JsonlStore({ ...options, directory: this.directory });
    this.factory = dependencies.socketFactory ?? createBaileysSocket;
    this.pairing = dependencies.pairingOutput ?? printPairingQr;
    this.logger = dependencies.log ?? ((event, details) => {
      process.stderr.write(JSON.stringify({ event, ...details }) + '\n');
    });
  }

  status(): DaemonStatus {
    const address = this.server?.address();
    return { state: this.state, connected: this.state === 'connected', reconnectAttempt: this.attempt,
      recordedMessages: this.recorded, port: typeof address === 'object' ? address?.port ?? null : null };
  }

  async start(): Promise<void> {
    if (this.stopping) await this.stopping;
    if (this.running) {
      await this.pendingListen;
      await this.pendingConnection;
      return;
    }
    this.running = true;
    this.state = 'connecting';
    const server = createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.setHeader('Cache-Control', 'no-store');
      if (request.headers.origin !== undefined || (request.headers.host !== `127.0.0.1:${this.status().port}`)) {
        response.statusCode = 403;
        response.end(JSON.stringify({ error: 'Use the local control endpoint without an Origin header.' }));
        request.resume();
        return;
      }
      if (request.method === 'GET' && request.url === '/status') {
        response.end(JSON.stringify(this.status()));
      } else if (request.method === 'POST' && request.url === '/stop') {
        response.once('finish', () => { void this.stop().catch(() => this.log('stop.failed')); });
        response.end(JSON.stringify({ stopping: true }));
      } else if (request.method === 'POST' && request.url === '/send') {
        void handleSendRequest(request, response, (value) => {
          if (!this.running) throw new SendError(503, 'WhatsApp is disconnected.');
          return this.sender.sendWithAudit(value);
        });
        return;
      } else {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: 'Not found' }));
      }
      request.resume();
    });
    server.requestTimeout = 10000;
    server.headersTimeout = 10000;
    this.server = server;
    try {
      this.pendingListen = new Promise<void>((accept, reject) => {
        server.once('error', reject);
        server.listen(this.options.port ?? 7877, '127.0.0.1', () => {
          server.off('error', reject);
          accept();
        });
      });
      await this.pendingListen;
    } catch (error) {
      this.running = false;
      this.server = undefined;
      this.state = 'stopped';
      throw error;
    }
    server.on('error', () => this.log('control.failed'));
    if (!this.running) return;
    this.pendingConnection = this.connect();
    await this.pendingConnection;
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.running = false;
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    this.state = 'stopped';
    const server = this.server;
    this.server = undefined;
    this.stopping = (async () => {
      // A stop may arrive while listen() is still opening the port.
      await this.pendingListen.catch(() => {});
      await Promise.all([
        this.pendingConnection,
        this.events,
        this.sender.flush(),
        new Promise<void>((accept) => {
          if (!server?.listening) { accept(); return; }
          server.close(() => accept());
          server.closeIdleConnections();
        }),
      ]);
      this.detach();
      this.state = 'stopped';
      this.removePairing();
      this.attempt = 0;
      this.log('daemon.stopped');
    })().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }

  /** Wait for already received events to reach disk (also useful for embedders). */
  async flush(): Promise<void> {
    await this.events;
  }

  private log(event: string, details?: { attempt: number; delayMs: number }): void {
    try { this.logger(event, details); } catch { /* Logging must not break reconnect or event handling. */ }
  }

  private removePairing(): void {
    try { removeFile(join(this.directory, 'pairing.png')); } catch { this.log('pairing.cleanup.failed'); }
  }

  private detach(): void {
    for (const remove of this.removeListeners) remove();
    this.removeListeners = [];
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      try { socket.end(undefined); } catch { this.log('socket.close.failed'); }
    }
  }

  private async connect(): Promise<void> {
    if (!this.running) return;
    try {
      const socket = await this.factory({ authDirectory: this.authDirectory, markOnlineOnConnect: false });
      if (!this.running) { socket.end(undefined); return; }
      this.socket = socket;
      this.on(socket, 'creds.update', () => socket.saveCredentials());
      this.on(socket, 'connection.update', async (update) => {
        if (update.connection === 'close') {
          this.detach();
          this.removePairing();
          const error = update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined;
          if (error?.output?.statusCode === 401) {
            this.state = 'logged-out';
            this.log('connection.logged-out');
          } else this.scheduleReconnect();
          return;
        }
        if (update.qr) {
          this.state = 'pairing';
          await this.pairing(update.qr, this.directory);
        }
        if (update.connection === 'open') {
          this.state = 'connected';
          this.attempt = 0;
          this.removePairing();
          this.log('connection.open');
        }
      });
      this.on(socket, 'contacts.upsert', (contacts) => this.cache.contacts(contacts));
      this.on(socket, 'contacts.update', (contacts) => this.cache.contacts(contacts));
      this.on(socket, 'groups.upsert', (groups) => this.cache.groups(groups));
      this.on(socket, 'groups.update', (groups) => this.cache.groups(groups));
      this.on(socket, 'messages.upsert', ({ messages, type }) => this.append(messages, type, socket));
      this.on(socket, 'messaging-history.set', ({ contacts, chats, messages }) => {
        this.cache.contacts(contacts);
        this.cache.groups(chats.filter((chat) => chat.id.endsWith('@g.us'))
          .map((chat) => ({ id: chat.id, ...(chat.name == null ? {} : { subject: chat.name }) })));
        this.append(messages, 'append', socket);
      });
    } catch {
      this.detach();
      this.log('connection.failed');
      this.scheduleReconnect();
    }
  }

  private on<K extends ListenerEvent>(
    socket: ListenerSocket, event: K, handler: (data: BaileysEventMap[K]) => void | Promise<void>,
  ): void {
    const callback = (data: BaileysEventMap[K]): void => {
      if (!this.running || this.socket !== socket) return;
      this.events = this.events.then(async () => {
        if (this.socket === socket) await handler(data);
      }).catch(() => this.log(`${event}.failed`));
    };
    socket.ev.on(event, callback);
    this.removeListeners.push(() => socket.ev.off(event, callback));
  }

  private append(messages: WAMessage[], type: 'notify' | 'append', socket: ListenerSocket): void {
    for (const message of messages) {
      try {
        const record = mapMessage(message, type, this.cache, socket.user?.id);
        if (record) { this.store.append(record); this.recorded++; }
      } catch { this.log('message.append.failed'); }
    }
  }

  private scheduleReconnect(): void {
    if (!this.running || this.retry) return;
    this.state = 'reconnecting';
    const delayMs = Math.min(this.options.backoffMaxMs ?? 60000,
      (this.options.backoffBaseMs ?? 1000) * 2 ** Math.min(this.attempt, 30));
    this.attempt++;
    this.log('connection.retry', { attempt: this.attempt, delayMs });
    this.retry = setTimeout(() => {
      this.retry = undefined;
      this.pendingConnection = this.connect();
    }, delayMs);
  }
}
