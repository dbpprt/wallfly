/** Archive timestamps are nonnegative Unix milliseconds. Missing metadata is null. */
interface RecordFields {
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

export interface ArchivedMessage extends RecordFields {
  v: 1 | 2;
  reconciliation?: never;
  targetMessageId?: never;
}

/** A new archive event; messageId identifies the event, targetMessageId its subject. */
export interface ReconciliationRecord extends RecordFields {
  v: 2;
  reconciliation: 'edit' | 'revoke';
  targetMessageId: string;
}

export type MessageRecord = ArchivedMessage | ReconciliationRecord;

const nullableString = (value: unknown): boolean => value === null || typeof value === 'string';
const timestamp = (value: unknown): boolean =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const identifier = (value: unknown): boolean => typeof value === 'string' && value.length > 0;

/** Only generated relative paths are accepted; no traversal or platform separators. */
export function validateMediaPath(value: unknown): value is string {
  return typeof value === 'string'
    && /^media\/\d{4}-(?:0[1-9]|1[0-2])\/[A-Za-z0-9_-]{1,160}-[a-z0-9]{1,10}$/.test(value);
}

/** Read v1 messages and shared v2 media/reconciliation records. */
export function validateRecord(value: unknown): value is MessageRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const reconciliation = record.reconciliation === undefined
    ? record.targetMessageId === undefined
    : record.v === 2 && (record.reconciliation === 'edit' || record.reconciliation === 'revoke')
      && identifier(record.targetMessageId)
      && (record.reconciliation !== 'revoke' || record.body === '');
  return reconciliation && (record.v === 1 || record.v === 2) && timestamp(record.ts) && timestamp(record.receivedAt)
    && identifier(record.chatJid) && nullableString(record.chatName)
    && (record.chatType === 'dm' || record.chatType === 'group')
    && typeof record.fromMe === 'boolean' && identifier(record.senderJid)
    && nullableString(record.senderName) && nullableString(record.pushName)
    && typeof record.body === 'string' && nullableString(record.mediaType)
    && identifier(record.messageId)
    && (record.mediaPath === undefined || (record.v === 2 && validateMediaPath(record.mediaPath)))
    && (record.syncType === undefined || record.syncType === 'notify' || record.syncType === 'append');
}
