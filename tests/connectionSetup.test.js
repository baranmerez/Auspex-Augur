import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConnection, connectionUrl, mergeProfiles, mergePgpass, pgpassEscape, pgpassFields, pgpassFile } from '../src/connectionSetup.js';
import { readProfilesFile } from '../src/config.js';

// The Setup screen's connection step: the profile into profiles.json, the
// password into pgpass, the password nowhere else. Invented names only.
const cli = fileURLToPath(new URL('../src/stageCli.js', import.meta.url));
const secret = 'S3cr:et\\pw-öz';
const request = (extra = {}) => ({ profileName: 'exampledb', host: 'db.example.test', port: 5432, database: 'exampledb', user: 'report_reader', password: secret, ...extra });

test('requests are checked field by field and errors never echo the password', () => {
  assert.deepEqual(validateConnection(request()), request());
  const cases = [
    [null, /JSON object/], [[1], /JSON object/],
    [{ ...request(), extra: 1 }, /Unknown field\(s\): extra/],
    [(({ password, ...r }) => r)(request()), /Missing field\(s\): password/],
    [request({ profileName: 'Example' }), /profileName/], [request({ profileName: '1x' }), /profileName/], [request({ profileName: 'a'.repeat(41) }), /profileName/],
    [request({ host: 'db.example.test/x' }), /host/], [request({ host: 'user@db.example.test' }), /host/], [request({ host: '' }), /host/], [request({ host: '[::1]' }), /host/],
    [request({ port: '5432' }), /port/], [request({ port: 0 }), /port/], [request({ port: 65536 }), /port/], [request({ port: 54.5 }), /port/],
    [request({ database: '' }), /database/], [request({ database: 'a'.repeat(64) }), /database/], [request({ database: 'a\nb' }), /database/], [request({ user: ' report_reader' }), /user/],
    [request({ password: '' }), /password is required/], [request({ password: 'a\nb' }), /one line/], [request({ password: 'x'.repeat(1025) }), /at most 1024/], [request({ password: 5 }), /password is required/],
  ];
  for (const [body, re] of cases) {
    assert.throws(() => validateConnection(body), err => re.test(err.message) && !err.message.includes(secret) && !err.message.includes('a\nb'), JSON.stringify(body)?.slice(0, 80));
  }
  assert.doesNotThrow(() => validateConnection(request({ host: '::1' })));
  assert.doesNotThrow(() => validateConnection(request({ host: '10.0.0.5', database: 'örnek db' })));
});

test('the profile URL is percent-encoded, brackets IPv6 and passes the server\'s own check', () => {
  assert.equal(connectionUrl(request()), 'postgresql://report_reader@db.example.test:5432/exampledb');
  assert.equal(connectionUrl(request({ host: '::1', user: 'report reader', database: 'örnek/db' })), 'postgresql://report%20reader@[::1]:5432/%C3%B6rnek%2Fdb');
});

test('profiles.json: the profile is added or its url replaced; everything else stays, in order', () => {
  const url = 'postgresql://report_reader@db.example.test:5432/exampledb';
  const added = mergeProfiles(null, 'exampledb', url);
  assert.equal(added.action, 'added');
  assert.deepEqual(JSON.parse(added.text), { exampledb: { url } });
  const before = { notesLanguage: 'tr', testdb: { url: 'postgresql://report_reader@db.example.test:5433/testdb', description: 'Test' }, ExampleDB: { url: 'postgresql://old@db.example.test/exampledb', description: 'Kept', maxTimeoutSeconds: 60 }, scriptRoots: { scripts: '/x' } };
  const updated = mergeProfiles('\uFEFF' + JSON.stringify(before), 'exampledb', url);
  assert.equal(updated.action, 'updated');
  const after = JSON.parse(updated.text);
  assert.deepEqual(Object.keys(after), Object.keys(before), 'no key added, removed or moved; a case variant is the same profile');
  assert.deepEqual(after.ExampleDB, { url, description: 'Kept', maxTimeoutSeconds: 60 });
  assert.deepEqual(after.testdb, before.testdb);
  assert.equal(after.notesLanguage, 'tr');
  assert.ok(!updated.text.startsWith('\uFEFF'), 'written without BOM');
  for (const broken of ['{ not json', '[]', '{"exampledb": "x"}']) {
    assert.throws(() => mergeProfiles(broken, 'exampledb', url), /nothing was written/);
  }
  assert.throws(() => mergeProfiles(null, 'exampledb', 'postgresql://u:pw@db.example.test/x'), /password/);
});

