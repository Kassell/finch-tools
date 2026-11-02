import { lstat, mkdir, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ACCEPTED, DEFAULT_TAG, KnowledgeStore, MAX_FILE_BYTES } from './store.js';
import { IndexSkipError, type IndexSkipReason } from './indexing-result.js';
import { inspectSourceFilesystem, remoteIndexKey, remoteIndexRoot, type SourceFilesystem } from './index-location.js';

export const INDEX_DIRECTORY = '.knowledge';
export interface ScanOutcome {
  updated: string[]; removed: string[]; unchanged: number; unreachable: string[];
  failed: Array<{ name: string; reason: string }>;
  skipped: Array<{ name: string; reason: IndexSkipReason }>;
  moved: string[];
}
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/** Sources must stay below the selected directory and outside private/nested index folders. */
export async function assertSourcePath(root: string, input: string): Promise<string> {
  const path = resolve(root, input);
  if (!inside(root, path) || relative(root, path).split(sep).some(part => part.toLowerCase() === INDEX_DIRECTORY)) throw new Error('Source must be inside the selected knowledge directory, outside .knowledge.');
  let cursor = root;
  for (const part of relative(root, path).split(sep)) {
    cursor = join(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Choose a regular file, not a symbolic link.');
  }
  if (!inside(await realpath(root), await realpath(path))) throw new Error('Source is outside the selected knowledge directory.');
  return path;
}

/** Existing content and empty directories are both valid; no source file is copied or moved. */
export async function openSourceDirectory(input: string, cachePath: string, options: { requireEngine?: (extension: string) => Promise<void>; progress?: (message: string) => void; onStatusChange?: (path: string, phase: 'processing' | 'settled') => void; sourceFilesystem?: (root: string) => Promise<SourceFilesystem> } = {}): Promise<KnowledgeStore> {
  if (!isAbsolute(input)) throw new Error('Choose an absolute library directory.');
  const root = await realpath(input);
  if (!(await stat(root)).isDirectory()) throw new Error('Choose a directory, not a file.');
  if (basename(root) === INDEX_DIRECTORY) throw new Error('Select the source directory, not .knowledge itself.');
  const filesystem = await (options.sourceFilesystem ?? inspectSourceFilesystem)(root);
  let index = join(root, INDEX_DIRECTORY);
  let indexKey: string | undefined;
  let engineCache = cachePath;
  if (filesystem.network) {
    const cache = await realpath(cachePath);
    engineCache = cache;
    if (inside(root, cache) || (await inspectSourceFilesystem(cache)).network) throw new Error('Network libraries require a local Finch cache directory.');
    indexKey = remoteIndexKey(filesystem.identity);
    index = remoteIndexRoot(cache, indexKey);
    for (const parent of [join(cache, 'remote')]) {
      const info = await lstat(parent).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
      if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error('Knowledge index data must not be a symbolic link.');
    }
  }
  const entry = await lstat(index).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
  if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) throw new Error('.knowledge must be a regular directory.');
  await mkdir(index, { recursive: true });
  for (const name of ['catalog.sqlite', 'catalog.sqlite-wal', 'catalog.sqlite-shm', 'vectors.lance']) {
    const data = await lstat(join(index, name)).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    if (data?.isSymbolicLink()) throw new Error('Knowledge index data must not be a symbolic link.');
  }
  const sourceGuard = filesystem.network ? async () => {
    const current = await (options.sourceFilesystem ?? inspectSourceFilesystem)(root);
    if (!current.network || current.identity !== filesystem.identity) throw new Error('The network source is disconnected or mapped to a different share. Reconnect the original share and retry.');
  } : undefined;
  return new KnowledgeStore(index, { ...options, cachePath: engineCache, directoryRoot: root, remoteIndexKey: indexKey, sourceGuard });
}

