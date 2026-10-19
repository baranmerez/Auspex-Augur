import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordResult, appendTrend, trendFile, readTrend } from '../src/schedule/store.js';

test('scheduled result and trend files keep preset parameters owner-private', { skip: process.platform === 'win32' }, t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'example-private-schedule-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const statePath = path.join(home, 'schedule-state.json');
  const trendsRoot = path.join(home, 'trends');
  const reportRef = { db: 'exampledb', schema: 'example', category: 'Orders', name: 'weekly-report' };
  const trend = {
    v: 1,
    scheduleId: 'exampleSchedule',
    slot: '2026-10-20',
    params: ['exampleCustomerId'],
    rows: 1,
  };
  const originalUmask = process.umask(0o022);
  try {
    recordResult(statePath, trend.scheduleId, {
      status: 'ok', slot: trend.slot, at: '2026-10-20T00:00:00Z',
    });
    appendTrend(trendsRoot, reportRef, trend);

    const trendPath = trendFile(trendsRoot, reportRef);
    assert.equal(fs.statSync(statePath).mode & 0o077, 0, 'state file must not be readable by others');
    assert.equal(fs.statSync(trendPath).mode & 0o077, 0, 'trend parameters must not be readable by others');
    assert.equal(fs.statSync(path.dirname(trendPath)).mode & 0o077, 0, 'trend directory must not be traversable by others');
    assert.deepEqual(readTrend(trendPath)[0].params, ['exampleCustomerId']);

    // Replace older files written with umask-controlled public permissions.
    fs.chmodSync(statePath, 0o644);
    fs.chmodSync(trendPath, 0o644);
    fs.chmodSync(path.dirname(trendPath), 0o755);
    recordResult(statePath, trend.scheduleId, {
      status: 'ok', slot: '2026-10-21', at: '2026-10-21T00:00:00Z',
    });
    appendTrend(trendsRoot, reportRef, { ...trend, slot: '2026-10-21' });
    assert.equal(fs.statSync(statePath).mode & 0o077, 0);
    assert.equal(fs.statSync(trendPath).mode & 0o077, 0);
    assert.equal(fs.statSync(path.dirname(trendPath)).mode & 0o077, 0);
    assert.equal(readTrend(trendPath).length, 2);
  } finally {
    process.umask(originalUmask);
  }
});
