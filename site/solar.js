// Add modelled solar generation to a usage record. Household load is unchanged; only net flows move.
const SLOTS = 48, H = 0.5;

/** Half-hourly kWh for `kwp` of panels, aligned to the usage days by calendar date (month-day). */
export function solarSeries(profile, orientation, kwp, usage) {
  const o = profile.orientations[orientation];
  const [y0, m0, d0] = profile.start.split('-').map(Number);
  const start = Date.UTC(y0, m0 - 1, d0);
  const byMd = new Map();                 // month*100+day -> day index in the profile year
  const nDays = Math.floor(o.hourly.length / 24);
  for (let k = 0; k < nDays; k++) {
    const dt = new Date(start + k * 86400000);
    byMd.set((dt.getUTCMonth() + 1) * 100 + dt.getUTCDate(), k);
  }
  const out = new Float64Array(usage.n);
  for (let i = 0; i < usage.n; i++) {
    const day = usage.day[i], md = day % 10000;
    const k = byMd.get(md) ?? byMd.get(md === 229 ? 228 : md);
    if (k == null) continue;
    // hourly value at hour h is the mean of the preceding hour -> covers slots 2(h-1), 2(h-1)+1
    const slot = usage.slot[i], h = Math.floor(slot / 2) + 1;
    const idx = k * 24 + h;
    const v = idx < o.hourly.length ? o.hourly[idx] : 0;
    out[i] = v * kwp * H;   // kWh per half-hour
  }
  return out;
}

/** New usage with extra solar netted off: same load, more export / less import. */
export function withSolar(usage, extra, exportLimitKw = 5) {
  const n = usage.n, cap = exportLimitKw * H;
  const imp = new Float64Array(n), exp = new Float64Array(n), curt = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const net = usage.imp[i] - usage.exp[i] - (usage.curt ? usage.curt[i] : 0) - extra[i];
    imp[i] = Math.max(net, 0);
    const surplus = Math.max(-net, 0);
    exp[i] = Math.min(surplus, cap);
    curt[i] = surplus - exp[i];
  }
  return { ...usage, imp, exp, curt };
}
