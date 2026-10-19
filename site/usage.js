// Usage file parsing. Everything stays in the browser; the NMI and meter serial are never kept.
// Supported: NEM12 (AEMO meter data, as downloaded from distributor/retailer portals)
//            Simple CSV with a timestamp column plus import / export / controlled-load kWh columns.

const SLOTS = 48;

function emptyAgg() { return new Map(); }   // key 'YYYYMMDD-slot' -> {imp, exp, cl}

function add(agg, ymd, slot, field, kwh) {
  const key = ymd * 100 + slot;
  let v = agg.get(key);
  if (!v) { v = { imp: 0, exp: 0, cl: 0, curt: 0 }; agg.set(key, v); }
  v[field] += kwh;
}

function weekday(ymd) {   // 0 = Monday, no time zone involved
  const y = Math.floor(ymd / 10000), m = Math.floor(ymd / 100) % 100, d = ymd % 100;
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/** Convert the aggregation map into the arrays the engine uses; complete days only. */
function finish(agg, meta) {
  const byDay = new Map();
  for (const key of agg.keys()) {
    const day = Math.floor(key / 100);
    byDay.set(day, (byDay.get(day) || 0) + 1);
  }
  const fullDays = [...byDay.entries()].filter(([, n]) => n === SLOTS).map(([d]) => d).sort((a, b) => a - b);
  const n = fullDays.length * SLOTS;
  const u = {
    n, days: fullDays.length, day: new Int32Array(n), wd: new Int8Array(n), mo: new Int8Array(n),
    slot: new Int8Array(n), imp: new Float64Array(n), exp: new Float64Array(n), cl: new Float64Array(n),
    curt: new Float64Array(n),
    first: fullDays[0], last: fullDays[fullDays.length - 1],
    dropped: byDay.size - fullDays.length, ...meta,
  };
  let i = 0;
  for (const d of fullDays) {
    const wd = weekday(d), mo = Math.floor(d / 100) % 100;
    for (let s = 0; s < SLOTS; s++, i++) {
      const v = agg.get(d * 100 + s);
      u.day[i] = d; u.wd[i] = wd; u.mo[i] = mo; u.slot[i] = s;
      u.imp[i] = v.imp; u.exp[i] = v.exp; u.cl[i] = v.cl; u.curt[i] = v.curt;
    }
  }
  return u;
}

/**
 * NEM12. Register mapping by NMI suffix: E1 general import, other E* controlled load, B* export.
 * `suffixMap` lets the user override (e.g. {E2: 'imp'} if E2 is not a controlled load).
 */
export function parseNem12(text, suffixMap = {}) {
  const agg = emptyAgg();
  const seen = { imp: new Set(), exp: new Set(), cl: new Set() };
  let field = null, len = 30, mult = 1, quality = { actual: 0, other: 0 };
  for (const raw of text.split(/\r?\n/)) {
    const f = raw.split(',');
    if (f[0] === '200') {
      const suffix = (f[4] || '').trim().toUpperCase();
      const uom = (f[7] || '').trim().toUpperCase();
      len = parseInt(f[8], 10) || 30;
      mult = uom === 'WH' ? 0.001 : uom === 'MWH' ? 1000 : 1;
      field = suffixMap[suffix] || (suffix.startsWith('B') ? 'exp' : suffix === 'E1' ? 'imp' : suffix.startsWith('E') ? 'cl' : null);
      if (field) seen[field].add(suffix);
      if (!['KWH', 'WH', 'MWH'].includes(uom)) field = null;   // ignore kVArh etc.
    } else if (f[0] === '300' && field) {
      const ymd = parseInt(f[1], 10);
      const per = 1440 / len;
      for (let k = 0; k < per; k++) {
        const v = parseFloat(f[2 + k]);
        if (!Number.isFinite(v)) continue;
        const slot = Math.floor((k * len) / 30);
        add(agg, ymd, slot, field, v * mult);
      }
      const q = (f[2 + per] || '').trim().charAt(0);
      if (q === 'A') quality.actual++; else quality.other++;
    }
  }
  return finish(agg, {
    format: 'NEM12',
    registers: { imp: [...seen.imp], exp: [...seen.exp], cl: [...seen.cl] },
    quality,
  });
}

/** Simple CSV: timestamp + import/export/controlled columns (header names matched loosely). */
export function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const head = lines[0].split(',').map(h => h.trim().toLowerCase());
  const find = (...pats) => head.findIndex(h => pats.some(p => p.test(h)));
  const ti = find(/start|time|date|interval/);
  const ii = find(/^import|general|consumption|usage|^e1/);
  const ei = find(/export|feed|solar|generation|^b1/);
  const ci = find(/controlled|^cl$|^cl_|tariff ?3[13]|hot ?water|^e2/);
  const ki = find(/curtail/);   // optional: estimated solar lost to an export limit (from inverter data)
  if (ti < 0 || ii < 0) throw new Error('CSV needs a timestamp column and an import/consumption column');
  const agg = emptyAgg();
  let minutes = null;
  for (const line of lines.slice(1)) {
    const f = line.split(',');
    const m = (f[ti] || '').match(/(\d{4})-?(\d{2})-?(\d{2})[T ](\d{1,2}):(\d{2})/);
    if (!m) continue;
    const ymd = +m[1] * 10000 + +m[2] * 100 + +m[3];
    const slot = Math.floor((+m[4] * 60 + +m[5]) / 30);
    add(agg, ymd, slot, 'imp', parseFloat(f[ii]) || 0);
    if (ei >= 0) add(agg, ymd, slot, 'exp', parseFloat(f[ei]) || 0);
    if (ci >= 0) add(agg, ymd, slot, 'cl', parseFloat(f[ci]) || 0);
    if (ki >= 0) add(agg, ymd, slot, 'curt', parseFloat(f[ki]) || 0);
    minutes = minutes ?? +m[5];
  }
  return finish(agg, { format: 'CSV', registers: { imp: [head[ii]], exp: ei >= 0 ? [head[ei]] : [], cl: ci >= 0 ? [head[ci]] : [] } });
}

export function parseUsage(text) {
  return /^\s*100,NEM12/m.test(text) || /^200,/m.test(text) ? parseNem12(text) : parseCsv(text);
}

/** Daily averages and an average-day profile for display. */
export function summarise(u) {
  const tot = { imp: 0, exp: 0, cl: 0 };
  const prof = { imp: new Float64Array(SLOTS), exp: new Float64Array(SLOTS), cl: new Float64Array(SLOTS) };
  for (let i = 0; i < u.n; i++) {
    for (const k of ['imp', 'exp', 'cl']) { tot[k] += u[k][i]; prof[k][u.slot[i]] += u[k][i]; }
  }
  for (const k of ['imp', 'exp', 'cl']) prof[k] = Array.from(prof[k], v => (v / u.days) * 2); // avg kW
  return { days: u.days, perDay: { imp: tot.imp / u.days, exp: tot.exp / u.days, cl: tot.cl / u.days }, prof };
}
