// Optional inverter generation upload: calibrates the postcode solar model to the household's real
// panels and estimates solar the inverter threw away at the export limit (which a battery could store).
import { solarSeries } from './solar.js';

const SLOTS = 48;

/** CSV with a timestamp and a generation column (kWh per interval; 5/15/30/60-min). */
export function parseGeneration(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const head = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/"/g, ''));
  const ti = head.findIndex(h => /time|date|start|interval/.test(h));
  const gi = head.findIndex(h => /gen|produc|yield|pv|solar|energy|kwh/.test(h) && !/time|date/.test(h));
  if (ti < 0 || gi < 0) throw new Error('Generation CSV needs a timestamp column and a generation (kWh) column');
  const unit = /kwh/.test(head[gi]) ? 1 : /wh/.test(head[gi]) ? 0.001 : 1;   // Wh columns (e.g. Fronius exports) -> kWh
  const pts = [];
  for (const line of lines.slice(1)) {
    const f = line.split(',').map(x => x.replace(/"/g, ''));
    const m = (f[ti] || '').match(/(\d{4})-?(\d{2})-?(\d{2})[T ](\d{1,2}):(\d{2})/);
    const v = parseFloat(f[gi]) * unit;
    if (m && Number.isFinite(v)) pts.push({ ymd: +m[1] * 10000 + +m[2] * 100 + +m[3], min: +m[4] * 60 + +m[5], v });
  }
  if (pts.length < 2) throw new Error('No generation readings found');
  const step = Math.max(5, Math.min(60, Math.abs(pts[1].min - pts[0].min) || 30));
  const map = new Map();
  for (const p of pts) {
    if (step === 60) {                                 // hourly: split across two half-hours
      for (const s of [Math.floor(p.min / 30), Math.floor(p.min / 30) + 1]) {
        const key = p.ymd * 100 + Math.min(s, 47);
        map.set(key, (map.get(key) || 0) + p.v / 2);
      }
    } else {
      const key = p.ymd * 100 + Math.floor(p.min / 30);
      map.set(key, (map.get(key) || 0) + p.v);
    }
  }
  return map;                                          // ymd*100+slot -> kWh
}

/**
 * Compare measured generation with the postcode model for the existing panels.
 * Returns {factor, curt (Float64Array), curtKwh, matchedDays}: factor scales the model to this roof;
 * curt = modelled-but-missing solar in intervals where exports sat at the limit.
 */
export function calibrate(usage, gen, profile, orientation, kwp, exportLimitKw = 5) {
  const model = solarSeries(profile, orientation, kwp, usage);
  const cap = exportLimitKw * 0.5;
  let meas = 0, mod = 0;
  const days = new Set();
  for (let i = 0; i < usage.n; i++) {
    const g = gen.get(usage.day[i] * 100 + usage.slot[i]);
    if (g == null) continue;
    days.add(usage.day[i]);
    if (usage.exp[i] < 0.95 * cap && model[i] > 0.05) { meas += g; mod += model[i]; }
  }
  const factor = mod > 0 ? meas / mod : null;
  const curt = new Float64Array(usage.n);
  let curtKwh = 0;
  if (factor) {
    for (let i = 0; i < usage.n; i++) {
      const g = gen.get(usage.day[i] * 100 + usage.slot[i]);
      if (g == null || usage.exp[i] < 0.95 * cap) continue;
      curt[i] = Math.max(0, model[i] * factor - g);
      curtKwh += curt[i];
    }
  }
  return { factor, curt, curtKwh, matchedDays: days.size };
}
