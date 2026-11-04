import type * as finch from 'finch';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat, unlink } from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';

// ── Types ───────────────────────────────────────────────────────────────────

/** An earlier recording of the same file, kept when its path is recorded again. */
interface DeliveryRevision {
  title: string;
  description?: string;
  sessionId?: string;
  recordedAt: number;
}

interface DeliveryRecord {
  id: string;
  sessionId: string;
  sessionTitle?: string;
  /** Space of the recording session; drives the project filter and grouping. */
  spaceId?: string;
  spaceName?: string;
  spaceDir?: string;
  filePath: string;
  fileName: string;
  fileType: string;
  title: string;
  description: string;
  textPreview?: string;
  /** Time of the latest recording of this path. */
  createdAt: number;
  /** Time this path was first recorded; only set once it has revisions. */
  firstCreatedAt?: number;
  /** Earlier recordings of this same path, newest first. */
  history?: DeliveryRevision[];
  starred?: boolean;
}

type Deliveries = DeliveryRecord[];

/** What the panel receives: the stored record plus transient file state. */
type PanelRecord = DeliveryRecord & { missing?: boolean };

const STORAGE_KEY = 'deliveries';
const SPACE_NAMES_KEY = 'spaceNames';
const MAX_PREVIEW = 500;
const MAX_HISTORY = 20;

// ── Helpers ─────────────────────────────────────────────────────────────────

function text(message: string, isError = false): finch.ToolResult {
  return { content: [{ type: 'text', text: message }], isError };
}

/** Extract a short file name from a full path. */
function baseName(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || filePath;
}

/** Map a file extension to a delivery file type. */
function detectFileType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'md' || ext === 'markdown') return 'md';
  if (ext === 'doc' || ext === 'docx') return 'word';
  if (ext === 'ppt' || ext === 'pptx') return 'ppt';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'xls' || ext === 'xlsx' || ext === 'csv') return 'excel';
  if (ext === 'html' || ext === 'htm') return 'web';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) return 'image';
  return 'other';
}

/** MIME type for an image file path, used to build a `data:` URL for the card thumbnail. */
function imageMime(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'bmp') return 'image/bmp';
  if (ext === 'svg') return 'image/svg+xml';
  return 'image/png';
}

/**
 * Cap for a base64 thumbnail embedded in a card. Full-resolution source
 * images (9:16 posters, PNGs) can be megabytes; embedding the whole thing
 * would bloat the stored record and the webview postMessage. We embed a
 * downscaled version where possible, but the backend has no image
 * processing deps — so instead we just refuse to embed images larger than a
 * practical ceiling and let the card fall back to its text preview. This
 * keeps the feature safe without pulling in a canvas/sharp dependency.
 */
const MAX_IMAGE_EMBED_BYTES = 1.5 * 1024 * 1024; // ~1.5 MB

/** Format a timestamp for display. */
function formatTime(ts: number): string {
  const d = new Date(ts);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const mins = String(d.getMinutes()).padStart(2, '0');
  return `${month}-${day} ${hours}:${mins}`;
}

/** Human-readable label for each file type, per fallback (non-localized) English. */
const TYPE_LABEL_EN: Record<string, string> = {
  md: 'MD',
  word: 'Word',
  ppt: 'PPT',
  pdf: 'PDF',
  excel: 'Excel',
  web: 'Web',
  image: 'Image',
  other: 'File',
};

/**
 * Build a short summary for the Delivery sidebar row, e.g. "3 MD" when every
 * record shares one file type, or a generic "5 files" when mixed. Space in
 * the sidebar row is very limited, so this never lists every type by name.
 */
