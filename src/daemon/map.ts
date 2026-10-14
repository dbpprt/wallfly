import type { BaileysEventMap, proto, WAMessage } from '@whiskeysockets/baileys';
import type { MessageRecord } from '../store/index.js';
import { NameCache, normalizedJid } from './cache.js';

// Pinned Baileys/WAProto enum values; keep transport loading lazy for offline readers.
const REVOKE = 0;
const MESSAGE_EDIT = 14;
const REVOKE_STUB = 1;

export function contentOf(message: proto.IMessage): proto.IMessage {
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
  if (!key.remoteJid || key.remoteJid === 'status@broadcast' || !key.id) return null;
  if (!message.message && message.messageStubType !== REVOKE_STUB) return null;
  const chatJid = normalizedJid(key.remoteJid);
  const group = chatJid.endsWith('@g.us');
  const sender = key.fromMe ? ownJid : (key.participant ?? (group ? undefined : chatJid));
  if (!sender) return null;
  const senderJid = normalizedJid(sender);
  const timestamp = message.messageTimestamp;
  const seconds = typeof timestamp === 'number' ? timestamp : timestamp?.toNumber();
  const ts = seconds === undefined || seconds === null ? receivedAt : seconds * 1000;
  if (!Number.isSafeInteger(ts) || ts < 0) return null;
  let content = contentOf(message.message ?? {});
  let editedWrapper = false;
  for (let depth = 0; depth < 10 && content.editedMessage?.message; depth++) {
    editedWrapper = true;
    content = contentOf(content.editedMessage.message);
  }
  const protocol = content.protocolMessage;
  const revoke = protocol?.type === REVOKE || message.messageStubType === REVOKE_STUB;
  const edit = protocol?.type === MESSAGE_EDIT || editedWrapper;
  const reconciliation = revoke ? 'revoke' : edit ? 'edit' : undefined;
  const targetMessageId = protocol ? protocol.key?.id : key.id;
  // A protocol target must belong to the envelope's chat. Context metadata alone is not an edit.
  if (reconciliation && (!targetMessageId || (protocol?.key?.remoteJid
    && normalizedJid(protocol.key.remoteJid) !== chatJid))) return null;
  if (edit) {
    const edited = protocol ? protocol.editedMessage : content;
    if (!edited) return null;
    content = contentOf(edited);
  }
  const media = content.imageMessage ? ['image', content.imageMessage.caption ?? '']
    : content.videoMessage ? ['video', content.videoMessage.caption ?? '']
      : content.documentMessage ? ['document', content.documentMessage.caption ?? '']
        : content.audioMessage ? ['audio', ''] : content.stickerMessage ? ['sticker', ''] : null;
  // Protocol-only updates are not chat messages; do not archive empty control records.
  const text = content.conversation ?? content.extendedTextMessage?.text;
  if (!revoke && !media && text == null && !content.contactMessage && !content.contactsArrayMessage
    && !content.locationMessage && !content.liveLocationMessage && !content.reactionMessage
    && !content.pollCreationMessage && !content.pollCreationMessageV2 && !content.pollCreationMessageV3) return null;
  // Updates expose edit timestamps rounded to seconds. Use the same clock in protocol upserts.
  const editMs = protocol?.timestampMs;
  const editTime = typeof editMs === 'number' ? editMs : editMs?.toNumber();
  const eventTs = edit && editTime != null ? Math.floor(editTime / 1000) * 1000 : ts;
  if (!Number.isSafeInteger(eventTs) || eventTs < 0) return null;
  const fields = {
    ts: eventTs, receivedAt, chatJid, chatName: cache.observedName(chatJid), chatType: group ? 'group' as const : 'dm' as const,
    fromMe: key.fromMe ?? false, senderJid, senderName: cache.observedName(senderJid),
    pushName: message.pushName ?? null, body: revoke ? '' : text ?? media?.[1] ?? '',
    mediaType: revoke ? null : media?.[0] ?? null, messageId: key.id, syncType,
  };
  return reconciliation ? { ...fields, v: 2, reconciliation, targetMessageId: targetMessageId! }
    : { ...fields, v: 2 };
}

/** Baileys also emits updates, and may fold them into upserts while buffering. */
export function mapMessageUpdate(update: BaileysEventMap['messages.update'][number], cache: NameCache,
  ownJid: string | undefined): MessageRecord | null {
  const { key, update: changes } = update;
  if (changes.messageStubType === REVOKE_STUB) {
    return mapMessage({ ...changes, key: changes.key ?? key,
      message: { protocolMessage: { type: REVOKE, key } } }, 'notify', cache, ownJid);
  }
  if (!changes.message) return null;
  const record = mapMessage({ ...changes, key, message: changes.message }, 'notify', cache, ownJid);
  return record?.reconciliation !== undefined ? record : null;
}
