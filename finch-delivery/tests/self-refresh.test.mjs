import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { panelScript, startHost } from './helpers.mjs';

test('every push carries the fingerprint of the page file on disk', async () => {
  const html = await readFile(new URL('../dist/panel.html', import.meta.url));
  const expected = createHash('sha1').update(html).digest('hex').slice(0, 12);
  const host = startHost();
  const view = host.openPanel({ view: 'appView', sessionId: undefined });
  await host.settle();
  assert.equal(view.last('deliveries').env.pageBuild, expected);
});

test('an open page reloads once when its file changed, keeping its state', async () => {
  const script = await panelScript();
  const start = script.indexOf('  // ── Self-refresh when dist/panel.html changes');
  const end = script.indexOf('  var TYPE_ORDER', start);
  assert.ok(start >= 0 && end > start);
  function makePage(saved) {
    const store = new Map(saved ? [['finch-delivery.restore', saved]] : []);
    const page = {
      filterMode: 'all', userPickedTab: false, searchQuery: '', projectFilter: 'all', typeFilter: 'all', expandedVersions: {},
      searchEl: { value: '' }, reloads: 0, modalOpen: false, store,
      sessionStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
      window: { scrollY: 640 },
    };
    page.location = { reload: () => { page.reloads++; } };
    page.document = { querySelector: () => (page.modalOpen ? {} : null) };
    vm.createContext(page);
    vm.runInContext(script.slice(start, end), page);
    return page;
  }

  const p = makePage();
  p.checkPageBuild('aaa');
  p.checkPageBuild('aaa');
  assert.equal(p.reloads, 0, "the first fingerprint is the page's own");
  p.modalOpen = true;
  p.checkPageBuild('bbb');
  assert.equal(p.reloads, 0, 'never reloads under an open dialog');
  p.modalOpen = false;
  Object.assign(p, { searchQuery: 'report', projectFilter: 'id:acme', typeFilter: 'md', filterMode: 'starred', userPickedTab: true, expandedVersions: { 'k': true } });
  p.checkPageBuild('bbb');
  assert.equal(p.reloads, 1);

  const q = makePage(p.store.get('finch-delivery.restore'));
  assert.equal(q.searchQuery, 'report');
  assert.equal(q.searchEl.value, 'report');
  assert.equal(q.projectFilter, 'id:acme');
  assert.equal(q.typeFilter, 'md');
  assert.equal(q.filterMode, 'starred');
  assert.equal(q.expandedVersions.k, true);
  assert.equal(q.restoreScrollY, 640);
  assert.equal(q.store.has('finch-delivery.restore'), false, 'the saved state is used once');
  q.checkPageBuild('bbb');
  assert.equal(q.reloads, 0, 'the reloaded page adopts the new fingerprint — no reload loop');
});
