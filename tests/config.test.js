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
    'Shop-Prod': { url: 'postgresql://Auspex@10.0.0.5:5432/shopdb', description: 'Shop prod (VPN)', maxTimeoutSeconds: 180 },
  });
  const config = loadConfig({ ...baseEnv, AUSPEX_PROFILES_FILE: file });
  assert.deepEqual([...config.profiles.keys()], ['local', 'shop-prod']);
  assert.deepEqual(config.profileInfo.get('shop-prod'), { source: 'file', description: 'Shop prod (VPN)' });
  assert.equal(config.maxTimeoutByProfile.get('shop-prod'), 180000);
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
  const file = profilesFile({ shop: { url: 'postgresql://Auspex@10.0.0.5/shopdb' } });
  const both = loadConfig({ ...baseEnv, AUSPEX_PROFILES_FILE: file, AUSPEX_DB_LOCAL: 'postgresql://Auspex@localhost/postgres' });
  assert.deepEqual([...both.profiles.keys()].sort(), ['local', 'shop']);
  assert.throws(() => loadConfig({ ...baseEnv, AUSPEX_PROFILES_FILE: file, AUSPEX_DB_SHOP: 'postgresql://x@y/z' }), /defined both/);
});

test('env timeout ceiling overrides the file value', () => {
  const file = profilesFile({ shop: { url: 'postgresql://Auspex@10.0.0.5/shopdb', maxTimeoutSeconds: 180 } });
  const config = loadConfig({ ...baseEnv, AUSPEX_PROFILES_FILE: file, AUSPEX_MAX_STATEMENT_TIMEOUT_MS_SHOP: '60000' });
  assert.equal(config.maxTimeoutByProfile.get('shop'), 60000);
});

const invalid = [
  ['broken JSON', '{"local": ', /not valid JSON/],
  ['array instead of object', [], /must be a JSON object/],
  ['password in url', { local: { url: 'postgresql://Auspex:secret@localhost/postgres' } }, /remove the password/],
  ['missing url', { local: { description: 'x' } }, /"url" is required/],
  ['non-postgres url', { local: { url: 'mysql://u@h/db' } }, /must start with postgresql/],
  ['unknown field', { local: { url: 'postgresql://u@h/db', password: 'x' } }, /unknown field\(s\) password/],
  ['bad name', { '1st': { url: 'postgresql://u@h/db' } }, /names use a-z/],
  ['duplicate name by case', { Shop: { url: 'postgresql://u@h/a' }, shop: { url: 'postgresql://u@h/b' } }, /defined twice/],
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
  const file = profilesFile({ shop: { url: 'postgresql://Auspex@10.0.0.5:5432/shopdb?sslmode=require&application_name=auspex' } });
  const config = loadConfig({ ...baseEnv, AUSPEX_PROFILES_FILE: file, AUSPEX_DB_LOCAL: 'postgresql://Auspex@localhost/postgres?sslmode=disable' });
  assert.deepEqual([...config.profiles.keys()].sort(), ['local', 'shop']);
});

test('every allowlisted query option is accepted', () => {
  const query = 'ssl=true&sslmode=verify-full&sslcert=c.crt&sslkey=c.key&sslrootcert=ca.crt'
    + '&sslnegotiation=direct&uselibpqcompat=true&application_name=auspex&fallback_application_name=x&connect_timeout=5'
    + '&keepalives=1&keepalives_idle=30';
  const file = profilesFile({ shop: { url: `postgresql://Auspex@h/db?${query}` } });
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
    'postgresql://review@10.0.0.5/fixture',
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
