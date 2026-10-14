import type { IncomingMessage, ServerResponse } from 'node:http';
import { SendError } from './index.js';

/** Bounded JSON input; text/form browser requests cannot trigger sends. */
export async function handleSendRequest(
  request: IncomingMessage, response: ServerResponse,
  send: (value: unknown) => Promise<{ messageId: string | null }>,
): Promise<void> {
  try {
    if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      throw new SendError(415, 'POST /send requires application/json.');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      const bytes = Buffer.from(chunk as Uint8Array);
      size += bytes.length;
      if (size > 1024 * 1024) throw new SendError(413, 'Send request exceeds 1 MiB.');
      chunks.push(bytes);
    }
    let value: unknown;
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new SendError(400, 'Invalid JSON.'); }
    response.end(JSON.stringify(await send(value)));
  } catch (error) {
    response.statusCode = error instanceof SendError ? error.status : 500;
    response.end(JSON.stringify({ error: error instanceof SendError ? error.message : 'Send request failed.' }));
    request.resume();
  }
}
