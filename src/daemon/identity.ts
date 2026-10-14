import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { privateDirectory, readPrivateFile, replacePrivateFile } from './files.js';

export function normalizedJid(jid: string): string {
  return jid.replace(/:\d+(?=@)/, '');
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Only observed pairs are retained; no phone-number guessing or network lookup. */
export class LidMap {
  readonly path: string;
  private readonly mappings = new Map<string, string>();
  private readonly reverse = new Map<string, Set<string>>();

  constructor(directory: string) {
    privateDirectory(directory);
    this.path = join(directory, 'lid-map.json');
    let raw: string;
    try { raw = readPrivateFile(this.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const data: unknown = JSON.parse(raw);
    if (!object(data) || data.v !== 1 || !object(data.mappings)) throw new Error('Invalid LID map.');
    for (const [lid, pn] of Object.entries(data.mappings)) {
      if (!lid.endsWith('@lid') || typeof pn !== 'string' || !pn.endsWith('@s.whatsapp.net')) {
        throw new Error('Invalid LID mapping.');
      }
      this.index(normalizedJid(lid), normalizedJid(pn));
    }
  }

  observe(first: string | null | undefined, second: string | null | undefined): void {
    if (!first || !second) return;
    const ids = [normalizedJid(first), normalizedJid(second)];
    const lid = ids.find((id) => id.endsWith('@lid'));
    const pn = ids.find((id) => id.endsWith('@s.whatsapp.net'));
    if (!lid || !pn || this.mappings.get(lid) === pn) return;
    const next = new Map(this.mappings).set(lid, pn);
    replacePrivateFile(this.path, JSON.stringify({ v: 1, mappings: Object.fromEntries(next) }) + '\n');
    this.index(lid, pn);
  }

  private index(lid: string, pn: string): void {
    const previous = this.mappings.get(lid);
    if (previous) this.reverse.get(previous)?.delete(lid);
    this.mappings.set(lid, pn);
    const lids = this.reverse.get(pn) ?? new Set<string>();
    lids.add(lid);
    this.reverse.set(pn, lids);
  }

  aliases(jid: string): string[] {
    const id = normalizedJid(jid);
    const pn = this.mappings.get(id) ?? id;
    return [...new Set([id, pn, ...(this.reverse.get(pn) ?? [])])];
  }

  phoneJid(jid: string): string | null {
    return this.aliases(jid).find((id) => id.endsWith('@s.whatsapp.net')) ?? null;
  }
}

/** Baileys multi-file auth stores forward and *_reverse records with bare user IDs. */
export function observeAuthMappings(records: unknown, observe: (lid: string, pn: string) => void): void {
  if (!object(records)) return;
  for (const [key, value] of Object.entries(records)) {
    if (typeof value !== 'string' || !value) continue;
    const reverse = key.endsWith('_reverse');
    const id = reverse ? key.slice(0, -8) : key;
    const lid = reverse ? value : id;
    const pn = reverse ? id : value;
    observe(lid.includes('@') ? lid : `${lid}@lid`, pn.includes('@') ? pn : `${pn}@s.whatsapp.net`);
  }
}

export function loadAuthMappings(directory: string, observe: (lid: string, pn: string) => void): void {
  for (const file of readdirSync(directory)) {
    if (!file.startsWith('lid-mapping-') || !file.endsWith('.json')) continue;
    const value: unknown = JSON.parse(readPrivateFile(join(directory, file)));
    observeAuthMappings({ [file.slice(12, -5)]: value }, observe);
  }
}
