// Half-hourly battery dispatch, ported from a household model that
// was checked against real bills. Rule-based, per plan, with same-day foresight:
//  - solar surplus (exports, plus any estimated curtailed solar) charges the battery first;
//  - optional grid charging in the day's cheapest pre-4 pm intervals, up to tonight's need +
//    planned exports - remaining solar;
//  - discharge to the home when the import price is above the cheap-charge threshold;
//  - battery-to-grid export only when the feed-in beats a 6c wear hurdle, never below an
//    overnight reserve that covers 90% of that month's nights, within the site export limit
//    and (optionally) a daily battery-export allowance.
import { buildLut, bill } from './engine.js';

const SLOTS = 48, H = 0.5, WEAR_COST = 0.06;

function quantile(sorted, q) {          // numpy default (linear)
  if (!sorted.length) return NaN;
  const pos = q * (sorted.length - 1), lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Per-interval first/second-tier prices and cap groups for a rule list. */
function priceArrays(rules, usage) {
  const lut = buildLut(rules), n = usage.n;
  const a = new Float64Array(n), b = new Float64Array(n), g = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const ri = lut[(usage.wd[i] * 12 + (usage.mo[i] - 1)) * SLOTS + usage.slot[i]];
    const r = rules[ri];
    a[i] = r.r; b[i] = r.after ?? r.r; g[i] = r.cap != null ? ri : -1;
  }
  return { a, b, g, cap: rules.map(r => r.cap ?? Infinity) };
}

/** kWh to hold back at each interval for overnight imports (90th percentile of the month's nights). */
export function reserveSchedule(usage, eta, q = 0.9) {
  const n = usage.n, days = usage.days, R = new Float64Array(n);
  if (q <= 0) return R;
  const rem = [];
  for (let d = 0; d < days - 1; d++) {
    const base = d * SLOTS, w = new Float64Array(40);
    for (let k = 0; k < 40; k++) w[k] = usage.imp[base + 30 + k];
    let stop = 39;
    for (let k = 19; k < 40; k++) if (usage.exp[base + 30 + k] > 0.02) { stop = k; break; }
    for (let k = stop; k < 40; k++) w[k] = 0;
    const r = new Float64Array(40);
    let acc = 0;
    for (let k = 39; k >= 0; k--) { acc += w[k]; r[k] = acc - w[k]; }
    rem.push({ d, mo: usage.mo[base], r });
  }
  for (let m = 1; m <= 12; m++) {
    const sel = rem.filter(x => x.mo === m);
    if (!sel.length) continue;
    const qk = new Float64Array(40);
    for (let k = 0; k < 40; k++) qk[k] = quantile(sel.map(x => x.r[k]).sort((x, y) => x - y), q) / eta;
    for (const { d } of sel) for (let k = 0; k < 40; k++) {
      const j = d * SLOTS + 30 + k;
      if (j < n) R[j] = Math.max(R[j], qk[k]);
    }
  }
  return R;
}

/**
 * Simulate one plan + battery + policy. Returns the bill (same costing as engine.bill) plus
 * throughput and the state of charge trace.
 * bat: {usable, charge_kw, discharge_kw, rte}
 * opt: {gridCharge, exportOn, exportLimitKw=5, reserveQ=0.9, dailyExportKwh=null, cl, clRef}
 */
