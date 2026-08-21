'use strict';
const { spawn } = require('child_process');
const readline = require('readline');

// SHQueryUserNotificationState 的全屏状态:2=全屏应用(如浏览器 F11)、
// 3=D3D 独占全屏(游戏)、4=演示模式、7=沉浸式商店应用。
// 系统自己就用这个 API 在全屏时屏蔽通知,语义正好一致。
const FULLSCREEN_STATES = [2, 3, 4, 7];

const isFullscreenQuns = (state) => FULLSCREEN_STATES.includes(state);

// ponytail: 常驻 PowerShell 轮询代替 native 模块;3s 粒度足够,状态变化才输出一行。
const WATCH_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  'Add-Type -Namespace Q -Name U -MemberDefinition \'[DllImport("shell32.dll")]public static extern int SHQueryUserNotificationState(out int s);\'',
  '$p=-1',
  'while($true){',
  '  $s=0',
  '  [void][Q.U]::SHQueryUserNotificationState([ref]$s)',
  `  $f=[int](${FULLSCREEN_STATES.map((s) => `$s -eq ${s}`).join(' -or ')})`,
  '  if($f -ne $p){[Console]::Out.WriteLine($f);[Console]::Out.Flush();$p=$f}',
  '  Start-Sleep -Seconds 3',
  '}',
].join('\n');

function startFullscreenWatch(onChange) {
  let child = null;
  let stopped = false;
  let retryTimer = null;
  const launch = () => {
    if (stopped) return;
    child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        Buffer.from(WATCH_SCRIPT, 'utf16le').toString('base64'),
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      const flag = line.trim();
      if (flag === '0' || flag === '1') onChange(flag === '1');
    });
    child.on('error', () => {});
    child.on('exit', () => {
      child = null;
      if (stopped) return;
      onChange(false); // 探测进程挂了就当没有全屏,让悬浮条恢复显示
      retryTimer = setTimeout(launch, 30_000);
      if (retryTimer.unref) retryTimer.unref();
    });
  };
  launch();
  return {
    stop() {
      stopped = true;
      clearTimeout(retryTimer);
      retryTimer = null;
      if (child) child.kill();
      child = null;
    },
  };
}

module.exports = { FULLSCREEN_STATES, WATCH_SCRIPT, isFullscreenQuns, startFullscreenWatch };
