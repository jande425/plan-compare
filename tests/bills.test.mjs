// Run: node --test tests/bills.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usageFromBills } from '../site/bills.js';
import { calibrate } from '../site/calibrate.js';
import { solarSeries } from '../site/solar.js';

// 1 year of a simple solar day: 0.7 kWh/kWp per hour from 9:00 to 15:00
const profile = { start: '2026-01-01', orientations: { north: { hourly: Array.from({ length: 365 * 24 }, (_, i) => (i % 24 >= 10 && i % 24 <= 15 ? 0.7 : 0)) } } };
const sum = a => a.reduce((x, y) => x + y, 0);

test('bill totals are preserved in the half-hourly estimate', () => {
  const u = usageFromBills([{ from: '2026-03-01', to: '2026-03-31', peak: 150, offpeak: 20, shoulder: 140, cl: 120, exp: 600 }], profile);
  assert.equal(u.days, 31);
  assert.ok(Math.abs(sum(u.imp) - 310) < 1e-6);
  assert.ok(Math.abs(sum(u.cl) - 120) < 1e-6);
  assert.ok(Math.abs(sum(u.exp) - 600) < 1e-6);
  // peak bucket (4-9 pm) keeps exactly its kWh
  let peak = 0;
  for (let i = 0; i < u.n; i++) if (u.slot[i] >= 32 && u.slot[i] < 42) peak += u.imp[i];
  assert.ok(Math.abs(peak - 150) < 1e-6);
});

test('a single total is split across the day and keeps its sum', () => {
  const u = usageFromBills([{ from: '2026-06-01', to: '2026-06-30', total: 450 }], null);
  assert.ok(Math.abs(sum(u.imp) - 450) < 1e-6);
  assert.equal(sum(u.exp), 0);
});

test('several bills join into one record; overlapping days are not double counted', () => {
  const u = usageFromBills([
    { from: '2026-01-01', to: '2026-01-10', total: 100 },
    { from: '2026-01-10', to: '2026-01-20', total: 110 },
  ], null);
  assert.equal(u.days, 20);
});

test('calibration recovers the roof factor and the solar lost at the export limit', () => {
  const u = usageFromBills([{ from: '2026-02-01', to: '2026-02-10', total: 100, exp: 1 }], profile);
  const model = solarSeries(profile, 'north', 6, u);
  const gen = new Map();
  for (let i = 0; i < u.n; i++) {
    const capped = u.slot[i] === 24;            // pretend exports sat at the limit in one slot a day
    if (capped) u.exp[i] = 2.5;
    gen.set(u.day[i] * 100 + u.slot[i], model[i] * 0.8 - (capped ? 0.3 : 0));
  }
  const c = calibrate(u, gen, profile, 'north', 6, 5);
  assert.ok(Math.abs(c.factor - 0.8) < 1e-9);
  assert.ok(Math.abs(c.curtKwh - 0.3 * 10) < 1e-9);
});