export function simulate(plan, usage, bat, opt, cache = {}) {
  const n = usage.n, days = usage.days;
  const C = bat.usable, Pc = bat.charge_kw * H, Pd = bat.discharge_kw * H, eta = Math.sqrt(bat.rte);
  const Lh = (opt.exportLimitKw ?? 5) * H;
  const curt = usage.curt || new Float64Array(n);
  const P = cache.P || (cache.P = priceArrays(plan.imp, usage));
  const F = cache.F || (cache.F = priceArrays(plan.fit, usage));
  const key = `${opt.reserveQ ?? 0.9}|${bat.rte}`;
  cache.R = cache.R || {};
  const Rfull = opt.exportOn ? (cache.R[key] || (cache.R[key] = reserveSchedule(usage, eta, opt.reserveQ ?? 0.9))) : null;

  // --- daily policy (plan_policy) ---
  const gc = new Uint8Array(n), target = new Float64Array(days), homeThr = new Float64Array(n).fill(0.05);
  const expThr = new Float64Array(n).fill(Infinity), srem = new Float64Array(n);
  for (let d = 0; d < days; d++) {
    const s0 = d * SLOTS;
    let theta = null;
    if (opt.gridCharge) {
      let cmin = Infinity, value = -Infinity;
      const cand = [];
      for (let k = 0; k < SLOTS; k++) {
        const p = P.a[s0 + k];
        if (k < 32) { cmin = Math.min(cmin, p); cand.push(p); } else value = Math.max(value, p);
        value = Math.max(value, F.a[s0 + k]);
      }
      if (cmin / bat.rte + 0.03 < value) {
        theta = Math.max(cmin + 0.005, Math.min(cmin + 0.005, value * bat.rte - 0.03));   // fixed-price plans
        for (let k = 0; k < 32; k++) if (P.a[s0 + k] <= theta) gc[s0 + k] = 1;
      }
    }
    const ht = theta != null ? Math.max(0.05, theta / bat.rte + 0.01) : 0.08;
    for (let k = 0; k < SLOTS; k++) homeThr[s0 + k] = ht;
    const x = theta == null ? WEAR_COST : Math.max(WEAR_COST, theta / bat.rte + 0.02);
    if (opt.exportOn) for (let k = 0; k < SLOTS; k++) expThr[s0 + k] = x;
    let anyGc = false;
    for (let k = 0; k < SLOTS; k++) if (gc[s0 + k]) { anyGc = true; break; }
    if (anyGc) {
      let need = 0;
      for (let k = 32; k < SLOTS; k++) if (P.a[s0 + k] > ht) need += usage.imp[s0 + k];
      for (let k = 0; k < 18 && s0 + SLOTS + k < n; k++) if (P.a[s0 + SLOTS + k] > ht) need += usage.imp[s0 + SLOTS + k];
      need /= eta;
      let planned = 0;
      if (opt.exportOn) {
        let cnt = 0, firstG = -1;
        for (let k = 0; k < SLOTS; k++) if (F.a[s0 + k] >= x) { cnt++; if (firstG < 0 && F.g[s0 + k] >= 0) firstG = F.g[s0 + k]; }
        if (cnt) {
          planned = Math.min(cnt * Pd, cnt * Lh) / eta;
          if (firstG >= 0) planned = Math.min(planned, F.cap[firstG] / eta);
          if (opt.dailyExportKwh != null) planned = Math.min(planned, opt.dailyExportKwh / eta);
        }
      }
      target[d] = need + planned + (d < days - 1 && Rfull ? Rfull[(d + 1) * SLOTS - 1] : 0);
      let acc = 0;
      for (let k = SLOTS - 1; k >= 0; k--) {
        const sp = k < 32 ? usage.exp[s0 + k] + curt[s0 + k] : 0;
        acc += sp; srem[s0 + k] = (acc - sp) * eta;
      }
    }
  }

  // --- interval loop (simulate) ---
  const imp = new Float64Array(n), exp = new Float64Array(n), soc = new Float32Array(n);
  const usedP = new Float64Array(plan.imp.length), usedF = new Float64Array(plan.fit.length);
  let s = 0, thru = 0, battExp = 0, emptyNights = 0, nightFlag = false;
  for (let i = 0; i < n; i++) {
    const sl = usage.slot[i];
    if (sl === 0) { usedP.fill(0); usedF.fill(0); battExp = 0; }
    let e = usage.exp[i], im = usage.imp[i];
    let c = 0, g = 0, dh = 0, dx = 0;
    const R = Rfull ? Math.min(Rfull[i], C) : 0;
    const avail = e + curt[i];
    c = Math.min(avail, Pc, (C - s) / eta);
    s += c * eta;
    e = Math.max(0, e - Math.max(0, c - curt[i]));
    if (gc[i]) {
      const need = target[Math.floor(i / SLOTS)] - s - srem[i];
      if (need > 0) {
        g = Math.min(Pc - c, need / eta, (C - s) / eta);
        if (g > 0) s += g * eta; else g = 0;
      }
    }
    if (c <= 1e-9 && g <= 0) {
      const gi = P.g[i];
      const pm = gi < 0 || usedP[gi] < P.cap[gi] ? P.a[i] : P.b[i];
      if (im > 0 && pm > homeThr[i]) {
        dh = Math.min(im, Pd, s * eta); s -= dh / eta; im -= dh;
      }
      const fi = F.g[i];
      const fm = fi < 0 || usedF[fi] < F.cap[fi] ? F.a[i] : F.b[i];
      if (fm >= expThr[i] && s > R + 1e-6) {
        dx = Math.min(Pd - dh, Math.max(0, Lh - e), (s - R) * eta);
        if (fi >= 0 && usedF[fi] < F.cap[fi] && F.b[i] < expThr[i]) dx = Math.min(dx, F.cap[fi] - usedF[fi] - e);
        if (opt.dailyExportKwh != null) dx = Math.min(dx, opt.dailyExportKwh - battExp);
        dx = Math.max(dx, 0);
        s -= dx / eta; battExp += dx;
      }
    }
    thru += dh + dx;
    if (sl >= 34 || sl < 12) { if (s < 1e-6 && im > 0.02) nightFlag = true; }
    if (sl === 12) { emptyNights += nightFlag ? 1 : 0; nightFlag = false; }
    const q = im + g, x = e + dx;
    // track cap usage exactly as the costing does
    const gi = P.g[i];
    if (gi >= 0) usedP[gi] += Math.min(q, Math.max(P.cap[gi] - usedP[gi], 0));
    const fi = F.g[i];
    if (fi >= 0) usedF[fi] += Math.min(x, Math.max(F.cap[fi] - usedF[fi], 0));
    imp[i] = q; exp[i] = x; soc[i] = s;
  }
  const b = bill(plan, { ...usage, imp, exp }, { cl: opt.cl, clRef: opt.clRef });
  return { bill: b, throughput: thru, emptyNights, soc, imp, exp };
}

