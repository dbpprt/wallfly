import type { proto, WAMessage } from '@whiskeysockets/baileys';
import type { MessageRecord } from '../store/index.js';
import { NameCache, normalizedJid } from './cache.js';

function contentOf(message: proto.IMessage): proto.IMessage {
  let content = message;
  for (let depth = 0; depth < 10; depth++) {
    const nested = content.ephemeralMessage?.message ?? content.viewOnceMessage?.message
      ?? content.viewOnceMessageV2?.message ?? content.viewOnceMessageV2Extension?.message
      ?? content.documentWithCaptionMessage?.message;
    if (!nested) break;
    content = nested;
  }
  return content;
}

export function mapMessage(
  message: WAMessage, syncType: 'notify' | 'append', cache: NameCache,
  ownJid: string | undefined, receivedAt = Date.now(),
): MessageRecord | null {
  const { key } = message;
  if (!key.remoteJid || key.remoteJid === 'status@broadcast' || !key.id || !message.message) return null;
  const chatJid = normalizedJid(key.remoteJid);
  const group = chatJid.endsWith('@g.us');
  const sender = key.fromMe ? ownJid : (key.participant ?? (group ? undefined : chatJid));
  if (!sender) return null;
  const senderJid = normalizedJid(sender);
  const timestamp = message.messageTimestamp;
  const seconds = typeof timestamp === 'number' ? timestamp : timestamp?.toNumber();
  const ts = seconds === undefined || seconds === null ? receivedAt : seconds * 1000;
  if (!Number.isSafeInteger(ts) || ts < 0) return null;
  const content = contentOf(message.message);
  const media = content.imageMessage ? ['image', content.imageMessage.caption ?? '']
    : content.videoMessage ? ['video', content.videoMessage.caption ?? '']
      : content.documentMessage ? ['document', content.documentMessage.caption ?? '']
        : content.audioMessage ? ['audio', ''] : content.stickerMessage ? ['sticker', ''] : null;
  // Protocol-only updates are not chat messages; do not archive empty control records.
  const text = content.conversation ?? content.extendedTextMessage?.text;
  if (!media && text === undefined && !content.contactMessage && !content.contactsArrayMessage
    && !content.locationMessage && !content.liveLocationMessage && !content.reactionMessage
    && !content.pollCreationMessage && !content.pollCreationMessageV2 && !content.pollCreationMessageV3) return null;
  return {
    v: 1, ts, receivedAt, chatJid, chatName: cache.observedName(chatJid), chatType: group ? 'group' : 'dm',
    fromMe: key.fromMe ?? false, senderJid, senderName: cache.observedName(senderJid),
    pushName: message.pushName ?? null, body: text ?? media?.[1] ?? '',
    mediaType: media?.[0] ?? null, messageId: key.id, syncType,
  };
}
