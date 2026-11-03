import { lstat, mkdir, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ACCEPTED, DEFAULT_TAG, KnowledgeStore, MAX_FILE_BYTES, type SourceIssue } from './store.js';
import { IndexSkipError, type IndexSkipReason } from './indexing-result.js';
import { inspectSourceFilesystem, remoteIndexKey, remoteIndexRoot, type SourceFilesystem } from './index-location.js';
import { hideKnowledgeDirectory } from './index-visibility.js';

export const INDEX_DIRECTORY = '.knowledge';
export interface ScanOutcome {
  paused?: boolean;
  updated: string[]; removed: string[]; unchanged: number; unreachable: string[];
  failed: Array<{ name: string; reason: string }>;
  skipped: Array<{ name: string; reason: IndexSkipReason }>;
  moved: string[];
}
// Windows paths are case-insensitive even when catalogue and enumeration spellings differ.
const pathKey = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
const ignoredSourceDirectory = (name: string) => ['$recycle.bin', 'system volume information'].includes(name.toLowerCase());
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
export async function openSourceDirectory(input: string, cachePath: string, options: { requireEngine?: (extension: string) => Promise<void>; progress?: (message: string) => void; onStatusChange?: (path: string, phase: 'processing' | 'settled') => void; sourceFilesystem?: (root: string) => Promise<SourceFilesystem>; onVisibilityWarning?: () => void } = {}): Promise<KnowledgeStore> {
  if (!isAbsolute(input)) throw new Error('Choose an absolute library directory.');
  const root = await realpath(input);
  if (!(await stat(root, { bigint: true })).isDirectory()) throw new Error('Choose a directory, not a file.');
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
  const store = new KnowledgeStore(index, { ...options, cachePath: engineCache, directoryRoot: root, remoteIndexKey: indexKey, sourceGuard });
  if (!indexKey && !(await hideKnowledgeDirectory(index))) {
    try { options.onVisibilityWarning?.(); } catch { /* Visibility warnings must not close a usable index. */ }
  }
  return store;
}