/** Best of self-use / solar export / grid charge + export for one plan. */
export function bestPolicy(plan, usage, bat, opt) {
  const cache = {};
  const options = [
    { gridCharge: false, exportOn: false, label: 'self-use' },
    { gridCharge: false, exportOn: true, label: 'solar + battery export' },
    { gridCharge: true, exportOn: true, label: 'grid charge + export' },
  ].filter(o => opt.allowExport !== false || !o.exportOn);
  let best = null;
  for (const o of options) {
    const r = simulate(plan, usage, bat, { ...opt, ...o }, cache);
    r.policy = o.label;
    if (!best || r.bill.total < best.bill.total) best = r;
  }
  return best;
}

/**
 * Cheaper Home Batteries rebate estimate (STCs). Default factors are those printed on installer
 * quotes for installs May-Dec 2026: 6.8 STC/kWh for the first 14 kWh, 4.08 for 14-28, 1.02 for 28-50.
 */
export function rebate(usableKwh, { factors = [6.8, 4.08, 1.02], stcPrice = 37 } = {}) {
  const t1 = Math.min(usableKwh, 14), t2 = Math.min(Math.max(usableKwh - 14, 0), 14), t3 = Math.min(Math.max(usableKwh - 28, 0), 22);
  const stcs = Math.floor(t1 * factors[0] + t2 * factors[1] + t3 * factors[2]);
  return { stcs, value: stcs * stcPrice };
}
