// Ten-year cost ranges from historical retail price movements (data/history.json).
// Bills, supply and usage escalate by randomly re-sampled historical annual changes
// (bootstrap). Feed-in credits are held flat by default, or fall by a chosen % per year.

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pct(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

/**
 * annual: {charges, credits} for year 1 (numbers), or per-year arrays at today's prices (e.g. a battery that
 * slowly loses capacity) (charges = supply+usage+CL+fees+demand, credits = feed-in).
 * Returns P10/P50/P90 of the 10-year total and per-year bands.
 */
export function tenYear(annual, history, { years = 10, runs = 2000, fitDecline = 0, seed = 2026 } = {}) {
  const rand = mulberry32(seed);
  const changes = history.annual_changes.map(c => c.change);
  const totals = [];
  const perYear = Array.from({ length: years }, () => []);
  for (let r = 0; r < runs; r++) {
    let idx = 1, fitIdx = 1, sum = 0;
    for (let y = 0; y < years; y++) {
      if (y) {
        idx *= 1 + changes[Math.floor(rand() * changes.length)];
        fitIdx *= 1 - fitDecline;
      }
      const ch = Array.isArray(annual.charges) ? annual.charges[y] : annual.charges;
      const cr = Array.isArray(annual.credits) ? annual.credits[y] : annual.credits;
      const v = ch * idx - cr * fitIdx;
      perYear[y].push(v);
      sum += v;
    }
    totals.push(sum);
  }
  totals.sort((a, b) => a - b);
  const bands = perYear.map(v => {
    v.sort((a, b) => a - b);
    return { p10: pct(v, 0.1), p50: pct(v, 0.5), p90: pct(v, 0.9) };
  });
  return { p10: pct(totals, 0.1), p50: pct(totals, 0.5), p90: pct(totals, 0.9), bands };
}

/**
 * Ten-year saving of an upgrade against a baseline, net of its price, using the same price paths for both
 * (so the range reflects price uncertainty, not noise). base/up: {charges, credits} numbers or per-year arrays.
 */
export function tenYearSaving(base, up, price, history, { years = 10, runs = 2000, fitDecline = 0, seed = 2026 } = {}) {
  const rand = mulberry32(seed);
  const changes = history.annual_changes.map(c => c.change);
  const at = (v, y) => (Array.isArray(v) ? v[y] : v);
  const out = [];
  for (let r = 0; r < runs; r++) {
    let idx = 1, fitIdx = 1, s = -price;
    for (let y = 0; y < years; y++) {
      if (y) { idx *= 1 + changes[Math.floor(rand() * changes.length)]; fitIdx *= 1 - fitDecline; }
      s += (at(base.charges, y) - at(up.charges, y)) * idx - (at(base.credits, y) - at(up.credits, y)) * fitIdx;
    }
    out.push(s);
  }
  out.sort((a, b) => a - b);
  return { p10: pct(out, 0.1), p50: pct(out, 0.5), p90: pct(out, 0.9) };
}
