// Desktop notification for a scheduled run: report title, status and the row
// count only, never data values, SQL, parameters or error messages.
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

// Notification texts per language ("language" in schedules.json, else the
// notesLanguage of the profiles file, else English); the viewer offers the
// same two languages.
export const notificationLanguages = ['en', 'tr'];
const texts = {
  en: {
    locale: 'en-US',
    report: 'scheduled report',
    ok: 'Scheduled run finished.',
    'skipped-unreachable': 'Skipped: the database was unreachable. It is retried later.',
    failed: 'Scheduled run failed',
    unknown: 'Scheduled run finished with an unknown status.',
    empty: 'Finished, but the result is empty (0 rows). Check the period or the data.',
    rows: (n, count) => `Finished: ${n} ${count === 1 ? 'row' : 'rows'}.`,
    estimated: n => `Finished: about ${n} rows (estimated).`,
    persistence: 'The report ran, but saving its trend point or the scheduler state failed',
    repairedNext: 'It is repaired on the next run without running the report again.',
    lost: 'The report ran, but a trend point was lost and cannot be restored',
  },
  tr: {
    locale: 'tr-TR',
    report: 'zamanlanm\u0131\u015f rapor',
    ok: 'Zamanlanm\u0131\u015f \u00e7al\u0131\u015ft\u0131rma tamamland\u0131.',
    'skipped-unreachable': 'Atland\u0131: veritaban\u0131na ula\u015f\u0131lamad\u0131. Daha sonra yeniden denenecek.',
    failed: 'Zamanlanm\u0131\u015f \u00e7al\u0131\u015ft\u0131rma ba\u015far\u0131s\u0131z',
    unknown: 'Zamanlanm\u0131\u015f \u00e7al\u0131\u015ft\u0131rma bilinmeyen bir durumla bitti.',
    empty: 'Tamamland\u0131, ancak sonu\u00e7 bo\u015f (0 sat\u0131r). D\u00f6nemi ya da veriyi kontrol et.',
    rows: n => `Tamamland\u0131: ${n} sat\u0131r.`,
    estimated: n => `Tamamland\u0131: yakla\u015f\u0131k ${n} sat\u0131r (tahmini).`,
    persistence: 'Rapor \u00e7al\u0131\u015ft\u0131, ancak trend noktas\u0131 ya da zamanlay\u0131c\u0131 durumu kaydedilemedi',
    repairedNext: 'Bir sonraki \u00e7al\u0131\u015ft\u0131rmada rapor yeniden \u00e7al\u0131\u015ft\u0131r\u0131lmadan onar\u0131l\u0131r.',
    lost: 'Rapor \u00e7al\u0131\u015ft\u0131, ancak bir trend noktas\u0131 kayboldu ve geri getirilemez',
  },
};

// Plain one-line text: control characters removed, length capped.
const clean = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim().slice(0, max);

const count = v => (Number.isInteger(v) && v >= 0 ? v : null);

// Text of a successful run: the row count when it is known (an empty result
// is called out, since it usually means a wrong period or missing data),
// else the planner's estimate, else the plain status.
function okText(t, rows, estimatedRows) {
  const n = v => v.toLocaleString(t.locale);
  if (rows === 0) return t.empty;
  if (rows !== null) return t.rows(n(rows), rows);
  if (estimatedRows !== null) return t.estimated(n(estimatedRows));
  return t.ok;
}

// { title, text } of a notification. errorCode is one of the fixed codes of
// src/errors.js (never a message); rows and estimatedRows are counts of the
// result (see runRows in store.js); language one of notificationLanguages.
export function notificationText({ reportTitle, status, errorCode, rows, estimatedRows, persistenceError, trendLost }, language = 'en') {
  const t = texts[language] ?? texts.en;
  const title = clean(`Auspex: ${clean(reportTitle, 120) || t.report}`, 140);
  // A successful run whose local writes failed: the code only, never a message.
  // A lost trend point cannot be repaired: no "repaired next run" promise.
  if (status === 'ok' && (persistenceError === 'TREND_LOST' || trendLost === true)) return { title, text: `${t.lost}.` };
  if (status === 'ok' && persistenceError) {
    const code = /^[A-Z_]{1,40}$/.test(String(persistenceError)) ? ` (${persistenceError})` : '';
    return { title, text: `${t.persistence}${code}. ${t.repairedNext}` };
  }
  if (status === 'ok') return { title, text: okText(t, count(rows), count(Number.isFinite(estimatedRows) ? Math.round(estimatedRows) : null)) };
  const base = status === 'skipped-unreachable' || status === 'failed' ? t[status] : t.unknown;
  const code = status === 'failed' && /^[A-Z_]{1,40}$/.test(String(errorCode ?? '')) ? ` (${errorCode}).` : status === 'failed' ? '.' : '';
  return { title, text: base + code };
}

// An empty result is worth a notification even when only failures are asked for.
export const isEmptyResult = ({ status, rows }) => status === 'ok' && rows === 0;

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
export function notify(message, { language = 'en', platform = process.platform, spawnFn = spawn, env = process.env, log = line => process.stderr.write(`${line}\n`), timeoutMs = 15000 } = {}) {
  const { title, text } = notificationText(message, language);
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