function buildDeliveryDetail(ctx: finch.MiniToolContext, records: Deliveries): string {
  if (records.length === 0) return '';
  const counts = new Map<string, number>();
  for (const r of records) counts.set(r.fileType, (counts.get(r.fileType) ?? 0) + 1);

  if (counts.size === 1) {
    const [fileType, count] = [...counts.entries()][0];
    const typeKey = `delivery.type.${fileType}`;
    const typeLabel = ctx.i18n.has(typeKey) ? ctx.i18n.t(typeKey) : TYPE_LABEL_EN[fileType] ?? TYPE_LABEL_EN.other;
    return ctx.i18n.t('delivery.detailSingle', { count: String(count), type: typeLabel });
  }
  return ctx.i18n.t('delivery.detailMixed', { count: String(records.length) });
}

// ── Storage helpers ─────────────────────────────────────────────────────────

async function loadDeliveries(ctx: finch.MiniToolContext): Promise<Deliveries> {
  return (await ctx.storage.get<Deliveries>(STORAGE_KEY)) ?? [];
}

async function saveDeliveries(ctx: finch.MiniToolContext, data: Deliveries): Promise<void> {
  await ctx.storage.set(STORAGE_KEY, data);
}

// ── Spaces ──────────────────────────────────────────────────────────────────

interface SpaceRef {
  spaceId?: string;
  spaceName?: string;
  spaceDir?: string;
}

/**
 * Space of the session calling the tool. `ctx.workspace` describes the Space
 * the mini tool was activated in, which is not necessarily the caller's, so
 * its name and directory are only trusted when the Space ids match.
 */
function resolveSpace(ctx: finch.MiniToolContext, exec: finch.ToolExecutionContext): SpaceRef {
  const spaceId = exec.spaceId ?? '';
  if (!spaceId) return {};
  let ws: finch.WorkspaceInfo | undefined;
  try {
    ws = ctx.workspace;
  } catch {
    ws = undefined;
  }
  const same = !!ws && ws.spaceId === spaceId;
  return {
    spaceId,
    spaceName: (same && ws?.spaceName) || undefined,
    spaceDir: (same && ws?.directoryPath) || undefined,
  };
}

/** spaceId → display name, learned from panel opens and tool calls. */
async function loadSpaceNames(ctx: finch.MiniToolContext): Promise<Record<string, string>> {
  return (await ctx.storage.get<Record<string, string>>(SPACE_NAMES_KEY)) ?? {};
}

async function learnSpaceName(
  ctx: finch.MiniToolContext,
  spaceId: string | undefined,
  spaceName: string | undefined,
): Promise<void> {
  if (!spaceId || !spaceName) return;
  const map = await loadSpaceNames(ctx);
  if (map[spaceId] === spaceName) return;
  map[spaceId] = spaceName;
  await ctx.storage.set(SPACE_NAMES_KEY, map);
}

/** Keep stored Space names in line with the latest known names (Spaces can be renamed). */
async function repairSpaceNames(ctx: finch.MiniToolContext): Promise<void> {
  const map = await loadSpaceNames(ctx);
  const all = await loadDeliveries(ctx);
  let changed = false;
  for (const r of all) {
    if (r.spaceId && map[r.spaceId] && r.spaceName !== map[r.spaceId]) {
      r.spaceName = map[r.spaceId];
      r.spaceDir = undefined;
      changed = true;
    }
  }
  if (changed) await saveDeliveries(ctx, all);
}

/**
 * A Panel App opened inside a session knows that session's Space: fill it
 * into records of that session that were saved without one (older records).
 */
async function backfillSpaceFromPanel(ctx: finch.MiniToolContext, panel: finch.AppPanel): Promise<void> {
  await learnSpaceName(ctx, panel.spaceId, panel.spaceName);
  await repairSpaceNames(ctx);
  const { sessionId, spaceId, spaceName } = panel;
  if (!sessionId || !spaceId || !spaceName) return;
  const all = await loadDeliveries(ctx);
  let changed = false;
  for (const r of all) {
    // A session may have moved: never overwrite an existing, different Space.
    if (r.sessionId === sessionId && !r.spaceName && (!r.spaceId || r.spaceId === spaceId)) {
      r.spaceId = spaceId;
      r.spaceName = spaceName;
      changed = true;
    }
  }
  if (changed) await saveDeliveries(ctx, all);
}

