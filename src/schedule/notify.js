// Desktop notification for a scheduled run: report title and status only,
// never data values, SQL, parameters or error messages.
//
// Windows: a toast through Windows PowerShell. The script is a fixed string;
// the title and text travel in environment variables and are put into the
// toast XML with CreateTextNode, so they are never parsed as script or markup.
// Spawned with an argument array, without a shell. Other systems, or when the
// toast fails: one line on stderr only. A notification never fails a run.
import { spawn } from 'node:child_process';

// PowerShell's own AppUserModelID: toasts show without registering an app.
const appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';
export const toastScript = [
  "$ErrorActionPreference = 'Stop'",
  '[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]',
  '[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]',
  '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
  "$xml.LoadXml('<toast><visual><binding template=\"ToastGeneric\"><text/><text/></binding></visual></toast>')",
  "$texts = $xml.GetElementsByTagName('text')",
  '[void]$texts.Item(0).AppendChild($xml.CreateTextNode($env:AUSPEX_TOAST_TITLE))',
  '[void]$texts.Item(1).AppendChild($xml.CreateTextNode($env:AUSPEX_TOAST_TEXT))',
  '$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)',
  `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${appId}').Show($toast)`,
].join('; ');

const statusText = {
  ok: 'Scheduled run finished.',
  'skipped-unreachable': 'Skipped: the database was unreachable. It is retried later.',
  failed: 'Scheduled run failed',
};

// Plain one-line text: control characters removed, length capped.
const clean = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim().slice(0, max);

// { title, text } of a notification. errorCode is one of the fixed codes of
// src/errors.js (never a message).
export function notificationText({ reportTitle, status, errorCode }) {
  const title = clean(`Auspex: ${clean(reportTitle, 120) || 'scheduled report'}`, 140);
  const base = statusText[status] ?? 'Scheduled run finished with an unknown status.';
  const code = status === 'failed' && /^[A-Z_]{1,40}$/.test(String(errorCode ?? '')) ? ` (${errorCode}).` : status === 'failed' ? '.' : '';
  return { title, text: base + code };
}

// The process to start for a toast: { command, args, options }. Exported for tests.
export function toastCommand({ title, text }, env = process.env) {
  const root = env.SystemRoot || env.windir || 'C:\\Windows';
  // The child gets the usual environment without Auspex and libpq settings
  // (an AUSPEX_PROFILE_* variable holds a connection string).
  const childEnv = Object.fromEntries(Object.entries(env).filter(([k]) => !/^(AUSPEX_|PG)/i.test(k)));
  return {
    command: `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', toastScript],
    options: {
      shell: false, windowsHide: true, stdio: 'ignore',
      env: { ...childEnv, SystemRoot: root, AUSPEX_TOAST_TITLE: title, AUSPEX_TOAST_TEXT: text },
    },
  };
}

// Shows a notification; resolves to 'toast', 'log' or 'failed'. Never throws.
// spawnFn and platform are injectable for tests.
export function notify(message, { platform = process.platform, spawnFn = spawn, env = process.env, log = line => process.stderr.write(`${line}\n`), timeoutMs = 15000 } = {}) {
  const { title, text } = notificationText(message);
  const logLine = () => log(`auspex scheduler: ${title}: ${text}`);
  if (platform !== 'win32') {
    logLine();
    return Promise.resolve('log');
  }
  return new Promise(resolve => {
    let done = false;
    const finish = outcome => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (outcome !== 'toast') logLine();
      resolve(outcome);
    };
    let child;
    const timer = setTimeout(() => { try { child?.kill(); } catch { /* ignore */ } finish('failed'); }, timeoutMs);
    try {
      const { command, args, options } = toastCommand({ title, text }, env);
      child = spawnFn(command, args, options);
      child.on('error', () => finish('failed'));
      child.on('exit', code => finish(code === 0 ? 'toast' : 'failed'));
    } catch {
      finish('failed');
    }
  });
}
