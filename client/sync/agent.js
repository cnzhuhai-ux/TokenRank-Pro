import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync, copyFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { SYNC_DIR, readConfig, writeConfig } from './config.js';
export const LABEL = 'com.tokenrank.sync';
export const TASK = 'TokenRankSync';
export const entry = resolve(import.meta.dirname, '../bin/tokenrank.js');
const xml = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const ps = text => "'" + String(text).replaceAll("'", "''") + "'";
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'pipe' });
export function plist({ node = process.execPath, script = entry, dir = SYNC_DIR } = {}) {
  const args = [node, '--no-warnings', script, 'watch'];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array>${args.map(a => `<string>${xml(a)}</string>`).join('')}</array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>15</integer>
<key>StandardOutPath</key><string>${xml(join(dir, 'logs', 'sync.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(dir, 'logs', 'sync.err.log'))}</string>
</dict></plist>\n`;
}
export function windowsScript({ node = process.execPath, script = entry } = {}) {
  const quote = s => '"' + s.replaceAll('"', '""') + '"';
  return `Dim result\r\nresult = CreateObject("WScript.Shell").Run(${quote(quote(node) + ' --no-warnings ' + quote(script) + ' watch')}, 0, True)\r\nWScript.Quit result\r\n`;
}
const stopWindows = () => `$script=${ps(entry)}; Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('"' + $script + '"') -and $_.CommandLine -match '\\s+watch(?:\\s|$)' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }; `;
// 重装韧性：任务可能由提权上下文注册，注销/覆盖注册都可能被拒（0x80070005）。
// vbs 路径每次安装固定不变且安装时重写内容——旧任务指向它就等于运行新代码，
// 因此"删不掉但 action 匹配"时选择复用而不是让整个安装失败。
const WIN_INSTALL = (vbs) => [
  "$ErrorActionPreference='Stop'",
  "try{ if(Get-ScheduledTask -TaskName 'TokenRankSync' -ErrorAction SilentlyContinue){ Stop-ScheduledTask -TaskName 'TokenRankSync' -ErrorAction SilentlyContinue } }catch{}",
  stopWindows(),
  "try{",
  `$a=New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ${ps('"' + vbs + '"')};`,
  "$t=New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME; $retry=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Minutes 5);",
  "$s=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries;",
  `Register-ScheduledTask -TaskName 'TokenRankSync' -Action $a -Trigger @($t,$retry) -Settings $s -User $env:USERNAME -RunLevel Limited -Force | Out-Null; Start-ScheduledTask -TaskName 'TokenRankSync'; Write-Output 'REGISTERED'`,
  "}catch{",
  "$t=Get-ScheduledTask -TaskName 'TokenRankSync' -ErrorAction SilentlyContinue;",
  `if($t -and (($t.Actions | Out-String).Contains(${ps('"' + vbs + '"')}))){ Write-Output 'REUSED'; try{ Start-ScheduledTask -TaskName 'TokenRankSync' }catch{} }`,
  "else{ Write-Output ('FAILED ' + $_.Exception.Message); exit 1 }",
  "}",
].join('; ');
const WIN_UNINSTALL = [
  "$ErrorActionPreference='Stop'",
  "$deleted=$false",
  "try{ if(Get-ScheduledTask -TaskName 'TokenRankSync' -ErrorAction SilentlyContinue){ Stop-ScheduledTask -TaskName 'TokenRankSync' -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName 'TokenRankSync' -Confirm:$false }; $deleted=$true }catch{}",
  "if(-not $deleted){ try{ schtasks.exe /End /TN 'TokenRankSync' | Out-Null; schtasks.exe /Delete /TN 'TokenRankSync' /F | Out-Null; $deleted=$true }catch{} }",
  "if($deleted){ Write-Output 'DELETED' } else { Write-Output 'DENIED' }",
  stopWindows(),
].join('; ');
export function installAgent({ dryRun = false, platform = process.platform, home = homedir(), dir = SYNC_DIR, runner = run, log = console.log } = {}) {
  const vbs = join(dir, 'sync.vbs');
  const macPath = join(home, 'Library', 'LaunchAgents', LABEL + '.plist');
  if (!['darwin', 'win32', 'linux'].includes(platform)) throw new Error('当前平台请使用 tokenrank watch 手动运行');
  if (dryRun) { log(platform === 'darwin' ? plist({ dir }) : platform === 'win32' ? windowsScript() : `tokenrank-sync.service: ${process.execPath} ${entry} watch`); return; }
  mkdirSync(join(dir, 'logs'), { recursive: true, mode: 0o700 });
  if (platform === 'darwin') {
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(macPath, plist({ dir }));
    try { runner('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`]); } catch {}
    runner('launchctl', ['bootstrap', `gui/${process.getuid()}`, macPath]);
  } else if (platform === 'win32') {
    writeFileSync(vbs, windowsScript());
    // AtLogOn starts a persistent read-only sync loop; only our dedicated task is touched.
    const out = String(runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_INSTALL(vbs)]) ?? '');
    // 旧桩子/旧 runner 无 stdout 时视为成功；REUSED = 任务删不掉但指向本安装的 vbs，内容已更新
    if (out.includes('REUSED')) log('已复用现有计划任务 TokenRankSync（内容已更新；如需重建请以管理员运行 schtasks /Delete /TN TokenRankSync /F）。');
    else if (out.includes('FAILED')) {
      const message = out.split('FAILED')[1]?.trim() || '未知原因';
      throw new Error(`计划任务 TokenRankSync 注册失败：${message}。请以管理员身份运行 schtasks /Delete /TN TokenRankSync /F 后重试安装`);
    }
  } else {
    const unitDir = join(home, '.config', 'systemd', 'user');
    mkdirSync(unitDir, { recursive: true });
    const quote = s => '"' + s.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%') + '"';
    writeFileSync(join(unitDir, 'tokenrank-sync.service'), `[Unit]\nDescription=TokenRank read-only sync\n[Service]\nExecStart=${quote(process.execPath)} --no-warnings ${quote(entry)} watch\nRestart=always\nRestartSec=15\n[Install]\nWantedBy=default.target\n`);
    runner('systemctl', ['--user', 'daemon-reload']); runner('systemctl', ['--user', 'enable', '--now', 'tokenrank-sync.service']);
    runner('systemctl', ['--user', 'restart', 'tokenrank-sync.service']);
  }
  log('已启动独立同步服务；原版 token-watcher 的服务未改变。');
}
export function uninstallAgent({ platform = process.platform, home = homedir(), dir = SYNC_DIR, runner = run, log = console.warn } = {}) {
  if (platform === 'darwin') {
    try { runner('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`]); } catch {}
    rmSync(join(home, 'Library', 'LaunchAgents', LABEL + '.plist'), { force: true });
  } else if (platform === 'win32') {
    // 重装场景下任务可能注册自提权上下文：注销被拒时退回 schtasks，再不行就给出
    // 明确的操作指引而不是让整个安装流程失败（vbs 会在随后的安装里被重写）。
    const out = String(runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_UNINSTALL]) ?? '');
    if (out.includes('DENIED')) {
      log('计划任务 TokenRankSync 删除需要管理员权限：请以管理员身份运行 schtasks /Delete /TN TokenRankSync /F。不影响本次安装（任务指向的脚本已更新）。');
      return 'denied';
    }
    rmSync(join(dir, 'sync.vbs'), { force: true });
  } else if (platform === 'linux') {
    try { runner('systemctl', ['--user', 'disable', '--now', 'tokenrank-sync.service']); } catch {}
    rmSync(join(home, '.config', 'systemd', 'user', 'tokenrank-sync.service'), { force: true });
    runner('systemctl', ['--user', 'daemon-reload']);
  }
}

