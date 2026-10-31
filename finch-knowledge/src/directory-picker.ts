import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sep } from 'node:path';

const execute = promisify(execFile);
export interface PickerCommand { command: string; args: string[] }

/** Parameters are data, never executable PowerShell/AppleScript source. */
export function directoryPickerCommand(platform: string, title: string, previous = ''): PickerCommand {
  if (platform === 'win32') {
    const text = (value: string) => Buffer.from(value, 'utf8').toString('base64');
    const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$picker = New-Object System.Windows.Forms.FolderBrowserDialog
$picker.Description = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${text(title)}'))
$picker.SelectedPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${text(previous)}'))
$picker.ShowNewFolderButton = $true
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.StartPosition = 'CenterScreen'
$owner.Opacity = 0
try {
  $owner.Show()
  $owner.Activate()
  if ($picker.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Out.Write($picker.SelectedPath)
  }
} finally {
  $picker.Dispose()
  $owner.Close()
  $owner.Dispose()
}
`;
    return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] };
  }
  if (platform === 'darwin') return {
    command: 'osascript', args: ['-e', 'on run argv', '-e', 'POSIX path of (choose folder with prompt (item 1 of argv))', '-e', 'end run', '--', title],
  };
  return { command: 'zenity', args: ['--file-selection', '--directory', '--title', title, ...(previous ? ['--filename', previous.endsWith(sep) ? previous : previous + sep] : [])] };
}

/** Cancellation is a no-op; unavailable desktop pickers fail visibly, never request typed paths. */
export async function pickDirectory(title: string, previous = '', run = execute, platform = process.platform): Promise<string | null> {
  const command = directoryPickerCommand(platform, title, previous);
  try {
    const { stdout } = await run(command.command, command.args, { encoding: 'utf8', windowsHide: true, timeout: 600_000, maxBuffer: 1024 * 1024 });
    return String(stdout).replace(/^\uFEFF/, '').trim() || null;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    if (platform === 'darwin' && String(error).includes('-128')) return null;
    if (platform !== 'darwin' && platform !== 'win32' && Number(failure.code) === 1) return null;
    if (platform !== 'darwin' && platform !== 'win32' && failure.code === 'ENOENT') {
      try {
        const { stdout } = await run('kdialog', ['--getexistingdirectory', previous || '.', '--title', title], { encoding: 'utf8', timeout: 600_000, maxBuffer: 1024 * 1024 });
        return String(stdout).trim() || null;
      } catch (fallback) {
        if (Number((fallback as NodeJS.ErrnoException).code) === 1) return null;
        throw fallback;
      }
    }
    throw error;
  }
}
