import type { BaileysEventMap, WAVersion } from '@whiskeysockets/baileys';
import { privateDirectory, secureAuthFiles } from './files.js';
import { bindSendTransport } from '../send/index.js';
import type { SendTransport } from '../send/index.js';

export type ListenerEvent = 'connection.update' | 'creds.update' | 'messages.upsert'
  | 'contacts.upsert' | 'contacts.update' | 'groups.upsert' | 'groups.update' | 'messaging-history.set';

/** Event transport plus an opaque outgoing port, invoked only by src/send. */
export interface ListenerSocket {
  ev: {
    on<K extends ListenerEvent>(event: K, callback: (data: BaileysEventMap[K]) => void): void;
    off<K extends ListenerEvent>(event: K, callback: (data: BaileysEventMap[K]) => void): void;
  };
  readonly user: { id: string } | undefined;
  readonly outgoing: SendTransport;
  saveCredentials(): Promise<void>;
  end(error: Error | undefined): void;
}

export interface SocketOptions {
  authDirectory: string;
  markOnlineOnConnect: false;
  /** Skip version discovery, including its network request. */
  version?: WAVersion;
  log?: (event: string) => void;
}
export type SocketFactory = (options: SocketOptions) => Promise<ListenerSocket>;

type BaileysDependencies = Pick<typeof import('@whiskeysockets/baileys'),
  'makeWASocket' | 'useMultiFileAuthState' | 'fetchLatestBaileysVersion' | 'DEFAULT_CONNECTION_CONFIG'>;

let cachedVersion: WAVersion | undefined;
let pendingVersion: Promise<WAVersion> | undefined;

function logVersionFallback(options: SocketOptions): void {
  try {
    if (options.log) options.log('socket.version.fallback');
    else process.stderr.write(JSON.stringify({ event: 'socket.version.fallback' }) + '\n');
  } catch { /* Logging must not prevent offline fallback. */ }
}

async function resolveVersion(options: SocketOptions, baileys: BaileysDependencies): Promise<WAVersion> {
  if (options.version) return options.version;
  if (cachedVersion) return cachedVersion;
  pendingVersion ??= (async () => {
    const { fetchLatestBaileysVersion, DEFAULT_CONNECTION_CONFIG } = baileys;
    try {
      const result = await fetchLatestBaileysVersion({ timeout: 10000 });
      // Baileys normally returns a fallback result instead of rejecting on fetch failure.
      if (!result.isLatest) throw new Error('Version discovery unavailable');
      cachedVersion = result.version;
    } catch {
      cachedVersion = DEFAULT_CONNECTION_CONFIG.version;
      logVersionFallback(options);
    }
    return cachedVersion;
  })();
  return pendingVersion;
}

/** Lazy import keeps module loading and mocked tests completely offline. */
export async function createBaileysSocket(options: SocketOptions,
  dependencies?: BaileysDependencies,
): Promise<ListenerSocket> {
  privateDirectory(options.authDirectory);
  secureAuthFiles(options.authDirectory);
  const baileys = dependencies ?? await import('@whiskeysockets/baileys');
  const { makeWASocket, useMultiFileAuthState } = baileys;
  const version = await resolveVersion(options, baileys);
  const { state, saveCreds } = await useMultiFileAuthState(options.authDirectory);
  secureAuthFiles(options.authDirectory);
  const originalSet = state.keys.set.bind(state.keys);
  state.keys.set = async (data) => {
    await originalSet(data);
    secureAuthFiles(options.authDirectory);
  };
  // Baileys' own debug logs may contain message/session data. Use only service lifecycle logs.
  const noop = (): void => {};
  const logger = { level: 'silent', child: () => logger,
    trace: noop, debug: noop, info: noop, warn: noop, error: noop };
  const socket = makeWASocket({ auth: state, logger, version, markOnlineOnConnect: options.markOnlineOnConnect,
    shouldIgnoreJid: (jid) => jid === 'status@broadcast',
    generateHighQualityLinkPreview: false });
  return {
    ev: socket.ev,
    outgoing: bindSendTransport(socket),
    get user() { return socket.user; },
    saveCredentials: async () => {
      await saveCreds();
      secureAuthFiles(options.authDirectory);
    },
    end: (error) => socket.end(error),
  };
}
