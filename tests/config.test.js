import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, readProfilesFile, defaultProfilesFile } from '../src/config.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auspex-config-'));
let n = 0;
function profilesFile(content) {
  const file = path.join(dir, `profiles-${n++}.json`);
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}
const baseEnv = { AUSPEX_HOME: dir };

test('profiles are read from the file with description and timeout ceiling', () => {
  const file = profilesFile({
    local: { url: 'postgresql://Auspex@localhost:5432/postgres', description: 'Local test' },
    'Example-Prod': { url: 'postgresql://Auspex@db.example.test:5432/exampledb', description: 'Example prod', maxTimeoutSeconds: 180 },
  });
  const config = loadConfig({ ...baseEnv, AUSPEX_PROFILES_FILE: file });
  assert.deepEqual([...config.profiles.keys()], ['local', 'example-prod']);
  assert.deepEqual(config.profileInfo.get('example-prod'), { source: 'file', description: 'Example prod' });
  assert.equal(config.maxTimeoutByProfile.get('example-prod'), 180000);
  assert.equal(config.maxTimeoutByProfile.has('local'), false);
  assert.equal(config.profilesFile, file);
});

test('a UTF-8 BOM written by Notepad is accepted', () => {
  const file = profilesFile('\uFEFF{"local":{"url":"postgresql://Auspex@localhost/postgres"}}');
  assert.equal(loadConfig({ ...baseEnv, AUSPEX_PROFILES_FILE: file }).profiles.size, 1);
});

test('a missing file means no file profiles; env profiles still load', () => {
  const config = loadConfig({ ...baseEnv, AUSPEX_PROFILES_FILE: path.join(dir, 'missing.json'), AUSPEX_DB_LOCAL: 'postgresql://Auspex@localhost/postgres' });
  assert.deepEqual([...config.profiles.keys()], ['local']);
  assert.equal(config.profileInfo.get('local').source, 'env');
});

test('file and env profiles combine; the same name in both is an error', () => {
  const file = profilesFile({ example: { url: 'postgresql://Auspex@db.example.test/exampledb' } });
  const both = loadConfig({ ...baseEnv, AUSPEX_PROFILES_FILE: file, AUSPEX_DB_LOCAL: 'postgresql://Auspex@localhost/postgres' });
  assert.deepEqual([...both.profiles.keys()].sort(), ['example', 'local']);
  assert.throws(() => loadConfig({ ...baseEnv, AUSPEX_PROFILES_FILE: file, AUSPEX_DB_EXAMPLE: 'postgresql://x@y/z' }), /defined both/);
});

test('env timeout ceiling overrides the file value', () => {
  const file = profilesFile({ example: { url: 'postgresql://Auspex@db.example.test/exampledb', maxTimeoutSeconds: 180 } });
  const config = loadConfig({ ...baseEnv, AUSPEX_PROFILES_FILE: file, AUSPEX_MAX_STATEMENT_TIMEOUT_MS_EXAMPLE: '60000' });
  assert.equal(config.maxTimeoutByProfile.get('example'), 60000);
});

const invalid = [
  ['broken JSON', '{"local": ', /not valid JSON/],
  ['array instead of object', [], /must be a JSON object/],
  ['password in url', { local: { url: 'postgresql://Auspex:secret@localhost/postgres' } }, /remove the password/],
  ['missing url', { local: { description: 'x' } }, /"url" is required/],
  ['non-postgres url', { local: { url: 'mysql://u@h/db' } }, /must start with postgresql/],
  ['unknown field', { local: { url: 'postgresql://u@h/db', password: 'x' } }, /unknown field\(s\) password/],
  ['bad name', { '1st': { url: 'postgresql://u@h/db' } }, /names use a-z/],
  ['duplicate name by case', { Example: { url: 'postgresql://u@h/a' }, example: { url: 'postgresql://u@h/b' } }, /defined twice/],
  ['bad timeout', { local: { url: 'postgresql://u@h/db', maxTimeoutSeconds: 0 } }, /maxTimeoutSeconds/],
  ['non-text description', { local: { url: 'postgresql://u@h/db', description: 5 } }, /description/],
];

for (const [name, content, message] of invalid) {
  test(`rejects profiles file with ${name}`, () => {
    const file = profilesFile(content);
    assert.throws(() => readProfilesFile(file), message);
  });
}

