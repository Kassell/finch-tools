import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { native, nativeCalls, panelScript, startHost, tempFiles } from './helpers.mjs';

const realPlatform = process.platform;
async function onPlatform(platform, fn) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  }
}
async function setup(name = '中文 空格 $(not-a-command).pptx', hostOptions) {
  const { dir, paths } = await tempFiles([name]);
  const host = startHost(hostOptions);
  await host.record({ filePath: paths[name], title: 'Deck' });
  return { dir, path: paths[name], host, view: host.openPanel(), id: host.records()[0].id };
}
function callsSince(from) {
  return nativeCalls.slice(from);
}

test('open in the default app and show in folder use the platform command, path as one argument', async () => {
  const { dir, path, view, id } = await setup();
  const expected = {
    darwin: { openNative: ['/usr/bin/open', [path]], revealNative: ['/usr/bin/open', ['-R', path]] },
    linux: { openNative: ['xdg-open', [path]], revealNative: ['xdg-open', [dir]] },
    win32: { openNative: ['explorer.exe', [path]], revealNative: ['explorer.exe', ['/select,' + path]] },
  };
  for (const platform of Object.keys(expected)) {
    for (const type of ['openNative', 'revealNative']) {
      const before = nativeCalls.length;
      await onPlatform(platform, () => view.send({ type, id, requestId: type }));
      assert.equal(view.last('openResult').ok, true, `${platform} ${type}`);
      const [file, args] = expected[platform][type];
      assert.deepEqual(callsSince(before), [{ file, args }], `${platform} ${type}`);
    }
  }
  await onPlatform('aix', () => view.send({ type: 'openNative', id, requestId: 'x' }));
  assert.equal(view.last('openResult').error, 'platform');
});

test('explorer.exe exit codes are ignored, other command failures are reported', async () => {
  const { view, id } = await setup();
  native.fail = () => Object.assign(new Error('exit 1'), { code: 1 });
  try {
    await onPlatform('win32', () => view.send({ type: 'openNative', id, requestId: 'w' }));
    assert.equal(view.last('openResult').ok, true);
    await onPlatform('darwin', () => view.send({ type: 'openNative', id, requestId: 'm' }));
    assert.equal(view.last('openResult').ok, false);
    assert.equal(view.last('openResult').error, 'nativeFailed');
  } finally {
    native.fail = null;
  }
});

test('a file Finch cannot preview opens in the default app instead', async () => {
  for (const ui of [{ openFilePreview: undefined }, { openFilePreview: async () => { throw new Error('refused'); } }]) {
    const { path, view, id } = await setup('report.md', { ui });
    const before = nativeCalls.length;
    await onPlatform('darwin', () => view.send({ type: 'openPreview', id, requestId: 'p' }));
    assert.equal(view.last('openResult').ok, true);
    assert.equal(view.last('openResult').mode, 'native');
    assert.deepEqual(callsSince(before), [{ file: '/usr/bin/open', args: [path] }]);
  }
});

test('moving to the Trash never falls back to a permanent delete', async () => {
  const { path, host, view, id } = await setup('a.md');
  const record = { ...host.records()[0] };
  const remove = async (platform) => {
    host.store.deliveries = [{ ...record }];
    const before = nativeCalls.length;
    await onPlatform(platform, () => view.send({ type: 'remove', id, deleteFile: true }));
    return { calls: callsSince(before), result: view.last('removeResult') };
  };

  let r = await remove('darwin');
  assert.deepEqual(r.calls, [{ file: '/usr/bin/trash', args: [path] }]);
  assert.equal(r.result.fileDeleteError, undefined);

  // No /usr/bin/trash on this macOS → ask Finder, with the path as argv, not inside the script.
  native.fail = (file) => (file === '/usr/bin/trash' ? Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) : null);
  r = await remove('darwin');
  assert.equal(r.calls[1].file, '/usr/bin/osascript');
  assert.equal(r.calls[1].args.at(-1), path);
  assert.ok(!r.calls[1].args.slice(0, -1).some((a) => a.includes(path)));
  assert.equal(r.result.fileDeleteError, undefined);

  // A real Trash failure is reported and nothing else is tried.
  native.fail = (file) => (file === '/usr/bin/trash' ? Object.assign(new Error('not permitted'), { code: 1 }) : null);
  r = await remove('darwin');
  assert.equal(r.calls.length, 1);
  assert.ok(r.result.fileDeleteError);
  native.fail = null;

  r = await remove('linux');
  assert.deepEqual(r.calls, [{ file: 'gio', args: ['trash', path] }]);

  r = await remove('win32');
  assert.deepEqual(r.calls, [], 'no Trash on this platform: the file is left in place');
  assert.match(r.result.fileDeleteError, /not supported/);
});

test('the page previews what Finch can render and opens the rest in the default app', async () => {
  const script = await panelScript();
  const start = script.indexOf('  var PREVIEW_TEXT_EXT');
  const end = script.indexOf('  // App View (the sidebar entry)', start);
  assert.ok(start >= 0 && end > start);
  const page = {};
  vm.createContext(page);
  vm.runInContext(script.slice(start, end), page);
  const MB = 1024 * 1024;
  for (const [name, size, previewed] of [
    ['a.md', 10, true], ['b.png', 10, true], ['c.html', 10, true], ['d.pdf', 50 * MB, true],
    ['e.docx', 10, true], ['f.xlsx', 10, true], ['g.xlsx', 25 * MB, false], ['h.pptx', 10, false],
    ['i.xls', 10, false], ['j.csv', 10, false], ['k.mp4', 10, false],
  ]) assert.equal(!!page.previewKind({ filePath: '/w/' + name, fileSize: size }), previewed, name);
  assert.equal(page.previewKind({ filePath: '/w/a.md', missing: true }), '');
});
