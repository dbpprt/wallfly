import { join } from 'node:path';
import { lstatSync } from 'node:fs';
import { createBaileysSocket } from '../daemon/socket.js';
import type { SocketFactory, ListenerSocket } from '../daemon/socket.js';
import { SendError, SendService, validateRequest } from './index.js';
import type { SendOptions, SendRequest, SendAuditRecord } from './index.js';

/** Explicit, single send only; never pair, reconnect, retry, or run a listener. */
export async function directSend(value: SendRequest, options: SendOptions & { directory: string },
  signal: AbortSignal, factory: SocketFactory = createBaileysSocket,
): Promise<{ messageId: string | null; audit: SendAuditRecord }> {
  const request = validateRequest(value);
  const authDirectory = join(options.directory, 'auth');
  try {
    if (!lstatSync(join(authDirectory, 'creds.json')).isFile()) throw new Error();
  } catch { throw new SendError(503, 'Saved auth is required. Run wallfly pair first.'); }
  let socket: ListenerSocket | undefined;
  let sender: SendService | undefined;
  let available = false;
  let credentialFailure = false;
  let credentials = Promise.resolve();
  let finish: (connected: boolean) => void = () => {};
  const update = (event: { connection?: string; qr?: string }): void => {
    if (event.connection === 'open') { available = true; finish(true); }
    else if (event.connection === 'close' || event.qr) { available = false; finish(false); }
  };
  const save = (): void => {
    credentials = credentials.then(() => socket!.saveCredentials()).catch(() => {
      credentialFailure = true; available = false; finish(false);
    });
  };
  try {
    if (signal.aborted) throw new SendError(503, 'Direct send cancelled.');
    socket = await factory({ authDirectory, markOnlineOnConnect: false });
    const connected = await new Promise<boolean>((accept) => {
      finish = (value): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        accept(value);
      };
      const abort = (): void => finish(false);
      const timer = setTimeout(abort, 30000);
      socket!.ev.on('connection.update', update);
      socket!.ev.on('creds.update', save);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    await credentials;
    if (!connected || credentialFailure) throw new SendError(503, 'Direct connection unavailable; run wallfly pair if needed.');
    sender = new SendService(options, () => available && !credentialFailure && !signal.aborted ? socket?.outgoing : undefined);
    return await sender.sendWithAudit(request);
  } finally {
    await sender?.flush();
    socket?.ev.off('connection.update', update);
    socket?.ev.off('creds.update', save);
    await credentials;
    socket?.end(undefined);
  }
}
