// Background pricing of every plan with an upgrade (added solar and/or battery).
// Batteries are simulated new and at year-10 capacity (for the most promising plans) so the
// 10-year view can include capacity fade.
import { bill } from './engine.js';
import { bestPolicy } from './battery.js';

self.onmessage = ({ data }) => {
  const { plans, usage, bat, opt, fade = 0.02, agedTop = 40 } = data;
  const out = [];
  plans.forEach((p, k) => {
    if (bat) {
      const r = bestPolicy(p, usage, bat, opt);
      out.push({ id: p.id, total: r.bill.total, fit: r.bill.fit, policy: r.policy, throughput: r.throughput, emptyNights: r.emptyNights });
    } else {
      const b = bill(p, usage, opt);
      out.push({ id: p.id, total: b.total, fit: b.fit, policy: 'solar only', throughput: 0, emptyNights: null });
    }
    if (k % 25 === 0) self.postMessage({ progress: (k / plans.length) * (bat ? 0.8 : 1) });
  });
  if (bat) {
    const aged = { ...bat, usable: bat.usable * Math.max(0, 1 - fade * 9) };
    const byId = new Map(plans.map(p => [p.id, p]));
    const top = [...out].sort((a, b) => a.total - b.total).slice(0, agedTop);
    top.forEach((o, k) => {
      const r = bestPolicy(byId.get(o.id), usage, aged, opt);
      o.total10 = r.bill.total; o.fit10 = r.bill.fit;
      if (k % 5 === 0) self.postMessage({ progress: 0.8 + 0.2 * (k / top.length) });
    });
  }
  self.postMessage({ done: out });
};
