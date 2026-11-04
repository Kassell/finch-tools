import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { panelScript, startHost } from './helpers.mjs';

test('records carry the Space of the calling session', async () => {
  const host = startHost({ workspace: { spaceId: 'ops', spaceName: 'Ops', directoryPath: '/w/ops', projectPath: undefined } });
  const caller = { sessionId: 's-ops', spaceId: 'ops' };
  await host.record({ title: 'Here', filePath: '/one.md' }, caller);
  assert.equal(host.records()[0].spaceId, 'ops');
  assert.equal(host.records()[0].spaceName, 'Ops');
  await host.record({ title: 'Elsewhere', filePath: '/two.md', sessionId: 's-other' }, caller);
  assert.equal(host.records()[1].spaceId, undefined, 'another session cannot inherit the caller Space');
  await host.record({ title: 'Other Space', filePath: '/three.md' }, { sessionId: 's-x', spaceId: 'acme' });
  assert.equal(host.records()[2].spaceId, 'acme');
  assert.equal(host.records()[2].spaceName, undefined, 'the activation Space name is not borrowed for a different Space');
});

test('a panel opened in a session fills in that session\'s Space', async () => {
  const host = startHost();
  await host.record({ title: 'Old', filePath: '/two.md' }, { sessionId: 's-other', spaceId: undefined });
  const view = host.openPanel({ sessionId: 's-other', spaceId: 'acme', spaceName: 'Acme' });
  await view.send({ type: 'requestDeliveries' });
  assert.equal(host.records()[0].spaceId, 'acme');
  assert.equal(host.records()[0].spaceName, 'Acme');
  assert.deepEqual(view.last('deliveries').env.spaceNames, { acme: 'Acme' });

  host.store.deliveries.push({ id: 'x', sessionId: 's-moved', spaceId: 'acme', filePath: '/x.md', fileName: 'x.md', fileType: 'md', title: 'x', description: '', createdAt: 9 });
  const other = host.openPanel({ sessionId: 's-moved', spaceId: 'ops', spaceName: 'Ops' });
  await other.send({ type: 'requestDeliveries' });
  assert.equal(host.records().find((r) => r.id === 'x').spaceId, 'acme', 'never replace an existing, different Space');
});

test('the page labels groups with the live Space name', async () => {
  const script = await panelScript();
  const start = script.indexOf('  function normPath(p)');
  const end = script.indexOf('  var DATE_ORDER', start);
  assert.ok(start >= 0 && end > start);
  const sandbox = {
    spacesList: [{ id: 'acme', name: 'Acme Corp', alias: 'Acme' }],
    spaceNames: { acme: 'Stale name' },
    currentSpaceId: '', currentSpaceName: '', t: () => 'No Space',
  };
  vm.createContext(sandbox);
  vm.runInContext(script.slice(start, end), sandbox);
  assert.equal(sandbox.spaceOf({ spaceId: 'acme', spaceName: 'Stale name' }).label, 'Acme', 'the Space alias beats a stored name');
  assert.equal(sandbox.spaceOf({ spaceId: 'unknown', spaceName: 'Stale name' }).label, 'unknown', 'never show an untrusted stored name');
  assert.equal(sandbox.spaceOf({ filePath: '/w/Acme/report.md' }).key, 'id:acme', 'old records match a folder named like the Space');
});
