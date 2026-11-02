import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = fileURLToPath(new URL('../', import.meta.url));
const profile = await mkdtemp(join(tmpdir(), 'knowledge-ui-'));
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = createServer(async (request, response) => {
  try {
    const path = resolve(root, `.${decodeURIComponent(new URL(request.url, 'http://localhost').pathname)}`);
    if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) { response.writeHead(403).end(); return; }
    const data = await readFile(path);
    response.writeHead(200, { 'Content-Type': mime[extname(path)] ?? 'application/octet-stream' });
    response.end(data);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

async function launch() {
  const candidates = process.env.FINCH_UI_BROWSER ? [process.env.FINCH_UI_BROWSER] : process.platform === 'win32'
    ? [join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'), join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe')]
    : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : ['chromium', 'chromium-browser', 'google-chrome'];
  for (const executable of candidates) {
    try {
      return await new Promise((resolve, reject) => {
        const child = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
        let output = '';
        const timer = setTimeout(() => { child.kill(); reject(new Error('Browser launch timed out')); }, 10000);
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`Browser exited: ${code}`)); });
        child.stderr.on('data', bytes => {
          output = (output + bytes.toString()).slice(-20000);
          const url = output.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1];
          if (url) { clearTimeout(timer); resolve({ child, url }); }
        });
      });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error('No Chromium browser found. Set FINCH_UI_BROWSER to a Chrome/Edge executable.');
}

function fixture() {
  let listener;
  let tags = [{ id: 'a', name: '工作', color: 'blue' }, { id: 'b', name: '收藏', color: 'purple' }, { id: 'c', name: '重要', color: 'red' }];
  let docs = ['unassigned.md', 'tagged.md'].map((name, index) => ({ id: String(index), path: `/library/notes/${name}`, name: `notes/${name}`, tags: index ? ['a', 'b'] : [], status: 'ready', chunks: 1, indexedChunks: 1, added_at: 1, indexed_at: 1, size_bytes: index ? 1024 : 0, modified_at: Date.UTC(2020 + index, 0, 1), file_type: 'md' }));
  let directories = [{ path: '', parent: null, name: '', count: 2 }, { path: 'notes', parent: '', name: 'notes', count: 2 }, { path: 'notes/sub', parent: 'notes', name: 'sub', count: 1 }];
  const libraries = [{ id: 'work', root: '/library', name: '工作资料' }, { id: 'personal', root: '/personal', name: '个人资料' }, { id: 'offline', root: '/offline', name: '离线资料' }];
  let current = libraries[0], libraryVersion = 1;
  const stores = new Map([['work', { tags, docs, directories }], ['personal', {
    tags: [{ id: 'private', name: '个人标签', color: 'green' }],
    docs: [{ ...docs[0], id: 'private-file', path: '/personal/private.md', name: 'private.md', tags: ['private'] }],
    directories: [{ path: '', parent: null, name: '', count: 1 }],
  }]]);
  const libraryInfo = () => ({ indexStorage: current.id === 'personal' ? 'local' : 'source', root: current.root, version: libraryVersion, activeId: current.id, name: current.name, libraries, selected: true, entered: true, isDefault: false, documents: docs.length, tags: tags.length, unavailable: null });
  const allTags = () => [{ id: 'default', name: '', count: docs.filter(doc => !doc.tags.length).length }, ...tags.map(tag => ({ ...tag, count: docs.filter(doc => doc.tags.includes(tag.id)).length }))];
  const emit = message => listener?.(JSON.parse(JSON.stringify({ root: current.root, libraryVersion, ...message })));
  window.testEmit = emit;
  window.testToasts = []; window.testColors = []; window.testRequests = []; window.testPreviews = [];
  window.testDensity = mode => {
    tags.splice(0, tags.length, ...(mode === 'many' ? Array.from({ length: 80 }, (_, i) => ({ id: `t${i}`, name: `标签 ${i}`, color: 'gray' })) : []));
    directories.splice(0, directories.length, { path: '', parent: null, name: '', count: 2 }, ...(mode === 'many' ? Array.from({ length: 80 }, (_, i) => ({ path: `folder${i}`, parent: '', name: `目录 ${i}`, count: 1 })) : []));
    emit({ type: 'changed', root: '/library', tags: allTags(), directories, change: { kind: 'tagColor' } });
  };
  window.finch = { appView: { openPreview: async path => { window.testPreviews.push(path); } }, onMessage(fn) { listener = fn; }, ui: { toast: async options => { window.testToasts.push(options); }, confirm: async () => ({ confirmed: false }) },
    postMessage(message) {
      window.testRequests.push(message);
      queueMicrotask(() => {
        if (message.type === 'libraryAction' || message.type === 'librarySwitch') {
          if (message.type === 'libraryAction') {
            if (!libraries.some(item => item.id === 'added')) {
              libraries.push({ id: 'added', name: '新增资料', root: '/added' });
              stores.set('added', { tags: [], docs: [], directories: [{ path: '', parent: null, name: '', count: 0 }] });
            }
          }
          const entry = libraries.find(item => item.id === (message.type === 'libraryAction' ? 'added' : message.id));
          if (!entry || !stores.has(entry.id)) { emit({ type: 'error', requestId: message.requestId, error: 'Offline fixture' }); return; }
          current = entry; libraryVersion++;
          ({ tags, docs, directories } = stores.get(entry.id));
          emit({ type: 'libraryDone', mode: 'switch', requestId: message.requestId, library: libraryInfo() });
        } else if (message.type === 'ready' || message.type === 'tags') {
          if (message.type === 'ready') emit({ type: 'finch:env', locale: 'zh-CN', view: 'appView' });
          emit({ type: 'tags', requestId: message.requestId, tags: allTags(), directories,
            library: libraryInfo(),
            environment: { ready: true, usable: true, running: false, steps: ['lancedb', 'anydoc', 'ocr'].map(id => ({ id, status: 'ready' })) } });
        } else if (message.type === 'page') {
          const ordered = docs.filter(doc => !message.tagId || (message.tagId === 'default' ? !doc.tags.length : doc.tags.includes(message.tagId)));
          if (['name', 'modified', 'size', 'type'].includes(message.sort)) ordered.sort((a,b) => {
            const key = {name:'name', modified:'modified_at', size:'size_bytes', type:'file_type'}[message.sort];
            const comparison = typeof a[key] === 'number' ? a[key] - b[key] : String(a[key]).localeCompare(String(b[key]));
            return message.descending ? -comparison : comparison;
          });
          emit({ type: 'page', requestId: message.requestId, documents: ordered, total: ordered.length, offset: 0 });
        } else if (message.type === 'search') emit({ type:'matches', requestId:message.requestId, matches:[] });
        else if (message.type === 'tagToggle') {
          const doc = docs.find(doc => doc.id === message.id);
          doc.tags = doc.tags.includes(message.tagId) ? doc.tags.filter(id => id !== message.tagId) : [...doc.tags, message.tagId];
          emit({ type: 'changedTag', requestId: message.requestId });
          emit({ type: 'changed', root: '/library', tags: allTags(), directories, change: { kind: 'tagToggle', documentId: doc.id, tags: doc.tags } });
        } else if (message.type === 'tagColor') {
          tags.find(tag => tag.id === message.id).color = message.color; window.testColors.push(message.color);
          emit({ type: 'changedTag', requestId: message.requestId });
          emit({ type: 'changed', root: '/library', tags: allTags(), directories, change: { kind: 'tagColor' } });
        } else if (message.type === 'sync') {
          const sync = { updated: [], removed: [], unchanged: 2, moved: [], unreachable: [], failed: [{ name: 'broken.pdf', reason: 'Read error fixture' }], skipped: [{ name: 'empty.txt', reason: 'empty_file' }] };
          emit({ type: 'syncStarted', requestId: message.requestId }); emit({ type: 'scanStarted', root: '/library' });
          emit({ type: 'scanDone', root: '/library', sync }); emit({ type: 'syncDone', requestId: message.requestId, root: '/library', sync });
        }
      });
    },
  };
}

