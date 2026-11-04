import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { nativeCalls, startHost, tempFiles } from './helpers.mjs';

const exists = (p) => access(p).then(() => true, () => false);
/** Paths handed to the (fake) Trash commands since `from`. */
const trashedSince = (from) => nativeCalls.slice(from).map((c) => c.args[c.args.length - 1]);
const noTrash = { skip: !['darwin', 'linux'].includes(process.platform) && 'the Trash is only reachable on macOS and Linux' };
const rec = (id, filePath, extra = {}) => ({
  id, sessionId: 's1', filePath, fileName: filePath.split('/').pop(), fileType: 'md',
  title: id, description: '', createdAt: 1, ...extra,
});

test('records saved before revisions existed are merged once at startup', async () => {
  const host = startHost({
    store: {
      deliveries: [
        rec('old', '/w/script.md', { title: 'script.md', description: 'first draft', createdAt: 1000, starred: true, spaceId: 'sp1', spaceName: 'Acme' }),
        rec('other', '/w/other.md', { createdAt: 1500 }),
        rec('new', '/w/script.md', { sessionId: 's2', title: 'Script', description: 'fact-checked', createdAt: 2000 }),
      ],
    },
  });
  await host.settle();
  assert.equal(host.records().length, 2);
  const merged = host.records().find((r) => r.filePath === '/w/script.md');
  assert.equal(merged.id, 'new', 'the newest record survives');
  assert.deepEqual(merged.history, [{ title: 'script.md', description: 'first draft', sessionId: 's1', recordedAt: 1000 }]);
  assert.equal(merged.firstCreatedAt, 1000);
  assert.equal(merged.starred, true, 'a star on any duplicate is kept');
  assert.equal(merged.spaceId, 'sp1', 'an older Space fills a gap');

  const again = startHost({ store: host.store });
  await again.settle();
  assert.equal(again.records().length, 2, 'merging is idempotent');
});

test('recording a path again updates the same entry as a revision', async () => {
  const host = startHost();
  await host.record({ filePath: '/w/plan.md', title: 'Plan', description: 'v1 notes' });
  const out = await host.record({ filePath: '/w//plan.md', title: 'Plan', description: 'reworked', textPreview: '# Plan' }, { sessionId: 's2', spaceId: undefined });
  assert.equal(out.isError, false);
  assert.match(out.content[0].text, /revision 2/);
  assert.equal(host.records().length, 1);
  const r = host.records()[0];
  assert.equal(r.description, 'reworked');
  assert.equal(r.sessionId, 's2');
  assert.equal(r.textPreview, '# Plan');
  assert.equal(r.history.length, 1);
  assert.equal(r.history[0].description, 'v1 notes');

  await host.record({ filePath: '/w/other.md', title: 'Other' });
  assert.equal(host.records().length, 2, 'a new path is still a new entry');
  const list = await host.tool.execute({ action: 'list' }, { sessionId: 's1' });
  assert.match(list.content[0].text, /Plan — plan\.md \([^)]*, 2 revisions\)/);
});

test('the tool tells the AI how to title and when to record', async () => {
  for (const file of ['en-US', 'zh-CN']) {
    const i18n = JSON.parse(await readFile(new URL(`../i18n/${file}.json`, import.meta.url), 'utf8'));
    assert.match(i18n['tool.description'], /filePath/);
    assert.match(i18n['tool.description'], file === 'en-US' ? /new revision/ : /新修订/);
  }
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.finch.systemPrompt, /revision of the existing entry/);
  assert.equal(pkg.finch.permissions.shell, true, 'shell runs the open / reveal / Trash commands');
});

test('remove deletes every delivery of an entry and, if asked, moves their files to the Trash', noTrash, async () => {
  const { dir, paths } = await tempFiles(['run-preview.md', 'run-v2-preview.md', 'keep.md']);
  const p1 = paths['run-preview.md'];
  const p2 = paths['run-v2-preview.md'];
  const host = startHost({
    store: {
      deliveries: [
        rec('1', p1), rec('2', p2, { createdAt: 2 }), rec('3', dir + '/already-gone.md', { createdAt: 3 }),
        rec('6', paths['keep.md'], { createdAt: 4 }),
      ],
    },
  });
  await host.settle();
  const view = host.openPanel();
  const before = nativeCalls.length;
  await view.send({ type: 'remove', id: '1', ids: ['1', '2', '3'], deleteFile: true });
  assert.deepEqual(host.records().map((r) => r.id), ['6']);
  assert.deepEqual(trashedSince(before).sort(), [p1, p2].sort(), 'a file already gone is skipped');
  assert.equal(view.last('removeResult').fileDeleteError, undefined);
  assert.deepEqual(view.last('removeResult').ids, ['1', '2', '3']);

  const mid = nativeCalls.length;
  await view.send({ type: 'remove', id: '6', deleteFile: false });
  assert.equal(host.records().some((r) => r.id === '6'), false, 'a single id still works');
  assert.equal(nativeCalls.length, mid, 'an unchecked box never touches the file');
  assert.equal(await exists(paths['keep.md']), true);
});

test('remove leaves a file that another remaining record still points to', noTrash, async () => {
  const { paths } = await tempFiles(['shared.md']);
  const host = startHost({ store: { deliveries: [rec('b', '/elsewhere/x.md', { sessionId: 's2' })] } });
  await host.settle();
  // Two records of one path only exist transiently (before the startup
  // merge); deleting one of them must leave the file for the other.
  host.store.deliveries.push(rec('a', paths['shared.md'], { sessionId: 's1' }), rec('c', paths['shared.md'], { sessionId: 's3', createdAt: 5 }));
  const view = host.openPanel();
  const before = nativeCalls.length;
  await view.send({ type: 'remove', ids: ['a'], deleteFile: true });
  assert.deepEqual(trashedSince(before), []);
  assert.equal(await exists(paths['shared.md']), true);
});

test('toggleStar stars and unstars every delivery of an entry together', async () => {
  const host = startHost({ store: { deliveries: [rec('1', '/w/run/a.md'), rec('2', '/w/run-v2/a.md'), rec('3', '/w/b.md')] } });
  await host.settle();
  const view = host.openPanel();
  await view.send({ type: 'toggleStar', id: '1', ids: ['1', '2'], value: true });
  assert.deepEqual(host.records().filter((r) => r.starred).map((r) => r.id), ['1', '2']);
  await view.send({ type: 'toggleStar', ids: ['1', '2'], value: false });
  assert.equal(host.records().some((r) => 'starred' in r), false);
});

test('the sidebar row counts a re-delivered document once, images by path', async () => {
  const host = startHost();
  for (const d of ['run', 'run-v2', 'run-v3']) {
    await host.record({ filePath: `/w/${d}/preview.md`, title: 'Daily report' });
  }
  assert.equal(host.records().length, 3, 'different paths stay separate records, so each opens');
  assert.equal(host.row.detail, 'delivery.detailSingle:1');
  await host.record({ filePath: '/w/raw/chart.png', title: 'Chart' });
  await host.record({ filePath: '/w/redacted/chart.png', title: 'Chart (redacted)' });
  assert.equal(host.row.detail, 'delivery.detailMixed:3', 'an image in another folder is another deliverable');
});