// ── Revisions: one record per file ──────────────────────────────────────────

function pathKey(p: string): string {
  return normalize(String(p || '').trim());
}

function historyEntry(r: DeliveryRecord): DeliveryRevision {
  const h: DeliveryRevision = { title: r.title, recordedAt: r.createdAt };
  if (r.description) h.description = r.description;
  if (r.sessionId) h.sessionId = r.sessionId;
  return h;
}

/**
 * Recording a path that is already logged used to append a second record.
 * Merge every group of records sharing a path into its newest record, keeping
 * the older ones as revisions. Idempotent; runs once per activation.
 */
async function mergeDuplicatePaths(ctx: finch.MiniToolContext): Promise<number> {
  const all = await loadDeliveries(ctx);
  const byPath = new Map<string, DeliveryRecord>();
  let merged = 0;
  for (const r of all.slice().sort((a, b) => a.createdAt - b.createdAt)) {
    const key = pathKey(r.filePath);
    const prev = byPath.get(key);
    if (prev) {
      // r is newer: it survives, prev becomes a revision.
      r.history = [...(r.history ?? []), historyEntry(prev), ...(prev.history ?? [])]
        .sort((a, b) => b.recordedAt - a.recordedAt)
        .slice(0, MAX_HISTORY);
      r.firstCreatedAt = Math.min(prev.firstCreatedAt ?? prev.createdAt, r.firstCreatedAt ?? r.createdAt);
      if (prev.starred) r.starred = true;
      if (!r.spaceId && prev.spaceId) {
        r.spaceId = prev.spaceId;
        r.spaceName = prev.spaceName;
        r.spaceDir = prev.spaceDir;
      }
      merged++;
    }
    byPath.set(key, r);
  }
  if (merged) await saveDeliveries(ctx, [...byPath.values()].sort((a, b) => a.createdAt - b.createdAt));
  return merged;
}

// ── Sidebar row ─────────────────────────────────────────────────────────────

// The user's Finch assistant name ("帕亚", or the default "Finch"). Resolved
// once and reused for every env payload; the webview needs it to render the
// empty-state copy ("Ask {finch} to create a document…") without a round trip.
let cachedAssistantName: string | null = null;
async function getAssistantName(ctx: finch.MiniToolContext): Promise<string> {
  if (cachedAssistantName) return cachedAssistantName;
  try {
    cachedAssistantName = (await ctx.app.getInfo()).assistantName || 'Finch';
  } catch (err) {
    ctx.logger.warn('Failed to resolve assistant name: ' + String(err));
    cachedAssistantName = 'Finch';
  }
  return cachedAssistantName;
}

/**
 * Key under which repeat deliveries of one file count once. Documents
 * delivered again under the same name in the same session (run/, run-v2/ …)
 * are the same deliverable; images only when the path is the same. Mirrors
 * `versionKeys()` in panel.html.
 */
function deliverableKey(r: DeliveryRecord): string {
  if (detectFileType(r.filePath) === 'image') return 'p:' + pathKey(r.filePath);
  return 'n:' + String(r.fileName || '').toLowerCase();
}