// The same synthetic secret is used everywhere so we can assert it never
// appears in an error message.
const secret = 'S3cret-marker';
const passwordUrls = [
  ['user-info password', `postgresql://Auspex:${secret}@localhost/postgres`],
  ['password query option', `postgresql://Auspex@localhost/postgres?password=${secret}`],
  ['upper-case query option', `postgresql://Auspex@localhost/postgres?PASSWORD=${secret}`],
  ['percent-encoded option name', `postgresql://Auspex@localhost/postgres?pass%77ord=${secret}`],
  ['repeated query option', `postgresql://Auspex@localhost/postgres?sslmode=disable&password=a&password=${secret}`],
  ['sslpassword option', `postgresql://Auspex@localhost/postgres?sslpassword=${secret}`],
];

for (const [name, url] of passwordUrls) {
  test(`file and env profiles both reject a ${name} without echoing it`, () => {
    const file = profilesFile({ local: { url } });
    const fromFile = assert.throws.bind(null, () => readProfilesFile(file));
    fromFile(err => /pgpass/.test(err.message) && !err.message.includes(secret));
    const env = { ...baseEnv, AUSPEX_PROFILES_FILE: path.join(dir, 'missing.json'), AUSPEX_DB_LOCAL: url };
    assert.throws(() => loadConfig(env), err => /pgpass/.test(err.message) && !err.message.includes(secret) && /AUSPEX_DB_LOCAL/.test(err.message));
  });
}

const invalidEnv = [
  ['bad name', { AUSPEX_DB_1ST: 'postgresql://u@h/db' }, /AUSPEX_DB_1ST: profile names use a-z/],
  ['name with a dot', { 'AUSPEX_DB_A.B': 'postgresql://u@h/db' }, /profile names use a-z/],
  ['non-postgres url', { AUSPEX_DB_LOCAL: 'mysql://u@h/db' }, /must start with postgresql/],
  ['not a url', { AUSPEX_DB_LOCAL: 'host=h dbname=db' }, /must look like postgresql/],
];

for (const [name, vars, message] of invalidEnv) {
  test(`rejects env profile with ${name}`, () => {
    assert.throws(() => loadConfig({ ...baseEnv, AUSPEX_PROFILES_FILE: path.join(dir, 'missing.json'), ...vars }), message);
  });
}

test('pgpass-style profiles with harmless query options still load', () => {
  const file = profilesFile({ example: { url: 'postgresql://Auspex@db.example.test:5432/exampledb?sslmode=require&application_name=auspex' } });
  const config = loadConfig({ ...baseEnv, AUSPEX_PROFILES_FILE: file, AUSPEX_DB_LOCAL: 'postgresql://Auspex@localhost/postgres?sslmode=disable' });
  assert.deepEqual([...config.profiles.keys()].sort(), ['example', 'local']);
});

test('every allowlisted query option is accepted', () => {
  const query = 'ssl=true&sslmode=verify-full&sslcert=c.crt&sslkey=c.key&sslrootcert=ca.crt'
    + '&sslnegotiation=direct&uselibpqcompat=true&application_name=auspex&fallback_application_name=x&connect_timeout=5'
    + '&keepalives=1&keepalives_idle=30';
  const file = profilesFile({ example: { url: `postgresql://Auspex@h/db?${query}` } });
  assert.equal(readProfilesFile(file).length, 1);
});

const forbiddenOptions = [
  ['session settings through options', 'options=-c%20default_transaction_read_only%3Doff', 'options'],
  ['search_path through options', 'options=-c%20search_path%3Devil', 'options'],
  ['replication', 'replication=database', 'replication'],
  ['client_encoding', 'client_encoding=LATIN1', 'client_encoding'],
  ['encoding alias', 'encoding=LATIN1', 'encoding'],
  ['user override', 'user=postgres', 'user'],
  ['database override', 'db=other', 'db'],
  ['statement_timeout', 'statement_timeout=0', 'statement_timeout'],
  ['upper-case spelling of an allowed name', 'SSLMODE=disable', 'SSLMODE'],
];

for (const [name, query, option] of forbiddenOptions) {
  test(`file and env profiles both reject the ${name} query option`, () => {
    const url = `postgresql://Auspex@localhost/postgres?sslmode=require&${query}`;
    const file = profilesFile({ local: { url } });
    const message = err => err.message.includes(`"${option}"`) && /not allowed/.test(err.message) && !err.message.includes('evil') && !err.message.includes('LATIN1');
    assert.throws(() => readProfilesFile(file), message);
    assert.throws(() => loadConfig({ ...baseEnv, AUSPEX_PROFILES_FILE: path.join(dir, 'missing.json'), AUSPEX_DB_LOCAL: url }), message);
  });
}