test('pgpass: escaping, replacing the matching line only, keeping the rest byte for byte', () => {
  assert.equal(pgpassEscape('a:b\\c'), 'a\\:b\\\\c');
  assert.deepEqual(pgpassFields('h\\:x:5432:d:u:p\\\\w'), ['h:x', '5432', 'd', 'u', 'p\\w']);
  const line = 'db.example.test:5432:exampledb:report_reader:S3cr\\:et\\\\pw-öz';
  const added = mergePgpass(null, request(), '\n');
  assert.deepEqual(added, { text: `${line}\n`, action: 'added', beforeWildcard: false });
  const others = '# my servers\r\n\r\ndb.example.test:5433:testdb:report_reader:other\r\ndb.example.test:5432:otherdb:report_reader:other\r\n';
  const appended = mergePgpass(others, request(), '\n');
  assert.equal(appended.text, `${others}${line}\r\n`, 'same host and user with another port or database is another entry; the file\'s own line ending is used');
  const noFinalNewline = mergePgpass('a:1:b:c:d', request(), '\n');
  assert.equal(noFinalNewline.text, `a:1:b:c:d\n${line}\n`);
  const existing = `\uFEFFfirst:1:x:y:z\ndb.example.test:5432:exampledb:report_reader:old\r\nlast:2:x:y:z`;
  const replaced = mergePgpass(existing, request(), '\n');
  assert.equal(replaced.action, 'replaced');
  assert.equal(replaced.text, `first:1:x:y:z\n${line}\r\nlast:2:x:y:z`, 'BOM dropped, other lines and endings unchanged');
  const commented = mergePgpass('#db.example.test:5432:exampledb:report_reader:old\n', request(), '\n');
  assert.equal(commented.action, 'added', 'comments never match');
  // Wildcards: never replaced; the exact line goes before the first one that
  // would also match, so libpq (first match wins) uses the new password.
  const wild = 'a:1:b:c:d\n*:*:*:report_reader:wild\n*:5432:exampledb:report_reader:wild2\n';
  const beforeWild = mergePgpass(wild, request(), '\n');
  assert.deepEqual(beforeWild, { text: `a:1:b:c:d\n${line}\n*:*:*:report_reader:wild\n*:5432:exampledb:report_reader:wild2\n`, action: 'added', beforeWildcard: true });
  const otherUser = mergePgpass('*:*:*:someone_else:wild\n', request(), '\n');
  assert.deepEqual([otherUser.beforeWildcard, otherUser.text], [false, `*:*:*:someone_else:wild\n${line}\n`], 'a wildcard line for another user does not match');
  const literalStar = mergePgpass('\\*:5432:exampledb:report_reader:lit\n', request(), '\n');
  assert.equal(literalStar.beforeWildcard, false, 'an escaped \\* is a literal star, not a wildcard');
  const shadowed = mergePgpass('*:*:*:*:wild\ndb.example.test:5432:exampledb:report_reader:old\n', request(), '\n');
  assert.deepEqual([shadowed.action, shadowed.shadowedByWildcard, shadowed.text], ['replaced', true, `*:*:*:*:wild\n${line}\n`], 'replaced in place, the wildcard before it is reported');
  const escapedHost = mergePgpass('fe80\\:\\:1:5432:exampledb:report_reader:old\n', request({ host: 'fe80::1' }), '\n');
  assert.deepEqual([escapedHost.action, escapedHost.text], ['replaced', 'fe80\\:\\:1:5432:exampledb:report_reader:S3cr\\:et\\\\pw-öz\n']);
});

test('pgpass location: absolute PGPASSFILE, else APPDATA on Windows, else ~/.pgpass', () => {
  const custom = path.join(os.tmpdir(), 'example-pgpass.conf');
  assert.equal(pgpassFile({ PGPASSFILE: custom, APPDATA: 'C:\\x' }, 'win32'), custom);
  assert.throws(() => pgpassFile({ PGPASSFILE: 'relative.conf' }, 'win32'), /absolute/);
  assert.equal(pgpassFile({ APPDATA: 'C:\\Users\\example\\AppData\\Roaming' }, 'win32'), path.join('C:\\Users\\example\\AppData\\Roaming', 'postgresql', 'pgpass.conf'));
  assert.throws(() => pgpassFile({}, 'win32'), /APPDATA/);
  assert.equal(pgpassFile({ HOME: '/home/example' }, 'linux'), path.join('/home/example', '.pgpass'));
});

