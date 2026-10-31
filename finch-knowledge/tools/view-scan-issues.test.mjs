import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { transform } from 'esbuild';

const source = (await readFile(new URL('../src/view.ts', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const declarations = source.slice(0, source.indexOf('\nmountStaticIcons();')).replace(/^import .*\r?\n/gm, '');
const start = source.indexOf('if (bridge) {\n  bridge.onMessage');
const end = source.indexOf("  resetPage(); request('ready');", start);
const { code } = await transform(`${declarations}\n${source.slice(start, end)}\n}`, { loader: 'ts' });
const copies = Object.fromEntries(await Promise.all(['zh-CN', 'en-US'].map(async locale => [locale, JSON.parse(await readFile(new URL(`../i18n/${locale}.json`, import.meta.url), 'utf8')).ui])));

function element(tag = 'div') {
  const classes = new Set();
  return { tagName: tag, children: [], textContent: '', hidden: false, open: false, style: {}, dataset: {}, attrs: {}, events: {},
    addEventListener(name, fn) { this.events[name] = fn; }, focus() { this.focused = true; },
    contains(target) { return this === target || this.children.some(child => child.contains?.(target)); },
    getBoundingClientRect() { return { left: 900, right: 932, top: 20, bottom: 52, width: 360, height: 200 }; },
    append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
    querySelector(name) { return this.children.find(child => child.tagName === name) ?? null; },
    setAttribute(key, value) { this.attrs[key] = value; }, removeAttribute(key) { delete this.attrs[key]; },
    classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); }, contains: name => classes.has(name) },
  };
}
function fixture(locale = 'en-US') {
  let receive;
  const elements = new Map(), toasts = [], events = {}, windowEvents = {};
  const byId = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  byId('scan-issues').hidden = true; byId('scan-issues-button').hidden = true;
  const context = createContext({
    window: { finch: { onMessage(callback) { receive = callback; }, postMessage() {} }, scrollX: 0, scrollY: 0, innerWidth: 1200, innerHeight: 800, addEventListener(name, fn) { windowEvents[name] = fn; } },
    clearTimeout() {}, document: { getElementById: byId, createElement: element, addEventListener(name, fn) { events[name] = fn; } }, toasts,
  });
  runInContext(code, context);
  context.ui = copies[locale];
  const run = script => runInContext(script, context);
  run("copy = ui; libraryPath = '/library'; renderDocs = updateLibrary = renderEnvironment = renderEnvironmentMenu = renderOnboardLibrary = renderActivity = setMenu = closeRowMenu = () => {}; toast = (...args) => toasts.push(args);");
  return { run, receive, byId, toasts, events, windowEvents };
}
const outcome = { updated: [], removed: [], unchanged: 2, unreachable: [], failed: [] };
function rows(panel) { return panel.children[1].children; }

test('last scan renders localized names and reasons, not just a transient count', () => {
  for (const locale of Object.keys(copies)) {
    const f = fixture(locale);
    f.receive({ type: 'scanDone', root: '/library', sync: { ...outcome, failed: [
      { name: 'photo.jpg', reason: 'No extractable text in photo.jpg.' },
      { name: 'notes.txt', reason: 'Choose a nonempty file smaller than 80 MB.' },
    ], unreachable: ['offline.pdf'] } });
    const panel = f.byId('scan-issues');
    assert.equal(panel.hidden, true, 'a completed scan never opens the report automatically');
    assert.equal(f.byId('scan-issues-button').hidden, false);
    assert.match(panel.children[0].children[0].textContent, /3/);
    assert.equal(rows(panel)[0].children[0].textContent, 'photo.jpg');
    assert.equal(rows(panel)[0].children[1].textContent, copies[locale].scanIssueNoText);
    assert.equal(rows(panel)[1].children[1].textContent, copies[locale].scanIssueSize.replace('{max}', '80'));
    assert.equal(rows(panel)[2].children[1].textContent, copies[locale].scanIssueUnreachable);
    f.run('wireScanIssues();'); f.byId('scan-issues-button').events.click();
    assert.equal(panel.hidden, false); assert.equal(f.byId('scan-issues-button').attrs['aria-expanded'], 'true');
    f.run('renderScanIssues();'); assert.equal(panel.hidden, false, 'copy refresh keeps an explicitly opened popover open');
    f.events.keydown({ key: 'Escape', preventDefault() {} });
    assert.equal(panel.hidden, true); assert.equal(f.byId('scan-issues-button').focused, true);
  }
});

test('names and unknown errors are plain text, never executable markup', () => {
  const f = fixture();
  const name = '<img src=x onerror=alert(1)>.pdf', reason = '<script>throw 1</script>';
  f.receive({ type: 'scanDone', root: '/library', sync: { ...outcome, failed: [{ name, reason }] } });
  assert.equal(rows(f.byId('scan-issues'))[0].children[0].textContent, name);
  assert.equal(rows(f.byId('scan-issues'))[0].children[1].textContent, reason);
  assert.equal(rows(f.byId('scan-issues'))[0].children[0].children.length, 0);
});

test('a clean scan clears the old report without claiming that failed work was unchanged', () => {
  const f = fixture();
  f.run("pending.set('scan', { type: 'sync' });");
  const sync = { ...outcome, failed: [{ name: 'photo.jpg', reason: 'No extractable text in photo.jpg.' }] };
  f.receive({ type: 'syncStarted', requestId: 'scan' });
  assert.equal(f.run("pending.has('scan')"), true, 'the acknowledgement keeps the request alive');
  f.receive({ type: 'scanDone', root: '/library', sync });
  assert.equal(f.toasts.length, 0, 'the broadcast does not duplicate the manual final toast');
  f.receive({ type: 'syncDone', requestId: 'scan', root: '/library', sync });
  assert.equal(f.run("pending.has('scan')"), false);
  assert.equal(f.byId('scan-issues-button').hidden, false);
  assert.equal(f.byId('scan-issues').hidden, true);
  assert.equal(f.toasts.length, 1);
  assert.ok(!f.toasts[0][0].includes(copies['en-US'].syncIdle));
  f.receive({ type: 'scanDone', root: '/library', sync: outcome });
  assert.equal(f.byId('scan-issues').hidden, true);
});