/** Incremental recursive reconciliation. Failed reads never become deletions. */
export interface ScanCheckpoint { completed: number; total: number; changed?: boolean }
export interface ScanOptions {
  onCheckpoint?: (state: ScanCheckpoint) => void | Promise<void>;
  onDiscover?: (count: number) => void;
  yieldMs?: number;
}
export async function scanSourceDirectory(store: KnowledgeStore, report?: (message: string, percent: number) => void, signal?: AbortSignal, options: ScanOptions = {}): Promise<ScanOutcome> {
  const root = store.directoryRoot;
  if (!root) throw new Error('No source directory selected.');
  const outcome: ScanOutcome = { updated: [], removed: [], unchanged: 0, unreachable: [], failed: [], skipped: [], moved: [] };
  // A still-existing local mountpoint is not evidence that its network share is connected.
  await store.assertSourceAvailable();
  // A root that went offline or changed mounts must not wipe the catalogue.
  const rootInfo = await stat(root, { bigint: true });
  const documents = await store.list();
  const files: Array<{ path: string; size: number }> = [];
  let discovered = 0;
  options.onDiscover?.(0);
  const folders: string[] = [];
  const issues: SourceIssue[] = [];
  const sourceKey = (path: string) => relative(root, path).split(sep).join('/');
  const seen = new Set<string>();
  const unsupported = new Set<string>();
  const blocked: string[] = [];
  const inventoried = new Set<string>();
  async function walk(directory: string): Promise<void> {
    if (signal?.aborted) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { blocked.push(directory); outcome.unreachable.push(relative(root!, directory) || root!); issues.push({ path: sourceKey(directory), kind: 'unavailable', reason: '' }); return; }
    inventoried.add(pathKey(directory));
    for (const entry of entries) {
      if (signal?.aborted) return;
      const path = join(directory, entry.name);
      if (entry.name === INDEX_DIRECTORY || entry.name.startsWith('.')) continue;
      if (entry.isDirectory() && ignoredSourceDirectory(entry.name)) continue;
      if (entry.isSymbolicLink()) { blocked.push(path); continue; }
      if (entry.isDirectory()) { folders.push(sourceKey(path)); await walk(path); }
      else if (entry.isFile()) {
        if (ACCEPTED.includes(extname(path).toLowerCase())) {
          seen.add(pathKey(path));
          const info = await lstat(path).catch(() => null);
          files.push({ path, size: info?.size ?? Number.MAX_SAFE_INTEGER });
        } else { unsupported.add(pathKey(path)); issues.push({ path: sourceKey(path), kind: 'unsupported', reason: '' }); }
        if (++discovered % 100 === 0) { options.onDiscover?.(discovered); await new Promise<void>(done => setImmediate(done)); }
      }
    }
  }
  await walk(root);
  if (signal?.aborted) return outcome;
  options.onDiscover?.(discovered);
  // Inventory is cheap and engine-free. Pending files are counted, but are not exceptions.
  await store.replaceSourceInventory(folders, [...issues, ...files.map(({ path }) => ({ path: sourceKey(path), kind: 'pending' as const, reason: '' }))], blocked.map(sourceKey), rootInfo, signal);
  await options.onCheckpoint?.({ completed: 0, total: files.length });
  files.sort((a, b) => a.size - b.size || a.path.localeCompare(b.path));
  async function sourcePresence(path: string): Promise<'present' | 'missing' | 'unsupported' | 'unavailable'> {
    if (!inside(root, path)) return 'unavailable';
    if (relative(root, path).split(sep).slice(0, -1).some(ignoredSourceDirectory)) return 'unsupported';
    if (blocked.some(directory => inside(directory, path))) return 'unavailable';
    try {
      const info = await lstat(path);
      if (info.isFile() && unsupported.has(pathKey(path))) return 'unsupported';
      return 'present';
    }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return 'unavailable'; }
    const currentRoot = await stat(root, { bigint: true }).catch(() => null);
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
      if (info?.isDirectory()) return inventoried.has(pathKey(parent)) ? 'missing' : 'unavailable';
      if (parent === root) break;
      parent = dirname(parent);
    }
    return 'unavailable';
  }
  const missing = new Map<string, (typeof documents)[number]>();
  for (const doc of documents) {
    if (signal?.aborted) return outcome;
    if (seen.has(pathKey(doc.path))) continue;
    const presence = await sourcePresence(doc.path);
    if (presence === 'missing' || presence === 'unsupported') missing.set(doc.id, doc);
    else if (presence === 'unavailable') outcome.unreachable.push(relative(root, doc.path));
  }
  for (const [index, file] of files.entries()) {
    const { path } = file;
    if (signal?.aborted) return outcome;
    const name = relative(root, path);
    report?.(name, Math.floor(index / Math.max(files.length, 1) * 100));
    let issue: SourceIssue | null = null;
    let changed = false;
    try {
      const candidates = [...missing.values()].filter(doc => basename(doc.path) === basename(path)).map(doc => doc.id);
      const moved = await store.relocateSource(path, candidates);
      if (moved) { changed = true; missing.delete(moved); outcome.moved.push(name); }
      const indexed = await store.importFile(path, basename(path), DEFAULT_TAG);
      if (indexed.unchanged) outcome.unchanged++; else { changed = true; outcome.updated.push(name); }
    } catch (error) {
      if (error instanceof IndexSkipError) {
        outcome.skipped.push({ name, reason: error.reason });
        issue = { path: sourceKey(path), kind: error.reason, reason: '' }; issues.push(issue);
      } else {
        const reason = error instanceof Error ? error.message : String(error);
        outcome.failed.push({ name, reason });
        issue = { path: sourceKey(path), kind: 'failed', reason }; issues.push(issue);
      }
    }
    if (!await store.settleSourceFile(sourceKey(path), issue, rootInfo)) { outcome.unreachable.push(root); return outcome; }
    await options.onCheckpoint?.({ completed: index + 1, total: files.length, changed: changed || issue !== null });
    // One file at a time with a cooperative gap: UI/search work wins over bulk indexing.
    const delay = Math.max(0, Math.min(1000, options.yieldMs ?? 25));
    if (delay && !signal?.aborted) await new Promise<void>(done => {
      const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); done(); };
      const timer = setTimeout(finish, delay); signal?.addEventListener('abort', finish, { once: true });
    });
  }
  if (signal?.aborted) return outcome;
  await store.assertSourceAvailable();
  const finalRoot = await stat(root, { bigint: true }).catch(() => null);
  if (!finalRoot?.isDirectory() || finalRoot.dev !== rootInfo.dev || finalRoot.ino !== rootInfo.ino) {
    outcome.unreachable.push(root);
    return outcome;
  }
  for (const doc of missing.values()) {
    if (signal?.aborted) return outcome;
    const presence = await sourcePresence(doc.path);
    const current = await store.document(doc.id);
    if ((presence === 'missing' || presence === 'unsupported') && current?.path === doc.path) {
      await store.remove(doc.id);
      outcome.removed.push(relative(root, doc.path));
    } else if (presence === 'unavailable') outcome.unreachable.push(relative(root, doc.path));
  }
  if (!signal?.aborted) await store.replaceSourceInventory(folders, issues, blocked.map(sourceKey), rootInfo, signal);
  report?.('', 100);
  return outcome;
}
