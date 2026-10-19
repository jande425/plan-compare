// "From your bills": build an estimated half-hourly usage record from bill totals.
// Rougher than a meter file: the split within each time-of-use bucket follows a typical SEQ
// household shape, solar exports follow the actual weather for those dates (postcode solar data).
const SLOTS = 48;

// Relative import weights by half-hour (typical SEQ shapes; only the within-bucket split matters).
const SHAPE_NO_SOLAR = Array.from({ length: SLOTS }, (_, s) => {
  const h = s / 2;
  return h < 6 ? 0.6 : h < 9 ? 1.1 : h < 16 ? 0.9 : h < 21 ? 1.6 : 1.0;
});
const SHAPE_SOLAR = Array.from({ length: SLOTS }, (_, s) => {
  const h = s / 2;
  return h < 6 ? 0.6 : h < 8 ? 1.0 : h < 9 ? 0.6 : h < 15.5 ? 0.2 : h < 16 ? 0.6 : h < 21 ? 1.6 : 1.0;
});
// Default Energex time-of-use windows used by most retailers: peak 4-9 pm, off-peak 9 am-4 pm, shoulder otherwise.
export const BUCKETS = {
  peak: s => s >= 32 && s < 42,
  offpeak: s => s >= 18 && s < 32,
  shoulder: s => s < 18 || s >= 42,
};

function ymdParts(str) { const [y, m, d] = str.split('-').map(Number); return Date.UTC(y, m - 1, d); }

const mdCache = new WeakMap();
/** Hourly north-facing kWh/kWp for the same month-day in the postcode profile year (null if no profile). */
function solarDay(profile, utc) {
  if (!profile) return null;
  let map = mdCache.get(profile);
  if (!map) {
    map = new Map();
    const start = ymdParts(profile.start), nDays = Math.floor(profile.orientations.north.hourly.length / 24);
    for (let k = 0; k < nDays; k++) {
      const dt = new Date(start + k * 86400000);
      map.set((dt.getUTCMonth() + 1) * 100 + dt.getUTCDate(), k);
    }
    mdCache.set(profile, map);
  }
  const dt = new Date(utc), md = (dt.getUTCMonth() + 1) * 100 + dt.getUTCDate();
  const k = map.get(md) ?? map.get(md === 229 ? 228 : md);
  if (k == null) return null;
  return profile.orientations.north.hourly.slice(k * 24, k * 24 + 24);
}

/**
 * bills: [{from, to, peak, shoulder, offpeak, total, cl, exp}] (dates inclusive, kWh for the period).
 * Either the three TOU buckets or `total` must be given.
 */
export function usageFromBills(bills, profile, { exportLimitKw = 5 } = {}) {
  const dayRows = [];
  for (const b of bills) {
    const t0 = ymdParts(b.from), t1 = ymdParts(b.to);
    const nd = Math.round((t1 - t0) / 86400000) + 1;
    if (!(nd > 0)) throw new Error(`Bill ${b.from} to ${b.to}: dates are the wrong way round`);
    const solarHome = (b.exp || 0) > 0;
    const shape = solarHome ? SHAPE_SOLAR : SHAPE_NO_SOLAR;
    const split = b.total != null && !(b.peak || b.shoulder || b.offpeak)
      ? (() => {                                      // split a single total by the shape
          const w = { peak: 0, offpeak: 0, shoulder: 0 };
          for (let s = 0; s < SLOTS; s++) for (const k in BUCKETS) if (BUCKETS[k](s)) w[k] += shape[s];
          const sum = w.peak + w.offpeak + w.shoulder;
          return { peak: b.total * w.peak / sum, offpeak: b.total * w.offpeak / sum, shoulder: b.total * w.shoulder / sum };
        })()
      : { peak: b.peak || 0, offpeak: b.offpeak || 0, shoulder: b.shoulder || 0 };
    const days = [];
    let solarSum = 0;
    for (let k = 0; k < nd; k++) {
      const utc = t0 + k * 86400000, sd = solarDay(profile, utc);
      const e = sd ? sd.reduce((a, v) => a + v, 0) : 1;
      solarSum += e;
      days.push({ utc, sd, e });
    }
    for (const d of days) {
      const imp = new Float64Array(SLOTS), exp = new Float64Array(SLOTS), cl = new Float64Array(SLOTS);
      for (const k in BUCKETS) {
        let w = 0;
        for (let s = 0; s < SLOTS; s++) if (BUCKETS[k](s)) w += shape[s];
        for (let s = 0; s < SLOTS; s++) if (BUCKETS[k](s)) imp[s] = (split[k] / nd) * shape[s] / w;
      }
      const clDay = (b.cl || 0) / nd;                 // controlled load: priced flat, timing doesn't change cost
      for (let s = 0; s < 12; s++) cl[s] = clDay / 12;
      const expDay = (b.exp || 0) * d.e / solarSum;
      if (expDay > 0) {
        // shape exports like the day's solar, centred on the sunny hours, capped at the export limit
        const hourly = d.sd || Array.from({ length: 24 }, (_, h) => Math.max(0, Math.sin(Math.PI * (h - 6) / 12)));
        const tot = hourly.reduce((a, v) => a + v, 0) || 1;
        for (let s = 0; s < SLOTS; s++) {
          const h = Math.floor(s / 2) + 1;             // hourly value covers the preceding hour
          exp[s] = Math.min(expDay * (hourly[h % 24] || 0) / tot / 2, exportLimitKw / 2);
        }
      }
      dayRows.push({ utc: d.utc, imp, exp, cl });
    }
  }
  dayRows.sort((a, b) => a.utc - b.utc);
  const seen = new Set(), rows = dayRows.filter(r => !seen.has(r.utc) && seen.add(r.utc));
  const n = rows.length * SLOTS;
  const u = { n, days: rows.length, day: new Int32Array(n), wd: new Int8Array(n), mo: new Int8Array(n), slot: new Int8Array(n),
    imp: new Float64Array(n), exp: new Float64Array(n), cl: new Float64Array(n), curt: new Float64Array(n), format: 'bills', estimated: true };
  rows.forEach((r, j) => {
    const dt = new Date(r.utc), ymd = dt.getUTCFullYear() * 10000 + (dt.getUTCMonth() + 1) * 100 + dt.getUTCDate();
    const wd = (dt.getUTCDay() + 6) % 7;
    for (let s = 0; s < SLOTS; s++) {
      const i = j * SLOTS + s;
      u.day[i] = ymd; u.wd[i] = wd; u.mo[i] = dt.getUTCMonth() + 1; u.slot[i] = s;
      u.imp[i] = r.imp[s]; u.exp[i] = r.exp[s]; u.cl[i] = r.cl[s];
    }
  });
  u.first = u.day[0]; u.last = u.day[n - 1];
  return u;
}
