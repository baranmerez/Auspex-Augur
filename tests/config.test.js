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

test('files live under AUSPEX_HOME, by default ~/.auspex (never AppData)', () => {
  assert.equal(defaultProfilesFile({ AUSPEX_HOME: 'D:\\data\\auspex' }), path.join('D:\\data\\auspex', 'profiles.json'));
  assert.equal(defaultProfilesFile({ APPDATA: 'C:\\x\\Roaming' }), path.join(os.homedir(), '.auspex', 'profiles.json'));
  const config = loadConfig({ AUSPEX_HOME: dir, AUSPEX_PROFILES_FILE: path.join(dir, 'none.json') });
  assert.equal(config.logDir, path.join(dir, 'logs'));
  assert.equal(config.exportDir, path.join(dir, 'exports'));
});
