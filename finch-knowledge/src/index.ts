import type * as finch from 'finch';
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { DEFAULT_TAG, KnowledgeStore, MAX_FILE_MB, SIZE_LIMIT_MESSAGE, engineForExtension, type DocumentSort } from './store.js';
import { expandImportTargets, MAX_BATCH_FILES, type ImportedFile, type ImportFailure, type ImportRequest, type SkipReason } from './tool-import.js';
import { loadEngine as loadDocumentEngine, ENGINE_VERSION as DOCUMENT_ENGINE_VERSION, isEngineInstalled as isDocumentEngineInstalled } from './document-engine.js';
import { loadEngine as loadOcrEngine, ENGINE_VERSION as OCR_ENGINE_VERSION, isEngineInstalled as isOcrEngineInstalled, engineBinaryPath } from './ocr-engine.js';
import { listModels as listOcrModels } from './ocr-runner.js';
import { loadLanceDB, isEngineInstalled as isLanceEngineInstalled, engineVersion as lanceEngineVersion } from './lancedb-engine.js';
import { LibraryGate } from './library-gate.js';
import { LibraryRegistry, LIBRARIES_STORAGE_KEY } from './libraries.js';
import { isLibraryScoped } from './library-scope.js';
import { AutoScanCooldown } from './scan-cooldown.js';
import { EnvironmentManager, type EnvironmentSnapshot } from './environment.js';
import { createKnowledgeComposer } from './composer.js';
import { assertSourcePath, openSourceDirectory, scanSourceDirectory, type ScanOutcome } from './source-directory.js';
import { pickDirectory } from './directory-picker.js';
export { pickDirectory, directoryPickerCommand } from './directory-picker.js';
export { assertSourcePath, openSourceDirectory, scanSourceDirectory } from './source-directory.js';
export { createKnowledgeComposer } from './composer.js';
export { resolveDocumentStatus } from './document-status.js';
export { IndexSkipError } from './indexing-result.js';
export { KnowledgeStore, vectorize, chunkText, DEFAULT_TAG, engineForExtension, ACCEPTED, MAX_FILE_BYTES, MAX_FILE_MB } from './store.js';
export { highlightTerms, snippetParts, snippetText } from './snippet.js';
export { openInPreview, openListedDocument, previewRoute } from './preview.js';
export { inScope, UNCLASSIFIED } from './scope.js';
export { expandImportTargets, MAX_BATCH_FILES } from './tool-import.js';
export { LibraryGate } from './library-gate.js';
export { LibraryRegistry, LIBRARIES_STORAGE_KEY } from './libraries.js';
export { isLibraryScoped } from './library-scope.js';
export { inspectSourceFilesystem, remoteIndexKey, remoteIndexRoot } from './index-location.js';
export { EnvironmentManager } from './environment.js';
export { downloadWithProgress, formatBytes, oncePerPercent } from './download.js';

const execFileAsync = promisify(execFile);
export const KNOWLEDGE_ACTIONS = ['search', 'tags', 'documents', 'library', 'environment', 'index', 'sync', 'create_tag', 'rename_tag', 'delete_tag', 'tag_document', 'untag_document'] as const;
interface ViewRequest { type?: string; libraryRoot?: string; libraryVersion?: number; directory?: string; color?: string; requestId?: string; id?: string; ids?: string[]; key?: string; tagId?: string | null; name?: string; size?: number; data?: string; query?: string; offset?: number; sort?: string; descending?: boolean; mode?: string }
function result(text: string, isError = false): finch.ToolResult {
  return { content: [{ type: 'text', text }], isError };
}

/**
 * Reads what the caller wants imported. Three shapes are accepted so that a single
 * file, a folder, several paths, or a hand-made classification can all arrive the
 * same way: `path`, `paths`, and `items` (each with its own destination tag).
 */
function readImportRequests(input: Record<string, unknown>): ImportRequest[] {
  const requests: ImportRequest[] = [];
  const push = (value: unknown, tag?: unknown): void => {
    if (typeof value !== 'string' || !value.trim()) return;
    requests.push({ path: value.trim(), tag: typeof tag === 'string' && tag.trim() ? tag.trim() : undefined });
  };
  push(input.path);
  if (Array.isArray(input.paths)) for (const entry of input.paths) push(entry);
  if (Array.isArray(input.items)) {
    for (const entry of input.items) {
      if (!entry || typeof entry !== 'object') continue;
      const item = entry as { path?: unknown; tag?: unknown };
      push(item.path, item.tag);
    }
  }
  return requests;
}

/** Reveal the indexed original in the system file manager. */
async function revealFile(path: string): Promise<void> {
  if (!(await stat(path)).isFile()) throw new Error('Indexed file is no longer on disk.');
  if (process.platform === 'darwin') await execFileAsync('open', ['-R', path]);
  else if (process.platform === 'win32') await execFileAsync('explorer.exe', [`/select,${path}`]);
  else await execFileAsync('xdg-open', [dirname(path)]);
}

/** Opens the library directory itself rather than selecting a file inside it. */
async function revealDirectory(path: string): Promise<void> {
  if (!(await stat(path)).isDirectory()) throw new Error('The library folder is no longer on disk.');
  if (process.platform === 'win32') await execFileAsync('explorer.exe', [path]);
  else await execFileAsync(process.platform === 'darwin' ? 'open' : 'xdg-open', [path]);
}

