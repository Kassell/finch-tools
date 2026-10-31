import assert from 'node:assert/strict';
import { test } from 'node:test';
import { directoryPickerCommand, pickDirectory } from '../dist/index.js';

test('Windows opens a native folder browser in STA mode with safe Unicode parameters', () => {
  const title = "选择目录 ' ; throw 'not code'";
  const previous = 'C:\\资料\\目录 A';
  const command = directoryPickerCommand('win32', title, previous);
  assert.equal(command.command, 'powershell.exe');
  assert.ok(command.args.includes('-STA'));
  const script = Buffer.from(command.args.at(-1), 'base64').toString('utf16le');
  assert.match(script, /System.Windows.Forms.FolderBrowserDialog/);
  assert.match(script, /ShowDialog\(\$owner\)/);
  assert.ok(script.includes(Buffer.from(title, 'utf8').toString('base64')));
  assert.ok(script.includes(Buffer.from(previous, 'utf8').toString('base64')));
  assert.equal(script.includes(title), false, 'user text is never executable PowerShell');
});

test('selection returns the exact Unicode path, cancellation never asks for typed input', async () => {
  const selected = await pickDirectory('Choose', '', async () => ({ stdout: '\uFEFFC:\\资料\\A B\r\n' }), 'win32');
  assert.equal(selected, 'C:\\资料\\A B');
  assert.equal(await pickDirectory('Choose', '', async () => ({ stdout: '' }), 'win32'), null);
  await assert.rejects(pickDirectory('Choose', '', async () => { throw new Error('Picker unavailable'); }, 'win32'), /Picker unavailable/);
});

test('macOS and Linux use native desktop directory pickers, including dismissal', async () => {
  assert.equal(directoryPickerCommand('darwin', 'Choose').command, 'osascript');
  assert.ok(directoryPickerCommand('linux', 'Choose').args.includes('--directory'));
  assert.equal(await pickDirectory('Choose', '', async () => { throw Object.assign(new Error('cancel'), { code: 1 }); }, 'linux'), null);
  const calls = [];
  assert.equal(await pickDirectory('Choose', '', async command => {
    calls.push(command);
    if (command === 'zenity') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return { stdout: '/home/test/docs\n' };
  }, 'linux'), '/home/test/docs');
  assert.deepEqual(calls, ['zenity', 'kdialog']);
});