let browser, socket;
const pending = new Map(), runtimeErrors = [];
let serial = 0, session;
try {
  browser = await launch();
  socket = new WebSocket(browser.url);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') runtimeErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    if (!message.id) return;
    const task = pending.get(message.id); if (!task) return;
    pending.delete(message.id); clearTimeout(task.timer);
    if (message.error) task.reject(new Error(JSON.stringify(message.error))); else task.resolve(message.result);
  });
  socket.addEventListener('close', () => { for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error('Browser closed')); } pending.clear(); });
  const call = (method, params = {}, target = session) => new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 8000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, ...(target ? { sessionId: target } : {}) }));
  });
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' }, null);
  session = (await call('Target.attachToTarget', { targetId, flatten: true }, null)).sessionId;
  await call('Page.enable'); await call('Runtime.enable');
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `(${fixture.toString()})();` });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const waitFor = async expression => {
    const until = Date.now() + 6000;
    while (Date.now() < until) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 40)); }
    const state = await evaluate("({library:document.querySelector('#library-path')?.textContent,rows:[...document.querySelectorAll('.doc-title')].map(node=>node.textContent),requests:window.testRequests.slice(-8),status:document.querySelector('#status')?.textContent})");
    throw new Error(`UI did not settle: ${expression}; ${runtimeErrors.join('; ')}; ${JSON.stringify(state)}`);
  };
  await call('Emulation.setDeviceMetricsOverride', { width: 1200, height: 850, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/dist/view.html` });
  await waitFor("document.querySelectorAll('.doc').length === 2 && document.querySelector('.doc-status').textContent.includes('已检索')");
  const measure = `(() => { const row = document.querySelector('.doc'), status = row.querySelector('.doc-status'), tools = row.querySelector('.doc-tools'), title = row.querySelector('.doc-title'); const r = row.getBoundingClientRect(), s = status.getBoundingClientRect(), t = title.getBoundingClientRect(); return { x:r.x, y:r.y, height:r.height, right:r.right, statusRight:s.right, titleWidth:t.width, status:getComputedStyle(status).visibility, tools:getComputedStyle(tools).visibility }; })()`;
  for (const width of [1200, 820, 520]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 850, deviceScaleFactor: 1, mobile: false });
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
    const before = await evaluate(measure);
    assert.equal(before.status, 'visible'); assert.equal(before.tools, 'hidden');
    assert.ok(Math.abs(before.right - before.statusRight - 9) < 1, `status is flush to the trailing inset at ${width}px`);
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: before.x + 25, y: before.y + before.height / 2 });
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const hovered = await evaluate(measure);
    assert.equal(hovered.status, 'hidden'); assert.equal(hovered.tools, 'visible');
    assert.equal(hovered.height, before.height); assert.equal(hovered.titleWidth, before.titleWidth);
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
    await evaluate("document.querySelector('.doc').focus()");
    const focused = await evaluate(measure);
    assert.equal(focused.status, 'hidden'); assert.equal(focused.tools, 'visible');
    await evaluate('document.activeElement.blur()');
  }
  await call('Emulation.setDeviceMetricsOverride', { width: 1200, height: 850, deviceScaleFactor: 1, mobile: false });
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const moveTo = async selector => {
    const point = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x:r.x + r.width / 2, y:r.y + r.height / 2 }; })()`);
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }); return point;
  };
  const click = async selector => {
    const point = await moveTo(selector);
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  };
  const key = async (value, code) => {
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: value, code: value, windowsVirtualKeyCode: code });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: value, code: value, windowsVirtualKeyCode: code });
  };
  await click('.directory-toggle:not(:disabled)');
  const treeGeometry = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.directory-row')];
    const first = rows[0], child = rows[1];
    const arrow = first.querySelector('.directory-toggle svg').getBoundingClientRect();
    const folder = first.querySelector('.directory-choice svg').getBoundingClientRect();
    const childFolder = child.querySelector('.directory-choice svg').getBoundingClientRect();
    const toggle = first.querySelector('.directory-toggle').getBoundingClientRect();
    return { gap: folder.left - arrow.right, indent: childFolder.left - folder.left, toggleWidth: toggle.width, childVisible: child.getBoundingClientRect().height > 0, folderWidth: folder.width };
  })()`);
  assert.ok(treeGeometry.gap >= 4 && treeGeometry.gap <= 8, 'arrow sits close to the folder without touching');
  assert.equal(treeGeometry.indent, 10, 'expanded child indentation is compact');
  assert.equal(treeGeometry.toggleWidth, 18, 'compact spacing preserves the arrow hit area');
  assert.equal(treeGeometry.folderWidth, 16); assert.equal(treeGeometry.childVisible, true);
  console.log('Directory geometry:', JSON.stringify(treeGeometry));
  if (process.env.FINCH_UI_SCREENSHOT) {
    const capture = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile(process.env.FINCH_UI_SCREENSHOT, Buffer.from(capture.data, 'base64'));
  }
  await click('.directory-toggle:not(:disabled)');
  // Real pointer selection, including word selection, must never activate a document.
  const titleBox = await evaluate("(() => { const r=document.querySelector('.doc-title').getBoundingClientRect(); return {x:r.x+2,y:r.y+r.height/2,width:r.width}; })()");
  await call('Input.dispatchMouseEvent', { type:'mousePressed', x:titleBox.x, y:titleBox.y, button:'left', clickCount:1 });
  await call('Input.dispatchMouseEvent', { type:'mouseMoved', x:titleBox.x+titleBox.width-4, y:titleBox.y, button:'left', buttons:1 });
  await call('Input.dispatchMouseEvent', { type:'mouseReleased', x:titleBox.x+titleBox.width-4, y:titleBox.y, button:'left', clickCount:1 });
  assert.ok(await evaluate('Boolean(window.getSelection().toString())'), 'title is selectable with a real drag');
  assert.equal(await evaluate('window.testPreviews.length'), 0, 'dragging a title never opens it');
  await click('.doc-title');
  const titlePoint = await moveTo('.doc-title');
  await call('Input.dispatchMouseEvent', { type:'mousePressed', ...titlePoint, button:'left', clickCount:2 });
  await call('Input.dispatchMouseEvent', { type:'mouseReleased', ...titlePoint, button:'left', clickCount:2 });
  assert.ok(await evaluate('Boolean(window.getSelection().toString())'), 'double-click still selects a word');
  assert.equal(await evaluate('window.testPreviews.length'), 0, 'interacting with an existing selection never opens it');
  await evaluate('window.getSelection().removeAllRanges(); document.activeElement.blur(); window.dispatchEvent(new Event("blur"))');
  await moveTo('#heading'); await moveTo('.doc-title');
  assert.equal(await evaluate('document.documentElement.classList.contains("window-inactive")'), false, 'fresh pointer recovers a missed focus event');
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".doc-tools")).visibility'), 'visible');
  const hover = await evaluate('getComputedStyle(document.querySelector(".doc")).backgroundColor');
  assert.notEqual(hover, 'rgba(0, 0, 0, 0)', 'hover band remains visible after returning');
  await click('.doc-title');
  assert.equal(await evaluate('window.testPreviews.length'), 1, 'a normal row click still opens exactly once');
  await click('.doc .doc-tools button');
  assert.equal(await evaluate('window.testPreviews.length'), 2, 'explicit preview opens exactly once without bubbling');
  await evaluate('document.querySelector(".doc").focus()'); await key('Enter', 13);
  assert.equal(await evaluate('window.testPreviews.length'), 3, 'keyboard activation remains available');
  await evaluate('document.activeElement.blur()'); await moveTo('#heading');
  const sidebarWidth = () => evaluate("document.querySelector('.sidebar').getBoundingClientRect().width");
  const resizeBy = async delta => {
    const point = await moveTo('#workspace-resizer');
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x + delta, y: point.y, button: 'left', buttons: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x + delta, y: point.y, button: 'left', clickCount: 1 });
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    assert.equal(await evaluate("document.documentElement.classList.contains('workspace-resizing')"), false, 'pointer release clears the dragging state');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#workspace-resizer'), '::before').opacity"), '0', 'release hides the guide even while the pointer is still over the separator');
  };
  await evaluate("window.resizeWitness = document.querySelector('.doc')");
  await resizeBy(40); assert.equal(await sidebarWidth(), 340);
  assert.equal(await evaluate("document.querySelector('#workspace-resizer').matches(':hover')"), true, 'the idle-hide regression includes a pointer still over the handle');
  await moveTo('#heading'); await moveTo('#workspace-resizer');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('#workspace-resizer'), '::before').opacity"), '1', 'returning to the separator restores its hover affordance');
  assert.equal(await evaluate("(() => { const a=document.querySelector('.sidebar').getBoundingClientRect(), b=document.querySelector('.library').getBoundingClientRect(); return b.left-a.right; })()"), 8, 'panes retain only an 8px resize gap');
  await resizeBy(-250); assert.equal(await sidebarWidth(), 220);
  await resizeBy(500); assert.equal(await sidebarWidth(), 420);
  assert.equal(await evaluate("document.querySelector('.doc') === window.resizeWitness"), true, 'dragging never rebuilds file rows');
  assert.equal(await evaluate("localStorage.getItem('knowledge.sidebar.width')"), '420');
  await key('ArrowLeft', 37); assert.equal(await sidebarWidth(), 410);
  await key('Home', 36); assert.equal(await sidebarWidth(), 220);
  await key('End', 35); assert.equal(await sidebarWidth(), 420);
  await call('Emulation.setDeviceMetricsOverride', { width: 620, height: 850, deviceScaleFactor: 1, mobile: false });
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  assert.ok(await sidebarWidth() >= 220 && await sidebarWidth() < 420);
  assert.ok(await evaluate("document.querySelector('.library').getBoundingClientRect().width") >= 280);
  await call('Emulation.setDeviceMetricsOverride', { width: 520, height: 850, deviceScaleFactor: 1, mobile: false });
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('#workspace-resizer')).display"), 'none');
  assert.equal(await evaluate("document.querySelector('#workspace-resizer').tabIndex"), -1);
  await call('Emulation.setDeviceMetricsOverride', { width: 1200, height: 850, deviceScaleFactor: 1, mobile: false });
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  assert.equal(await sidebarWidth(), 420, 'temporary viewport clamps do not erase the preferred width');
  await evaluate("document.querySelector('#workspace-resizer').focus()");
  await key('Enter', 13); assert.equal(await sidebarWidth(), 300);
  await key('ArrowRight', 39); await key('ArrowRight', 39); assert.equal(await sidebarWidth(), 320);
  await call('Page.reload');
  await waitFor("document.querySelectorAll('.doc').length === 2 && document.querySelector('.doc-status').textContent.includes('已检索')");
  assert.equal(await sidebarWidth(), 320, 'width survives recreating the webview page');
  await evaluate("document.querySelector('#workspace-resizer').dispatchEvent(new MouseEvent('dblclick', {bubbles:true}))");
  assert.equal(await sidebarWidth(), 300);
  assert.equal(await evaluate("localStorage.getItem('knowledge.sidebar.width')"), null);
  assert.equal(await evaluate("document.querySelector('.doc').querySelectorAll('.doc-tag').length"), 0, 'no Unclassified placeholder in real DOM');
  assert.equal(await evaluate("document.querySelector('#tags .tag-row[data-id=default]')"), null, 'Unclassified never appears as a user tag');
  assert.equal(await evaluate("document.querySelector('#row-classify-label').textContent"), '标签');
  const rightClickAt = async (x, y) => {
    assert.ok(await evaluate(`document.elementFromPoint(${x}, ${y}) !== null`), 'context point belongs to the viewport');
    await call('Input.dispatchMouseEvent', { type:'mouseMoved', x, y });
    await call('Input.dispatchMouseEvent', { type:'mousePressed', x, y, button:'right', clickCount:1 });
    await call('Input.dispatchMouseEvent', { type:'mouseReleased', x, y, button:'right', clickCount:1 });
  };
  const sourcePoint = await evaluate("(() => { const r = document.querySelector('.doc').getBoundingClientRect(); return { x:r.x+20, right:r.right-20, y:r.y+r.height/2 }; })()");
  for (const x of [sourcePoint.x, sourcePoint.right]) {
    await rightClickAt(x, sourcePoint.y);
    await waitFor("!document.querySelector('#row-menu').hidden");
    const main = await evaluate("(() => { const r=document.querySelector('#row-menu').getBoundingClientRect(); return {x:r.x,right:r.right}; })()");
    assert.ok(x === sourcePoint.right ? main.right <= x + 1 : main.x >= x - 1, 'context menu chooses the available side of the pointer');
    await moveTo('#row-classify');
    await waitFor("!document.querySelector('#row-submenu').hidden");
    const flyout = await evaluate("(() => { const r=document.querySelector('#row-submenu').getBoundingClientRect(); return {x:r.x,right:r.right}; })()");
    assert.ok(x === sourcePoint.right ? flyout.right <= main.x : flyout.x >= main.right, 'tag flyout opens right normally, left only at the edge');
    await key('Escape', 27);
  }
  await evaluate("window.tagBeforeCreating = (() => { const r=document.querySelector('.tag-row[data-id=a]').getBoundingClientRect();return {left:r.left,width:r.width};})()");
  await rightClickAt(sourcePoint.x, sourcePoint.y);
  assert.equal(await evaluate("document.querySelector('#row-menu #row-new-tag')"),null,'new tag is not a top-level file action');
  await moveTo('#row-classify'); await waitFor("!document.querySelector('#row-submenu').hidden");
  assert.equal(await evaluate("!!document.querySelector('#row-submenu #row-new-tag')"),true,'new tag belongs in the Tags submenu');
  await click('#row-new-tag');
  assert.equal(await evaluate("document.activeElement.matches('#tags .tag-row.creating input')"), true, 'file context action opens the focused inline tag editor');
  const tagForm = await evaluate("(() => {const e=document.querySelector('.creating .tag-editor'),i=e.querySelector('input'),r=e.getBoundingClientRect(),f=i.getBoundingClientRect(),s=getComputedStyle(e);return {height:r.height,width:r.width,fieldRight:f.right,right:r.right,bg:s.backgroundColor,border:s.borderTopWidth,shadow:getComputedStyle(i).boxShadow,weight:getComputedStyle(i).fontWeight,count:!!e.querySelector('.tag-count')};})()");
  assert.equal(tagForm.height,36); assert.ok(tagForm.width>150); assert.equal(tagForm.border,'1px');
  assert.notEqual(tagForm.bg,'rgba(0, 0, 0, 0)'); assert.equal(tagForm.shadow,'none'); assert.equal(tagForm.weight,'500');
  assert.equal(tagForm.count,false); assert.ok(tagForm.fieldRight>=tagForm.right-10, 'new-tag text fills the frame without a phantom count column');
  const expandedForm = await evaluate("(() => {const e=document.querySelector('.creating .tag-editor'),r=e.getBoundingClientRect(),i=e.querySelector('input').getBoundingClientRect(),f=document.querySelector('#library-footer').getBoundingClientRect(),t=document.querySelector('.tag-row[data-id=a]').getBoundingClientRect();return {left:r.left,right:r.right,textLeft:i.left,footerLeft:f.left,footerRight:f.right,tagLeft:t.left,tagWidth:t.width,oldLeft:window.tagBeforeCreating.left,oldWidth:window.tagBeforeCreating.width,icon:!!e.querySelector('svg')};})()");
  assert.ok(Math.abs(expandedForm.left-expandedForm.footerLeft)<1 && Math.abs(expandedForm.right-expandedForm.footerRight)<1,'creation frame uses the wider footer-aligned inset');
  assert.ok(expandedForm.textLeft-expandedForm.left<=10); assert.equal(expandedForm.icon,false,'there is no decorative icon column stealing text width');
  assert.equal(expandedForm.tagLeft,expandedForm.oldLeft); assert.equal(expandedForm.tagWidth,expandedForm.oldWidth,'existing tags do not move when the form widens');
  await call('Input.insertText',{text:'222'});
  await evaluate("window.dispatchEvent(new Event('blur'));window.dispatchEvent(new Event('focus'))");
  assert.equal(await evaluate("document.querySelector('.creating input').value"),'222','switching applications preserves an editing draft');
  await key('Escape', 27);
  const tagPoint = await moveTo('#tags-title');
  await rightClickAt(tagPoint.x, tagPoint.y);
  await waitFor("!document.querySelector('#tag-context-menu').hidden");
  await key('Escape', 27);
  assert.equal(await evaluate("document.querySelector('#tag-context-menu').hidden"), true);
  await rightClickAt(tagPoint.x, tagPoint.y);
  await click('#tag-context-new');
  assert.equal(await evaluate("document.activeElement.matches('#tags .tag-row.creating input')"), true, 'sidebar context action uses the same tag editor');
  assert.equal(await evaluate("document.querySelector('#tag-context-menu').hidden"), true);
  await key('Escape', 27);
  await moveTo('.doc');
  await evaluate("document.querySelector('.doc').focus();window.dispatchEvent(new Event('blur'))");
  const inactiveRow = await evaluate(measure);
  assert.equal(inactiveRow.status,'visible'); assert.equal(inactiveRow.tools,'hidden');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.doc')).backgroundColor"),'rgba(0, 0, 0, 0)','window blur clears latched row highlight');
  await evaluate("window.dispatchEvent(new Event('focus'))");
  assert.equal((await evaluate(measure)).tools,'hidden','focus return alone does not replay stale pointer state');
  await evaluate("document.querySelector('.doc').focus()");
  assert.equal((await evaluate(measure)).tools,'visible','deliberate keyboard focus still exposes actions');
  await evaluate('document.activeElement.blur()');
  await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:0,y:0});
  await moveTo('.doc');
  assert.equal((await evaluate(measure)).tools,'visible','fresh pointer input restores hover');
  await evaluate("window.originalFirst = document.querySelector('.doc')");
  await click('.doc[data-id="1"] .doc-tools .icon-button:last-child');
  await moveTo('#row-classify');
  await waitFor("!document.querySelector('#row-submenu').hidden");
  assert.equal(await evaluate("document.querySelectorAll('#row-submenu [role=menuitemcheckbox]').length"), 3);
  assert.equal(await evaluate("document.querySelectorAll('#row-submenu [aria-checked=true]').length"), 2);
  assert.equal(await evaluate("document.querySelector('#row-submenu').textContent.includes('可多选')"), false);
  await click('#row-submenu [data-tag-id=c]');
  await waitFor("document.querySelector('#row-submenu [data-tag-id=c]').getAttribute('aria-checked') === 'true'");
  await click('#row-submenu [data-tag-id=b]');
  await waitFor("document.querySelector('#row-submenu [data-tag-id=b]').getAttribute('aria-checked') === 'false'");
  await evaluate('new Promise(resolve => setTimeout(resolve, 300))');
  assert.equal(await evaluate("document.querySelector('#row-submenu').hidden"), false, 'multi-select keeps the menu open after pointer-leave timers settle');
  assert.equal(await evaluate("document.querySelectorAll('#row-submenu [aria-checked=true]').length"), 2);
  assert.equal(await evaluate("document.querySelector('.doc') === window.originalFirst"), true, 'other rows are not rebuilt');
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 1, button: 'left', clickCount: 1 });
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 1, y: 1, button: 'left', clickCount: 1 });
  await evaluate("document.querySelector('#sync').click()");
  await waitFor('window.testToasts.length === 1');
  const result = await evaluate('window.testToasts[0]');
  assert.equal(result.variant, 'success'); assert.equal(result.position, 'TC'); assert.equal(result.title, '扫描完成。');
  assert.equal(await evaluate("document.querySelectorAll('#scan-issues-button, #scan-issues').length"), 0, 'scan warnings are removed, not hidden');
  await call('Emulation.setDeviceMetricsOverride', { width: 1200, height: 850, deviceScaleFactor: 1, mobile: false });
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  assert.equal(await evaluate("document.querySelector('#tags-title').textContent"), '标签');
  const tagMeasure = "(() => { const r=document.querySelector('.tag-row[data-id=a]'), n=r.querySelector('.tag-choice .tag-name'), b=r.getBoundingClientRect(), t=n.getBoundingClientRect(); return {height:b.height,right:b.right,nameX:t.x,nameWidth:t.width,count:getComputedStyle(r.querySelector('.tag-count')).visibility,actions:getComputedStyle(r.querySelector('.tag-actions')).opacity}; })()";
  await call('Input.dispatchMouseEvent', {type:'mouseMoved',x:0,y:0});
  await evaluate('document.activeElement.blur()');
  const tagIdle = await evaluate(tagMeasure);
  assert.equal(tagIdle.count, 'visible'); assert.equal(tagIdle.actions, '0');
  await moveTo('.tag-row[data-id=a] .tag-choice .tag-name');
  const tagHover = await evaluate(tagMeasure);
  assert.equal(tagHover.count, 'hidden'); assert.equal(tagHover.actions, '1');
  for (const field of ['height','right','nameX','nameWidth']) assert.equal(tagHover[field], tagIdle[field], `hover preserves tag ${field}`);
  await evaluate("document.querySelector('.tag-row[data-id=a] .tag-actions button').focus()");
  await call('Input.dispatchMouseEvent', {type:'mouseMoved',x:0,y:0});
  const tagFocused = await evaluate(tagMeasure);
  assert.equal(tagFocused.count, 'hidden'); assert.equal(tagFocused.actions, '1', 'keyboard actions also replace the count');
  await evaluate('document.activeElement.blur()');
  assert.equal((await evaluate(tagMeasure)).count, 'visible', 'leaving restores the tally');
  await call('Emulation.setTouchEmulationEnabled', {enabled:true,maxTouchPoints:1});
  const tagTouch = await evaluate(tagMeasure);
  assert.equal(tagTouch.count, 'hidden'); assert.equal(tagTouch.actions, '1', 'touch keeps actions accessible without a second tally');
  assert.equal(tagTouch.nameWidth, tagIdle.nameWidth);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.directory-all .tag-count')).visibility"), 'visible', 'folder counts are unaffected');
  await call('Emulation.setTouchEmulationEnabled', {enabled:false});
  const colorButton = '.tag-row[data-id=a] .tag-color-trigger';
  await evaluate("window.colorWitness = document.querySelector('.doc')");
  await click(colorButton);
  assert.equal(await evaluate("document.querySelector('#tag-color-picker').hidden"), false);
  assert.equal(await evaluate("document.querySelector('.doc') === window.colorWitness"), true, 'clicking the leading dot never changes the browsing scope');
  assert.equal(await evaluate("document.querySelectorAll('.tag-row[data-id=a] .tag-actions button').length"), 2);
  assert.equal(await evaluate("document.querySelectorAll('input[type=color], .color-well').length"), 0, 'no large preview or second native color popup');
  const swatches = await evaluate("Array.from(document.querySelectorAll('.tag-color-option'), b => { const r=b.getBoundingClientRect(), d=b.querySelector('.tag-dot').getBoundingClientRect(); return {w:r.width,h:r.height,dx:d.x+d.width/2-r.x-r.width/2,dy:d.y+d.height/2-r.y-r.height/2,display:getComputedStyle(b).display}; })");
  assert.equal(swatches.length, 7);
  for (const swatch of swatches) { assert.equal(swatch.w, 24); assert.equal(swatch.h, 24); assert.ok(Math.abs(swatch.dx)<.6 && Math.abs(swatch.dy)<.6, `preset dots are centered: ${JSON.stringify(swatch)}`); }
  await click('.tag-color-option[data-color="#92969d"]');
  assert.equal(await evaluate("document.querySelectorAll('.tag-color-option[aria-pressed=true]').length"), 1, 'a preset has one selection ring');
  assert.equal(await evaluate("document.querySelector('.color-hex').value"), '#92969d');
  await key('ArrowLeft', 37);
  const presetFocus = await evaluate("(() => { const b=document.activeElement, s=getComputedStyle(b); return {preset:b.classList.contains('tag-color-option'),outline:s.outlineWidth,border:s.borderTopColor}; })()");
  assert.equal(presetFocus.preset, true); assert.equal(presetFocus.outline, '2px'); assert.equal(presetFocus.border, 'rgba(0, 0, 0, 0)', 'keyboard focus replaces, rather than doubles, the selection ring');
  assert.equal(await evaluate('window.testColors.length'), 0, 'previewing a preset never saves metadata');
  await evaluate("document.querySelector('.color-hue').value='120'; document.querySelector('.color-hue').dispatchEvent(new Event('input',{bubbles:true}))");
  await click('.color-sv');
  assert.match(await evaluate("document.querySelector('.color-hex').value"), /^#[0-9a-f]{6}$/);
  const beforeKeyboard = await evaluate("document.querySelector('.color-hex').value");
  await key('ArrowRight', 39);
  assert.notEqual(await evaluate("document.querySelector('.color-hex').value"), beforeKeyboard, 'arrow keys adjust the directly visible surface');
  await evaluate("document.querySelector('.color-hex').value='#808080'; document.querySelector('.color-hex').dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('.color-hue').value='240'; document.querySelector('.color-hue').dispatchEvent(new Event('input',{bubbles:true})); for(let i=0;i<10;i++){document.querySelector('.color-sv').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',shiftKey:true,bubbles:true})); document.querySelector('.color-sv').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',shiftKey:true,bubbles:true}));}");
  assert.equal(await evaluate("document.querySelector('.color-hex').value"), '#0000ff', 'choosing a hue while gray preserves it when saturation returns');
  await evaluate("const input = document.querySelector('.color-hex'); input.value = '#12zzzz'; input.dispatchEvent(new Event('input', {bubbles:true}))");
  assert.equal(await evaluate("document.querySelector('.color-actions .primary').disabled"), true);
  await evaluate("document.querySelector('.color-hex').value = '#123456'; document.querySelector('.color-hex').dispatchEvent(new Event('input', {bubbles:true})); document.querySelector('.color-actions .outline').click()");
  assert.equal(await evaluate('window.testColors.length'), 0, 'cancel discards the draft');
  await click(colorButton);
  await evaluate("document.querySelector('.color-hex').value = '#1a2b3c'; document.querySelector('.color-hex').dispatchEvent(new Event('input', {bubbles:true}))");
  assert.equal(await evaluate("document.querySelector('.color-hex').value"), '#1a2b3c');
  await evaluate("document.querySelector('.color-actions .primary').click()");
  await waitFor("window.testColors[0] === '#1a2b3c'");
  assert.equal(await evaluate("document.querySelector('.tag-row[data-id=a] .tag-dot').style.backgroundColor"), 'rgb(26, 43, 60)');
  await click(colorButton);
  await evaluate("document.querySelector('.color-reset').click(); document.querySelector('.color-actions .primary').click()");
  await waitFor("window.testColors[1] === 'gray'");
  await call('Emulation.setDeviceMetricsOverride', { width: 1600, height: 850, deviceScaleFactor: 1, mobile: false });
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  for (const field of ['modified', 'type', 'size']) {
    const geometry = await evaluate(`(() => { const h=document.querySelector('#column-${field}'), c=document.querySelector('.doc-${field}'); return {visible:getComputedStyle(c).display!=='none', header:h.getBoundingClientRect().left, cell:c.getBoundingClientRect().left}; })()`);
    assert.equal(geometry.visible, true); assert.ok(Math.abs(geometry.header - geometry.cell) < 1, `${field} header aligns with values`);
  }
  assert.equal(await evaluate("document.querySelector('.doc-size').textContent"), '0 B');
  assert.match(await evaluate("document.querySelector('.doc-modified').textContent"), /2020/);
  assert.equal(await evaluate("document.querySelector('.doc-type').textContent"), 'Markdown');
  await evaluate("document.querySelector('#column-size').click()");
  await waitFor("document.querySelector('.doc').dataset.id === '1'");
  assert.equal(await evaluate("document.querySelector('#column-size').dataset.direction"), 'descending');
  await evaluate("document.querySelector('#column-size').click()");
  await waitFor("document.querySelector('.doc').dataset.id === '0'");
  assert.equal(await evaluate("document.querySelector('#column-size').dataset.direction"), 'ascending');
  for (const [width, dateVisible, sizeVisible] of [[1200,true,true],[820,false,true],[620,false,false]]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 850, deviceScaleFactor: 1, mobile: false });
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.doc-modified')).display !== 'none'"), dateVisible);
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.doc-size')).display !== 'none'"), sizeVisible);
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.doc-type')).display"), 'none');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.doc-status')).visibility"), 'visible');
    assert.ok(await evaluate("document.querySelector('.doc').title.includes('2020')"), 'hidden metadata stays available on hover');
  }
  await evaluate("document.querySelector('#browse').click()");
  assert.ok(await evaluate("document.querySelector('#search-dialog').getBoundingClientRect().height") < 180, 'search empty state is compact');
  assert.equal(await evaluate("document.querySelector('#matches').textContent"), '输入关键词，检索你的资料');
  assert.equal(await evaluate("document.querySelectorAll('#matches .match').length"), 0);
  await evaluate("document.querySelector('#query').value='absent'; document.querySelector('#query').dispatchEvent(new Event('input',{bubbles:true}))");
  await waitFor("document.querySelector('#matches').textContent.includes('未找到相关内容')");
  await evaluate("document.querySelector('#query').value=''; document.querySelector('#query').dispatchEvent(new Event('input',{bubbles:true}))");
  assert.equal(await evaluate("document.querySelector('#matches').textContent"), '输入关键词，检索你的资料');
  await key('Escape', 27);
  assert.equal(await evaluate("document.querySelector('#search-dialog').open"), false);
  await call('Emulation.setDeviceMetricsOverride', { width: 1200, height: 850, deviceScaleFactor: 1, mobile: false });
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  assert.equal(await evaluate("document.querySelectorAll('.masthead-tools [data-icon=triangle-alert]').length"), 0);
  await evaluate("window.beforeBadge = window.testRequests.length");
  await click('.doc[data-id="1"] .doc-tag[data-tag-id="a"]');
  await waitFor("document.querySelector('#library-title').textContent === '工作' && document.querySelectorAll('.doc').length === 1");
  assert.equal(await evaluate("document.querySelector('.tag-row[data-id=a] .tag-choice').getAttribute('aria-pressed')"), 'true');
  assert.equal(await evaluate("window.testRequests.slice(window.beforeBadge).every(message => message.type === 'page')"), true, 'badge click filters only; it does not open or retag a file');
  await evaluate("document.querySelector('.directory-all').click()");
  await waitFor("document.querySelectorAll('.doc').length === 2 && document.querySelector('#library-title').textContent === '全部资料'");
  await evaluate("document.querySelector('#sync').click()");
  await waitFor('window.testToasts.length === 2');
  assert.equal(await evaluate('window.testToasts[1].title'), '扫描完成。');
  await evaluate("window.testDensity('many')");
  for (const width of [1200, 520]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 850, deviceScaleFactor: 1, mobile: false });
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const panes = await evaluate("(() => { const p = document.querySelector('#sidebar-panes'), d = document.querySelector('.directories-section'), t = document.querySelector('.tags-section'), dl = document.querySelector('#directories'), tl = document.querySelector('#tags'); dl.scrollTop=0; tl.scrollTop=0; const before=dl.scrollTop; tl.scrollTop=40; const independent=dl.scrollTop===before && tl.scrollTop>0; return {total:p.clientHeight, dir:d.getBoundingClientRect().height, tags:t.getBoundingClientRect().height, dirScroll:dl.scrollHeight>dl.clientHeight, tagScroll:tl.scrollHeight>tl.clientHeight, independent, footer:document.querySelector('#library-footer').getBoundingClientRect().bottom, sidebar:document.querySelector('.sidebar').getBoundingClientRect().bottom}; })()");
    assert.ok(panes.tags <= Math.min(panes.total * .35, 280) + 1, JSON.stringify(panes));
    assert.ok(panes.dir > panes.tags); assert.ok(panes.dirScroll && panes.tagScroll && panes.independent);
    assert.ok(panes.footer <= panes.sidebar + 1);
    for (const [section, list, row] of [['.tags-section','#tags','.tag-row'],['.directories-section','#directories','.directory-all']]) {
      const inset = await evaluate(`(() => { const section=document.querySelector('${section}'), list=document.querySelector('${list}'), row=list.querySelector('${row}'); const sectionRight=section.getBoundingClientRect().right, contentRight=sectionRight-parseFloat(getComputedStyle(section).paddingRight); return {contentRight, rowRight:row.getBoundingClientRect().right, scrollbarRight:list.getBoundingClientRect().right, sectionRight}; })()`);
      assert.ok(Math.abs(inset.rowRight-inset.contentRight)<1, 'scrollbar does not shrink the original row content width');
      assert.ok(inset.scrollbarRight > inset.contentRight + 8 && inset.scrollbarRight < inset.sectionRight, 'scrollbar occupies the existing right padding');
    }
  }
  await call('Emulation.setDeviceMetricsOverride', { width: 1200, height: 850, deviceScaleFactor: 1, mobile: false });
  await call('Input.dispatchMouseEvent', { type:'mouseMoved', x:0, y:0 });
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await waitFor("!document.querySelector('#tags').classList.contains('is-scrolling')");
  const thumb = () => evaluate("(() => { const p=document.querySelector('#tags'); return {color:getComputedStyle(p,'::-webkit-scrollbar-thumb').backgroundColor,width:p.clientWidth}; })()");
  const idleThumb = await thumb();
  assert.equal(idleThumb.color, 'rgba(0, 0, 0, 0)', 'idle scroll thumb is fully transparent');
  await moveTo('#tags');
  await waitFor("getComputedStyle(document.querySelector('#tags'),'::-webkit-scrollbar-thumb').backgroundColor !== 'rgba(0, 0, 0, 0)'");
  assert.equal((await thumb()).width, idleThumb.width, 'revealing the scrollbar does not change pane width');
  await call('Input.dispatchMouseEvent', { type:'mouseMoved', x:0, y:0 });
  await waitFor("getComputedStyle(document.querySelector('#tags'),'::-webkit-scrollbar-thumb').backgroundColor === 'rgba(0, 0, 0, 0)'");
  await evaluate("document.querySelector('#tags').scrollTop += 30");
  await waitFor("document.querySelector('#tags').classList.contains('is-scrolling') && getComputedStyle(document.querySelector('#tags'),'::-webkit-scrollbar-thumb').backgroundColor !== 'rgba(0, 0, 0, 0)'");
  assert.notEqual((await thumb()).color, idleThumb.color, 'scrolling reveals the thumb even while the pointer is elsewhere');
  await waitFor("!document.querySelector('#tags').classList.contains('is-scrolling') && getComputedStyle(document.querySelector('#tags'),'::-webkit-scrollbar-thumb').backgroundColor === 'rgba(0, 0, 0, 0)'");
  assert.equal((await thumb()).width, idleThumb.width);
  const wheelPoint = await moveTo('#tags');
  const beforeWheel = await evaluate("document.querySelector('#tags').scrollTop");
  await call('Input.dispatchMouseEvent', { type:'mouseWheel', ...wheelPoint, deltaX:0, deltaY:80 });
  await waitFor(`document.querySelector('#tags').scrollTop > ${beforeWheel}`);
  await call('Input.dispatchMouseEvent', { type:'mouseMoved', x:0, y:0 });
  await evaluate("window.testDensity('empty')");
  assert.equal(await evaluate("!!document.querySelector('#directories .side-empty') && !!document.querySelector('#tags .side-empty')"), true);
  const emptyContext = await moveTo('.doc'); await rightClickAt(emptyContext.x,emptyContext.y);
  await moveTo('#row-classify'); await waitFor("!document.querySelector('#row-submenu').hidden");
  assert.equal(await evaluate("document.querySelector('#row-submenu').textContent.trim()"),'新建标签','an empty Tags submenu offers creation directly');
  assert.equal(await evaluate("document.querySelectorAll('#row-submenu [role=menuitemcheckbox], #row-submenu .menu-hint').length"),0,'no obsolete category/left-column instruction');
  await key('Escape',27);
  for (const [width,height] of [[1200,850],[820,650],[520,850]]) {
    await call('Emulation.setDeviceMetricsOverride', { width,height,deviceScaleFactor:1,mobile:false });
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const empty = await evaluate("(() => { const pane=document.querySelector('#sidebar-panes'), section=document.querySelector('.tags-section'), list=document.querySelector('#tags'), hint=list.querySelector('.side-empty'); const s=section.getBoundingClientRect(), l=list.getBoundingClientRect(), h=hint.getBoundingClientRect(), f=document.querySelector('#library-footer').getBoundingClientRect(); return {total:pane.clientHeight,height:s.height,center:h.y+h.height/2-l.y-l.height/2,hintTop:h.top,hintBottom:h.bottom,listTop:l.top,listBottom:l.bottom,sectionBottom:s.bottom,footerTop:f.top}; })()");
    assert.ok(empty.height >= Math.min(160,empty.total*.35)-1, `empty tags retain their minimum height: ${JSON.stringify(empty)}`);
    assert.ok(Math.abs(empty.center)<1, 'empty guidance is vertically centered rather than squeezed against the footer');
    assert.ok(empty.hintTop>=empty.listTop-1 && empty.hintBottom<=empty.listBottom+1, 'empty guidance is never clipped');
    assert.ok(empty.sectionBottom<=empty.footerTop+1, 'empty tags never overlap directory controls');
  }
  await call('Emulation.setDeviceMetricsOverride', { width:1200,height:850,deviceScaleFactor:1,mobile:false });
  await evaluate("window.finch.ui.toast = async () => { throw new Error('Fixture: native toast unavailable'); }; document.querySelector('#sync').click()");
  await waitFor("document.querySelector('#status').textContent.includes('扫描完成')");
  const fallback = await evaluate("(() => { const r=document.querySelector('#status').getBoundingClientRect(); return {top:r.top,bottom:r.bottom,width:r.width}; })()");
  assert.ok(fallback.top >= 0 && fallback.top <= 20 && fallback.bottom < 150 && fallback.width > 100, 'completion fallback stays at the top, never the footer');
  await waitFor("document.querySelector('#status').textContent === ''");
  // Library switching is intentionally a small picker, with no rename/remove controls.
  const chooseLibrary = async id => {
    await click('#library-menu-button');
    await click(`[data-library-id="${id}"] .library-choice`);
  };
  for (const width of [1200, 820, 520]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height:850, deviceScaleFactor:1, mobile:false });
    await click('#library-menu-button');
    const picker = await evaluate("(() => { const menu=document.querySelector('#library-menu').getBoundingClientRect(); return {left:menu.left,right:menu.right,top:menu.top,bottom:menu.bottom,count:document.querySelectorAll('.library-choice').length,current:document.querySelector('.library-choice[aria-checked=true]')?.closest('.library-entry').dataset.libraryId,extra:document.querySelectorAll('.library-entry-actions').length}; })()");
    assert.equal(picker.count, 3); assert.equal(picker.current, 'work'); assert.equal(picker.extra, 0);
    assert.ok(picker.left >= 0 && picker.right <= width && picker.top >= 0 && picker.bottom <= 850, `picker fits ${width}px: ${JSON.stringify(picker)}`);
    await key('Escape',27);
  }
  await chooseLibrary('personal');
  await waitFor("document.querySelectorAll('.doc').length === 1 && document.querySelector('.doc-title').textContent.includes('private.md')");
  assert.equal(await evaluate("document.querySelector('#library-path').textContent"), '个人资料');
  assert.equal(await evaluate("document.querySelector('#library-note').textContent.includes('索引和标签独立保存在本机')"), true, 'remote library explains its local independent index');
  assert.equal(await evaluate("document.querySelector('#tags').textContent.includes('个人标签')"), true);
  assert.equal(await evaluate("document.querySelector('#library-title').textContent"), '全部资料');
  assert.equal(await evaluate("window.testRequests.filter(item=>item.type==='page').at(-1).libraryRoot"), '/personal');
  await chooseLibrary('offline');
  await waitFor("!document.querySelector('#library-menu-button').disabled");
  assert.equal(await evaluate("document.querySelector('#library-path').textContent"), '个人资料', 'failed switch keeps the usable library');
  // Returning A -> B -> A must reject old same-root data, not just other-root data.
  await chooseLibrary('work');
  await waitFor("document.querySelectorAll('.doc').length === 2");
  await evaluate("window.testEmit({type:'changed',root:'/library',libraryVersion:1,tags:[{id:'stale',name:'STALE',count:1}],directories:[],change:{kind:'tagColor'}}); window.testEmit({type:'scanStarted',root:'/library',libraryVersion:1});");
  assert.equal(await evaluate("document.querySelector('#tags').textContent.includes('STALE')"), false);
  assert.equal(await evaluate("document.querySelector('#activity').hidden"), true, 'old scan cannot restart the current progress bar');
  await click('#library-menu-button'); await click('#library-location');
  await waitFor("document.querySelector('#library-path').textContent === '新增资料'");
  assert.equal(await evaluate("document.querySelectorAll('.library-choice').length"), 4);
  assert.equal(await evaluate("document.querySelectorAll('.doc').length"), 0, 'adding an empty library clears old rows');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('#document-columns')).display"), 'none', 'empty libraries show guidance without column headings');
  assert.equal(await evaluate("document.querySelector('#tags').textContent.includes('个人标签')"), false);
  await chooseLibrary('personal');
  await waitFor("document.querySelectorAll('.doc').length === 1");
  assert.equal(await evaluate("document.querySelector('#document-columns').hidden"), false, 'returning to files restores their headings');
  assert.deepEqual(runtimeErrors, []);
  console.log('UI smoke passed: multi-library add/switch/failure isolation, stale-event rejection, responsive picker,  520/820/1200px status/action exclusivity, stable row geometry, multi-tag toggles, one completion toast and non-shifting toolbar popover.');
} finally {
  if (socket?.readyState === 1) {
    socket.send(JSON.stringify({ id: ++serial, method: 'Browser.close' }));
    await new Promise(resolve => { const timer = setTimeout(resolve, 2000); browser.child.once('exit', () => { clearTimeout(timer); resolve(); }); });
    socket.close();
  }
  if (browser?.child.exitCode === null) browser.child.kill();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
}