export function activate(ctx: finch.MiniToolContext): void {
  const panels = new Set<finch.AppPanel>();
  const gate = new LibraryGate();
  const libraries = new LibraryRegistry(() => ctx.storage.get(LIBRARIES_STORAGE_KEY), data => ctx.storage.set(LIBRARIES_STORAGE_KEY, data));
  let libraryVersion = 0;
  const bound = new WeakSet<finch.AppPanel>();
  const t = (key: string, values?: Record<string, string | number>) => ctx.i18n.t(key, values);
  const forwardProgress = (message: string): void => {
    for (const panel of panels) void panel.postMessage({ type: 'progress', message }).catch(() => {});
  };

  /** The library directory is chosen at runtime, so the store is swapped in place instead of rebuilt. */
  let activeStore: KnowledgeStore | undefined;
  const state = {
    root: '',
    get store(): KnowledgeStore { if (!activeStore) throw new Error(t('library.chooseFirst')); return activeStore; },
    set store(store: KnowledgeStore) { activeStore = store; },
  };
  let disposed = false;
  let scanController: AbortController | undefined;
  let scanning: Promise<SyncOutcome> | undefined;
  let statusSequence = 0;
  const statusTasks = new Set<Promise<void>>();
  ctx.subscriptions.push({ async dispose() { disposed = true; scanController?.abort(); await ready; await scanning?.catch(() => {}); await Promise.allSettled([...statusTasks]); await activeStore?.close(); } });
  let unavailable: string | null = null;
  let setupComplete = false;

  async function swapTo(root: string, commit?: (root: string) => Promise<void>): Promise<void> {
    scanController?.abort();
    await scanning?.catch(() => {});
    const versions = new Map<string, number>();
    const selectionVersion = libraryVersion + 1;
    const next: KnowledgeStore = await openSourceDirectory(root, ctx.storagePath, { progress: forwardProgress, requireEngine,
      onStatusChange(path, phase) {
        if (disposed || activeStore !== next) return;
        const version = ++statusSequence;
        versions.set(path, version);
        const publish = (document?: unknown) => {
          if (disposed || activeStore !== next || versions.get(path) !== version) return;
          for (const panel of panels) void panel.postMessage({ type: 'documentStatus', root: next.directoryRoot, libraryVersion: selectionVersion, path, phase, version, document }).catch(() => {});
        };
        if (phase === 'processing') publish();
        else {
          const task = next.statusForPath(path).then(publish).catch(() => {});
          statusTasks.add(task);
          void task.finally(() => statusTasks.delete(task));
        }
      },
    });
    // Persist the selection before exposing a new store. A failed save keeps the old library usable.
    try { await commit?.(next.directoryRoot!); }
    catch (error) { await next.close(); throw error; }
    const previous = activeStore;
    libraryVersion++;
    state.root = next.directoryRoot!;
    state.store = next;
    await Promise.allSettled([...statusTasks]);
    await previous?.close();
  }

  const ready = (async () => {
    setupComplete = await ctx.storage.get<boolean>('setupComplete') === true;
    const saved = await ctx.storage.get<string>('sourceDirectory');
    // A missing directory (unmounted drive) keeps the pointer so it resumes once the volume is back.
    if (saved && saved !== state.root) {
      try { await swapTo(saved); } catch { unavailable = saved; }
    }
    await libraries.load(state.root || saved);
  })();

  /**
   * Follows every recorded source file: re-indexes the ones whose content changed and drops
   * the ones that are gone. This is the "keep up with edits made outside the app" path, and
   * automatic triggers are rate-limited per directory while manual scans always remain available.
   */
  type SyncOutcome = ScanOutcome;
  const scanCooldown = new AutoScanCooldown(key => ctx.storage.get<number>(key), (key, value) => ctx.storage.set(key, value));
  async function autoScan(): Promise<SyncOutcome | undefined> {
    const store = activeStore;
    if (!store || !setupComplete || disposed) return;
    return scanCooldown.run(store.directoryRoot, async () => {
      if (disposed || activeStore !== store) return undefined;
      return syncSources();
    });
  }

  async function syncSources(report?: (message: string, percent: number) => void, signal?: AbortSignal): Promise<SyncOutcome> {
    if (scanning) return scanning;
    const store = state.store, scopeVersion = libraryVersion;
    scanController = new AbortController();
    const controller = scanController;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    for (const panel of panels) void panel.postMessage({ type: 'scanStarted', root: store.directoryRoot, libraryVersion: scopeVersion }).catch(() => {});
    scanning = gate.write(async () => {
      await scanCooldown.record(store.directoryRoot);
      return scanSourceDirectory(store, (name, percent) => {
        const message = t('progress.sync', { name });
        report?.(message, percent);
        for (const panel of panels) void panel.postMessage({ type: 'scanProgress', root: store.directoryRoot, libraryVersion: scopeVersion, message, percent }).catch(() => {});
      }, controller.signal);
    }).then(async outcome => {
      if (!controller.signal.aborted) await scanCooldown.record(store.directoryRoot);
      if (!disposed && activeStore === store) await broadcast();
      for (const panel of panels) void panel.postMessage({ type: 'scanDone', root: store.directoryRoot, libraryVersion: scopeVersion, sync: outcome }).catch(() => {});
      return outcome;
    }).catch(error => {
      for (const panel of panels) void panel.postMessage({ type: 'scanFailed', root: store.directoryRoot, libraryVersion: scopeVersion, error: errorText(error) }).catch(() => {});
      throw error;
    }).finally(() => { scanning = undefined; signal?.removeEventListener('abort', abort); });
    return scanning;
  }

  /**
   * The three engines download lazily on first use; the onboard page simply does
   * that up front so the wait is visible. State lives here rather than in a panel,
   * so closing the App View does not cancel a run.
   */
  const environment = new EnvironmentManager([
    {
      id: 'lancedb',
      version: lanceEngineVersion(),
      probe: () => isLanceEngineInstalled(ctx.storagePath),
      install: async (report) => {
        await loadLanceDB(ctx.storagePath, report);
        // Loading verifies the native binding without creating a library before directory selection.
        if (activeStore) await state.store.tags();
      },
    },
    {
      id: 'anydoc',
      version: DOCUMENT_ENGINE_VERSION,
      probe: () => isDocumentEngineInstalled(join(ctx.storagePath, 'anydoc')),
      install: async (report) => { await loadDocumentEngine(join(ctx.storagePath, 'anydoc'), report); },
    },
    {
      id: 'ocr',
      version: OCR_ENGINE_VERSION,
      // Only image imports need this, so setup must not hold the library hostage to a ~70 MB download.
      optional: true,
      lazy: true,
      probe: () => isOcrEngineInstalled(join(ctx.storagePath, 'ocr')),
      install: async (report) => {
        const binary = await loadOcrEngine(join(ctx.storagePath, 'ocr'), report);
        // Running the binary once proves it is executable on this machine, not just present.
        await listOcrModels(binary);
      },
    },
  ], (snapshot) => {
    for (const panel of panels) void panel.postMessage({ type: 'environment', environment: snapshot }).catch(() => {});
  });

  function environmentStatus(): Record<string, unknown> {
    const snapshot = environment.snapshot();
    return {
      ...snapshot,
      cachePath: ctx.storagePath,
      platform: `${process.platform}/${process.arch}`,
      ocrBinary: engineBinaryPath(join(ctx.storagePath, 'ocr')) ?? null,
    };
  }

  const composerAction = ctx.composerActions.register('knowledge', createKnowledgeComposer({
    snapshot: async () => { await ready; return unavailable || !activeStore ? null : state.store.summary(); },
    locale: async () => (await ctx.app?.getInfo())?.locale,
    t,
    showGuide: async () => {
      await ctx.ui.showModalDialog({ title: t('composer.guide'), message: t('composer.guideText'),
        actions: [{ id: 'close', label: t('composer.close') }] });
    },
  }));
  ctx.subscriptions.push(composerAction);

  async function openRepairSession(): Promise<string> {
    const snapshot = environment.snapshot();
    const failures = snapshot.steps.filter((step) => step.status === 'failed');
    type SessionCreate = (options: finch.SessionCreateOptions) => Promise<{ id: string }>;
    const sessions = ctx.sessions as unknown as {
      create?: SessionCreate;
      send?: (sessionId: string, message: { text: string; idempotencyKey: string }) => Promise<unknown>;
    } | undefined;
    if (!sessions?.create || !sessions.send) throw new Error('Environment help needs the sessions permission.');
    const lines = [
      t('environment.helpIntro'),
      '',
      `- platform: ${process.platform}/${process.arch}`,
      `- cache: ${ctx.storagePath}`,
      `- lancedb: ${statusOf(snapshot, 'lancedb')}`,
      `- anydoc: ${statusOf(snapshot, 'anydoc')}`,
      `- ocr: ${statusOf(snapshot, 'ocr')}`,
      '',
      t('environment.helpAsk'),
    ];
    for (const step of failures) lines.push('', `${step.id}: ${step.error ?? t('environment.unknownFailure')}`);
    const message = lines.join('\n');
    const created = await sessions.create({});
    await sessions.send(created.id, {
      text: message,
      idempotencyKey: `knowledge-env-${Date.now()}-${created.id}`,
    });
    await ctx.navigation.openSession(created.id);
    return created.id;
  }

  function statusOf(snapshot: EnvironmentSnapshot, id: string): string {
    const step = snapshot.steps.find((item) => item.id === id);
    if (!step) return 'unknown';
    return `${step.status}${step.detail ? ` (${step.detail})` : ''}${step.error ? ` — ${step.error}` : ''}`;
  }

  async function libraryInfo(): Promise<Record<string, unknown>> {
    // summary() reads the catalogue only, so the first paint never waits on an engine download.
    const store = activeStore, root = state.root, version = libraryVersion;
    const { documents, tags } = store ? await store.summary() : { documents: 0, tags: [] };
    const current = libraries.forRoot(root);
    return { root, version, indexStorage: store?.indexStorage, indexRoot: store?.root, name: current?.name, activeId: current?.id, libraries: libraries.list(), selected: Boolean(store), entered: setupComplete, isDefault: false, documents, tags: tags.length, unavailable };
  }

  const errorText = (error: unknown): string => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('UNIQUE constraint failed: tags.name')) return t('error.duplicateTag');
    if (message === 'Tag no longer exists.') return t('error.missingTag');
    if (message === 'Tag name must be 1–60 characters.') return t('error.tagName');
    if (message === 'Document no longer exists.') return t('error.missingDocument');
    if (message === 'Indexed file is no longer on disk.' || message.includes('ENOENT')) return t('error.missingFile');
    if (message === 'Specify a local file path.') return t('tool.fileRequired');
    if (message === 'The file must be inside the current workspace.') return t('tool.fileOutside');
    if (message === 'Choose a regular file, not a symbolic link.') return t('tool.fileSymlink');
    if (message === SIZE_LIMIT_MESSAGE) return t('tool.fileSize', { max: MAX_FILE_MB });
    if (message === 'File import cancelled.') return t('tool.fileCancelled');
    if (message === 'The library directory is switching. Try again when it finishes.') return t('library.switching');
    if (message === 'Finish current indexing or edits before switching directories.') return t('library.busy');
    if (message.startsWith('Unsupported knowledge index format.')) return t('library.unsupportedIndex');
    if (message === 'Choose a library directory.' || message === 'Choose an absolute library directory.' || message === 'Choose a directory, not a file.') return t('library.invalidDirectory');
    if (message === 'This is already the working library directory.') return t('library.same');
    if (message === 'Library is no longer registered.') return t('library.missing');
    if (message.startsWith('Unable to determine the source filesystem') || message === 'Drive type is unavailable.' || message === 'Network share identity is unavailable.') return t('library.filesystemUnavailable');
    if (message.startsWith('The network source is disconnected or mapped')) return t('library.networkUnavailable');
    if (message === 'Network libraries require a local Finch cache directory.') return t('library.localCacheRequired');
    if (message === 'The library folder is no longer on disk.') return t('library.unavailable');
    return message;
  };
  const supported = new Set(['enterLibrary', 'ready', 'page', 'locate', 'tags', 'tagCreate', 'tagRename', 'tagColor', 'tagDelete', 'tagToggle', 'tagReorder', 'search', 'reveal', 'sync', 'library', 'libraryAction', 'librarySwitch', 'libraryReveal', 'environment', 'environmentInstall', 'environmentHelp']);
  const retired = new Set(['addFiles', 'uploadStart', 'uploadChunk', 'uploadFinish', 'uploadAbort', 'uploadCancel', 'delete', 'backup']);

  /**
   * Tells every open page what changed. `change` describes a change that concerns a single row, so
   * a page can patch that row instead of reloading the list under the user.
   */
  async function broadcast(change?: { kind: 'tagToggle' | 'tagColor'; documentId?: string; tags?: string[] }): Promise<void> {
    composerAction.notifyUpdate();
    const store = state.store, root = state.root, version = libraryVersion;
    const tags = await store.tags();
    const directories = await store.directories();
    if (store !== activeStore) return;
    for (const panel of panels) void panel.postMessage({ type: 'changed', root, libraryVersion: version, tags, directories, ...(change ? { change } : {}) }).catch(() => {});
  }
  async function broadcastLibraries(except?: finch.AppPanel): Promise<void> {
    composerAction.notifyUpdate();
    const library = await libraryInfo();
    await Promise.allSettled([...panels].filter(panel => panel !== except).map(panel => panel.postMessage({ type: 'libraries', library })));
  }
  async function indexedPage(tagId: string | null, sort: DocumentSort, offset: number, directory: string | null = null, descending?: boolean) {
    const store = state.store;
    const page = await store.page(tagId, sort, offset, 50, directory, descending);
    return { ...page, documents: await store.indexStatus(page.documents) };
  }
  async function handle(panel: finch.AppPanel, raw: unknown): Promise<void> {
    const message = raw as ViewRequest;
    if (!message || typeof message !== 'object') return;
    if (retired.has(message.type ?? '')) {
      await panel.postMessage({ requestId: message.requestId, type: 'error', error: t('library.readOnlySources') });
      return;
    }
    if (!supported.has(message.type ?? '')) return;
    const requestId = typeof message.requestId === 'string' ? message.requestId.slice(0, 80) : '';
    let requestRoot = state.root, requestVersion = libraryVersion;
    const reply = (payload: Record<string, unknown>) => panel.postMessage({ requestId, root: requestRoot, libraryVersion: requestVersion, ...payload });
    try {
      await ready;
      requestRoot = state.root; requestVersion = libraryVersion;
      if (isLibraryScoped(message.type!) && ((message.libraryRoot !== undefined && message.libraryRoot !== state.root) || (message.libraryVersion !== undefined && message.libraryVersion !== libraryVersion))) throw new Error(t('library.changed'));
      if (!activeStore && !['ready', 'library', 'libraryAction', 'librarySwitch', 'environment', 'environmentInstall', 'environmentHelp'].includes(message.type!)) {
        if (message.type === 'page') { await reply({ type: 'page', documents: [], total: 0, offset: 0 }); return; }
        throw new Error(t('library.chooseFirst'));
      }
      switch (message.type) {
        case 'ready': {
          // Everything here must be engine-free: on a fresh machine the vector engine is still
          // downloading, and the setup screen cannot wait for it.
          const { tags } = activeStore ? await state.store.summary() : { tags: [] };
          await reply({ type: 'tags', tags, library: await libraryInfo(),
            environment: await environment.probe(), directories: activeStore ? await state.store.directories() : [] });
          if (activeStore && setupComplete && !scanning) void autoScan().catch(error => forwardProgress(errorText(error)));
          break;
        }
        case 'environment':
          await reply({ type: 'environment', environment: environment.snapshot() });
          break;
        case 'environmentInstall': {
          // Reply immediately so the page can render, then stream updates as steps run.
          const snapshot = environment.snapshot();
          await reply({ type: 'environment', environment: snapshot });
          void environment.install().then(() => activeStore && setupComplete ? autoScan() : undefined).catch(error => forwardProgress(errorText(error)));
          break;
        }
        case 'enterLibrary': {
          if (!activeStore || unavailable || !environment.snapshot().usable) throw new Error(t('library.setupIncomplete'));
          setupComplete = true;
          await ctx.storage.set('setupComplete', true);
          await reply({ type: 'libraryEntered', library: await libraryInfo(), environment: environment.snapshot() });
          void autoScan().catch(error => forwardProgress(errorText(error)));
          break;
        }
        case 'environmentHelp': {
          const sessionId = await openRepairSession();
          await reply({ type: 'environmentHelpOpened', sessionId });
          break;
        }
        case 'library':
          await reply({ type: 'library', library: await libraryInfo() });
          break;
        case 'libraryReveal':
          await revealDirectory(state.root);
          await reply({ type: 'libraryRevealed' });
          break;
        case 'libraryAction':
        case 'librarySwitch': {
          if (message.type === 'libraryAction' && message.mode !== 'choose') throw new Error(t('library.invalidDirectory'));
          const chosen = message.type === 'librarySwitch' ? libraries.find(message.id ?? '').root
            : await pickDirectory(t('library.title.choose', { root: state.root }), state.root);
          if (!chosen) { await reply({ type: 'libraryCanceled' }); break; }
          // Open in place; registering and switching never copy or rename source files.
          scanController?.abort();
          await scanning?.catch(() => {});
          const previousRoot = state.root;
          const existing = (await stat(join(chosen, '.knowledge')).catch(() => null))?.isDirectory();
          await gate.exclusive(() => swapTo(chosen, async root => {
            await libraries.add(root);
            await ctx.storage.set('sourceDirectory', root);
          }));
          unavailable = null;
          await reply({ type: 'libraryDone', mode: message.type === 'librarySwitch' ? 'switch' : existing ? 'open' : 'create', previousRoot, library: await libraryInfo(), environment: await environment.probe() });
          await broadcastLibraries(panel);
          await broadcast();
          if (setupComplete) void autoScan().catch(error => forwardProgress(errorText(error)));
          break;
        }
        case 'tags':
          await reply({ type: 'tags', tags: await state.store.tags(), directories: await state.store.directories() });
          break;
        case 'page': {
          const tagId = typeof message.tagId === 'string' ? message.tagId : null;
          const sort = (['name', 'added', 'updated', 'modified', 'type', 'size'].includes(message.sort ?? '') ? message.sort : 'updated') as DocumentSort;
          const page = await indexedPage(tagId, sort, Number(message.offset ?? 0), typeof message.directory === 'string' ? message.directory : null, typeof message.descending === 'boolean' ? message.descending : undefined);
          await reply({ type: 'page', ...page, offset: Math.max(0, Math.floor(Number(message.offset ?? 0)) || 0) });
          break;
        }
        case 'locate': {
          const tagId = typeof message.tagId === 'string' ? message.tagId : null;
          const sort = (['name', 'added', 'updated', 'modified', 'type', 'size'].includes(message.sort ?? '') ? message.sort : 'updated') as DocumentSort;
          const id = String(message.id ?? '');
          const directory = typeof message.directory === 'string' ? message.directory : null;
          const position = await state.store.position(id, tagId, sort, directory, typeof message.descending === 'boolean' ? message.descending : undefined);
          if (position === null) throw new Error('Document is not in the selected tag.');
          const offset = Math.floor(position / 50) * 50;
          await reply({ type: 'page', ...(await indexedPage(tagId, sort, offset, directory, typeof message.descending === 'boolean' ? message.descending : undefined)), offset, focusId: id });
          break;
        }
        case 'tagCreate': {
          const tag = await gate.write(() => state.store.createTag(String(message.name ?? '')));
          await reply({ type: 'tagCreated', tag });
          await broadcast();
          break;
        }
        case 'tagColor':
          await gate.write(() => state.store.setTagColor(String(message.id ?? ''), String(message.color ?? '')));
          await reply({ type: 'changedTag' });
          await broadcast({ kind: 'tagColor' });
          break;
        case 'tagRename':
          await gate.write(() => state.store.renameTag(String(message.id ?? ''), String(message.name ?? '')));
          await reply({ type: 'changedTag' });
          await broadcast();
          break;
        case 'tagDelete': {
          const outcome = await gate.write(() => state.store.deleteTag(String(message.id ?? '')));
          await reply({ type: 'changedTag', removed: outcome.affected, orphaned: outcome.orphaned });
          await broadcast();
          break;
        }
        case 'tagToggle': {
          // Clicking a tag in the row menu adds or removes it; clicking Unclassified clears them all,
          // because that row is what "no category" means.
          const id = String(message.id ?? '');
          const tagId = String(message.tagId ?? DEFAULT_TAG);
          const updated = await gate.write(async () => {
            if (tagId === DEFAULT_TAG) await state.store.setTags(id, []);
            else {
              const doc = await state.store.document(id);
              if (!doc) throw new Error('Document no longer exists.');
              await (doc.tags.includes(tagId) ? state.store.removeTag(id, tagId) : state.store.addTag(id, tagId));
            }
            // The page patches this one row from the reply, so it has to carry the outcome.
            return (await state.store.document(id))?.tags ?? [];
          });
          await reply({ type: 'changedTag', id, tags: updated });
          await broadcast({ kind: 'tagToggle', documentId: id, tags: updated });
          break;
        }
        case 'tagReorder': {
          // The panel answers a drag with the whole order it just showed, so the catalogue simply
          // adopts it. The two pinned rows never appear in that list.
          const ids = Array.isArray(message.ids) ? (message.ids as unknown[]).filter((id): id is string => typeof id === 'string') : [];
          if (!ids.length) throw new Error('A tag order must name at least one tag.');
          await gate.write(() => state.store.reorderTags(ids));
          await reply({ type: 'changedTag' });
          await broadcast();
          break;
        }
        case 'search': {
          const query = String(message.query ?? '').trim().slice(0, 500);
          const tagId = typeof message.tagId === 'string' ? message.tagId : null;
          await reply({ type: 'matches', matches: await state.store.search(query, 10, tagId, typeof message.directory === 'string' ? message.directory : null) });
          break;
        }
        case 'sync': {
          const root = state.root;
          // Answer first so the page can show the hairline, then stream progress into it.
          await reply({ type: 'syncStarted' });
          if (root !== state.root) throw new Error(t('library.changed'));
          const outcome = await syncSources(
            (message, percent) => { void panel.postMessage({ type: 'progress', message, percent }).catch(() => {}); },
            undefined,
          );
          await reply({ type: 'syncDone', root, sync: outcome });
          break;
        }
        case 'reveal': {
          const doc = await state.store.document(String(message.id ?? ''));
          if (!doc) throw new Error('Document no longer exists.');
          await revealFile(doc.path);
          await reply({ type: 'revealed' });
          break;
        }
      }
    } catch (error) {
      await reply({ type: 'error', error: errorText(error) });
    }
  }

  ctx.subscriptions.push(ctx.ui.onDidOpenPanel((panel) => {
    if (panel.view !== 'appView') return;
    panels.add(panel);
    if (bound.has(panel)) return;
    bound.add(panel);
    ctx.subscriptions.push(
      panel.onDidReceiveMessage((message) => handle(panel, message)),
      panel.onDidDispose(() => { panels.delete(panel); }),
    );
  }));

  async function findTag(value: string, store = state.store): Promise<{ id: string; name: string; count: number }> {
    const requested = value.trim();
    if (!requested) throw new Error(t('tool.tagRequired'));
    const tags = await store.tags();
    const tag = tags.find((item) => item.id === requested ||
      (item.id === DEFAULT_TAG ? t('tool.uncategorized') : item.name).toLowerCase() === requested.toLowerCase());
    if (!tag) throw new Error(t('tool.tagMissing', { name: requested }));
    return { id: tag.id, name: tag.id === DEFAULT_TAG ? t('tool.uncategorized') : tag.name, count: tag.count };
  }

  /**
   * A format's engine has to be installed before the bytes are read, because the download must not
   * happen under the library lock. The install starts here instead — in the background, where the
   * footer hairline already reports it — and the caller is told to import again once it lands.
   */
  async function requireEngine(extension: string): Promise<void> {
    const step = engineForExtension(extension);
    if (!step) return;
    let state = environment.snapshot();
    if (!state.steps.some((item) => item.id === step)) state = await environment.probe();
    const entry = state.steps.find((item) => item.id === step);
    if (!entry || entry.status === 'ready') return;
    if (step === 'ocr') {
      const snapshot = await environment.ensure('ocr');
      const ocr = snapshot.steps.find(item => item.id === 'ocr');
      if (ocr?.status !== 'ready') throw new Error(ocr?.error ?? t('environment.unknownFailure'));
      return;
    }
    if (entry.status !== 'running' && !state.running) void environment.install().catch(() => {});
    const installing = entry.status === 'running' || state.running;
    throw new Error(t(installing ? 'import.engineInstalling' : 'import.engineMissing', {
      name: t('engine.anydoc'),
    }));
  }

  ctx.subscriptions.push(ctx.tools.register({
    name: 'local_knowledge_search',
    title: t('tool.title'),
    description: t('tool.description'),
    defaultEnabled: true,
    risk: 'medium',
    timeoutMs: 600_000,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...KNOWLEDGE_ACTIONS], description: 'Operation. Defaults to search for backwards compatibility.' },
        query: { type: 'string', description: 'Search question or keywords (search only).' },
        tag: { type: 'string', description: 'Tag name or id: search/documents filter; rename_tag/delete_tag target; index tag assignment. A missing tag is created for index. Omit for all tags in search/documents, or leave a new document untagged when indexing.' },
        name: { type: 'string', description: 'New tag name (create_tag or rename_tag). Renaming changes only the tag name; it does not change its color or document assignments.' },
        force: { type: 'boolean', description: 'delete_tag: required to remove a tag that still holds documents. The documents are never deleted and keep their other tags; a document that had only this tag becomes untagged. Confirmation prevents accidental removal of a tag from a batch.' },
        documentId: { type: 'string', description: 'Document ID from documents/search (tag_document, untag_document).' },
        path: { type: 'string', description: 'index: existing file or folder inside the selected knowledge directory, absolute or relative to that root. Indexes in place without copying files. A folder is read recursively.' },
        paths: { type: 'array', items: { type: 'string' }, description: 'index: several files and/or folders in one call. Every entry lands in the tag given by `tag`.' },
        items: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, tag: { type: 'string' } }, required: ['path'] }, description: 'index: per-file tag assignments, for tagging a batch yourself — read the files, then send each one with the tag it belongs to. Overrides `tag`. Example: [{"path":"a/合同.pdf","tag":"合同"},{"path":"b/发票.pdf","tag":"发票"}].' },
        recursive: { type: 'boolean', description: 'index: read subfolders too (default true). Set false to read only the folder itself.' },
        offset: { type: 'number', description: 'Document list offset (documents; default 0).' },
        limit: { type: 'number', description: 'Maximum passages (1–20) or documents (1–50).' },
      },
    },
    async execute(input, exec) {
      try {
        await ready;
        const action = input.action ?? 'search';
        if (!KNOWLEDGE_ACTIONS.some(allowed => allowed === action)) {
          return result(t(['import', 'import_url', 'save_document', 'delete', 'remove', 'backup'].includes(String(action)) ? 'library.readOnlySources' : 'tool.actionUnknown'), true);
        }
        if (action === 'library') {
          const info = await libraryInfo();
          return result(t('tool.libraryEntry', { root: String(info.root), documents: Number(info.documents), tags: Number(info.tags) }) +
            (info.indexRoot ? `\n${t('tool.indexLocation', { path: String(info.indexRoot) })}` : '') +
            (info.isDefault ? `\n${t('tool.libraryDefault')}` : '') +
            (info.unavailable ? `\n${t('tool.libraryUnavailable', { path: String(info.unavailable) })}` : ''));
        }
        if (action === 'environment') {
          const status = environmentStatus();
          const steps = status.steps as Array<{ id: string; status: string; detail?: string; error?: string; message?: string }>;
          return result([
            t('tool.environmentEntry', { platform: String(status.platform), root: String(status.cachePath) }),
            ...steps.map((step) => `- ${step.id}: ${step.status}${step.detail ? ` (${step.detail})` : ''}${step.message ? ` — ${step.message}` : ''}${step.error ? `\n  ${step.error}` : ''}`),
          ].join('\n'));
        }
        // Bind every subsequent store access to the library selected at call start.
        // If the user switches during an await, fail safely instead of reading or editing the next library.
        return await inSelectedLibrary(activeStore);
        async function inSelectedLibrary(selected: KnowledgeStore | undefined): Promise<finch.ToolResult> {
        const state = { get store(): KnowledgeStore {
          if (!selected) throw new Error(t('library.chooseFirst'));
          if (selected !== activeStore) throw new Error(t('library.changed'));
          return selected;
        } };
        if (action === 'tags') {
          const tags = await state.store.tags();
          return result(tags.map((tag) => t('tool.tagEntry', {
            name: tag.id === DEFAULT_TAG ? t('tool.uncategorized') : tag.name,
            count: tag.count, id: tag.id,
          })).join('\n'));
        }
        if (action === 'create_tag') {
          const tag = await gate.write(() => state.store.createTag(typeof input.name === 'string' ? input.name : ''));
          await broadcast();
          return result(t('tool.tagCreated', { name: tag.name, id: tag.id }));
        }
        if (action === 'rename_tag') {
          const tag = await findTag(typeof input.tag === 'string' ? input.tag : '', state.store);
          const name = typeof input.name === 'string' ? input.name.trim() : '';
          await gate.write(() => state.store.renameTag(tag.id, name));
          await broadcast();
          return result(t('tool.tagRenamed', { name, id: tag.id }));
        }
        if (action === 'delete_tag') {
          const tag = await findTag(typeof input.tag === 'string' ? input.tag : '', state.store);
          // Documents are never deleted with the tag, but re-filing a batch by accident should
          // not be silent either, so a tag that still holds documents needs an explicit retry.
          if (tag.count > 0 && input.force !== true) {
            return result(t('tool.tagNotEmpty', { name: tag.name, count: tag.count, uncategorized: t('tool.uncategorized') }), true);
          }
          const outcome = await gate.write(() => state.store.deleteTag(tag.id));
          await broadcast();
          return result(t('tool.tagDeleted', { name: tag.name, count: outcome.affected, orphaned: outcome.orphaned, uncategorized: t('tool.uncategorized') }));
        }
        if (action === 'tag_document' || action === 'untag_document') {
          // A document may carry several tags; these add or remove one without touching the rest.
          const tag = await findTag(typeof input.tag === 'string' ? input.tag : '', state.store);
          const id = typeof input.documentId === 'string' ? input.documentId : '';
          const removing = action === 'untag_document';
          const updated = await gate.write(async () => {
            await (removing ? state.store.removeTag(id, tag.id) : state.store.addTag(id, tag.id));
            return (await state.store.document(id))?.tags ?? [];
          });
          await broadcast({ kind: 'tagToggle', documentId: id, tags: updated });
          return result(t(removing ? 'tool.documentUntagged' : 'tool.documentTagged', { id, tag: tag.name }));
        }
        if (action === 'sync') {
          // Re-indexes the sources that changed and drops the ones that are gone.
          void state.store;
          const outcome = await syncSources(
            (message, percent) => exec.progress?.report({ message, percent }),
            exec.signal,
          );
          const lines = [t('tool.syncDone', {
            updated: outcome.updated.length, removed: outcome.removed.length, unchanged: outcome.unchanged,
          })];
          if (outcome.moved.length) lines.push(t('tool.syncMoved', { count: outcome.moved.length }));
          if (outcome.skipped.length) lines.push(t('tool.syncSkipped', { count: outcome.skipped.length, list: outcome.skipped.map(item => `${item.name}: ${t(`index.skip.${item.reason}`)}`).join('\n') }));
          if (outcome.updated.length) lines.push(t('tool.syncUpdated', { list: outcome.updated.join(' · ') }));
          if (outcome.removed.length) lines.push(t('tool.syncRemoved', { list: outcome.removed.join(' · ') }));
          if (outcome.unreachable.length) lines.push(t('tool.syncUnreachable', { list: outcome.unreachable.join(' · ') }));
          if (outcome.failed.length) {
            lines.push(t('tool.syncFailed', {
              count: outcome.failed.length,
              list: outcome.failed.map((item) => t('tool.importFailureLine', { path: item.name, reason: item.reason })).join('\n'),
            }));
          }
          if (!outcome.updated.length && !outcome.removed.length && !outcome.unreachable.length && !outcome.failed.length && !outcome.skipped.length && !outcome.moved.length) lines.push(t('tool.syncNothing'));
          return result(lines.join('\n'), outcome.failed.length > 0);
        }
        if (action === 'index') {
          const importRoot = state.store.directoryRoot;
          if (!importRoot) return result(t('tool.workspaceRequired'), true);
          const requests = readImportRequests(input);
          if (!requests.length) return result(t('tool.fileRequired'), true);
          const expanded = await expandImportTargets(importRoot, requests, { recursive: input.recursive !== false });
          const skipLabels: Record<SkipReason, string> = {
            hidden: t('tool.skipHidden'), unsupported: t('tool.skipUnsupported'), symlink: t('tool.skipSymlink'),
            notFile: t('tool.skipNotFile'), empty: t('tool.skipEmpty'), tooLarge: t('tool.skipTooLarge', { max: MAX_FILE_MB }), limit: t('tool.skipLimit', { max: MAX_BATCH_FILES }),
          };
          const counted = new Map<SkipReason, number>();
          for (const entry of expanded.skipped) counted.set(entry.reason, (counted.get(entry.reason) ?? 0) + 1);
          const skipDetail = [...counted].map(([reason, count]) => `${skipLabels[reason]} ${count}`).join(' · ');
          const failureList = (list: ImportFailure[]) => list
            .map((item) => t('tool.importFailureLine', { path: basename(item.path) || item.path, reason: errorText(item.error) }))
            .join('\n');
          if (!expanded.targets.length) {
            // Nothing usable: surface the caller's own mistake first, then anything a folder held.
            const head = expanded.failures.length ? failureList(expanded.failures) : t('tool.importNothing');
            return result(skipDetail ? `${head}\n${t('tool.importSkipped', { count: expanded.skipped.length, detail: skipDetail })}` : head, true);
          }
          const label = (tag: { id: string; name: string }) => tag.id === DEFAULT_TAG ? t('tool.uncategorized') : tag.name;
          const tagIds = new Map<string, { id: string; name: string }>();
          for (const tag of await state.store.tags()) tagIds.set(label(tag).toLowerCase(), { id: tag.id, name: label(tag) });
          const createdTags: string[] = [];
          const ensureTag = async (requested?: string): Promise<{ id: string; name: string }> => {
            const value = (requested ?? '').trim();
            if (!value) return { id: DEFAULT_TAG, name: t('tool.uncategorized') };
            const known = tagIds.get(value.toLowerCase()) ?? (await state.store.tags()).find((tag) => tag.id === value);
            if (known) return { id: known.id, name: known.id === DEFAULT_TAG ? t('tool.uncategorized') : known.name };
            // Classifying a batch often names a tag that does not exist yet; creating it keeps one call enough.
            const created = await gate.write(() => state.store.createTag(value));
            createdTags.push(created.name);
            tagIds.set(created.name.toLowerCase(), { id: created.id, name: created.name });
            return { id: created.id, name: created.name };
          };
          const fallback = await ensureTag(typeof input.tag === 'string' ? input.tag : '');
          const finished: Array<{ file: ImportedFile; tag: string }> = [];
          const failed: ImportFailure[] = [];
          const perTag = new Map<string, number>();
          for (const [index, target] of expanded.targets.entries()) {
            if (exec.signal?.aborted) break;
            const tag = target.tag ? await ensureTag(target.tag) : fallback;
            try {
              exec.progress?.report({ message: t('progress.indexing', { name: target.name }), percent: Math.floor(index / expanded.targets.length * 100) });
              const outcome: ImportedFile = await gate.write(async () => {
                const path = await assertSourcePath(importRoot, target.path);
                const indexed = await state.store.importFile(path, basename(path), tag.id);
                return { name: target.name, documentId: indexed.document.id, unchanged: indexed.unchanged };
              });
              finished.push({ file: outcome, tag: tag.name });
              perTag.set(tag.name, (perTag.get(tag.name) ?? 0) + 1);
            } catch (error) {
              failed.push({ path: target.path, error: error instanceof Error ? error : new Error(String(error)) });
            }
          }
          await broadcast();
          if (failed.length && !finished.length) return result(failureList(failed), true);
          // A plain one-file call keeps the short answer it has always given.
          if (finished.length === 1 && !failed.length && !expanded.skipped.length && !expanded.failures.length && !createdTags.length) {
            const only = finished[0];
            return result(t(only.file.unchanged ? 'tool.importUnchanged' : 'tool.imported',
              { name: only.file.name, id: only.file.documentId, tag: only.tag }));
          }
          const unchanged = finished.filter((item) => item.file.unchanged).length;
          const lines = [finished.length
            ? unchanged > 0
              ? t('tool.importDoneUnchanged', { ok: finished.length, unchanged })
              : t('tool.importDone', { ok: finished.length })
            : t('tool.importNothing')];
          if (createdTags.length) lines.push(t('tool.importCreatedTags', { list: createdTags.join(' · ') }));
          if (perTag.size) lines.push(t('tool.importByTag', { list: [...perTag].map(([name, count]) => `${name} ${count}`).join(' · ') }));
          if (expanded.skipped.length) lines.push(t('tool.importSkipped', { count: expanded.skipped.length, detail: skipDetail }));
          const problems = [...expanded.failures, ...failed].map((item) => t('tool.importFailureLine', {
            path: basename(item.path) || item.path, reason: errorText(item.error),
          }));
          if (problems.length) lines.push(t('tool.importFailures', { count: problems.length, list: problems.join('\n') }));
          return result(lines.join('\n'), failed.length > 0);
        }
        let tagId: string | null = null;
        if (typeof input.tag === 'string' && input.tag.trim()) tagId = (await findTag(input.tag, state.store)).id;
        if (action === 'documents') {
          const offset = typeof input.offset === 'number' && Number.isFinite(input.offset) ? input.offset : 0;
          const limit = typeof input.limit === 'number' && Number.isFinite(input.limit) ? input.limit : 50;
          const page = await state.store.page(tagId, 'updated', offset, limit);
          const tags = await state.store.tags();
          return result(t('tool.documentsTotal', { total: page.total, offset: Math.max(0, Math.floor(offset)) }) + '\n' +
            (page.documents.map((doc) => t('tool.documentEntry', {
              name: doc.name, id: doc.id,
              tag: doc.tags.length ? doc.tags.map((tagId) => tags.find((tag) => tag.id === tagId)?.name ?? tagId).join(' · ') : t('tool.uncategorized'),
            })).join('\n') || t('tool.empty')));
        }
        if (action !== 'search') return result(t('tool.actionUnknown'), true);
        const query = typeof input.query === 'string' ? input.query.trim().slice(0, 500) : '';
        if (!query) return result(t('tool.queryRequired'), true);
        const limit = typeof input.limit === 'number' && Number.isFinite(input.limit) ? input.limit : 5;
        const matches = await state.store.search(query, limit, tagId);
        if (!matches.length) return result(t('tool.empty'));
        const tags = await state.store.tags();
        return result(matches.map((row, index) =>
          `[${index + 1}] ${row.name} · ${t('tool.chunk', { number: row.chunk })} · ${tags.find((tag) => tag.id === row.tag_id)?.name || t('tool.uncategorized')} · ${t('tool.documentId', { id: row.document_id })}\n${t('tool.source')}: ${row.path}\n${row.text}`,
        ).join('\n\n---\n\n'));
        }
      } catch (error) {
        return result(errorText(error), true);
      }
    },
  }));
}
