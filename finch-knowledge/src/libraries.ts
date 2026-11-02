import { createHash } from 'node:crypto';
import { basename, isAbsolute, resolve } from 'node:path';

export interface LibraryRecord { id: string; root: string; name: string }
interface LibraryRegistryData { version: 1; libraries: LibraryRecord[] }
export const LIBRARIES_STORAGE_KEY = 'sourceLibraries';

/** Registry metadata only. No filesystem access or changes to source directories. */
export class LibraryRegistry {
  private records: LibraryRecord[] = [];
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly read: () => Promise<unknown>, private readonly save: (data: LibraryRegistryData) => Promise<void>) {}

  private record(root: string, name?: string): LibraryRecord {
    if (!root || !isAbsolute(root)) throw new Error('Choose an absolute library directory.');
    root = resolve(root);
    const key = process.platform === 'win32' ? root.toLowerCase() : root;
    const id = createHash('sha256').update(key).digest('hex').slice(0, 24);
    return { id, root, name: name ?? (basename(root) || root) };
  }

  list(): LibraryRecord[] { return this.records.map(record => ({ ...record })); }
  forRoot(root: string): LibraryRecord | undefined {
    const id = root ? this.record(root).id : undefined;
    const record = this.records.find(item => item.id === id);
    return record ? { ...record } : undefined;
  }
  find(id: string): LibraryRecord {
    const record = this.records.find(record => record.id === id);
    if (!record) throw new Error('Library is no longer registered.');
    return { ...record };
  }

  async load(currentRoot?: string): Promise<void> {
    const stored = await this.read();
    const data = stored as Partial<LibraryRegistryData> | null;
    const records: LibraryRecord[] = [];
    if (data?.version === 1 && Array.isArray(data.libraries)) {
      for (const value of data.libraries) {
        if (!value || typeof value.root !== 'string' || !isAbsolute(value.root)) continue;
        const name = typeof value.name === 'string' ? value.name.trim() : '';
        const record = this.record(value.root, name && name.length <= 60 ? name : undefined);
        if (!records.some(item => item.id === record.id)) records.push(record);
      }
    }
    this.records = records;
    // Preserve the previous single-directory selection, even if its drive is offline.
    if (currentRoot && isAbsolute(currentRoot)) await this.add(currentRoot);
  }

  private update<T>(change: (records: LibraryRecord[]) => T): Promise<T> {
    const next = this.tail.then(async () => {
      const records = this.list();
      const result = change(records);
      await this.save({ version: 1, libraries: records });
      this.records = records;
      return result;
    });
    this.tail = next.catch(() => {});
    return next;
  }

  add(root: string): Promise<LibraryRecord> {
    const record = this.record(root);
    return this.update(records => {
      const existing = records.find(item => item.id === record.id);
      if (existing) return { ...existing };
      records.push(record);
      return { ...record };
    });
  }

}