const endpointOverrides = [
  ['host', 'host=production.invalid', ['host']],
  ['port', 'port=6543', ['port']],
  ['host and port', 'host=production.invalid&port=6543', ['host', 'port']],
  ['repeated host', 'host=a.invalid&host=production.invalid', ['host']],
  ['Unix socket host', 'host=%2Fvar%2Frun%2Fpostgresql', ['host']],
  ['upper-case HOST', 'HOST=production.invalid', ['HOST']],
];

for (const [name, query, options] of endpointOverrides) {
  test(`file and env profiles both reject a ${name} query option that would override the URL authority`, () => {
    const url = `postgresql://review@staging.invalid:5432/fixture?${query}&sslmode=require`;
    const file = profilesFile({ local: { url } });
    const message = err => options.every(o => err.message.includes(`"${o}"`)) && /URL authority/.test(err.message)
      && !err.message.includes('production.invalid') && !err.message.includes('6543') && !err.message.includes('staging.invalid');
    assert.throws(() => readProfilesFile(file), message);
    assert.throws(() => loadConfig({ ...baseEnv, AUSPEX_PROFILES_FILE: path.join(dir, 'missing.json'), AUSPEX_DB_LOCAL: url }), message);
  });
}

test('the connection summary shows the host and port node-postgres uses (no connection)', async () => {
  const { describeConnection } = await import('../src/config.js');
  const { default: pg } = await import('pg');
  const urls = [
    'postgresql://review@staging.invalid:5432/fixture',
    'postgresql://review@staging.invalid:6543/fixture?sslmode=verify-full&application_name=auspex',
    'postgres://review@staging.invalid/fixture',
    'postgresql://review@[::1]:5433/fixture',
    'postgresql://review@[2001:db8::1]/fixture',
    'postgresql://review@db.example.test/fixture',
    'postgresql://review@my%2Dhost/fixture',
    'postgresql://review@%2Fvar%2Frun%2Fpostgresql/fixture',
  ];
  for (const url of urls) {
    const file = profilesFile({ p: { url } });
    assert.equal(readProfilesFile(file).length, 1, `${url} is an allowed profile`);
    const shown = describeConnection(url);
    const effective = new pg.Client({ connectionString: url }).connectionParameters; // never connected
    assert.equal(shown.host, effective.host, url);
    assert.equal(shown.port, String(effective.port), url);
  }
  assert.equal(describeConnection('postgresql://review@[::1]/fixture').port, '5432', 'default port');
});

test('connection summary flags a password in the query string without showing it', async () => {
  const { describeConnection } = await import('../src/config.js');
  const info = describeConnection(`postgresql://Auspex@h/db?password=${secret}`);
  assert.equal(info.passwordInString, true);
  assert.ok(!JSON.stringify(info).includes(secret));
  assert.equal(describeConnection('postgresql://Auspex@h/db?sslmode=require').passwordInString, false);
});

test('files live under AUSPEX_HOME, by default ~/.auspex (never AppData)', () => {
  assert.equal(defaultProfilesFile({ AUSPEX_HOME: 'D:\\data\\auspex' }), path.join('D:\\data\\auspex', 'profiles.json'));
  assert.equal(defaultProfilesFile({ APPDATA: 'C:\\x\\Roaming' }), path.join(os.homedir(), '.auspex', 'profiles.json'));
  const config = loadConfig({ AUSPEX_HOME: dir, AUSPEX_PROFILES_FILE: path.join(dir, 'none.json') });
  assert.equal(config.logDir, path.join(dir, 'logs'));
  assert.equal(config.exportDir, path.join(dir, 'exports'));
});

test('script roots come from the profiles file and AUSPEX_SCRIPT_ROOT_<NAME>, and are not profiles', () => {
  const rootA = path.join(dir, 'Scripts A');
  const rootB = path.join(dir, 'Scripts B');
  const file = profilesFile({
    local: { url: 'postgresql://Auspex@localhost/postgres' },
    scriptRoots: { Scripts: rootA },
  });
  const config = loadConfig({ ...baseEnv, AUSPEX_PROFILES_FILE: file, AUSPEX_SCRIPT_ROOT_SPARE: rootB });
  assert.deepEqual([...config.profiles.keys()], ['local']);
  assert.deepEqual(readProfilesFile(file).map(p => p.name), ['local']);
  assert.deepEqual([...config.scriptRoots], [['scripts', { dir: rootA, source: 'file' }], ['spare', { dir: rootB, source: 'env' }]]);
  assert.equal(loadConfig({ ...baseEnv, AUSPEX_PROFILES_FILE: path.join(dir, 'none.json') }).scriptRoots.size, 0);
  assert.throws(() => loadConfig({ ...baseEnv, AUSPEX_PROFILES_FILE: file, AUSPEX_SCRIPT_ROOT_SCRIPTS: rootB }), /defined both/);
});

