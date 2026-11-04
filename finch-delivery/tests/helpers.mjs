// Shared fake host for the black-box tests: runs the real built `activate()`
// against an in-memory storage, a captured tool and fake panels.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activate } from '../dist/index.js';

/** Creates real files in a fresh temp directory and returns their paths. */
export async function tempFiles(names) {
  const dir = await mkdtemp(join(tmpdir(), 'finch-delivery-test-'));
  const paths = {};
  for (const name of names) {
    const path = join(dir, name);
    await writeFile(path, 'test');
    paths[name] = path;
  }
  return { dir, paths };
}

export function startHost({ store: initial = {}, workspace, ui = {} } = {}) {
  const store = structuredClone(initial);
  const previews = [];
  const host = { store, previews, row: undefined, tool: undefined, panelListener: undefined };
  const ctx = {
    storage: {
      get: async (k) => structuredClone(store[k]),
      set: async (k, v) => { store[k] = structuredClone(v); },
    },
    ui: {
      onDidOpenPanel: (listener) => { host.panelListener = listener; return { dispose() {} }; },
      delivery: {
        set: async (v) => { host.row = v; },
        remove: async () => { host.row = null; },
      },
      openFilePreview: async (path) => { previews.push(path); },
      ...ui,
    },
    workspace: workspace ?? { spaceId: undefined, spaceName: undefined, directoryPath: undefined, projectPath: undefined },
    icons: { register: () => ({ dispose() {} }) },
    tools: { register: (def) => { host.tool = def; return { dispose() {} }; } },
    subscriptions: [],
    logger: { info() {}, warn() {} },
    i18n: { t: (k, v) => (v && v.count ? `${k}:${v.count}` : k), has: () => false, locale: 'en-US' },
    app: { getInfo: async () => ({ assistantName: 'Finch' }) },
  };
  activate(ctx);

  host.record = (input, exec = { sessionId: 's1', spaceId: undefined }) =>
    host.tool.execute({ action: 'record', ...input }, exec);
  host.records = () => store.deliveries ?? [];
  host.settle = () => new Promise((r) => setTimeout(r, 30));
  host.openPanel = (props = {}) => {
    const posted = [];
    let receive;
    const panel = {
      id: 'panel-' + Math.random().toString(36).slice(2),
      view: 'session',
      sessionId: 's1',
      ...props,
      postMessage: async (m) => { posted.push(m); },
      onDidDispose: () => ({ dispose() {} }),
      onDidReceiveMessage: (listener) => { receive = listener; return { dispose() {} }; },
    };
    host.panelListener(panel);
    return {
      panel,
      posted,
      send: (m) => receive(m),
      last: (type) => [...posted].reverse().find((m) => m.type === type),
    };
  };
  return host;
}

/** The panel page's inline script, for slicing out pure helpers. */
export async function panelScript() {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(new URL('../dist/panel.html', import.meta.url), 'utf8');
  return html.match(/<script>([\s\S]*?)<\/script>/)[1];
}