test('directory switches clear the report and reject late old-directory events', () => {
  const f = fixture();
  const sync = { ...outcome, failed: [{ name: 'photo.jpg', reason: 'No extractable text in photo.jpg.' }] };
  f.receive({ type: 'scanDone', root: '/library', sync });
  f.run("applyLibrary({ root: '/other', selected: true, isDefault: false, documents: 0, tags: 0, unavailable: null });");
  assert.equal(f.byId('scan-issues').hidden, true);
  for (const type of ['scanDone', 'scanFailed', 'scanStarted', 'syncDone']) f.receive({ type, root: '/library', sync, error: 'old error' });
  f.run("pending.set('old-scan', { type: 'sync' });");
  f.receive({ type: 'syncDone', requestId: 'old-scan', root: '/library', sync });
  assert.equal(f.run("pending.has('old-scan')"), false, 'stale replies release their request bookkeeping');
  assert.equal(f.byId('scan-issues').hidden, true);
  assert.equal(f.run('scanBusy'), false);
  assert.equal(f.toasts.length, 1, 'late events do not show errors or change the new directory scan');
});

test('the toolbar report is a bounded themed dialog outside the document list', async () => {
  const html = await readFile(new URL('../src/view.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../src/view.css', import.meta.url), 'utf8');
  assert.match(html, /id="scan-issues"[^>]*hidden[^>]*role="dialog"/);
  assert.ok(html.indexOf('id="scan-issues"') > html.indexOf('</main>'));
  assert.ok(html.indexOf('id="scan-issues-button"') < html.indexOf('id="sync"'));
  assert.match(html, /data-icon="triangle-alert"/);
  assert.match(css, /\.scan-issues\s*\{[^}]*position:\s*absolute/);
  assert.match(css, /\.scan-issues-list\s*\{[^}]*max-height:[^}]*overflow-y:\s*auto/);
  assert.match(css, /\.scan-issues\s*\{[^}]*var\(--finch-border/);
});

test('empty and textless sources show localized skip notices rather than refresh failures', () => {
  for (const locale of Object.keys(copies)) {
    const f = fixture(locale);
    const skipped = [{ name: 'empty.txt', reason: 'empty_file' }, { name: 'photo.png', reason: 'image_no_text' }, { name: 'blank.txt', reason: 'no_text' }];
    f.receive({ type: 'scanDone', root: '/library', sync: { ...outcome, skipped } });
    const notices = rows(f.byId('scan-issues'));
    assert.equal(notices[0].children[1].textContent, copies[locale].scanIssueEmpty);
    assert.equal(notices[1].children[1].textContent, copies[locale].scanIssueImageNoText);
    assert.equal(notices[2].children[1].textContent, copies[locale].scanIssueNoText);
    assert.equal(f.toasts.length, 1); assert.equal(f.toasts[0][1], 'info');
    assert.ok(f.toasts[0][0].includes(copies[locale].syncSkippedEmpty.replace('{count}', '1')));
    assert.ok(f.toasts[0][0].includes(copies[locale].syncSkippedImage.replace('{count}', '1')));
  }
});

test('a manual scan containing only skipped sources never claims refresh failed or nothing was scanned', () => {
  const f = fixture('zh-CN');
  f.run("pending.set('scan', { type: 'sync' });");
  f.receive({ type: 'syncDone', root: '/library', requestId: 'scan', sync: { ...outcome, unchanged: 0, skipped: [{ name: 'empty.txt', reason: 'empty_file' }] } });
  assert.equal(f.toasts.length, 1); assert.equal(f.toasts[0][1], 'info');
  assert.match(f.toasts[0][0], /跳过 1/); assert.ok(!f.toasts[0][0].includes('失败'));
  assert.ok(!f.toasts[0][0].includes(copies['zh-CN'].syncNoSources));
  assert.ok(!f.toasts[0][0].includes(copies['zh-CN'].syncIdle));
});

test('genuine failures stay in the report without a generic refresh-failed warning toast', () => {
  const f = fixture('zh-CN'); f.run("pending.set('scan', { type: 'sync' });");
  f.receive({ type: 'syncDone', root: '/library', requestId: 'scan', sync: { ...outcome,
    skipped: [{ name: 'empty.txt', reason: 'empty_file' }], failed: [{ name: 'broken.pdf', reason: 'Read error' }] } });
  assert.equal(f.toasts[0][1], 'info'); assert.match(f.toasts[0][0], /跳过 1/); assert.doesNotMatch(f.toasts[0][0], /失败/);
  assert.equal(rows(f.byId('scan-issues'))[1].children[1].textContent, 'Read error');
});


test('clearing scan notices hides the triangle and returns focus without changing source indexes', () => {
  const f = fixture();
  f.receive({ type: 'scanDone', root: '/library', sync: { ...outcome, skipped: [{ name: 'empty.txt', reason: 'empty_file' }] } });
  const toasts = f.toasts.length;
  const panel = f.byId('scan-issues'); panel.children[0].children[1].events.click();
  assert.equal(panel.hidden, true); assert.equal(panel.children.length, 0);
  assert.equal(f.byId('scan-issues-button').hidden, true); assert.equal(f.byId('sync').focused, true);
  assert.equal(f.run('scanIssues.length'), 0); assert.equal(f.toasts.length, toasts);
});
