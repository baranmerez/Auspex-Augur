import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { notify, notificationText, toastCommand, toastScript } from '../src/schedule/notify.js';

// A spawn double: records the call and exits with the given code.
function fakeSpawn(code = 0, calls = []) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => child.emit('exit', code));
    return child;
  };
}

const hostile = 'Example report"; Remove-Item C:\\ -Recurse; $(calc) <toast>&amp;';

test('the toast is spawned with an argument array, no shell, and the text only in the environment', async () => {
  const calls = [];
  const outcome = await notify({ reportTitle: hostile, status: 'failed', errorCode: 'DATABASE_ERROR' },
    { platform: 'win32', spawnFn: fakeSpawn(0, calls), env: { SystemRoot: 'C:\\Windows', AUSPEX_DB_EXAMPLE: 'postgresql://report_reader:secret@db.example.test/exampledb', PGPASSWORD: 'secret', PATH: 'x' }, log: () => {} });
  assert.equal(outcome, 'toast');
  assert.equal(calls.length, 1);
  const { command, args, options } = calls[0];
  assert.equal(command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.ok(Array.isArray(args));
  assert.equal(options.shell, false);
  assert.equal(args.at(-1), toastScript, 'the script is the fixed string');
  for (const a of args) assert.ok(!a.includes('Example report') && !a.includes('DATABASE_ERROR'), 'no message text in the arguments');
  assert.ok(toastScript.includes('CreateTextNode($env:AUSPEX_TOAST_TITLE)'), 'text goes in as a text node');
  assert.equal(options.env.AUSPEX_TOAST_TITLE, `Auspex: ${hostile}`);
  assert.equal(options.env.AUSPEX_TOAST_TEXT, 'Scheduled run failed (DATABASE_ERROR).');
  assert.equal(options.env.AUSPEX_DB_EXAMPLE, undefined, 'connection strings are not passed on');
  assert.equal(options.env.PGPASSWORD, undefined);
  assert.equal(options.env.PATH, 'x');
});

test('the text holds the title and status only, never a message, SQL or parameters', () => {
  assert.deepEqual(notificationText({ reportTitle: 'Example report', status: 'ok' }), { title: 'Auspex: Example report', text: 'Scheduled run finished.' });
  assert.match(notificationText({ reportTitle: 'r', status: 'skipped-unreachable' }).text, /unreachable/);
  assert.equal(notificationText({ reportTitle: 'r', status: 'failed', errorCode: 'relation "example.orders" does not exist' }).text, 'Scheduled run failed.', 'only a fixed error code is shown');
  assert.equal(notificationText({ reportTitle: 'a\nb\u0007c', status: 'ok' }).title, 'Auspex: a b c', 'control characters removed');
  assert.ok(notificationText({ reportTitle: 'x'.repeat(500), status: 'ok' }).title.length <= 140);
  const c = toastCommand({ title: 't', text: 'x' }, {});
  assert.equal(c.command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
});

test('outside Windows the notification is a log line; a failing toast falls back to it and never throws', async () => {
  const lines = [];
  assert.equal(await notify({ reportTitle: 'Example report', status: 'ok' }, { platform: 'linux', spawnFn: () => assert.fail('no spawn'), log: l => lines.push(l) }), 'log');
  assert.deepEqual(lines, ['auspex scheduler: Auspex: Example report: Scheduled run finished.']);
  assert.equal(await notify({ reportTitle: 'r', status: 'ok' }, { platform: 'win32', spawnFn: fakeSpawn(1), env: {}, log: l => lines.push(l) }), 'failed');
  assert.equal(await notify({ reportTitle: 'r', status: 'ok' }, { platform: 'win32', spawnFn: () => { throw new Error('ENOENT'); }, env: {}, log: () => {} }), 'failed');
  const hang = () => { const c = new EventEmitter(); c.kill = () => {}; return c; };
  assert.equal(await notify({ reportTitle: 'r', status: 'ok' }, { platform: 'win32', spawnFn: hang, env: {}, log: () => {}, timeoutMs: 20 }), 'failed');
});

test('a successful run says how many rows it returned and calls out an empty result', () => {
  const text = m => notificationText({ reportTitle: 'r', status: 'ok', ...m }).text;
  assert.equal(text({ rows: 1091 }), 'Finished: 1,091 rows.');
  assert.equal(text({ rows: 1 }), 'Finished: 1 row.');
  assert.equal(text({ rows: 0 }), 'Finished, but the result is empty (0 rows). Check the period or the data.');
  assert.equal(text({ rows: null, estimatedRows: 1499.6 }), 'Finished: about 1,500 rows (estimated).');
  assert.equal(text({}), 'Scheduled run finished.');
  assert.equal(text({ rows: -1 }), 'Scheduled run finished.', 'not a count');
  assert.equal(text({ rows: '12; rm' }), 'Scheduled run finished.', 'not a count');
  assert.equal(notificationText({ reportTitle: 'r', status: 'failed', errorCode: 'TIMEOUT', rows: 5 }).text, 'Scheduled run failed (TIMEOUT).', 'counts only for successful runs');
});
