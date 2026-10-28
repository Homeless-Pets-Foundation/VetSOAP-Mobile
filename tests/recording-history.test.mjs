import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { loadTsModule } from './helpers/loadTs.mjs';

const previousTimezone = process.env.TZ;
before(() => { process.env.TZ = 'America/New_York'; });
after(() => {
  if (previousTimezone === undefined) delete process.env.TZ;
  else process.env.TZ = previousTimezone;
});

const { activityBounds, localDateKey, matchesActivityRange } = await loadTsModule('src/lib/recordingHistory.ts');
const plain = (value) => JSON.parse(JSON.stringify(value));
const custom = (from, through = from) => activityBounds({ preset: 'custom', from, through }, NaN);
const now = Date.parse('2026-10-28T16:30:00.000Z');

test('all dates has no bounds and local picker keys use the device calendar', () => {
  assert.deepEqual(plain(activityBounds({ preset: 'all' }, now)), {});
  assert.equal(matchesActivityRange({ createdAt: null }, {}), true);
  assert.equal(localDateKey(new Date('2026-10-28T02:30:00.000Z')), '2026-10-27');
  assert.equal(localDateKey(new Date(2026, 0, 1)), '2026-01-01');
  assert.throws(() => localDateKey(new Date(NaN)), /valid date/);
});

test('a single day starts at local midnight and ends at the next local midnight', () => {
  assert.deepEqual(plain(custom('2026-10-28')), {
    activityFrom: '2026-10-28T04:00:00.000Z',
    activityBefore: '2026-10-29T04:00:00.000Z',
  });
});

test('custom ranges include Through across month, year, and leap-day boundaries', () => {
  for (const [from, through, expectedFrom, expectedBefore] of [
    ['2026-01-31', '2026-02-01', '2026-01-31T05:00:00.000Z', '2026-02-02T05:00:00.000Z'],
    ['2026-12-31', '2027-01-01', '2026-12-31T05:00:00.000Z', '2027-01-02T05:00:00.000Z'],
    ['2024-02-29', '2024-02-29', '2024-02-29T05:00:00.000Z', '2024-03-01T05:00:00.000Z'],
  ]) {
    assert.deepEqual(plain(custom(from, through)), { activityFrom: expectedFrom, activityBefore: expectedBefore });
  }
});

test('invalid, normalized-overflow, missing, and reversed custom dates fail', () => {
  for (const invalid of ['', undefined, null, '2026-2-01', '2026-02-30', '2025-02-29', '2026-13-01', '2026-00-01', '2026-01-00', '2026-10-28T00:00:00Z']) {
    assert.throws(() => custom(invalid), /valid date/);
    assert.throws(() => activityBounds({ preset: 'custom', from: '2026-01-01', through: invalid }, now), /valid date/);
  }
  assert.throws(() => custom('2026-10-29', '2026-10-28'), /From must be on or before Through/);
  assert.throws(() => activityBounds({ preset: 'today' }, NaN), /valid date/);
});

test('spring-forward and fall-back ranges retain complete calendar days', () => {
  const spring = custom('2026-03-08');
  assert.deepEqual(plain(spring), {
    activityFrom: '2026-03-08T05:00:00.000Z',
    activityBefore: '2026-03-09T04:00:00.000Z',
  });
  const fall = custom('2026-11-01');
  assert.deepEqual(plain(fall), {
    activityFrom: '2026-11-01T04:00:00.000Z',
    activityBefore: '2026-11-02T05:00:00.000Z',
  });
  assert.equal((Date.parse(spring.activityBefore) - Date.parse(spring.activityFrom)) / 3_600_000, 23);
  assert.equal((Date.parse(fall.activityBefore) - Date.parse(fall.activityFrom)) / 3_600_000, 25);
  assert.equal(matchesActivityRange({ createdAt: '2026-11-01T05:30:00Z' }, fall), true);
  assert.equal(matchesActivityRange({ createdAt: '2026-11-01T06:30:00Z' }, fall), true);
});

test('relative presets cover today, yesterday, and seven days including today', () => {
  for (const [preset, from, before] of [
    ['today', '2026-10-28T04:00:00.000Z', '2026-10-29T04:00:00.000Z'],
    ['yesterday', '2026-10-27T04:00:00.000Z', '2026-10-28T04:00:00.000Z'],
    ['last7', '2026-10-22T04:00:00.000Z', '2026-10-29T04:00:00.000Z'],
  ]) {
    assert.deepEqual(plain(activityBounds({ preset }, now)), { activityFrom: from, activityBefore: before });
  }
});

test('relative presets recalculate on a local day change and cross DST by calendar day', () => {
  const previousDay = Date.parse('2026-10-29T03:59:59.999Z');
  const nextDay = previousDay + 1;
  assert.equal(activityBounds({ preset: 'today' }, previousDay).activityFrom, '2026-10-28T04:00:00.000Z');
  assert.equal(activityBounds({ preset: 'today' }, nextDay).activityFrom, '2026-10-29T04:00:00.000Z');
  assert.equal(activityBounds({ preset: 'yesterday' }, nextDay).activityFrom, '2026-10-28T04:00:00.000Z');
  for (const [reference, expectedFrom, expectedBefore] of [
    ['2026-03-10T16:00:00Z', '2026-03-04T05:00:00.000Z', '2026-03-11T04:00:00.000Z'],
    ['2026-11-03T17:00:00Z', '2026-10-28T04:00:00.000Z', '2026-11-04T05:00:00.000Z'],
  ]) {
    assert.deepEqual(plain(activityBounds({ preset: 'last7' }, Date.parse(reference))), {
      activityFrom: expectedFrom, activityBefore: expectedBefore,
    });
  }
});

test('matching uses an inclusive start, exclusive end, and the displayed submission/creation date', () => {
  const bounds = custom('2026-10-28');
  for (const [timestamp, expected] of [
    ['2026-10-28T03:59:59.999Z', false],
    ['2026-10-28T04:00:00.000Z', true],
    ['2026-10-29T03:59:59.999Z', true],
    ['2026-10-29T04:00:00.000Z', false],
  ]) {
    assert.equal(matchesActivityRange({ createdAt: timestamp, submittedAt: null }, bounds), expected);
    assert.equal(matchesActivityRange({ createdAt: '2025-01-01T00:00:00Z', submittedAt: timestamp }, bounds), expected);
  }
  assert.equal(matchesActivityRange({ createdAt: bounds.activityFrom, submittedAt: 'unreadable' }, bounds), true);
  assert.equal(matchesActivityRange({ createdAt: 'unreadable' }, bounds), false);
  assert.equal(matchesActivityRange({ createdAt: bounds.activityFrom }, { activityFrom: bounds.activityFrom }), false);
  assert.equal(matchesActivityRange({ createdAt: bounds.activityFrom }, { activityBefore: bounds.activityBefore }), false);
});