/** Update the Delivery sidebar row for the current session. */
async function refreshDeliveryRow(
  ctx: finch.MiniToolContext,
  sessionId: string | undefined,
): Promise<void> {
  if (!sessionId) return;
  const all = await loadDeliveries(ctx);
  const sessionRecords = all.filter((r) => r.sessionId === sessionId);
  if (sessionRecords.length === 0) {
    await ctx.ui.delivery.remove();
    return;
  }
  const latest = sessionRecords[sessionRecords.length - 1];
  const seen = new Set<string>();
  const deliverables = sessionRecords.slice().reverse().filter((r) => {
    const key = deliverableKey(r);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  await ctx.ui.delivery.set({
    // Keep the title short and stable — the record's own title can be long
    // and would crowd this narrow row; the type/count breakdown goes in detail.
    title: ctx.i18n.t('delivery.title'),
    detail: buildDeliveryDetail(ctx, deliverables),
    // Full pack-qualified form — the delivery row's auto pack resolution
    // for the shorthand `ext:library` can fall back to the default puzzle
    // icon, so reference the registered pack explicitly.
    icon: 'ext:delivery-icons/library',
    payload: { sessionId, latestId: latest.id },
  });
}

// ── Open panel registry ────────────────────────────────────────────────────

/**
 * Every live panel instance — right-side Panel Apps across sessions plus the
 * appView sidebar page. `ctx.storage` has no change event, so mutations that
 * happen outside a panel's own message flow (the record_artifact tool running
 * in any session, or remove/clearSession issued from a *different* panel) would
 * otherwise leave already-open views stale until reopen. Every mutation fans
 * out from {@link broadcastDeliveries} to all panels in this set; panels leave
 * it on dispose, so it only ever holds instances Finch considers alive.
 */
const livePanels = new Set<finch.AppPanel>();

/**
 * Guards against double-binding listeners: re-opening a still-alive
 * single-instance panel re-emits it from `onDidOpenPanel` (with updated
 * payload), and we must not register a second `onDidReceiveMessage` for it.
 */
const boundPanels = new WeakSet<finch.AppPanel>();

/**
 * Fingerprint of the page file currently on disk. Reloading or updating the
 * mini tool restarts only this backend; a page that is already open keeps
 * running its old code. Pages compare this value with the first one they
 * received and reload themselves once it changes. Re-hashed only when the
 * file's mtime changes.
 */
let pageBuildCache = { mtimeMs: -1, hash: '' };
async function currentPageBuild(): Promise<string> {
  try {
    const url = new URL('./panel.html', import.meta.url);
    const info = await stat(url);
    if (info.mtimeMs !== pageBuildCache.mtimeMs) {
      const buf = await readFile(url);
      pageBuildCache = { mtimeMs: info.mtimeMs, hash: createHash('sha1').update(buf).digest('hex').slice(0, 12) };
    }
    return pageBuildCache.hash;
  } catch {
    return '';
  }
}

/** Env payload shared by the initial push, `requestDeliveries` and broadcasts. */
async function buildPanelEnv(
  ctx: finch.MiniToolContext,
  panel: finch.AppPanel,
): Promise<Record<string, unknown>> {
  return {
    sessionId: panel.sessionId ?? '',
    view: panel.view ?? '',
    spaceId: panel.spaceId ?? '',
    spaceName: panel.spaceName ?? '',
    // `finch:env.locale` is only delivered for the appView scope today, so
    // thread the resolved locale through our own env payload instead — it
    // works uniformly for both the right-side Panel App and the appView
    // sidebar entry.
    locale: ctx.i18n.locale,
    assistantName: await getAssistantName(ctx),
    spaceNames: await loadSpaceNames(ctx),
    pageBuild: await currentPageBuild(),
  };
}

/**
 * Flags records whose file is gone from disk so the page can show them as
 * moved or deleted instead of failing on click. Never persisted.
 */
async function withFileState(all: Deliveries): Promise<PanelRecord[]> {
  return Promise.all(
    all.map(async (r): Promise<PanelRecord> => {
      try {
        await stat(r.filePath);
        return r;
      } catch {
        return { ...r, missing: true };
      }
    }),
  );
}

async function postDeliveries(ctx: finch.MiniToolContext, panel: finch.AppPanel, all: Deliveries): Promise<void> {
  await panel.postMessage({ type: 'deliveries', data: await withFileState(all), env: await buildPanelEnv(ctx, panel) });
}

/** Push the latest deliveries to every live panel so open views stay current. */
async function broadcastDeliveries(ctx: finch.MiniToolContext): Promise<void> {
  if (livePanels.size === 0) return;
  const all = await loadDeliveries(ctx);
  for (const panel of livePanels) {
    try {
      await postDeliveries(ctx, panel, all);
    } catch (err) {
      // A dying panel must never break the mutation that triggered the push.
      ctx.logger.warn(`Failed to push deliveries to panel ${panel.id}: ${String(err)}`);
    }
  }
}

// ── Opening files ───────────────────────────────────────────────────────────

/** An open failure with a reason code the page maps to a localized message. */
function openFailure(reason: string, message: string): Error {
  return Object.assign(new Error(message), { reason });
}

function openErrorReason(err: unknown): string {
  const e = err as { reason?: unknown; code?: unknown } | null;
  if (e && typeof e.reason === 'string') return e.reason;
  if (e && e.code === 'ENOENT') return 'missingFile';
  if (e && (e.code === 'EACCES' || e.code === 'EPERM')) return 'permission';
  return 'openFailed';
}

/**
 * Resolve a record id sent by the page to its file. The page only ever sends
 * ids: the path always comes from the stored record, never from the page.
 */
async function recordFile(all: Deliveries, id: unknown): Promise<DeliveryRecord> {
  const record = typeof id === 'string' ? all.find((r) => r.id === id) : undefined;
  if (!record) throw openFailure('missingRecord', 'missing record');
  if (typeof record.filePath !== 'string' || !isAbsolute(record.filePath)) {
    throw openFailure('invalidPath', 'invalid path');
  }
  const info = await stat(record.filePath);
  if (!info.isFile()) throw openFailure('invalidPath', 'not a regular file');
  return record;
}

/** Opens Finch's built-in file preview in the panel's current scope. */
async function openFilePreview(ctx: finch.MiniToolContext, filePath: string): Promise<void> {
  if (typeof ctx.ui.openFilePreview !== 'function') {
    throw openFailure('unsupported', 'ctx.ui.openFilePreview is not available on this Finch version');
  }
  await ctx.ui.openFilePreview(filePath);
}

// ── Panel message handling ──────────────────────────────────────────────────

interface PanelMessage {
  type: string;
  id?: string;
  /** Several records acted on together (every delivery of one entry). */
  ids?: unknown;
  requestId?: string;
  sessionId?: string;
  filePath?: string;
  value?: boolean;
  /** Panel-only: when true, also delete the underlying files from disk (best-effort). */
  deleteFile?: boolean;
}

function messageIds(msg: PanelMessage): string[] {
  const ids: unknown[] = Array.isArray(msg.ids) ? msg.ids : [msg.id];
  return ids.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

async function handlePanelMessage(
  ctx: finch.MiniToolContext,
  panel: finch.AppPanel,
  message: unknown,
): Promise<void> {
  const msg = (message && typeof message === 'object' ? message : {}) as PanelMessage;
  if (msg.type === 'requestDeliveries') {
    try {
      await backfillSpaceFromPanel(ctx, panel);
    } catch (err) {
      ctx.logger.warn('Space backfill failed: ' + String(err));
    }
  }
  const all = await loadDeliveries(ctx);

  switch (msg.type) {
    case 'requestDeliveries': {
      // Send all deliveries + current env info
      await postDeliveries(ctx, panel, all);
      break;
    }
    case 'openPreview': {
      const response: Record<string, unknown> = { type: 'openResult', id: msg.id, requestId: msg.requestId };
      try {
        const record = await recordFile(all, msg.id);
        await openFilePreview(ctx, record.filePath);
        response.ok = true;
      } catch (err) {
        response.ok = false;
        response.error = openErrorReason(err);
      }
      await panel.postMessage(response);
      break;
    }
    case 'toggleStar': {
      // One entry can stand for several deliveries of the same file: `ids`
      // stars them together so the star survives the next delivery.
      const ids = messageIds(msg);
      const targets = all.filter((r) => ids.includes(r.id));
      if (!targets.length) break;
      const value = typeof msg.value === 'boolean' ? msg.value : !targets[0].starred;
      for (const target of targets) {
        if (value) target.starred = true;
        else delete target.starred;
      }
      await saveDeliveries(ctx, all);
      await broadcastDeliveries(ctx);
      break;
    }
    case 'remove': {
      // Deleting an entry removes every delivery of it (`ids`); a single id still works.
      const ids = messageIds(msg);
      if (!ids.length) break;
      const removed = all.filter((r) => ids.includes(r.id));
      const remaining = all.filter((r) => !ids.includes(r.id));
      await saveDeliveries(ctx, remaining);
      // Broadcast instead of replying only to the requester — the same
      // removal must also update any other open panel (e.g. the appView
      // sidebar page) watching this data.
      await broadcastDeliveries(ctx);
      for (const sessionId of new Set(removed.map((r) => r.sessionId))) {
        await refreshDeliveryRow(ctx, sessionId);
      }

      // Deleting the records never blocks on the disk delete below — the
      // record is the source of truth for this tool, the file is best-effort.
      let fileDeleteError: string | undefined;
      if (msg.deleteFile) {
        for (const filePath of new Set(removed.map((r) => r.filePath))) {
          // Leave files another remaining record still points to, and skip ones already gone.
          if (remaining.some((r) => r.filePath === filePath)) continue;
          try {
            await unlink(filePath);
          } catch (err) {
            if ((err as { code?: unknown }).code === 'ENOENT') continue;
            fileDeleteError = err instanceof Error ? err.message : String(err);
            ctx.logger.warn(`Failed to delete file on disk: ${filePath} — ${fileDeleteError}`);
          }
        }
      }
      await panel.postMessage({
        type: 'removeResult',
        id: ids[0],
        ids,
        deleteFileRequested: !!msg.deleteFile,
        fileDeleteError,
      });
      break;
    }
    case 'clearSession': {
      if (!msg.sessionId) break;
      const filtered = all.filter((r) => r.sessionId !== msg.sessionId);
      await saveDeliveries(ctx, filtered);
      await broadcastDeliveries(ctx);
      await refreshDeliveryRow(ctx, msg.sessionId);
      break;
    }
    case 'requestImage': {
      // The card gallery reads image thumbnails on demand instead of
      // persisting them — keeps the stored record small and also works for
      // already-recorded images. Read the file, embed as a base64 data URL
      // (bounded), and let the page slot it into the matching card.
      if (!msg.filePath) break;
      const filePath = msg.filePath;
      // Only files that are actually recorded: the page must not be able to
      // read arbitrary paths through this channel.
      if (!all.some((r) => r.filePath === filePath)) {
        await panel.postMessage({ type: 'imageData', filePath, error: 'unknown' });
        break;
      }
      try {
        const fileStat = await stat(filePath).catch(() => null);
        if (fileStat && fileStat.size > MAX_IMAGE_EMBED_BYTES) {
          ctx.logger.warn(`Skipping thumbnail for oversized image: ${filePath} (${fileStat.size} bytes)`);
          await panel.postMessage({ type: 'imageData', filePath, error: 'too-large' });
          break;
        }
        const buf = await readFile(filePath);
        const dataUrl = `data:${imageMime(filePath)};base64,${buf.toString('base64')}`;
        await panel.postMessage({ type: 'imageData', filePath, dataUrl });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.logger.warn(`Failed to read image for thumbnail: ${filePath} — ${message}`);
        await panel.postMessage({ type: 'imageData', filePath, error: 'unreadable' });
      }
      break;
    }
  }
}

// ── Activate ────────────────────────────────────────────────────────────────

export function activate(ctx: finch.MiniToolContext): void {
  // Records saved before revisions existed may repeat a path; fold them once.
  mergeDuplicatePaths(ctx)
    .then(async (n) => {
      if (!n) return;
      ctx.logger.info(`finch-delivery merged ${n} duplicate record(s) into revisions`);
      await broadcastDeliveries(ctx);
    })
    .catch((err) => ctx.logger.warn('Duplicate merge failed: ' + String(err)));

  // ── Icon pack ─────────────────────────────────────────────────────────────
  const iconPack = ctx.icons.register('delivery-icons', {
    'library': {
      svg:
        '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<rect width="8" height="18" x="3" y="3" rx="1"/>' +
        '<path d="M7 3v18"/>' +
        '<path d="M20.4 18.9c.2.5-.1 1.1-.6 1.3l-1.9.7c-.5.2-1.1-.1-1.3-.6L11.1 5.1c-.2-.5.1-1.1.6-1.3l1.9-.7c.5-.2 1.1.1 1.3.6Z"/>' +
        '</svg>',
    },
  });
  ctx.subscriptions.push(iconPack);

  // ── Panel open listener ──────────────────────────────────────────────────
  ctx.subscriptions.push(
    ctx.ui.onDidOpenPanel((panel) => {
      // Track the instance for broadcasts. Re-opening a still-alive
      // single-instance panel re-emits it here, so guard the one-time
      // listener binding with `boundPanels`.
      livePanels.add(panel);
      if (!boundPanels.has(panel)) {
        boundPanels.add(panel);
        ctx.subscriptions.push(
          panel.onDidDispose(() => livePanels.delete(panel)),
          panel.onDidReceiveMessage((msg) => handlePanelMessage(ctx, panel, msg)),
        );
      }
      // Proactively send current data on open
      loadDeliveries(ctx)
        .then((all) => postDeliveries(ctx, panel, all))
        .catch((err) => ctx.logger.warn(`Failed to push deliveries to panel ${panel.id}: ${String(err)}`));
    }),
  );

  // ── Agent tool ───────────────────────────────────────────────────────────
  const tool = ctx.tools.register({
    name: 'record_artifact',
    title: ctx.i18n.t('tool.title'),
    description: ctx.i18n.t('tool.description'),
    callDisplay: {
      inline: {
        mode: 'single',
        fields: [
          { path: 'filePath', format: 'path', maxLength: 48 },
          { path: 'sessionId', format: 'truncate', maxLength: 32 },
          { path: 'id', format: 'truncate', maxLength: 32 },
        ],
      },
    },
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['record', 'list', 'remove'],
          description: 'Operation to perform.',
        },
        filePath: {
          type: 'string',
          description:
            'Absolute path to the deliverable file (required for record). A path that is already recorded is updated as a new revision instead of creating a duplicate.',
        },
        fileType: {
          type: 'string',
          enum: ['md', 'word', 'ppt', 'pdf', 'excel', 'web', 'image', 'other'],
          description: 'File type category. If omitted, auto-detected from extension.',
        },
        title: {
          type: 'string',
          description:
            "Short name of what the deliverable is, in the user's language (required for record). Not the file name, and no version or draft markers such as V2 or draft — revisions are tracked automatically.",
        },
        description: {
          type: 'string',
          description: 'One-line description of what this deliverable contains.',
        },
        textPreview: {
          type: 'string',
          description: 'For Markdown files: first ~500 characters of content for thumbnail preview.',
        },
        sessionId: {
          type: 'string',
          description: 'Session ID to filter by (for list) or to associate with (for record).',
        },
        id: {
          type: 'string',
          description: 'Delivery record ID (required for remove).',
        },
      },
      required: ['action'],
    },
    risk: 'low',
    async execute(input, exec): Promise<finch.ToolResult> {
      const action = String(input.action ?? '');

      switch (action) {
        // ── record ─────────────────────────────────────────────────────────
        case 'record': {
          const filePath = String(input.filePath ?? '').trim();
          const title = String(input.title ?? '').trim();
          if (!filePath || !title) {
            return text('`record` requires both `filePath` and `title`.', true);
          }
          const description = String(input.description ?? '').trim();
          const fileType = String(input.fileType ?? '') || detectFileType(filePath);
          const textPreview = String(input.textPreview ?? '').slice(0, MAX_PREVIEW) || undefined;
          const sessionId = String(input.sessionId ?? exec.sessionId ?? '');
          // The execution context describes the caller, not an explicitly
          // supplied different session: leave that one unclassified for now.
          const space: SpaceRef = sessionId === String(exec.sessionId ?? '') ? resolveSpace(ctx, exec) : {};
          if (space.spaceId && !space.spaceName) {
            space.spaceName = (await loadSpaceNames(ctx))[space.spaceId] || undefined;
          } else {
            await learnSpaceName(ctx, space.spaceId, space.spaceName);
          }

          const all = await loadDeliveries(ctx);
          const existing = all.find((r) => pathKey(r.filePath) === pathKey(filePath));
          if (existing) {
            // Same file recorded again: a new revision of the same entry.
            existing.history = [historyEntry(existing), ...(existing.history ?? [])].slice(0, MAX_HISTORY);
            existing.firstCreatedAt = existing.firstCreatedAt ?? existing.createdAt;
            Object.assign(existing, { sessionId, filePath, fileName: baseName(filePath), fileType, title, description });
            existing.createdAt = Date.now();
            if (textPreview) existing.textPreview = textPreview;
            else delete existing.textPreview;
            if (space.spaceId) {
              existing.spaceId = space.spaceId;
              existing.spaceName = space.spaceName;
              existing.spaceDir = space.spaceDir;
            }
            await saveDeliveries(ctx, all);
            await refreshDeliveryRow(ctx, sessionId || undefined);
            await broadcastDeliveries(ctx);
            return text(
              `Deliverable updated: this file was already recorded, so this is revision ${existing.history.length + 1} of the same entry.\nTitle: ${title} (${fileType})\nID: ${existing.id}\nFile: ${existing.fileName}`,
            );
          }

          const record: DeliveryRecord = {
            id: randomUUID(),
            sessionId,
            spaceId: space.spaceId,
            spaceName: space.spaceName,
            spaceDir: space.spaceDir,
            filePath,
            fileName: baseName(filePath),
            fileType,
            title,
            description,
            textPreview,
            createdAt: Date.now(),
          };

          all.push(record);
          await saveDeliveries(ctx, all);
          await refreshDeliveryRow(ctx, sessionId || undefined);
          // Keep every already-open panel (right-side Panel App / appView
          // sidebar) in sync — a panel opened before this push would
          // otherwise never see the new record until manually reopened.
          await broadcastDeliveries(ctx);

          return text(
            `Deliverable recorded: ${title} (${fileType})\nID: ${record.id}\nFile: ${record.fileName}`,
          );
        }

        // ── list ───────────────────────────────────────────────────────────
        case 'list': {
          const all = await loadDeliveries(ctx);
          const filterSession = String(input.sessionId ?? '');
          const filtered = filterSession
            ? all.filter((r) => r.sessionId === filterSession)
            : all;

          if (filtered.length === 0) {
            return text('No deliverables found.');
          }

          const lines = filtered.map((r, i) => {
            const time = formatTime(r.createdAt);
            const revisions = r.history?.length ? `, ${r.history.length + 1} revisions` : '';
            return `${i + 1}. [${r.fileType}] ${r.title} — ${r.fileName} (${time}${revisions})\n   ID: ${r.id}`;
          });
          return text(
            `${filtered.length} deliverable(s):\n\n${lines.join('\n\n')}`,
          );
        }

        // ── remove ─────────────────────────────────────────────────────────
        case 'remove': {
          const id = String(input.id ?? '').trim();
          if (!id) {
            return text('`remove` requires `id`.', true);
          }
          const all = await loadDeliveries(ctx);
          const found = all.find((r) => r.id === id);
          if (!found) {
            return text(`No deliverable found with id: ${id}`, true);
          }
          const filtered = all.filter((r) => r.id !== id);
          await saveDeliveries(ctx, filtered);
          await refreshDeliveryRow(ctx, found.sessionId);
          await broadcastDeliveries(ctx);

          return text(`Removed: ${found.title} (${found.fileName})`);
        }

        default:
          return text(`Unknown action: ${action}`, true);
      }
    },
  });

  ctx.subscriptions.push(tool);

  ctx.logger.info('finch-delivery activated');
}
