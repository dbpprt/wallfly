import { join } from 'node:path';
import type { Contact, GroupMetadata } from '@whiskeysockets/baileys';
import { privateDirectory, readPrivateFile, replacePrivateFile } from './files.js';

export function normalizedJid(jid: string): string {
  return jid.replace(/:\d+(?=@)/, '');
}

/** Only identifiers and display names are cached, never complete transport objects. */
export class NameCache {
  readonly path: string;
  private readonly names = new Map<string, string>();

  constructor(directory: string) {
    privateDirectory(directory);
    this.path = join(directory, 'contacts.json');
    let raw: string;
    try {
      raw = readPrivateFile(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const saved: unknown = JSON.parse(raw);
    if (typeof saved !== 'object' || saved === null || Array.isArray(saved)) {
      throw new Error('Invalid name cache.');
    }
    const data = saved as { v?: unknown; names?: unknown };
    if (data.v !== 1 || typeof data.names !== 'object' || data.names === null || Array.isArray(data.names)) {
      throw new Error('Invalid name cache.');
    }
    for (const [jid, name] of Object.entries(data.names)) {
      if (!jid || typeof name !== 'string') throw new Error('Invalid name cache entry.');
      this.names.set(normalizedJid(jid), name);
    }
  }

  get(jid: string): string | null {
    return this.names.get(normalizedJid(jid)) ?? null;
  }

  contacts(contacts: Partial<Contact>[]): void {
    this.update(contacts.map((contact) => ({ id: contact.id,
      name: contact.name ?? contact.notify ?? contact.verifiedName })));
  }

  groups(groups: Partial<GroupMetadata>[]): void {
    this.update(groups.map((group) => ({ id: group.id, name: group.subject })));
  }

  private update(entries: { id: string | undefined; name: string | undefined }[]): void {
    const next = new Map(this.names);
    for (const { id, name } of entries) {
      if (id && id !== 'status@broadcast' && name !== undefined) next.set(normalizedJid(id), name);
    }
    if (next.size === this.names.size && [...next].every(([id, name]) => this.names.get(id) === name)) return;
    replacePrivateFile(this.path, JSON.stringify({ v: 1, names: Object.fromEntries(next) }) + '\n');
    this.names.clear();
    for (const [id, name] of next) this.names.set(id, name);
  }
}
