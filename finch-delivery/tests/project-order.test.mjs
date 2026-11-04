import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { panelScript } from './helpers.mjs';

test('project groups can be reordered and keep their slots', async () => {
  const script = await panelScript();
  const start = script.indexOf('  function normPath(p)');
  const end = script.indexOf('  function renderTabs()', start);
  assert.ok(start >= 0 && end > start);
  const storage = new Map();
  const sandbox = {
    spacesList: [], spaceNames: {}, currentSpaceId: '', currentSpaceName: '',
    groupMode: 'space', spaceOrder: [], LS_SPACE_ORDER: 'order',
    deliveries: [
      { spaceId: 'a', createdAt: 3 },
      { spaceId: 'b', createdAt: 2 },
      { spaceId: 'c', createdAt: 1 },
    ],
    t: () => 'No space',
    localStorage: { setItem: (k, v) => storage.set(k, v) },
    window: { addEventListener() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(script.slice(start, end), sandbox);
  const order = () => Array.from(sandbox.buildGroups(sandbox.deliveries), (g) => g.key);
  assert.deepEqual(order(), ['id:a', 'id:b', 'id:c']);
  assert.equal(sandbox.moveSpaceGroup('id:c', 'id:b', false, sandbox.buildGroups(sandbox.deliveries)), true);
  assert.deepEqual(order(), ['id:a', 'id:c', 'id:b']);
  assert.deepEqual(JSON.parse(storage.get('order')), ['id:a', 'id:c', 'id:b']);
  // Reload from storage; an extra unsorted group appears after saved groups.
  sandbox.spaceOrder = JSON.parse(storage.get('order'));
  sandbox.deliveries.unshift({ spaceId: 'new', createdAt: 4 });
  assert.deepEqual(order(), ['id:a', 'id:c', 'id:b', 'id:new']);
  // Only a and b visible: swap them, leaving c and new in their positions.
  const visible = sandbox.buildGroups(sandbox.deliveries.filter((r) => r.spaceId === 'a' || r.spaceId === 'b'));
  assert.equal(sandbox.moveSpaceGroup('id:b', 'id:a', false, visible), true);
  assert.deepEqual(order(), ['id:b', 'id:c', 'id:a', 'id:new']);
  // An absent group retains its slot across later edits.
  sandbox.deliveries = sandbox.deliveries.filter((r) => r.spaceId !== 'c');
  assert.equal(sandbox.moveSpaceGroup('id:new', 'id:a', false, sandbox.buildGroups(sandbox.deliveries)), true);
  sandbox.deliveries.push({ spaceId: 'c', createdAt: 1 });
  assert.deepEqual(order(), ['id:b', 'id:c', 'id:new', 'id:a']);
  assert.equal(sandbox.moveSpaceGroup('id:b', 'id:b', false, sandbox.buildGroups(sandbox.deliveries)), false);
  // Move across several groups and insert after the target.
  assert.equal(sandbox.moveSpaceGroup('id:b', 'id:a', true, sandbox.buildGroups(sandbox.deliveries)), true);
  assert.deepEqual(order(), ['id:c', 'id:new', 'id:a', 'id:b']);
  assert.equal(sandbox.moveSpaceGroup('id:c', 'id:new', false, sandbox.buildGroups(sandbox.deliveries)), false);
});
