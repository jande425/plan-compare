// Tariff engine: prices half-hourly usage against a plan from plans.json.
// Runs entirely in the browser. Mirrors the household model that reconciled to real bills:
// first matching rule wins; capped rules use a daily kWh allowance then an after-cap rate.

const SLOTS = 48;

/** Lookup table: [weekday 0=Mon][month 1..12][slot] -> rule index (first match wins). */
export function buildLut(rules) {
  const lut = new Int16Array(7 * 12 * SLOTS).fill(-1);
  for (let wd = 0; wd < 7; wd++) {
    for (let mo = 1; mo <= 12; mo++) {
      for (let slot = 0; slot < SLOTS; slot++) {
        const h = slot / 2;
        const idx = rules.findIndex(r =>
          h >= r.s && h < r.e && (!r.d || r.d.includes(wd)) && (!r.m || r.m.includes(mo)));
        lut[(wd * 12 + (mo - 1)) * SLOTS + slot] = idx;
      }
    }
  }
  return lut;
}

const lutCache = new WeakMap();
function luts(plan) {
  let v = lutCache.get(plan);
  if (!v) {
    v = { imp: buildLut(plan.imp), fit: buildLut(plan.fit) };
    lutCache.set(plan, v);
  }
  return v;
}

/** Cost of `kwh` under rule `r`, updating that rule's daily allowance `used`. */
function priced(r, kwh, used, idx) {
  if (r.cap == null) return kwh * r.r;
  const a = Math.min(kwh, Math.max(r.cap - used[idx], 0));
  used[idx] += a;
  return a * r.r + (kwh - a) * r.after;
}

/**
 * Bill for the period covered by `usage`.
 * usage: {n, day[], wd[], mo[], slot[], imp[], exp[], cl[], days}
 * opts.cl: 'cl33' | 'cl31' | 'none'; opts.clRef: fallback {r, s} when a plan has no matching CL rate.
 */
export function bill(plan, usage, opts = {}) {
  const { imp: li, fit: lf } = luts(plan);
  const clKey = opts.cl || 'none';
  const hasCl = clKey !== 'none';
  let clRate = null;
  const flags = [];
  if (hasCl) {
    clRate = plan.cl[clKey] || null;
    if (!clRate && opts.clRef) {
      const f = plan.disc ?? 1;   // the plan's guaranteed discount also applies to the reference rate
      clRate = { r: opts.clRef.r * f, s: opts.clRef.s * f };
      flags.push('controlled-load rate not published: reference rate used');
    }
  }
  const usedI = new Float64Array(plan.imp.length);
  const usedF = new Float64Array(plan.fit.length);
  let lastDay = -1, usageCost = 0, fitCredit = 0, clCost = 0;
  for (let i = 0; i < usage.n; i++) {
    if (usage.day[i] !== lastDay) {
      usedI.fill(0); usedF.fill(0); lastDay = usage.day[i];
    }
    const k = (usage.wd[i] * 12 + (usage.mo[i] - 1)) * SLOTS + usage.slot[i];
    const q = usage.imp[i];
    if (q > 0) {
      const ri = li[k];
      usageCost += priced(plan.imp[ri], q, usedI, ri);
    }
    const x = usage.exp[i];
    if (x > 0) {
      const rf = lf[k];
      fitCredit += priced(plan.fit[rf], x, usedF, rf);
    }
    if (hasCl && usage.cl[i] > 0 && clRate) clCost += usage.cl[i] * clRate.r;
  }
  const days = usage.days;
  const supply = plan.supply * days + (hasCl && clRate ? clRate.s * days : 0);
  const fee = plan.fee * days / 365;
  const demand = demandCost(plan, usage);
  const total = supply + usageCost + clCost + fee + demand - fitCredit;
  return { total, supply, usage: usageCost, cl: clCost, fee, demand, fit: fitCredit, days, flags };
}

/** Demand charges from half-hourly imports (kW = 2 x kWh per 30 min). */
export function demandCost(plan, usage) {
  if (!plan.demand || !plan.demand.length) return 0;
  let total = 0;
  for (const dm of plan.demand) {
    const daily = new Map();   // day -> max kW in window
    for (let i = 0; i < usage.n; i++) {
      const h = usage.slot[i] / 2;
      if (h < dm.s || h >= dm.e || (dm.d && !dm.d.includes(usage.wd[i]))) continue;
      const kw = usage.imp[i] * 2;
      const prev = daily.get(usage.day[i]) || 0;
      if (kw > prev) daily.set(usage.day[i], kw);
    }
    // Days with no in-window interval still carry the minimum demand.
    const allDays = [...new Set(usage.day)];
    const vals = allDays.map(d => Math.max(daily.get(d) || 0, dm.min || 0));
    if (dm.measure === 'DAY') {
      if (dm.charge === 'DAY') total += vals.reduce((a, b) => a + b, 0) * dm.r;
    } else {
      const byMonth = new Map();
      allDays.forEach((d, j) => {
        const key = Math.floor(d / 100);
        const m = byMonth.get(key) || { max: 0, n: 0 };
        m.max = Math.max(m.max, vals[j]); m.n += 1;
        byMonth.set(key, m);
      });
      for (const m of byMonth.values()) total += m.max * dm.r * (dm.charge === 'DAY' ? m.n : 1);
    }
  }
  return total;
}

/** Price every plan; returns rows sorted by annualised cost. */
export function rankAll(plans, usage, opts = {}) {
  const scale = 365 / usage.days;
  const rows = plans.map(p => {
    const b = bill(p, usage, opts);
    return { plan: p, bill: b, annual: b.total * scale };
  });
  rows.sort((a, b) => a.annual - b.annual);
  return rows;
}

/** Median controlled-load rate across plans, used when a plan doesn't publish one. */
export function referenceCl(plans, key) {
  const v = plans.map(p => p.cl[key]).filter(Boolean);
  if (!v.length) return null;
  const r = v.map(x => x.r).sort((a, b) => a - b);
  const s = v.map(x => x.s).sort((a, b) => a - b);
  return { r: r[Math.floor(r.length / 2)], s: s[Math.floor(s.length / 2)] };
}
