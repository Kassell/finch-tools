import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { panelScript } from './helpers.mjs';

const script = await panelScript();
new vm.Script(script, { filename: 'panel.html' });

function slice(from, to) {
  const start = script.indexOf(from);
  const end = script.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `markers ${from} … ${to}`);
  return script.slice(start, end);
}

const ids = (list) => Array.from(list, (r) => r.id);

test('one entry per deliverable, however often it was delivered', () => {
  const page = {
    normPath: (p) => String(p || '').replace(/\/+$/, ''),
    dirOf: (p) => p.slice(0, p.lastIndexOf('/')),
    dayKey: (ts) => new Date(ts).toDateString(),
    classifyFile: (r) => (/\.(png|jpg)$/i.test(r.fileName || r.filePath) ? 'image' : 'md'),
  };
  vm.createContext(page);
  vm.runInContext(slice('  function versionKeys(', '  // Shared prefix'), page);

  const T = new Date(2026, 10, 2, 16, 0).getTime();
  const min = 60000;
  const recs = [];
  // A report delivered three times, each into its own run folder.
  ['run', 'run-v2', 'run-v3'].forEach((d, i) => recs.push({ id: 'pv' + i, sessionId: 'S1', filePath: `/w/${d}/preview.md`, fileName: 'preview.md', title: 'Report ' + i, createdAt: T + i * min }));
  // Five charts, then a redacted copy of each in another folder.
  for (let i = 1; i <= 5; i++) {
    recs.push({ id: 'raw' + i, sessionId: 'S2', filePath: `/w/charts/chart${i}.png`, fileName: `chart${i}.png`, title: `Chart ${i}`, createdAt: T + 60 * min + i * 1000 });
    recs.push({ id: 'red' + i, sessionId: 'S2', filePath: `/w/charts-redacted/chart${i}.png`, fileName: `chart${i}.png`, title: `Chart ${i} (redacted)`, createdAt: T + 65 * min + i * 1000 });
  }
  // The same file name in another session is a different deliverable.
  recs.push({ id: 'other', sessionId: 'S3', filePath: '/w/x/preview.md', fileName: 'preview.md', title: 'Other', createdAt: T + 90 * min });
  const sorted = recs.slice().sort((a, b) => b.createdAt - a.createdAt);

  const units = page.buildUnits(sorted);
  const report = units.find((u) => u.kind === 'single' && u.record.sessionId === 'S1');
  assert.equal(report.record.id, 'pv2', 'the newest delivery is the head');
  assert.deepEqual(ids(report.records), ['pv2', 'pv1', 'pv0']);
  const albums = units.filter((u) => u.kind === 'album');
  assert.equal(albums.length, 2, 'redacted copies in another folder are a separate album');
  assert.deepEqual(Array.from(albums, (a) => a.items.length), [5, 5]);
  assert.equal(units.length, 4, 'report, two albums and the other session');
  assert.equal(page.uniqueCount(recs), 12, '1 report + 10 images + 1 other');
  assert.deepEqual({ ...page.countUnitsBy(recs, page.classifyFile) }, { md: 2, image: 10 });

  // Revisions folded into one record by the backend are listed, not openable.
  const folded = page.groupVersions([{ id: 'a', sessionId: 's', filePath: '/x.md', fileName: 'x.md', title: 'New', createdAt: 3000, history: [{ title: 'Old', recordedAt: 1000 }] }]);
  assert.equal(folded[0].versions.length, 2);
  assert.equal(folded[0].versions[1].isRevision, true);
  assert.deepEqual(ids(folded[0].records), ['a'], 'star and delete only act on real records');

  // The same path always merges, even across sessions; a star on any delivery stars the entry.
  const cross = page.groupVersions([
    { id: 'b', sessionId: 'S9', filePath: '/w/a.md', fileName: 'a.md', title: 'b', createdAt: 2 },
    { id: 'a', sessionId: 'S8', filePath: '/w/a.md', fileName: 'a.md', title: 'a', createdAt: 1, starred: true },
  ]);
  assert.equal(cross.length, 1);
  assert.equal(page.unitStarred(cross[0]), true);
});

test('album titles keep the shared part of a batch', () => {
  const page = {};
  vm.createContext(page);
  vm.runInContext(slice('  function albumTitle(', '  function dayLabel('), page);
  assert.equal(page.albumTitle([{ title: 'Sales chart 1 (redacted)' }, { title: 'Sales chart 2 (redacted)' }]), 'Sales chart (redacted)');
  assert.equal(page.albumTitle([{ title: 'Alpha' }, { title: 'Beta' }]), 'Beta', 'nothing shared → the latest title');
});

test('file types are recognised by extension and filter together with scope', () => {
  const page = {
    TYPE_ORDER: ['all', 'image', 'excel', 'word', 'pdf', 'ppt', 'md', 'web', 'text', 'audio', 'video', 'archive', 'ebook', 'other'],
    typeFilter: 'all', filterMode: 'all', currentSessionId: 's1', deliveries: [],
    searchQuery: '', projectFilter: 'all', spaceOf: () => ({ key: '__none__', label: '', last: true }),
  };
  vm.createContext(page);
  vm.runInContext(slice('  function classifyFile(r)', '  // ── Card motion'), page);
  for (const [name, type] of [
    ['a.JPG', 'image'], ['b.XLSX', 'excel'], ['c.tsv', 'excel'], ['d.docx', 'word'], ['e.PDF', 'pdf'],
    ['f.pptx', 'ppt'], ['g.md', 'md'], ['h.html', 'web'], ['i.txt', 'text'], ['j.mp3', 'audio'],
    ['k.mp4', 'video'], ['l.zip', 'archive'], ['m.epub', 'ebook'], ['n.xyz', 'other'],
  ]) assert.equal(page.classifyFile({ filePath: '/dir/' + name, fileType: 'other' }), type, name);
  page.deliveries = [
    { id: '1', sessionId: 's1', filePath: '/a.xlsx', fileType: 'other', title: 'Budget' },
    { id: '2', sessionId: 's2', filePath: '/b.xlsx', fileType: 'excel', title: 'Forecast', starred: true },
    { id: '3', sessionId: 's1', filePath: '/c.docx', fileType: 'word', title: 'Budget memo' },
  ];
  page.typeFilter = 'excel';
  assert.deepEqual(ids(page.getFiltered()), ['1', '2']);
  page.filterMode = 'current';
  assert.deepEqual(ids(page.getFiltered()), ['1']);
  page.filterMode = 'starred';
  assert.deepEqual(ids(page.getFiltered()), ['2']);
  page.filterMode = 'all';
  page.typeFilter = 'all';
  page.searchQuery = 'budget';
  assert.deepEqual(ids(page.getFiltered()), ['1', '3']);
  assert.equal(page.emptyTextKey(), 'panel.emptySearch');
});
