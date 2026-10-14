/** Version 1/2 timestamps are nonnegative Unix milliseconds. Missing metadata is null. */
export interface MessageRecord {
  v: 1 | 2;
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
  /** Relative to the wallfly directory; present only on v2 archived media. */
  mediaPath?: string;
  /** Added by the listener; older v1 records omit this field. */
  syncType?: 'notify' | 'append';
}

const nullableString = (value: unknown): boolean => value === null || typeof value === 'string';
const timestamp = (value: unknown): boolean =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const identifier = (value: unknown): boolean => typeof value === 'string' && value.length > 0;

/** Only generated relative paths are accepted; no traversal or platform separators. */
export function validateMediaPath(value: unknown): value is string {
  return typeof value === 'string'
    && /^media\/\d{4}-(?:0[1-9]|1[0-2])\/[A-Za-z0-9_-]{1,160}-[a-z0-9]{1,10}$/.test(value);
}

/** Required fields shared by v1/v2; unknown versions are rejected. */
export function validateRecord(value: unknown): value is MessageRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (record.v === 1 || record.v === 2) && timestamp(record.ts) && timestamp(record.receivedAt)
    && identifier(record.chatJid) && nullableString(record.chatName)
    && (record.chatType === 'dm' || record.chatType === 'group')
    && typeof record.fromMe === 'boolean' && identifier(record.senderJid)
    && nullableString(record.senderName) && nullableString(record.pushName)
    && typeof record.body === 'string' && nullableString(record.mediaType)
    && identifier(record.messageId)
    && (record.mediaPath === undefined || (record.v === 2 && validateMediaPath(record.mediaPath)))
    && (record.syncType === undefined || record.syncType === 'notify' || record.syncType === 'append');
}