const invalidRoots = [
  ['a relative path', { s: 'Scripts' }, /must be absolute/],
  ['an empty path', { s: '' }, /absolute directory path/],
  ['a value that is not text', { s: 42 }, /absolute directory path/],
  ['a URL', { s: 'postgresql://u:p@h/db' }, /must not look like a URL/],
  ['a password option', { s: path.join(dir, 'password=x') }, /hold a password/],
  ['a control character', { s: path.join(dir, 'a\nb') }, /control characters/],
  ['a bad name', { '1x': dir }, /names use a-z/],
  ['a duplicate name', { s: dir, S: dir }, /defined twice/],
];

for (const [name, roots, message] of invalidRoots) {
  test(`script roots reject ${name}`, () => {
    const file = profilesFile({ scriptRoots: roots });
    assert.throws(() => loadConfig({ ...baseEnv, AUSPEX_PROFILES_FILE: file }), message);
  });
}

test('script roots must be an object; env roots are validated too', () => {
  assert.throws(() => loadConfig({ ...baseEnv, AUSPEX_PROFILES_FILE: profilesFile({ scriptRoots: [dir] }) }), /expected an object/);
  const none = path.join(dir, 'none.json');
  assert.throws(() => loadConfig({ ...baseEnv, AUSPEX_PROFILES_FILE: none, AUSPEX_SCRIPT_ROOT_X: 'relative' }), /must be absolute/);
  assert.throws(() => loadConfig({ ...baseEnv, AUSPEX_PROFILES_FILE: none, AUSPEX_SCRIPT_ROOT_9: dir }), /AUSPEX_SCRIPT_ROOT_9/);
});

test('notesLanguage is read from the profiles file, null when absent, and is not a profile', () => {
  const file = profilesFile({ local: { url: 'postgresql://Auspex@localhost/postgres' }, notesLanguage: 'pt-BR' });
  const config = loadConfig({ ...baseEnv, AUSPEX_PROFILES_FILE: file });
  assert.equal(config.notesLanguage, 'pt-BR');
  assert.deepEqual([...config.profiles.keys()], ['local']);
  assert.deepEqual(readProfilesFile(file).map(p => p.name), ['local']);
  assert.equal(loadConfig({ ...baseEnv, AUSPEX_PROFILES_FILE: path.join(dir, 'none.json') }).notesLanguage, null);
  assert.equal(loadConfig({ ...baseEnv, AUSPEX_PROFILES_FILE: profilesFile({ scriptRoots: {} }) }).notesLanguage, null);
});

for (const [name, value] of [['a number', 42], ['an empty string', ''], ['free text', 'turkish please'], ['an underscore code', 'pt_BR'], ['an array', ['tr']]]) {
  test(`notesLanguage rejects ${name}`, () => {
    const file = profilesFile({ notesLanguage: value });
    assert.throws(() => loadConfig({ ...baseEnv, AUSPEX_PROFILES_FILE: file }), /Invalid "notesLanguage"/);
  });
}

test('auspexRoot is read from the profiles file, null when absent, and is not a profile', () => {
  const root = path.join(dir, 'auspex-checkout');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'stageCli.js'), '');
  const file = profilesFile({ local: { url: 'postgresql://Auspex@localhost/postgres' }, auspexRoot: `${root}${path.sep}` });
  const config = loadConfig({ ...baseEnv, AUSPEX_PROFILES_FILE: file });
  assert.equal(config.auspexRoot, root);
  assert.deepEqual([...config.profiles.keys()], ['local']);
  assert.deepEqual(readProfilesFile(file).map(p => p.name), ['local']);
  assert.equal(loadConfig({ ...baseEnv, AUSPEX_PROFILES_FILE: path.join(dir, 'none.json') }).auspexRoot, null);
});

{
  const noCli = path.join(dir, 'not-a-checkout');
  fs.mkdirSync(noCli, { recursive: true });
  const cases = [
    ['a number', 42, /absolute directory path/],
    ['an empty string', '', /absolute directory path/],
    ['a relative path', 'auspex', /must be absolute/],
    ['a control character', path.join(dir, 'a\nb'), /control characters/],
    ['a missing directory', path.join(dir, 'missing-root'), /does not exist/],
    ['a directory without src/stageCli.js', noCli, /no src\/stageCli\.js/],
  ];
  for (const [name, value, message] of cases) {
    test(`auspexRoot rejects ${name}`, () => {
      const file = profilesFile({ auspexRoot: value });
      assert.throws(() => loadConfig({ ...baseEnv, AUSPEX_PROFILES_FILE: file }), message);
    });
  }
}
