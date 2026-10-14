import type { BaileysEventMap } from '@whiskeysockets/baileys';
import { privateDirectory, secureAuthFiles } from './files.js';

export type ListenerEvent = 'connection.update' | 'creds.update' | 'messages.upsert'
  | 'contacts.upsert' | 'contacts.update' | 'groups.upsert' | 'groups.update' | 'messaging-history.set';

/** Deliberately narrow transport port: no outgoing message or chat mutation APIs. */
export interface ListenerSocket {
  ev: {
    on<K extends ListenerEvent>(event: K, callback: (data: BaileysEventMap[K]) => void): void;
    off<K extends ListenerEvent>(event: K, callback: (data: BaileysEventMap[K]) => void): void;
  };
  readonly user: { id: string } | undefined;
  saveCredentials(): Promise<void>;
  end(error: Error | undefined): void;
}

export interface SocketOptions {
  authDirectory: string;
  markOnlineOnConnect: false;
}
export type SocketFactory = (options: SocketOptions) => Promise<ListenerSocket>;

/** Lazy import keeps module loading and mocked tests completely offline. */
export const createBaileysSocket: SocketFactory = async (options) => {
  privateDirectory(options.authDirectory);
  secureAuthFiles(options.authDirectory);
  const { makeWASocket, useMultiFileAuthState } = await import('@whiskeysockets/baileys');
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
  const socket = makeWASocket({ auth: state, logger, markOnlineOnConnect: options.markOnlineOnConnect,
    shouldIgnoreJid: (jid) => jid === 'status@broadcast',
    generateHighQualityLinkPreview: false });
  return {
    ev: socket.ev,
    get user() { return socket.user; },
    saveCredentials: async () => {
      await saveCreds();
      secureAuthFiles(options.authDirectory);
    },
    end: (error) => socket.end(error),
  };
};
