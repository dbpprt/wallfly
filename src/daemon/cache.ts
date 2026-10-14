import { join } from 'node:path';
import type { Contact, GroupMetadata, WAMessage } from '@whiskeysockets/baileys';
import { privateDirectory, readPrivateFile, replacePrivateFile } from './files.js';
import { LidMap, normalizedJid } from './identity.js';

export { normalizedJid } from './identity.js';
export interface CachedParticipant {
  jid: string;
  lid: string | null;
  rank: 'member' | 'admin' | 'superadmin';
}
interface Pushname { name: string; ts: number }
export interface Identity {
  jid: string;
  aliases: string[];
  name: string | null;
  phone: string | null;
  phoneJid: string | null;
  pushname: string | null;
  pushnameTs: number | null;
  groups: { jid: string; name: string | null; rank: CachedParticipant['rank'] }[];
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Versioned identity facts only, never complete transport objects or address books. */
export class NameCache {
  readonly path: string;
  readonly lidMap: LidMap;
  private readonly names = new Map<string, string>();
  private readonly pushnames = new Map<string, Pushname>();
  private readonly participants = new Map<string, CachedParticipant[]>();

  constructor(directory: string) {
    privateDirectory(directory);
    this.path = join(directory, 'contacts.json');
    this.lidMap = new LidMap(directory);
    let raw: string;
    try { raw = readPrivateFile(this.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const data: unknown = JSON.parse(raw);
    if (!object(data) || (data.v !== 1 && data.v !== 2) || !object(data.names)) {
      throw new Error('Invalid name cache.');
    }
    for (const [jid, name] of Object.entries(data.names)) {
      if (!jid || typeof name !== 'string') throw new Error('Invalid name cache entry.');
      this.names.set(normalizedJid(jid), name);
    }
    if (data.v === 1) return;
    if (!object(data.pushnames) || !object(data.participants)) throw new Error('Invalid identity cache.');
    for (const [jid, entry] of Object.entries(data.pushnames)) {
      if (!jid || !object(entry) || typeof entry.name !== 'string'
        || !Number.isSafeInteger(entry.ts) || (entry.ts as number) < 0) throw new Error('Invalid pushname.');
      this.pushnames.set(normalizedJid(jid), { name: entry.name, ts: entry.ts as number });
    }
    for (const [jid, entries] of Object.entries(data.participants)) {
      if (!jid.endsWith('@g.us') || !Array.isArray(entries)) throw new Error('Invalid group participants.');
      const members: CachedParticipant[] = [];
      for (const entry of entries as unknown[]) {
        if (!object(entry) || typeof entry.jid !== 'string' || !entry.jid
          || (entry.lid !== null && (typeof entry.lid !== 'string' || !entry.lid.endsWith('@lid')))
          || !['member', 'admin', 'superadmin'].includes(String(entry.rank))) throw new Error('Invalid participant.');
        members.push({ jid: normalizedJid(entry.jid), lid: entry.lid as string | null,
          rank: entry.rank as CachedParticipant['rank'] });
      }
      this.participants.set(normalizedJid(jid), members);
    }
  }

  private pushname(jid: string): Pushname | null {
    let latest: Pushname | null = null;
    for (const alias of this.lidMap.aliases(jid)) {
      const entry = this.pushnames.get(alias);
      if (entry && (!latest || entry.ts >= latest.ts)) latest = entry;
    }
    return latest;
  }

  get(jid: string): string | null {
    for (const alias of this.lidMap.aliases(jid)) {
      const name = this.names.get(alias);
      if (name) return name;
    }
    return this.pushname(jid)?.name ?? null;
  }

  identity(jid: string): Identity {
    const id = normalizedJid(jid);
    const aliases = this.lidMap.aliases(id);
    const phoneJid = this.lidMap.phoneJid(id);
    const pushname = this.pushname(id);
    const groups: Identity['groups'] = [];
    for (const [group, members] of this.participants) {
      const member = members.find((entry) => aliases.includes(entry.jid) || (entry.lid !== null && aliases.includes(entry.lid)));
      if (member) groups.push({ jid: group, name: this.get(group), rank: member.rank });
    }
    return { jid: id, aliases, name: this.get(id), phoneJid,
      phone: phoneJid ? `+${phoneJid.slice(0, -15)}` : null,
      pushname: pushname?.name ?? null, pushnameTs: pushname?.ts ?? null, groups };
  }

  knownGroups(): string[] {
    return [...new Set([...this.names.keys(), ...this.participants.keys()].filter((jid) => jid.endsWith('@g.us')))];
  }

  contacts(contacts: Partial<Contact>[]): void {
    for (const contact of contacts) {
      this.lidMap.observe(contact.lid ?? contact.id, contact.jid ?? contact.id);
      const name = contact.name ?? contact.verifiedName;
      for (const id of [contact.id, contact.jid, contact.lid]) {
        if (id && id !== 'status@broadcast' && name !== undefined) this.names.set(normalizedJid(id), name);
        // Contact history has no name timestamp. Treat notify as a fallback,
        // so it cannot override a pushname harvested from a dated message.
        if (id && id !== 'status@broadcast' && contact.notify !== undefined && !this.pushnames.has(normalizedJid(id))) {
          this.pushnames.set(normalizedJid(id), { name: contact.notify, ts: 0 });
        }
      }
    }
    this.save();
  }

  groups(groups: Partial<GroupMetadata>[]): void {
    for (const group of groups) {
      if (!group.id?.endsWith('@g.us')) continue;
      const id = normalizedJid(group.id);
      if (group.subject !== undefined) this.names.set(id, group.subject);
      if (!this.participants.has(id)) this.participants.set(id, []);
      if (group.participants !== undefined) {
        const members = new Map<string, CachedParticipant>();
        for (const participant of group.participants) {
          this.lidMap.observe(participant.lid ?? participant.id, participant.jid ?? participant.id);
          const jid = normalizedJid(participant.jid || participant.id);
          const lid = participant.lid || (participant.id.endsWith('@lid') ? participant.id : null);
          members.set(lid ? normalizedJid(lid) : jid, { jid, lid: lid ? normalizedJid(lid) : null,
            rank: participant.admin ?? (participant.isSuperAdmin ? 'superadmin' : participant.isAdmin ? 'admin' : 'member') });
        }
        this.participants.set(id, [...members.values()]);
      }
    }
    this.save();
  }

  /** Harvest before archive deduplication: even a replay/control message can reveal identity. */
  message(message: WAMessage, ownJid?: string, receivedAt = Date.now()): void {
    const { key } = message;
    if (!key.remoteJid || key.remoteJid === 'status@broadcast') return;
    const group = key.remoteJid.endsWith('@g.us');
    this.lidMap.observe(key.senderLid, key.senderPn);
    this.lidMap.observe(key.participantLid, key.participantPn);
    const sender = key.fromMe ? ownJid ?? key.participant ?? key.senderPn ?? key.senderLid
      : key.participant ?? (group ? key.participantLid ?? key.participantPn ?? key.senderLid ?? key.senderPn : key.remoteJid);
    if (!sender) return;
    // A from-me DM's sender fields describe the owner, never the recipient.
    const pn = key.participantPn ?? key.senderPn;
    const lid = key.participantLid ?? key.senderLid;
    this.lidMap.observe(sender, pn);
    this.lidMap.observe(sender, lid);
    if (!message.pushName) return;
    const timestamp = message.messageTimestamp;
    const seconds = typeof timestamp === 'number' ? timestamp : timestamp?.toNumber();
    const ts = seconds == null ? receivedAt : seconds * 1000;
    if (!Number.isSafeInteger(ts) || ts < 0) return;
    for (const id of this.lidMap.aliases(sender)) {
      const previous = this.pushnames.get(id);
      if (!previous || ts >= previous.ts) this.pushnames.set(id, { name: message.pushName, ts });
    }
    this.save();
  }

  private save(): void {
    const data = JSON.stringify({ v: 2, names: Object.fromEntries(this.names),
      pushnames: Object.fromEntries(this.pushnames), participants: Object.fromEntries(this.participants) }) + '\n';
    // Avoid rewriting identical contact/group replays.
    try { if (readPrivateFile(this.path) === data) return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    replacePrivateFile(this.path, data);
  }
}
