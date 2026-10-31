import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fixtureLink, fixtureRm, nativeTarget } from './test-platform.mjs';
import { activate, KNOWLEDGE_ACTIONS } from './test-store.mjs';

async function snapshot(root) {
  const result = {};
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.knowledge') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { result[path] = 'directory'; await walk(path); }
      else {
        const info = await stat(path);
        result[path] = { hash: createHash('sha256').update(await readFile(path)).digest('hex'), size: info.size, mtime: info.mtimeMs };
      }
    }
  }
  await walk(root);
  return result;
}

async function harness(t) {
  const root = await mkdtemp(join(tmpdir(), 'finch-knowledge-boundary-'));
  t.after(() => fixtureRm(root, { recursive: true, force: true }));
  const source = join(root, 'sources');
  await mkdir(join(source, 'nested'), { recursive: true });
  await writeFile(join(source, 'nested', 'notes.md'), '# Boundary\n\nOriginalkeyword remains unchanged.');
  await writeFile(join(source, 'unindexed.bin'), 'Preserve unsupported source data.');
  const engine = join(root, 'lancedb-engine', '0.39.0');
  await mkdir(engine, { recursive: true });
  await fixtureLink(resolve(`node_modules/@lancedb/lancedb-${nativeTarget}/lancedb.${nativeTarget}.node`), join(engine, `lancedb.${nativeTarget}.node`));
  const copy = JSON.parse(await readFile(new URL('../i18n/en-US.json', import.meta.url), 'utf8'));
  let tool, receive, open;
  const sent = [];
  const values = new Map([['sourceDirectory', source]]);
  activate({
    storagePath: root, subscriptions: [],
    storage: { get: async key => values.get(key), set: async (key, value) => { values.set(key, value); } },
    i18n: { t: (key, replacements = {}) => Object.entries(replacements).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), copy[key] ?? key) },
    app: { getInfo: () => ({ locale: 'en-US' }) },
    tools: { register(definition) { tool = definition; return { dispose() {} }; } },
    composerActions: { register() { return { dispose() {}, notifyUpdate() {} }; } },
    ui: { onDidOpenPanel(handler) { open = handler; return { dispose() {} }; }, pickFile: async () => assert.fail('No source importing') },
  });
  open({ id: 'boundary', view: 'appView', postMessage: async message => { sent.push(message); },
    onDidReceiveMessage(handler) { receive = handler; return { dispose() {} }; }, onDidDispose() { return { dispose() {} }; } });
  const exec = { cwd: root, signal: new AbortController().signal, progress: { report() {} } };
  return { source, tool, receive, sent, exec };
}

test('the public schema and runtime reject retired source-writing actions, including stale clients', async t => {
  const { source, tool, receive, sent, exec } = await harness(t);
  const before = await snapshot(source);
  assert.deepEqual(tool.inputSchema.properties.action.enum, KNOWLEDGE_ACTIONS);
  for (const field of ['url', 'refine', 'title', 'content']) assert.equal(field in tool.inputSchema.properties, false);
  for (const action of ['import', 'import_url', 'save_document', 'delete', 'remove', 'backup']) {
    assert.equal(KNOWLEDGE_ACTIONS.includes(action), false);
    const result = await tool.execute({ action, path: 'nested/notes.md', url: 'https://invalid.example', title: 'forbidden', content: 'must not write' }, exec);
    assert.equal(result.isError, true, action);
    assert.match(result.content[0].text, /only maintains indexes and tags/);
  }
  for (const type of ['addFiles', 'uploadStart', 'uploadChunk', 'uploadFinish', 'uploadAbort', 'uploadCancel', 'delete', 'backup']) {
    await receive({ type, requestId: type, id: 'anything', path: source });
    const reply = sent.find(message => message.requestId === type);
    assert.equal(reply?.type, 'error', type);
    assert.match(reply.error, /only maintains indexes and tags/);
  }
  assert.deepEqual(await snapshot(source), before, 'no original names, bytes or modification times change');
});

test('indexing, classification and repeated scans only write private knowledge data', async t => {
  const { source, tool, exec, receive, sent } = await harness(t);
  const before = await snapshot(source);
  const call = async input => {
    const result = await tool.execute(input, exec);
    assert.equal(result.isError, false, result.content[0].text);
    return result.content[0].text;
  };
  await call({ action: 'index', path: 'nested/notes.md', tag: 'Research' });
  await receive({ type: 'page', requestId: 'coverage-page' });
  const page = sent.find(message => message.requestId === 'coverage-page');
  assert.equal(page.documents[0].indexState, 'indexed', 'the real page bridge includes verified coverage');
  assert.equal(page.documents[0].indexedChunks, page.documents[0].chunks);
  assert.equal(page.documents[0].status, 'ready');
  assert.ok(sent.some(message => message.type === 'documentStatus' && message.phase === 'processing'), 'indexing emits live row-state changes');
  await receive({ type: 'locate', requestId: 'coverage-locate', id: page.documents[0].id });
  assert.equal(sent.find(message => message.requestId === 'coverage-locate').documents[0].indexState, 'indexed');
  await call({ action: 'rename_tag', tag: 'Research', name: 'Topics' });
  await call({ action: 'sync' });
  await call({ action: 'sync' });
  const progress = sent.filter(message => message.type === 'scanProgress');
  assert.ok(progress.some(message => message.percent === 0));
  assert.ok(progress.some(message => message.percent === 100));
  assert.ok(progress.every(message => message.root === source && message.percent >= 0 && message.percent <= 100));
  assert.match(await call({ action: 'search', query: 'Originalkeyword' }), /notes.md/);
  await call({ action: 'delete_tag', tag: 'Topics', force: true });
  for (const path of ['../escape.md', '.knowledge/catalog.sqlite', '.KNOWLEDGE/catalog.sqlite']) {
    assert.equal((await tool.execute({ action: 'index', path }, exec)).isError, true);
  }
  assert.deepEqual(await snapshot(source), before);
  assert.equal((await stat(join(source, '.knowledge', 'catalog.sqlite'))).isFile(), true);
});

test('the directory UI exposes scanning and source-folder access, not file management', async () => {
  const html = await readFile(new URL('../src/view.html', import.meta.url), 'utf8');
  const view = await readFile(new URL('../src/view.ts', import.meta.url), 'utf8');
  for (const id of ['sync', 'open-directory']) assert.match(html, new RegExp(`id="${id}"`));
  for (const id of ['add', 'file-input', 'backup', 'row-remove']) assert.doesNotMatch(html, new RegExp(`id="${id}"`));
  assert.doesNotMatch(view, /request\('(uploadStart|uploadChunk|uploadFinish|addFiles|delete|backup)'/);
  assert.match(view, /directoryDropHint/);
});
