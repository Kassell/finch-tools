import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeCalls, startHost, tempFiles } from './helpers.mjs';

test('openPreview resolves the path from the record id, never from the page', async () => {
  const { paths } = await tempFiles(['report.md']);
  const host = startHost();
  await host.record({ filePath: paths['report.md'], title: 'Report' });
  const id = host.records()[0].id;
  const view = host.openPanel();
  await view.send({ type: 'openPreview', id, requestId: 'r1', filePath: '/etc/passwd' });
  assert.deepEqual(host.previews, [paths['report.md']]);
  assert.deepEqual(view.last('openResult'), { type: 'openResult', id, requestId: 'r1', mode: 'preview', ok: true });
});

test('openPreview reports why a file cannot be opened', async () => {
  const { dir, paths } = await tempFiles(['a.md']);
  const host = startHost({
    store: {
      deliveries: [
        { id: 'gone', sessionId: 's1', filePath: dir + '/missing.md', fileName: 'missing.md', fileType: 'md', title: 'x', description: '', createdAt: 1 },
        { id: 'rel', sessionId: 's1', filePath: 'relative.md', fileName: 'relative.md', fileType: 'md', title: 'x', description: '', createdAt: 2 },
        { id: 'dir', sessionId: 's1', filePath: dir, fileName: 'dir', fileType: 'other', title: 'x', description: '', createdAt: 3 },
      ],
    },
  });
  const view = host.openPanel();
  const before = nativeCalls.length;
  for (const type of ['openPreview', 'openNative', 'revealNative']) {
    for (const [id, reason] of [['gone', 'missingFile'], ['rel', 'invalidPath'], ['dir', 'invalidPath'], ['nope', 'missingRecord']]) {
      await view.send({ type, id, requestId: id, filePath: paths['a.md'] });
      assert.equal(view.last('openResult').ok, false, `${type} ${id}`);
      assert.equal(view.last('openResult').error, reason, `${type} ${id}`);
    }
  }
  assert.equal(host.previews.length, 0, 'invalid records never open anything');
  assert.equal(nativeCalls.length, before, 'invalid records never launch a command');
});

test('requestImage only reads files that are recorded', async () => {
  const { paths } = await tempFiles(['shot.png', 'secret.png']);
  const host = startHost();
  await host.record({ filePath: paths['shot.png'], title: 'Shot' });
  const view = host.openPanel();
  await view.send({ type: 'requestImage', filePath: paths['secret.png'] });
  assert.deepEqual(view.last('imageData'), { type: 'imageData', filePath: paths['secret.png'], error: 'unknown' });
  await view.send({ type: 'requestImage', filePath: paths['shot.png'] });
  assert.match(view.last('imageData').dataUrl, /^data:image\/png;base64,/);
});

test('panel pushes flag files that are gone from disk', async () => {
  const { dir, paths } = await tempFiles(['here.md']);
  const host = startHost({
    store: {
      deliveries: [
        { id: 'a', sessionId: 's1', filePath: paths['here.md'], fileName: 'here.md', fileType: 'md', title: 'Here', description: '', createdAt: 1 },
        { id: 'b', sessionId: 's1', filePath: dir + '/gone.md', fileName: 'gone.md', fileType: 'md', title: 'Gone', description: '', createdAt: 2 },
      ],
    },
  });
  const view = host.openPanel();
  await view.send({ type: 'requestDeliveries' });
  const data = view.last('deliveries').data;
  assert.equal(data.find((r) => r.id === 'a').missing, undefined);
  assert.equal(data.find((r) => r.id === 'b').missing, true);
  assert.equal(host.records().some((r) => 'missing' in r), false, 'the flag is never persisted');
});
