// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bill } from '../site/engine.js';
import { parseNem12, parseCsv } from '../site/usage.js';
import { tenYear } from '../site/forecast.js';

const hdr = 'start,import_kwh,export_kwh,controlled_kwh';
function oneDayCsv(imp, exp = () => 0, cl = () => 0, date = "2026-01-05") {      // 5 Jan 2026 is a Monday
  const lines = [hdr];
  for (let s = 0; s < 48; s++) {
    const h = String(Math.floor(s / 2)).padStart(2, '0'), m = s % 2 ? '30' : '00';
    lines.push(`${date}T${h}:${m},${imp(s)},${exp(s)},${cl(s)}`);
  }
  return lines.join('\n');
}
const flat = { supply: 1, fee: 0, disc: 1, demand: [], cl: { cl33: { r: 0.2, s: 0.1 } },
  imp: [{ s: 0, e: 24, r: 0.3 }, { s: 0, e: 24, r: 0.3 }], fit: [{ s: 0, e: 24, r: 0.05 }, { s: 0, e: 24, r: 0 }] };

test('flat rate: supply + usage - feed-in', () => {
  const u = parseCsv(oneDayCsv(() => 0.5, s => (s >= 20 && s < 28 ? 1 : 0)));
  const b = bill(flat, u);
  assert.equal(u.days, 1);
  assert.ok(Math.abs(b.total - (1 + 24 * 0.3 - 8 * 0.05)) < 1e-9);
});

test('time-of-use windows: first matching rule wins', () => {
  const plan = { ...flat, imp: [{ s: 16, e: 21, r: 0.5 }, { s: 0, e: 24, r: 0.2 }, { s: 0, e: 24, r: 0.5 }] };
  const u = parseCsv(oneDayCsv(() => 1));
  // 10 half-hours at 50c (4-9 pm), 38 at 20c
  assert.ok(Math.abs(bill(plan, u).usage - (10 * 0.5 + 38 * 0.2)) < 1e-9);
});

test('daily cap: first kWh at tier 1, rest at after-cap rate, resets each day', () => {
  const plan = { ...flat, fit: [{ s: 16, e: 21, r: 0.35, cap: 3, after: 0.1 }, { s: 0, e: 24, r: 0 }] };
  const day = d => oneDayCsv(() => 0, s => (s >= 32 && s < 42 ? 0.5 : 0), () => 0, d).split('\n').slice(1);
  const u = parseCsv([hdr, ...day('2026-01-05'), ...day('2026-01-06')].join('\n'));
  // per day: 5 kWh exported 4-9 pm -> 3 x 35c + 2 x 10c = 1.25
  assert.ok(Math.abs(bill(plan, u).fit - 2 * 1.25) < 1e-9);
});

test('controlled load: rate + supply, reference rate gets plan discount', () => {
  const u = parseCsv(oneDayCsv(() => 0, () => 0, s => (s === 20 ? 2 : 0)));
  assert.ok(Math.abs(bill(flat, u, { cl: 'cl33' }).cl - 0.4) < 1e-9);
  const noCl = { ...flat, cl: {}, disc: 0.5 };
  const b = bill(noCl, u, { cl: 'cl33', clRef: { r: 0.2, s: 0 } });
  assert.ok(Math.abs(b.cl - 0.2) < 1e-9);
  assert.equal(b.flags.length, 1);
});

test('NEM12: E1 import, B1 export, E2 controlled load, Wh converted, 5-min summed to 30-min', () => {
  const vals = n => Array(n).fill(0);
  const e1 = vals(48); e1[0] = 0.4;
  const b1 = vals(48); b1[24] = 1.5;
  const e2 = vals(288); for (let k = 0; k < 6; k++) e2[120 + k] = 100;   // Wh, 5-min -> slot 20
  const text = [
    '100,NEM12,202601060000,MDP,RETAILER',
    '200,QB00000000,E1B1E2,E1,E1,N1,123,KWH,30,', `300,20260105,${e1.join(',')},A,,,20260106000000,`,
    '200,QB00000000,E1B1E2,B1,B1,N1,123,KWH,30,', `300,20260105,${b1.join(',')},A,,,20260106000000,`,
    '200,QB00000000,E1B1E2,E2,E2,N2,123,WH,5,', `300,20260105,${e2.join(',')},A,,,20260106000000,`,
    '900',
  ].join('\n');
  const u = parseNem12(text);
  assert.equal(u.days, 1);
  assert.ok(Math.abs(u.imp[0] - 0.4) < 1e-9);
  assert.ok(Math.abs(u.exp[24] - 1.5) < 1e-9);
  assert.ok(Math.abs(u.cl[20] - 0.6) < 1e-9);
  assert.deepEqual(u.registers, { imp: ['E1'], exp: ['B1'], cl: ['E2'] });
});

test('incomplete days are dropped', () => {
  const csv = oneDayCsv(() => 1).split('\n').slice(0, 30).join('\n');
  assert.equal(parseCsv(csv).days, 0);
});

test('ten-year range is ordered and deterministic', () => {
  const h = { annual_changes: [{ change: 0.1 }, { change: -0.05 }, { change: 0.03 }] };
  const a = tenYear({ charges: 2000, credits: 300 }, h, { runs: 500 });
  const b = tenYear({ charges: 2000, credits: 300 }, h, { runs: 500 });
  assert.ok(a.p10 <= a.p50 && a.p50 <= a.p90);
  assert.equal(a.p50, b.p50);
  assert.ok(Math.abs(a.bands[0].p50 - 1700) < 1e-9);
});
