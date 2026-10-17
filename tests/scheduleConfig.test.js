// Local times below are read in a zone with daylight saving time, so the
// slot arithmetic is checked across the spring and autumn changes. Set before
// any Date is created; node:test runs each file in its own process.
process.env.TZ = 'Europe/Berlin';

const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { validateSchedules, latestDueSlot, nextSlot, taskTimeOf, cadenceText } = await import('../src/schedule/config.js');
const { resolvePreset, resolveBuiltInPreset } = await import('../src/reports/presets.js');

const report = { db: 'exampledb', schema: 'example', category: 'Orders/Delivery', name: 'example-report' };
const entry = (over = {}) => ({ id: 'weekly-example', profile: 'exampledb', report, preset: 'last_7_days', cadence: { weekly: 'monday', at: '08:00' }, ...over });
const reject = (data, pattern) => assert.throws(() => validateSchedules(data), err => err.errorCode === 'INVALID_INPUT' && pattern.test(err.message), String(pattern));

test('a valid file is normalized: weekly and daily cadences, defaults', () => {
  const v = validateSchedules({ schedules: [entry(), entry({ id: 'daily-example', preset: undefined, cadence: { daily: true, at: '07:30' }, enabled: false })] });
  assert.equal(v.notify, 'all');
  assert.equal(v.taskTime, null);
  assert.deepEqual(v.schedules[0].report, report);
  assert.equal(v.schedules[0].cadence.weekday, 1);
  assert.equal(v.schedules[0].enabled, true);
  assert.equal(v.schedules[1].preset, null);
  assert.equal(v.schedules[1].enabled, false);
  assert.equal(cadenceText(v.schedules[0].cadence), 'weekly monday 08:00');
  assert.equal(cadenceText(v.schedules[1].cadence), 'daily 07:30');
  assert.equal(taskTimeOf(v), '08:00', 'latest time of the enabled schedules');
  assert.equal(taskTimeOf({ ...v, taskTime: '06:15' }), '06:15');
});

