import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const SCRIPT = String.raw`param(
  [string]$Origin,
  [string]$Token,
  [int]$ParentPid
)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = [System.Drawing.SystemIcons]::Application
$tray.Text = '黄果 PotPlayer 点播台'
$tray.Visible = $true
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = $menu.Items.Add('打开点播台')
$restartItem = $menu.Items.Add('重启服务')
$exitItem = $menu.Items.Add('退出服务')
$tray.ContextMenuStrip = $menu

function Invoke-LocalAction([string]$Path) {
  try {
    Invoke-WebRequest -UseBasicParsing -Method Post -Uri ($Origin + $Path) -Headers @{
      'X-HG-Token' = $Token
      'Origin' = $Origin
    } -ContentType 'application/json' -Body '{}' -TimeoutSec 3 | Out-Null
  } catch {}
}

$openAction = {
  try { Start-Process $Origin } catch {}
}
$openItem.add_Click($openAction)
$tray.add_DoubleClick($openAction)
$restartItem.add_Click({
  Invoke-LocalAction '/api/restart'
  $tray.Visible = $false
  [System.Windows.Forms.Application]::Exit()
})
$exitItem.add_Click({
  Invoke-LocalAction '/api/shutdown'
  $tray.Visible = $false
  [System.Windows.Forms.Application]::Exit()
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1200
$timer.add_Tick({
  if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) {
    $tray.Visible = $false
    [System.Windows.Forms.Application]::Exit()
  }
})
$timer.Start()
[System.Windows.Forms.Application]::Run()
$timer.Stop()
$tray.Visible = $false
$tray.Dispose()
`;

export function startTray(dataDirectory, origin, token) {
  if (process.env.HG_NO_TRAY === '1' || process.platform !== 'win32') return null;
  try {
    const scriptPath = path.join(dataDirectory, 'tray.ps1');
    writeFileSync(scriptPath, `\ufeff${SCRIPT}`, 'utf8');
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden',
      '-File', scriptPath,
      '-Origin', origin,
      '-Token', token,
      '-ParentPid', String(process.pid),
    ], {
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return child;
  } catch {
    return null;
  }
}
