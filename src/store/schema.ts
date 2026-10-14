/** Version 1 timestamps are nonnegative Unix milliseconds. Missing metadata is null. */
export interface MessageRecord {
  v: 1;
  ts: number;
  receivedAt: number;
  chatJid: string;
  chatName: string | null;
  chatType: 'dm' | 'group';
  fromMe: boolean;
  senderJid: string;
  senderName: string | null;
  pushName: string | null;
  body: string;
  mediaType: string | null;
  messageId: string;
}

const nullableString = (value: unknown): boolean => value === null || typeof value === 'string';
const timestamp = (value: unknown): boolean =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const identifier = (value: unknown): boolean => typeof value === 'string' && value.length > 0;

/** Plain type guard: all v1 fields are required; unknown versions are rejected. */
export function validateRecord(value: unknown): value is MessageRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.v === 1 && timestamp(record.ts) && timestamp(record.receivedAt)
    && identifier(record.chatJid) && nullableString(record.chatName)
    && (record.chatType === 'dm' || record.chatType === 'group')
    && typeof record.fromMe === 'boolean' && identifier(record.senderJid)
    && nullableString(record.senderName) && nullableString(record.pushName)
    && typeof record.body === 'string' && nullableString(record.mediaType)
    && identifier(record.messageId);
}