function runCli(home, stdin, extraEnv = {}) {
  const env = { ...process.env, AUSPEX_HOME: home, PGPASSFILE: path.join(home, 'pg', 'pgpass.conf'), ...extraEnv };
  for (const k of ['AUSPEX_PROFILES_FILE', 'AUSPEX_LOG_DIR', 'AUSPEX_DATA_DIR']) delete env[k];
  for (const k of Object.keys(env)) if (k.startsWith('AUSPEX_DB_') && !(k in extraEnv)) delete env[k];
  const res = spawnSync(process.execPath, [cli, 'save-connection'], { env, input: stdin, encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, out: JSON.parse(res.stdout.trim()) };
}
const allText = dir => fs.readdirSync(dir, { recursive: true }).map(f => path.join(dir, f)).filter(f => fs.statSync(f).isFile()).map(f => [f, fs.readFileSync(f, 'utf8')]);

test('stageCli save-connection writes both files; the password is only in pgpass', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-connection-'));
  const first = runCli(home, JSON.stringify(request()));
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.deepEqual([first.out.profileAction, first.out.pgpassAction, first.out.profile], ['added', 'added', 'exampledb']);
  const profiles = readProfilesFile(path.join(home, 'profiles.json'));
  assert.deepEqual(profiles.map(p => [p.name, p.url]), [['exampledb', 'postgresql://report_reader@db.example.test:5432/exampledb']]);
  const pgpass = fs.readFileSync(path.join(home, 'pg', 'pgpass.conf'));
  assert.notEqual(pgpass[0], 0xef, 'no BOM');
  assert.match(pgpass.toString('utf8'), /^db\.example\.test:5432:exampledb:report_reader:S3cr\\:et\\\\pw-öz\r?\n$/);
  const again = runCli(home, JSON.stringify(request({ password: 'second-pw' })));
  assert.deepEqual([again.out.profileAction, again.out.pgpassAction], ['updated', 'replaced']);
  assert.equal(fs.readFileSync(path.join(home, 'pg', 'pgpass.conf'), 'utf8').trim().split(/\r?\n/).length, 1);
  // Refusals and a broken request.
  const refused = runCli(home, JSON.stringify(request({ port: 'x', password: 'third-secret-pw' })));
  assert.equal(refused.status, 1);
  const garbage = runCli(home, `{"password":"fourth-secret-pw",`);
  assert.equal(garbage.out.code, 'INVALID_INPUT');
  const envClash = runCli(home, JSON.stringify(request({ password: 'fifth-secret-pw' })), { AUSPEX_DB_EXAMPLEDB: 'postgresql://report_reader@db.example.test/exampledb' });
  assert.equal(envClash.out.code, 'PRECONDITION_FAILED');
  // The password appears in no output, no audit line and no file but pgpass.
  for (const pw of [secret, 'second-pw', 'third-secret-pw', 'fourth-secret-pw', 'fifth-secret-pw']) {
    for (const r of [first, again, refused, garbage, envClash]) assert.ok(!r.stdout.includes(pw) && !r.stderr.includes(pw), `output holds ${pw}`);
    for (const [file, text] of allText(home)) {
      if (file.endsWith('pgpass.conf')) continue;
      assert.ok(!text.includes(pw), `${file} holds ${pw}`);
    }
  }
  const audit = allText(path.join(home, 'logs')).flatMap(([, t]) => t.trim().split('\n')).map(l => JSON.parse(l)).filter(e => e.tool === 'save_connection');
  assert.equal(audit.length, 5);
  assert.deepEqual([audit[0].profile, audit[0].profileAction, audit[0].pgpassAction, audit[0].source], ['exampledb', 'added', 'added', 'desktop']);
});

test('save-connection takes no arguments and refuses a broken profiles file without writing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-connection-'));
  const args = spawnSync(process.execPath, [cli, 'save-connection', '--password=argv-secret'], { env: { ...process.env, AUSPEX_HOME: home }, input: '', encoding: 'utf8' });
  assert.equal(JSON.parse(args.stdout).code, 'INVALID_INPUT');
  assert.ok(!args.stdout.includes('argv-secret'));
  fs.writeFileSync(path.join(home, 'profiles.json'), '{ broken');
  const res = runCli(home, JSON.stringify(request()));
  assert.equal(res.out.code, 'PRECONDITION_FAILED');
  assert.equal(fs.readFileSync(path.join(home, 'profiles.json'), 'utf8'), '{ broken');
  assert.equal(fs.existsSync(path.join(home, 'pg', 'pgpass.conf')), false, 'no password stored either');
});

test('save-connection reports when it put the line before a wildcard line', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-connection-'));
  fs.mkdirSync(path.join(home, 'pg'));
  fs.writeFileSync(path.join(home, 'pg', 'pgpass.conf'), '*:*:*:report_reader:wild\n');
  const res = runCli(home, JSON.stringify(request()));
  assert.deepEqual([res.status, res.out.pgpassAction, res.out.pgpassWildcard], [0, 'added', 'before']);
  assert.match(fs.readFileSync(path.join(home, 'pg', 'pgpass.conf'), 'utf8'), /^db\.example\.test:5432:[^\n]*\n\*:\*:\*:report_reader:wild\n$/);
});
