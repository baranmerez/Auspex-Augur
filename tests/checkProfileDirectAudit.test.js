import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadOnlyDatabase } from '../src/db.js';

test('direct checkProfile logs successful checks and early errors through audited', async () => {
  const entries = [];
  const db = new ReadOnlyDatabase({
    profiles: new Map([['exampledb', 'postgresql://example@localhost:5432/exampledb']]),
    statementTimeoutMs: 1000,
  }, { audit: entry => entries.push(entry) });

  // No database is opened. Supply the catalog result a successful internal
  // read-only role check would have cached.
  db.withReadOnly = async profile => {
    db.roleChecks.set(profile, {
      status: 'warning',
      blocking: [],
      warnings: [{ code: 'default_read_only_off' }],
    });
  };

  const checked = await db.withCorrelation('exampleCall', () => db.checkProfile('exampledb'));
  assert.equal(checked.profile, 'exampledb');
  assert.equal(checked.status, 'warning');
  assert.deepEqual(entries.map(entry => entry.tool), ['check_profile']);
  assert.deepEqual({
    profile: entries[0].profile,
    roleStatus: entries[0].roleStatus,
    correlationId: entries[0].correlationId,
  }, { profile: 'exampledb', roleStatus: 'warning', correlationId: 'exampleCall' });

  await assert.rejects(db.checkProfile('unknown'), error => error.errorCode === 'PROFILE_INVALID');
  assert.deepEqual(entries.map(entry => entry.tool), ['check_profile', 'check_profile']);
  assert.equal(entries[1].profile, 'unknown');
  assert.equal(entries[1].errorCode, 'PROFILE_INVALID');
  assert.match(entries[1].error, /Unknown profile/);
});
