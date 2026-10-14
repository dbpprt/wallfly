import { checkFilters, matchesRecord } from './index.js';
import type { Filters, JsonlStore, StoreEntry, StoreIterator } from './index.js';
import type { ArchivedMessage, MessageRecord, ReconciliationRecord } from './schema.js';

function key(chatJid: string, messageId: string): string {
  return JSON.stringify([chatJid, messageId]);
}

/** In-memory projection only. A revoke is terminal; later edits cannot restore text. */
export class ReconciliationView {
  private readonly messages = new Map<string, ArchivedMessage>();
  private readonly changes = new Map<string, ReconciliationRecord>();

  add(record: MessageRecord): ArchivedMessage | null {
    const id = key(record.chatJid, record.reconciliation === undefined ? record.messageId : record.targetMessageId);
    if (record.reconciliation === undefined) this.messages.set(id, record);
    else if (this.changes.get(id)?.reconciliation !== 'revoke') this.changes.set(id, record);
    const original = this.messages.get(id);
    return original ? this.apply(original) : null;
  }

  apply(record: ArchivedMessage): ArchivedMessage {
    const change = this.changes.get(key(record.chatJid, record.messageId));
    if (!change) return record;
    if (change.reconciliation === 'edit') return { ...record, body: `${change.body} [edited]` };
    const deleted = { ...record, body: '[deleted]', mediaType: null };
    delete deleted.mediaPath;
    return deleted;
  }
}

/** Apply the complete retained snapshot before filtering, including later updates. */
export function queryRecords(store: JsonlStore, filters: Filters = {}, raw = false,
  view = new ReconciliationView()): StoreIterator {
  if (raw) return store.iterate({ filters });
  // Validate filters through the store, but do not filter away reconciliation events.
  checkFilters(filters);
  const archive = store.iterate();
  const records = function* (): Generator<StoreEntry> {
    const originals: StoreEntry[] = [];
    for (const entry of archive) {
      view.add(entry.record);
      if (entry.record.reconciliation === undefined) originals.push(entry);
    }
    for (const entry of originals) {
      if (entry.record.reconciliation !== undefined) continue;
      const record = view.apply(entry.record);
      if (matchesRecord(record, filters)) yield { ...entry, record };
    }
  };
  return Object.assign(records(), { stats: archive.stats });
}