/** Retire only an old TokenRank service with proven executable ownership. Never remove an original installation. */
export function migrateLegacyAgent({ appRoot, home = homedir(), platform = process.platform, dir = SYNC_DIR, runner = run, log = console.log } = {}) {
  if (!appRoot) return false;
  const root = resolve(appRoot), manifest = join(root, 'package.json');
  if (!existsSync(manifest)) return false;
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
  if (pkg.name !== 'tokenrank-client' || pkg.version !== '0.1.0') return false;
  const script = join(root, 'bin', 'tokenwatcher.js');
  if (platform === 'darwin') {
    const file = join(home, 'Library', 'LaunchAgents', 'com.tokenwatcher.server.plist');
    if (!existsSync(file)) return false;
    const contents = readFileSync(file, 'utf8');
    const actualScript = existsSync(script) ? realpathSync(script) : script;
    if (![actualScript, script].some(path => contents.includes(`<string>${xml(path)}</string>`))) return false;
    mkdirSync(join(dir, 'migrations'), { recursive: true });
    copyFileSync(file, join(dir, 'migrations', `legacy-agent-${Date.now()}.plist`));
    let loaded = false;
    try { runner('launchctl', ['print', `gui/${process.getuid()}/com.tokenwatcher.server`]); loaded = true; } catch {}
    if (loaded) runner('launchctl', ['bootout', `gui/${process.getuid()}/com.tokenwatcher.server`]);
    rmSync(file);
    writeConfig({ ...readConfig(dir), legacy_collector_retired: true }, dir);
  } else if (platform === 'win32') {
    const vbs = join(home, '.tokenmeter', 'rank-watch.vbs');
    if (!existsSync(vbs) || !readFileSync(vbs, 'utf8').includes(script.replaceAll('"', '""'))) return false;
    // Inspect process and task action before stopping, avoiding unrelated recycled PIDs/tasks.
    const command = `$old=${ps(script)}; Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($old) -and $_.CommandLine.Contains('rank-watch') } | ForEach-Object { Stop-Process -Id $_.ProcessId }; `
      + `$t=Get-ScheduledTask -TaskName 'TokenRank' -ErrorAction SilentlyContinue; if($t -and (($t.Actions | Out-String).Contains(${ps(vbs)}))){Unregister-ScheduledTask -TaskName 'TokenRank' -Confirm:$false}`;
    runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]);
    // Preserve the upstream data directory; remove only the old TokenRank login shortcut.
    const shortcut = join(home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'TokenRank.lnk');
    runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `if(Test-Path ${ps(shortcut)}){$s=(New-Object -ComObject WScript.Shell).CreateShortcut(${ps(shortcut)}); if($s.Arguments.Contains(${ps(vbs)})){Remove-Item -LiteralPath ${ps(shortcut)}}`]);
  } else return false;
  log('已停用确认属于旧 TokenRank 的后台服务；统计库保持原样。请确认原版 token-watcher 已独立运行。');
  return true;
}