/** Incremental recursive reconciliation. Failed reads never become deletions. */
export async function scanSourceDirectory(store: KnowledgeStore, report?: (message: string, percent: number) => void, signal?: AbortSignal): Promise<ScanOutcome> {
  const root = store.directoryRoot;
  if (!root) throw new Error('No source directory selected.');
  const outcome: ScanOutcome = { updated: [], removed: [], unchanged: 0, unreachable: [], failed: [], skipped: [], moved: [] };
  // A still-existing local mountpoint is not evidence that its network share is connected.
  await store.assertSourceAvailable();
  // A root that went offline or changed mounts must not wipe the catalogue.
  const rootInfo = await stat(root);
  const documents = await store.list();
  const files: string[] = [];
  const seen = new Set<string>();
  const blocked: string[] = [];
  const inventoried = new Set<string>();
  async function walk(directory: string): Promise<void> {
    if (signal?.aborted) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { blocked.push(directory); outcome.unreachable.push(relative(root!, directory) || root!); return; }
    inventoried.add(directory);
    for (const entry of entries) {
      if (signal?.aborted) return;
      const path = join(directory, entry.name);
      if (entry.name === INDEX_DIRECTORY || entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink()) { blocked.push(path); continue; }
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        seen.add(path);
        if (ACCEPTED.includes(extname(path).toLowerCase())) files.push(path);
      }
    }
  }
  await walk(root);
  async function sourcePresence(path: string): Promise<'present' | 'missing' | 'unavailable'> {
    if (blocked.some(directory => inside(directory, path))) return 'unavailable';
    try { await lstat(path); return 'present'; }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return 'unavailable'; }
    const currentRoot = await stat(root).catch(() => null);
    if (!currentRoot?.isDirectory() || currentRoot.dev !== rootInfo.dev || currentRoot.ino !== rootInfo.ino) return 'unavailable';
    // A whole removed/moved subtree has missing parents too. Climb to an ancestor that this
    // scan actually listed, rather than treating every absent parent as an offline volume.
    let parent = dirname(path);
    while (inside(root, parent)) {
      if (blocked.some(directory => inside(directory, parent))) return 'unavailable';
      const info = await lstat(parent).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
        throw error;
      }).catch(() => undefined);
      if (info === undefined || info?.isSymbolicLink()) return 'unavailable';
      if (info?.isDirectory()) return inventoried.has(parent) ? 'missing' : 'unavailable';
      if (parent === root) break;
      parent = dirname(parent);
    }
    return 'unavailable';
  }
  const missing = new Map<string, (typeof documents)[number]>();
  for (const doc of documents) {
    if (signal?.aborted) return outcome;
    if (seen.has(doc.path)) continue;
    const presence = await sourcePresence(doc.path);
    if (presence === 'missing') missing.set(doc.id, doc);
    else if (presence === 'unavailable') outcome.unreachable.push(relative(root, doc.path));
  }
  for (const [index, path] of files.entries()) {
    if (signal?.aborted) return outcome;
    const name = relative(root, path);
    report?.(name, Math.floor(index / Math.max(files.length, 1) * 100));
    try {
      const candidates = [...missing.values()].filter(doc => basename(doc.path) === basename(path)).map(doc => doc.id);
      const moved = await store.relocateSource(path, candidates);
      if (moved) { missing.delete(moved); outcome.moved.push(name); }
      const indexed = await store.importFile(path, basename(path), DEFAULT_TAG);
      if (indexed.unchanged) outcome.unchanged++; else outcome.updated.push(name);
    } catch (error) {
      if (error instanceof IndexSkipError) outcome.skipped.push({ name, reason: error.reason });
      else outcome.failed.push({ name, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  await store.assertSourceAvailable();
  for (const doc of missing.values()) {
    if (signal?.aborted) return outcome;
    const presence = await sourcePresence(doc.path);
    const current = await store.document(doc.id);
    if (presence === 'missing' && current?.path === doc.path) {
      await store.remove(doc.id);
      outcome.removed.push(relative(root, doc.path));
    } else if (presence === 'unavailable') outcome.unreachable.push(relative(root, doc.path));
  }
  report?.('', 100);
  return outcome;
}
