import { NameCache, normalizedJid } from '../daemon/cache.js';
import type { MessageRecord } from '../store/index.js';

/** Resolve current labels for display without changing append-only archive facts. */
export function displayRecord(cache: NameCache, record: MessageRecord): MessageRecord & {
  manual?: true; chatManual?: true; senderManual?: true;
} {
  const peer = !record.fromMe && cache.lidMap.aliases(record.chatJid).includes(normalizedJid(record.senderJid));
  const chat = cache.display(record.chatJid, peer ? record.pushName : null, record.chatName);
  const sender = cache.display(record.senderJid, record.pushName, record.senderName);
  return { ...record, chatName: chat.name, senderName: sender.name,
    ...(chat.manual || sender.manual ? { manual: true } : {}),
    ...(chat.manual ? { chatManual: true } : {}), ...(sender.manual ? { senderManual: true } : {}) };
}