test('validation is strict and needs an explicit profile', () => {
  reject([], /JSON object/);
  reject({ schedules: {} }, /must be an array/);
  reject({ schedules: [], extra: 1 }, /unknown key "extra"/);
  reject({ schedules: [entry({ profile: undefined })] }, /"profile" is required \(there is no default profile\)/);
  reject({ schedules: [entry({ profile: '  ' })] }, /"profile" is required/);
  reject({ schedules: [entry({ profile: 'otherdb' })] }, /must be the report's db/);
  reject({ schedules: [entry(), entry()] }, /used twice/);
  reject({ schedules: [entry({ id: 'Bad Id' })] }, /id must be/);
  reject({ schedules: [entry({ cadence: { weekly: 'monday', daily: true, at: '08:00' } })] }, /exactly one of/);
  reject({ schedules: [entry({ cadence: { at: '08:00' } })] }, /exactly one of/);
  reject({ schedules: [entry({ cadence: { weekly: 'mon', at: '08:00' } })] }, /weekday name/);
  reject({ schedules: [entry({ cadence: { daily: 'yes', at: '08:00' } })] }, /daily must be true/);
  reject({ schedules: [entry({ cadence: { daily: true, at: '8:00' } })] }, /HH:MM/);
  reject({ schedules: [entry({ cadence: { daily: true, at: '24:00' } })] }, /HH:MM/);
  reject({ schedules: [entry({ cadence: { daily: true, at: '08:00', tz: 'UTC' } })] }, /unknown key "tz"/);
  reject({ schedules: [entry({ report: { ...report, name: 'Example Report' } })] }, /library name "example-report"/);
  reject({ schedules: [entry({ report: { ...report, schema: '../x' } })] }, /report/);
  reject({ schedules: [entry({ report: { ...report, extra: 'x' } })] }, /unknown key/);
  reject({ schedules: [entry({ preset: '' })] }, /"preset"/);
  reject({ schedules: [entry({ preset: 'a\nb' })] }, /"preset"/);
  reject({ schedules: [entry({ enabled: 'no' })] }, /"enabled"/);
  reject({ schedules: [entry({ sql: 'select 1' })] }, /unknown key "sql"/);
  reject({ schedules: [], notify: 'sometimes' }, /"notify"/);
  reject({ schedules: [], taskTime: '25:00' }, /taskTime/);
});

const weekly = { weekly: 'monday', weekday: 1, at: '08:00', hour: 8, minute: 0 };
const daily = { daily: true, at: '08:00', hour: 8, minute: 0 };

test('the latest due slot: before, at and after the time; catch-up on a later day', () => {
  // 2026-10-12 is a Monday.
  assert.equal(latestDueSlot(weekly, new Date(2026, 9, 12, 7, 59)).key, '2026-10-05T08:00', 'before 08:00 the previous Monday is the latest slot');
  assert.equal(latestDueSlot(weekly, new Date(2026, 9, 12, 8, 0)).key, '2026-10-12T08:00');
  const tuesday = latestDueSlot(weekly, new Date(2026, 9, 13, 10, 0));
  assert.equal(tuesday.key, '2026-10-12T08:00', 'a catch-up on Tuesday gets Monday\'s slot');
  assert.equal(tuesday.at.getTime(), new Date(2026, 9, 12, 8, 0).getTime());
  assert.equal(latestDueSlot(weekly, new Date(2026, 9, 18, 23, 0)).key, '2026-10-12T08:00', 'Sunday still points at the last Monday');
  assert.equal(latestDueSlot(daily, new Date(2026, 9, 13, 7, 0)).key, '2026-10-12T08:00');
  assert.equal(latestDueSlot(daily, new Date(2026, 9, 13, 9, 0)).key, '2026-10-13T08:00');
  assert.equal(nextSlot(weekly, new Date(2026, 9, 12, 8, 0)).key, '2026-10-19T08:00');
  assert.equal(nextSlot(weekly, new Date(2026, 9, 12, 7, 0)).key, '2026-10-12T08:00');
  assert.equal(nextSlot(daily, new Date(2026, 9, 13, 9, 0)).key, '2026-10-14T08:00');
});

test('slots keep their local time and day across daylight saving changes', () => {
  // Spring: 2026-03-29 (Sunday) 02:00 -> 03:00; autumn: 2026-10-25 03:00 -> 02:00.
  assert.equal(latestDueSlot(daily, new Date(2026, 2, 29, 8, 0)).key, '2026-03-29T08:00');
  assert.equal(latestDueSlot(daily, new Date(2026, 2, 29, 8, 0)).at.getHours(), 8);
  assert.equal(latestDueSlot(daily, new Date(2026, 2, 29, 7, 59)).key, '2026-03-28T08:00');
  assert.equal(latestDueSlot(daily, new Date(2026, 9, 25, 8, 0)).key, '2026-10-25T08:00');
  assert.equal(latestDueSlot(daily, new Date(2026, 9, 26, 7, 0)).key, '2026-10-25T08:00');
  assert.equal(nextSlot(daily, new Date(2026, 9, 24, 9, 0)).at.getHours(), 8, 'the slot after the change is at 08:00 local, not 07:00');
  // A time inside the skipped hour falls due right after it, on the same day.
  const gap = { daily: true, at: '02:30', hour: 2, minute: 30 };
  const s = latestDueSlot(gap, new Date(2026, 2, 29, 4, 0));
  assert.equal(s.key, '2026-03-29T02:30');
  assert.equal(s.at.getHours(), 3);
  // The weekly slot before and after the spring change: one week apart in calendar days.
  const mon = { weekly: 'monday', weekday: 1, at: '08:00', hour: 8, minute: 0 };
  assert.equal(latestDueSlot(mon, new Date(2026, 2, 30, 9, 0)).key, '2026-03-30T08:00');
  assert.equal(latestDueSlot(mon, new Date(2026, 2, 30, 7, 0)).key, '2026-03-23T08:00');
});

test('a preset resolves against the reference date, not the run time', () => {
  const slot = latestDueSlot(weekly, new Date(2026, 9, 13, 10, 0)); // Tuesday catch-up
  const fail = msg => new Error(msg);
  const atSlot = resolvePreset('last_7_days', [], 2, fail, slot.at, true);
  assert.deepEqual(atSlot.params, ['2026-10-06', '2026-10-13']);
  assert.deepEqual(resolveBuiltInPreset('last_7_days', new Date(2026, 9, 12, 8, 0)), atSlot.params, 'the same period as a run on Monday');
  assert.notDeepEqual(resolvePreset('last_7_days', [], 2, fail, new Date(2026, 9, 13, 10, 0), true).params, atSlot.params);
  assert.deepEqual(resolvePreset('last_month', [], 2, fail, new Date(2026, 2, 1, 0, 30), true).params, ['2026-02-01', '2026-03-01']);
  assert.throws(() => resolvePreset('last_7_days', [], 2, fail, slot.at, false), /not available/, 'built-in presets need dateRange: true');
  assert.deepEqual(resolvePreset('Example set', [{ name: 'Example set', params: ['A'] }], 1, fail, slot.at, false).params, ['A']);
});
