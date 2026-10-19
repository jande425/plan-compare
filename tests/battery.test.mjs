// Run: node --test tests/battery.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../site/usage.js';
import { simulate, bestPolicy, rebate } from '../site/battery.js';
import { bill } from '../site/engine.js';
import { solarSeries, withSolar } from '../site/solar.js';

const hdr = 'start,import_kwh,export_kwh,controlled_kwh';
function days(n, imp, exp) {
  const lines = [hdr];
  for (let d = 0; d < n; d++) {
    const date = `2026-01-${String(5 + d).padStart(2, '0')}`;
    for (let s = 0; s < 48; s++) {
      const h = String(Math.floor(s / 2)).padStart(2, '0'), m = s % 2 ? '30' : '00';
      lines.push(`${date}T${h}:${m},${imp(s)},${exp(s)},0`);
    }
  }
  return parseCsv(lines.join('\n'));
}
const tou = {
  supply: 1, fee: 0, disc: 1, demand: [], cl: {},
  imp: [{ s: 16, e: 21, r: 0.4 }, { s: 0, e: 24, r: 0.3 }, { s: 0, e: 24, r: 0.4 }],
  fit: [{ s: 16, e: 21, r: 0.28 }, { s: 0, e: 24, r: 0.03 }, { s: 0, e: 24, r: 0 }],
};
// 10 kWh exported 10:00-15:00, 6 kWh imported 17:00-23:00
const u = days(3, s => (s >= 34 && s < 46 ? 0.5 : 0), s => (s >= 20 && s < 30 ? 1 : 0));

test('self-use: stored solar covers the evening, nothing is imported', () => {
  const bat = { usable: 20, charge_kw: 5, discharge_kw: 5, rte: 1 };
  const r = simulate(tou, u, bat, { gridCharge: false, exportOn: false });
  assert.ok(r.imp.reduce((a, b) => a + b, 0) < 1e-9);
  // 3 days: 30 kWh solar stored... 18 kWh used at home, the rest stays in the battery (no export)
  assert.ok(Math.abs(r.throughput - 18) < 1e-9);
});

test('export: battery sells surplus 4-9 pm but keeps the overnight reserve', () => {
  const bat = { usable: 20, charge_kw: 5, discharge_kw: 5, rte: 1 };
  const self = simulate(tou, u, bat, { gridCharge: false, exportOn: false });
  const exp = simulate(tou, u, bat, { gridCharge: false, exportOn: true });
  assert.ok(exp.bill.total < self.bill.total);
});

test('daily battery-export allowance is respected', () => {
  const bat = { usable: 30, charge_kw: 10, discharge_kw: 10, rte: 1 };
  const big = days(2, () => 0, s => (s >= 20 && s < 30 ? 2.5 : 0));
  const r = simulate(tou, big, bat, { gridCharge: false, exportOn: true, dailyExportKwh: 4, reserveQ: 0 });
  for (let d = 0; d < 2; d++) {
    let batt = 0;
    for (let k = 32; k < 42; k++) batt += r.exp[d * 48 + k];
    assert.ok(batt <= 4 + 1e-9);
  }
});

test('best policy is never worse than no battery', () => {
  const bat = { usable: 10, charge_kw: 5, discharge_kw: 5, rte: 0.9 };
  assert.ok(bestPolicy(tou, u, bat, {}).bill.total <= bill(tou, u).total + 1e-9);
});

test('rebate matches installer quotes (41.76 kWh = 166 STCs, 44.25 kWh = 168 STCs)', () => {
  assert.equal(rebate(41.76).stcs, 166);
  assert.equal(rebate(44.25).stcs, 168);
  assert.equal(rebate(10).stcs, 68);
});

test('added solar keeps load the same and respects the export limit', () => {
  const profile = { start: '2026-01-01', orientations: { north: { hourly: Array(24 * 31).fill(0).map((_, i) => (i % 24 >= 9 && i % 24 <= 15 ? 0.8 : 0)) } } };
  const extra = solarSeries(profile, 'north', 6.6, u);
  const v = withSolar(u, extra, 5);
  for (let i = 0; i < u.n; i++) {
    const load0 = u.imp[i] - u.exp[i], load1 = v.imp[i] - v.exp[i] - v.curt[i] + extra[i];
    assert.ok(Math.abs(load0 - load1) < 1e-9);
    assert.ok(v.exp[i] <= 2.5 + 1e-9);
  }
});
