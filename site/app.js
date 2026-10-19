import { parseUsage, summarise } from './usage.js';
import { rankAll, referenceCl } from './engine.js';
import { tenYear, tenYearSaving } from './forecast.js';
import { rebate } from './battery.js';
import { solarSeries, withSolar } from './solar.js';
import { usageFromBills } from './bills.js';
import { parseGeneration, calibrate } from './calibrate.js';

const $ = id => document.getElementById(id);
const money = v => (v < 0 ? '−$' : '$') + Math.abs(Math.round(v)).toLocaleString('en-AU');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const TOP = 25;
const FADE = 0.02;            // battery capacity loss per year (typical; warranties allow up to ~2.5-3%)

let data, history, equipment, postcodes, solar = null, usage, rows = [], showAll = false, charts = {};
let pc = null, calib = null, gen = null;
let upgrade = null;          // {label, price, byId: Map(id -> result)}

async function init() {
  [data, history, equipment, postcodes] = await Promise.all([
    fetch('data/plans.json').then(r => r.json()),
    fetch('data/history.json').then(r => r.json()),
    fetch('data/equipment.json').then(r => r.json()),
    fetch('data/postcodes.json').then(r => r.json()),
  ]);
  $('postcode').addEventListener('input', setPostcode);
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
    for (const id of ['tab-file', 'tab-bills']) $(id).hidden = id !== t.dataset.tab;
  }));
  $('add-bill').addEventListener('click', () => addBillRow());
  $('use-bills').addEventListener('click', useBills);
  addBillRow();
  $('gen-file').addEventListener('change', async e => { const f = e.target.files[0]; if (f) { gen = parseGeneration(await f.text()); applyCalibration(); } });
  for (const id of ['ex-kw', 'ex-dir', 'exp-lim']) $(id).addEventListener('change', applyCalibration);
  $('data-meta').textContent = `${data.count.toLocaleString()} plan variants for ${data.area}, checked ${data.built}`;
  const names = [...new Set(data.plans.map(p => `${p.brand} — ${p.name}`))].sort();
  $('plan-list').innerHTML = names.map(n => `<option value="${esc(n)}">`).join('');
  $('bat-sys').innerHTML += equipment.systems.map(s => `<option value="${s.id}">${esc(s.brand)} ${esc(s.name)}</option>`).join('')
    + '<option value="custom">Custom (enter specs)</option>';
  $('file').addEventListener('change', async e => { const f = e.target.files[0]; if (f) load(await f.text()); });
  $('sample').addEventListener('click', async () => load(await fetch('data/sample-usage.csv').then(r => r.text()), true));
  for (const id of ['cl', 'fitdecline', 'wholesale', 'restricted', 'clmissing', 'current']) $(id).addEventListener('change', () => { upgrade = null; run(); });
  $('more').addEventListener('click', () => { showAll = !showAll; render(); });
  $('bat-sys').addEventListener('change', batteryUi);
  $('bat-mod').addEventListener('change', specUi);
  for (const id of ['c-kwh', 'c-ch', 'c-dis', 'c-rte', 'pv-kw', 'pv-dir']) $(id).addEventListener('input', specUi);
  $('run-upgrade').addEventListener('click', runUpgrade);
  $('clear-upgrade').addEventListener('click', () => { upgrade = null; $('clear-upgrade').hidden = true; run(); });
  batteryUi();
}

// ---------------------------------------------------------------- usage
async function load(text, sample = false) {
  try {
    const u = parseUsage(text);
    if (u.days < 7) throw new Error('Need at least 7 complete days of half-hourly data.');
    if (sample && !pc) { $('postcode').value = '4000'; await setPostcode(); }
    loadUsage(u, sample);
  } catch (err) {
    showError(`Couldn't read that file: ${err.message}`);
  }
}

function showError(msg) { $('usage-error').textContent = msg; $('usage-error').hidden = !msg; }

async function setPostcode() {
  const v = $('postcode').value.trim();
  const info = postcodes.postcodes[v];
  pc = info ? v : null;
  solar = null;
  if (!v) { $('pc-note').textContent = ''; return; }
  if (!info) { $('pc-note').textContent = v.length === 4 ? 'Not covered yet: this draft covers the Energex area of South East Queensland.' : ''; return; }
  $('pc-note').textContent = info.suburbs.slice(0, 4).join(', ') + (info.suburbs.length > 4 ? '…' : '');
  solar = await fetch(`data/solar/${info.cell}.json`).then(r => (r.ok ? r.json() : null)).catch(() => null);
  specUi();
  if (usage) { upgrade = null; run(); }
}

function addBillRow(v = {}) {
  const tr = document.createElement('tr');
  const cell = (k, type = 'number') => `<td><input data-k="${k}" type="${type}" ${type === 'number' ? 'min="0" step="0.1"' : ''} value="${v[k] ?? ''}"></td>`;
  tr.innerHTML = cell('from', 'date') + cell('to', 'date') + ['peak', 'offpeak', 'shoulder', 'total', 'cl', 'exp'].map(k => cell(k)).join('')
    + '<td><button class="secondary" title="Remove">×</button></td>';
  tr.querySelector('button').addEventListener('click', () => tr.remove());
  $('bill-rows').appendChild(tr);
}

function useBills() {
  const bills = [...$('bill-rows').querySelectorAll('tr')].map(tr => {
    const o = {};
    tr.querySelectorAll('input').forEach(i => { o[i.dataset.k] = i.type === 'date' ? i.value : (i.value === '' ? null : +i.value); });
    return o;
  }).filter(b => b.from && b.to);
  if (!bills.length) return showError('Enter at least one bill with its from and to dates.');
  if (bills.some(b => !(b.peak || b.offpeak || b.shoulder || b.total))) return showError('Each bill needs either the time-of-use kWh or a total kWh.');
  if (!pc) return showError('Enter your postcode first: it sets the solar timing for your area.');
  if (!solar) return showError('Solar data for this postcode is still loading or unavailable; try again in a moment.');
  try {
    loadUsage(usageFromBills(bills, solar, { exportLimitKw: +$('exp-lim').value || 5 }));
  } catch (err) { showError(err.message); }
}

function loadUsage(u, sample = false) {
  showError('');
  usage = u;
  usage.curtOrig = usage.curt;
  calib = null;
  upgrade = null;
  const s = summarise(usage);
  const d = n => `${String(n).slice(6, 8)}/${String(n).slice(4, 6)}/${String(n).slice(0, 4)}`;
  $('stats').innerHTML = [
    [s.days, `days (${d(usage.first)} – ${d(usage.last)})${sample ? ', sample household' : ''}`],
    [s.perDay.imp.toFixed(1) + ' kWh', 'bought from the grid per day'],
    [s.perDay.exp.toFixed(1) + ' kWh', 'solar exported per day'],
    [s.perDay.cl.toFixed(1) + ' kWh', 'controlled load per day'],
  ].map(([b, t]) => `<div class="stat"><b>${b}</b><span>${t}</span></div>`).join('');
  $('partial').hidden = usage.days >= 330 && !usage.estimated;
  $('partial').textContent = (usage.estimated ? 'Estimated from bill totals, so treat close results as a tie. ' : '')
    + (usage.days < 330 ? `Only ${usage.days} days of data: results are scaled up to a year, so seasonal differences (e.g. summer air-con, winter solar) may be under- or over-counted.` : '');
  $('cl').value = s.perDay.cl > 0.05 ? 'cl33' : 'none';
  for (const id of ['step-summary', 'step-options', 'step-upgrade', 'step-results']) $(id).hidden = false;
  drawProfile(s);
  specUi();
  run();
}

function drawProfile(s) {
  const labels = Array.from({ length: 48 }, (_, i) => (i % 4 === 0 ? `${String(i / 2).padStart(2, '0')}:00` : ''));
  charts.profile?.destroy();
  charts.profile = new Chart($('profile'), {
    type: 'line',
    data: { labels, datasets: [
      { label: 'Grid import (kW)', data: s.prof.imp, borderColor: '#d1495b', pointRadius: 0, borderWidth: 2 },
      { label: 'Solar export (kW)', data: s.prof.exp, borderColor: '#e8a33d', pointRadius: 0, borderWidth: 2 },
      { label: 'Controlled load (kW)', data: s.prof.cl, borderColor: '#2a78d6', pointRadius: 0, borderWidth: 2 },
    ] },
    options: { animation: false, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: { title: { display: true, text: 'Your average day' } }, scales: { y: { beginAtZero: true } } },
  });
}

// ---------------------------------------------------------------- equipment
function selectedSystem() {
  const id = $('bat-sys').value;
  if (!id) return null;
  if (id === 'custom') {
    return { custom: true, label: `Custom ${$('c-kwh').value} kWh battery`, usable: +$('c-kwh').value,
      charge_kw: +$('c-ch').value, discharge_kw: +$('c-dis').value, rte: +$('c-rte').value / 100 };
  }
  const s = equipment.systems.find(x => x.id === id);
  const n = +$('bat-mod').value || s.modules.min;
  const usable = +(s.module_kwh * n).toFixed(2);
  const modKw = s.per_module_kw ? s.per_module_kw * n : Infinity;
  return { sys: s, n, usable, rte: s.rte, label: `${s.brand} ${s.name}, ${usable} kWh`,
    charge_kw: Math.min(s.inverter_charge_kw, modKw), discharge_kw: Math.min(s.inverter_discharge_kw, modKw) };
}

function batteryUi() {
  const id = $('bat-sys').value;
  $('bat-custom').hidden = id !== 'custom';
  $('bat-mod-wrap').hidden = !id || id === 'custom';
  const s = equipment.systems.find(x => x.id === id);
  if (s) {
    const opts = [];
    for (let n = s.modules.min; n <= s.modules.max; n++) {
      const lab = s.modules.label.replace('{n}', n).replace('{m}', n - 1).replace('{x50}', n * 50);
      opts.push(`<option value="${n}">${lab} — ${(s.module_kwh * n).toFixed(1)} kWh</option>`);
    }
    $('bat-mod').innerHTML = opts.join('');
    $('bat-mod').value = String(Math.min(s.modules.max, Math.max(s.modules.min, Math.round(40 / s.module_kwh))));
  }
  specUi();
}

function specUi() {
  const b = selectedSystem();
  if (!b) {
    $('bat-spec').innerHTML = '';
  } else {
    const s = b.sys;
    const conf = k => (s && s.confidence[k] ? `<span class="conf">${s.confidence[k]}</span>` : '');
    $('bat-spec').innerHTML = `<b>${b.usable} kWh usable</b>${conf('module_kwh')} · charge ${b.charge_kw} kW / discharge ${b.discharge_kw} kW${conf('power')}
      · round trip ${Math.round(b.rte * 100)}%${s ? conf('rte') : ''}` + (s ? `<br>${esc(s.inverter)}<br>Backup: ${esc(s.backup)}
      <br>Warranty: ${esc(s.warranty.text)}${conf('warranty')}${s.notes.map(x => `<br>• ${esc(x)}`).join('')}
      <br><span class="hint">Sources: ${s.sources.map(x => `${esc(x.title)} (${esc(x.date)})`).join('; ')}</span>` : '');
    const rb = rebate(b.usable);
    $('rebate-note').textContent = `Estimated federal battery rebate for ${b.usable} kWh installed before 31 Dec 2026: about ${money(rb.value)} (${rb.stcs} STCs at ~$37). Most quotes already deduct it.`;
  }
  if (!b) $('rebate-note').textContent = '';
  const kw = +$('pv-kw').value;
  $('pv-kw').disabled = !solar;
  if (!solar) {
    $('pv-note').textContent = pc ? 'Solar data for this area is not available yet.' : 'Enter your postcode (step 1) to model extra panels.';
  } else {
    const o = solar.orientations[$('pv-dir').value];
    $('pv-note').textContent = `Postcode ${pc}: about ${o.annual_kwh_per_kwp.toLocaleString()} kWh per kW per year at this angle (${solar.start} to ${solar.end} weather, 20% system losses).`
      + (kw ? ` ${kw} kW adds about ${Math.round(o.annual_kwh_per_kwp * kw).toLocaleString()} kWh a year.` : '');
  }
}

// ---------------------------------------------------------------- pricing
function filteredPlans() {
  const cl = $('cl').value;
  return data.plans.filter(p => (!pc || !p.not_pc || !p.not_pc.includes(pc))
    && ($('wholesale').checked || p.ranked)
    && ($('restricted').checked || !p.restricted)
    && (cl === 'none' || $('clmissing').checked || p.cl[cl]));
}

function pricingOpts() {
  const cl = $('cl').value;
  return { cl, clRef: cl === 'none' ? null : referenceCl(data.plans, cl) };
}

function run() {
  if (!usage) return;
  const ranked = rankAll(filteredPlans(), usage, pricingOpts());
  const seen = new Map();
  rows = [];
  for (const r of ranked) {
    const key = `${r.plan.brand}|${r.plan.name}|${r.annual.toFixed(2)}`;
    if (seen.has(key)) { seen.get(key).variants++; continue; }
    r.variants = 1; seen.set(key, r); rows.push(r);
  }
  const scale = 365 / usage.days;
  if (upgrade) {
    for (const r of rows) {
      const u = upgrade.byId.get(r.plan.id);
      if (u) r.up = { annual: u.total * scale, fit: u.fit * scale, policy: u.policy, emptyNights: u.emptyNights, throughput: u.throughput * scale,
        annual10: u.total10 != null ? u.total10 * scale : null, fit10: u.fit10 != null ? u.fit10 * scale : null };
    }
    rows.sort((a, b) => (a.up?.annual ?? Infinity) - (b.up?.annual ?? Infinity));
  }
  const cur = $('current').value;
  const current = rows.find(r => `${r.plan.brand} — ${r.plan.name}` === cur);
  const baseline = current ? current.annual : Math.min(...rows.map(r => r.annual));
  rows.forEach(r => {
    r.isCurrent = r === current;
    const mine = r.up ? r.up.annual : r.annual;
    r.delta = current ? mine - current.annual : null;
    r.payback = upgrade && upgrade.price && r.up && baseline - r.up.annual > 0 ? upgrade.price / (baseline - r.up.annual) : null;
  });
  const fitDecline = +$('fitdecline').value;
  const baseRow = current || [...rows].sort((a, b) => a.annual - b.annual)[0];
  const baseFlows = { charges: baseRow.annual + baseRow.bill.fit * scale, credits: baseRow.bill.fit * scale };
  const flows = r => {
    if (!r.up) return { charges: r.annual + r.bill.fit * scale, credits: r.bill.fit * scale };
    const t1 = r.up.annual, f1 = r.up.fit;
    const t10 = r.up.annual10 ?? t1, f10 = r.up.fit10 ?? f1;     // capacity fade: interpolate new -> year 10
    const tot = Array.from({ length: 10 }, (_, y) => t1 + (t10 - t1) * y / 9);
    const fit = Array.from({ length: 10 }, (_, y) => f1 + (f10 - f1) * y / 9);
    return { charges: tot.map((t, y) => t + fit[y]), credits: fit };
  };
  rows.project = r => {
    if (r.ten) return r.ten;
    r.ten = tenYear(flows(r), history, { fitDecline });
    if (upgrade && upgrade.price && r.up) r.saving = tenYearSaving(baseFlows, flows(r), upgrade.price, history, { fitDecline });
    return r.ten;
  };
  rows.slice(0, TOP).forEach(rows.project);
  if (current) rows.project(current);
  document.querySelectorAll('.up').forEach(el => { el.hidden = !upgrade; });
  $('results-note').textContent = `${rows.length} distinct plans priced`
    + (upgrade ? `, ranked with ${upgrade.label}` : '')
    + (current ? `; compared with ${current.plan.brand} ${current.plan.name}${upgrade ? ' as it is today' : ''}` : '')
    + (upgrade && !upgrade.price ? '. Enter the quoted price to see payback' : '') + '. Click a plan for details.';
  render();
  drawTenYear(current);
}

function runUpgrade() {
  if (!usage) return;
  const bat = selectedSystem();
  const kw = solar ? +$('pv-kw').value : 0;
  if (!bat && !kw) { $('progress').textContent = 'Choose extra panels and/or a battery first.'; return; }
  const lim = +$('exp-lim').value;
  let u = usage;
  if (kw > 0) u = withSolar(usage, solarSeries(solar, $('pv-dir').value, kw, usage), lim);
  const be = $('bat-exp').value;
  const opt = { ...pricingOpts(), exportLimitKw: lim, allowExport: be !== 'none', dailyExportKwh: be === '10' ? 10 : null };
  const plans = filteredPlans();
  const label = [kw ? `${kw} kW extra solar (${$('pv-dir').value})` : '', bat ? bat.label : ''].filter(Boolean).join(' + ');
  $('run-upgrade').disabled = true;
  const worker = new Worker('worker.js', { type: 'module' });
  worker.onmessage = ({ data: m }) => {
    if (m.progress != null) { $('progress').textContent = `Simulating… ${Math.round(m.progress * 100)}%`; return; }
    worker.terminate();
    $('run-upgrade').disabled = false;
    $('progress').textContent = '';
    $('clear-upgrade').hidden = false;
    upgrade = { label, bat, price: +$('price').value || 0, byId: new Map(m.done.map(x => [x.id, x])) };
    run();
  };
  worker.onerror = e => { $('progress').textContent = `Simulation failed: ${e.message}`; $('run-upgrade').disabled = false; };
  worker.postMessage({ plans, usage: u, bat: bat && { usable: bat.usable, charge_kw: bat.charge_kw, discharge_kw: bat.discharge_kw, rte: bat.rte }, opt, fade: FADE });
}

// ---------------------------------------------------------------- output
function render() {
  const list = showAll ? rows.slice() : rows.slice(0, TOP);
  const cur = rows.find(r => r.isCurrent);
  if (cur && !list.includes(cur)) list.push(cur);
  $('results').querySelector('tbody').innerHTML = list.map(r => {
    const i = rows.indexOf(r);
    const ten = r.ten ? `${money(r.ten.p10)} – ${money(r.ten.p90)}` : '<span class="hint">click</span>';
    const delta = r.delta == null || (r.isCurrent && !upgrade) ? '' :
      `<span class="${r.delta < 0 ? 'save' : 'cost'}">${r.delta < 0 ? 'save ' : '+'}${money(Math.abs(r.delta))}</span>`;
    const pills = [...(usage.estimated && r.plan.demand.length ? ['less reliable from bills (demand charge)'] : []), ...r.plan.flags, ...r.bill.flags].slice(0, 3).map(f => `<span class="pill">${esc(f)}</span>`).join('');
    const up = upgrade ? `<td class="num"><b>${r.up ? money(r.up.annual) : '–'}</b>${r.up ? `<div class="hint">${esc(r.up.policy)}</div>` : ''}</td>
      <td class="num">${r.payback ? r.payback.toFixed(1) + ' yrs' : '–'}</td>
      <td class="num">${r.saving ? `<b class="${r.saving.p50 >= 0 ? 'save' : 'cost'}">${money(r.saving.p50)}</b><div class="hint">${money(r.saving.p10)} to ${money(r.saving.p90)}</div>` : '–'}</td>` : '';
    return `<tr data-i="${i}" class="${r.isCurrent ? 'current' : ''}">
      <td>${i + 1}</td>
      <td><div class="plan-name">${esc(r.plan.name)}${r.variants > 1 ? ` <span class="hint">(${r.variants} variants)</span>` : ''}</div>
        <div class="brand">${esc(r.plan.brand)}${r.isCurrent ? ' · your current plan' : ''}</div></td>
      <td class="num">${money(r.annual)}</td>${up}<td class="num m-hide">${delta}</td><td class="num">${ten}</td><td class="m-hide">${pills}</td></tr>`;
  }).join('');
  $('more').textContent = showAll ? `Show top ${TOP}` : `Show all ${rows.length} plans`;
  $('results').querySelectorAll('tbody tr').forEach(tr => tr.addEventListener('click', () => detail(rows[+tr.dataset.i])));
}

function drawTenYear(current) {
  const picks = rows.slice(0, 3);
  if (current && !picks.includes(current)) picks.push(current);
  const colors = ['#137a3f', '#1f6feb', '#7a4ec2', '#d1495b'];
  const labels = Array.from({ length: 10 }, (_, i) => `Year ${i + 1}`);
  const datasets = [];
  picks.forEach((r, k) => {
    rows.project(r);
    const c = colors[k];
    const name = `${r.plan.brand} – ${r.plan.name}${r.isCurrent ? ' (current)' : ''}`;
    datasets.push({ label: `${name} (likely range)`, data: r.ten.bands.map(b => b.p90), borderColor: 'transparent',
      backgroundColor: c + '22', pointRadius: 0, fill: '+1' });
    datasets.push({ label: '_low', data: r.ten.bands.map(b => b.p10), borderColor: 'transparent', pointRadius: 0, fill: false });
    datasets.push({ label: name, data: r.ten.bands.map(b => b.p50), borderColor: c, borderWidth: 2, pointRadius: 0, fill: false });
  });
  charts.ten?.destroy();
  charts.ten = new Chart($('tenyear'), {
    type: 'line', data: { labels, datasets },
    options: { animation: false, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: {
        title: { display: true, text: `Yearly bill${upgrade ? ' with ' + upgrade.label : ''}: line = typical, shading = likely range (10th–90th percentile)` },
        legend: { labels: { filter: i => !i.text.startsWith('_') && !i.text.endsWith('(likely range)') } },
        tooltip: { filter: i => !i.dataset.label.startsWith('_') && !i.dataset.label.endsWith('(likely range)'),
          callbacks: { label: i => `${i.dataset.label}: ${money(i.parsed.y)}` } },
      },
      scales: { y: { ticks: { callback: v => money(v) } } } },
  });
}

function detail(r) {
  rows.project(r);
  render();
  const p = r.plan, b = r.bill, scale = 365 / usage.days;
  const hh = v => { const h = Math.floor(v), m = Math.round((v - h) * 60); return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`; };
  const rulesText = (rules, unit) => rules.slice(0, -1).map(x => `${hh(x.s)}–${hh(x.e)}${x.d ? ' (some days)' : ''}: ${(x.r * 100).toFixed(2)}c${
    x.cap != null ? ` for first ${x.cap.toFixed(1)} kWh/day, then ${(x.after * 100).toFixed(2)}c` : ''}`).join('<br>') || unit;
  const line = (k, v) => `<tr><td>${k}</td><td class="num">${money(v * scale)}</td></tr>`;
  const up = r.up ? `<tr><td><b>With ${esc(upgrade.label)}</b> (${esc(r.up.policy)})</td><td class="num"><b>${money(r.up.annual)}</b></td></tr>
      ${r.up.throughput ? `<tr><td>Battery throughput / nights run empty</td><td class="num">${Math.round(r.up.throughput).toLocaleString()} kWh/yr · ${r.up.emptyNights}</td></tr>` : ''}
      ${r.payback ? `<tr><td>Simple payback on ${money(upgrade.price)}</td><td class="num">${r.payback.toFixed(1)} years</td></tr>` : ''}
      ${r.saving ? `<tr><td>10-year saving after the price, vs ${esc(baseRow().plan.brand)} ${esc(baseRow().plan.name)} without the upgrade (typical / likely range)</td>
        <td class="num">${money(r.saving.p50)} (${money(r.saving.p10)} to ${money(r.saving.p90)})</td></tr>` : ''}
      ${warrantyLine(r)}` : '';
  $('detail').innerHTML = `
    <h3>${esc(p.brand)} — ${esc(p.name)}</h3>
    <p class="hint">Effective ${esc(p.eff)} · <a href="${esc(p.url)}" target="_blank" rel="noopener">published plan data</a></p>
    <table><tbody>
      ${line('Supply charges', b.supply)}${line('Usage', b.usage)}${line('Controlled load', b.cl)}
      ${b.demand ? line('Demand charges', b.demand) : ''}${b.fee ? line('Fees', b.fee) : ''}
      ${line('Feed-in credit', -b.fit)}
      <tr><td><b>Year 1 as you are today</b></td><td class="num"><b>${money(r.annual)}</b></td></tr>
      ${up}
      <tr><td>10 years (typical / likely range)</td><td class="num">${money(r.ten.p50)} (${money(r.ten.p10)} – ${money(r.ten.p90)})</td></tr>
    </tbody></table>
    <p><b>Supply:</b> ${(p.supply * 100).toFixed(2)}c/day<br><b>Usage rates:</b><br>${rulesText(p.imp, 'n/a')}</p>
    <p><b>Feed-in:</b><br>${rulesText(p.fit, 'none')}</p>
    ${p.cond.length ? `<p><b>Conditional discounts (not included):</b><br>${p.cond.map(esc).join('<br>')}</p>` : ''}
    ${p.inc.length ? `<p><b>Incentives:</b><br>${p.inc.map(esc).join('<br>')}</p>` : ''}
    ${p.elig.length ? `<p><b>Eligibility:</b><br>${p.elig.map(esc).join('<br>')}</p>` : ''}`;
  $('detail').hidden = false;
  $('detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function baseRow() {
  return rows.find(r => r.isCurrent) || [...rows].sort((a, b) => a.annual - b.annual)[0];
}

function warrantyLine(r) {
  const b = upgrade && upgrade.bat;
  const w = b && b.sys && b.sys.warranty;
  if (!w || !w.throughput_mwh_per_kwh || !r.up || !r.up.throughput) return '';
  const limitMwh = w.throughput_mwh_per_kwh * b.usable;
  const yrs = limitMwh * 1000 / r.up.throughput;
  return `<tr><td>Warranty energy limit (${limitMwh.toFixed(0)} MWh) reached after</td><td class="num">${yrs.toFixed(0)} years at this use (warranty term ${w.years} years)</td></tr>`;
}

function applyCalibration() {
  if (!usage) return;
  const kw = +$('ex-kw').value;
  usage.curt = usage.curtOrig;
  calib = null;
  if (!gen) return;
  if (!solar || !kw) { $('gen-note').textContent = 'Enter your postcode and existing panel size to use the generation file.'; return; }
  calib = calibrate(usage, gen, solar, $('ex-dir').value, kw, +$('exp-lim').value || 5);
  if (!calib.factor) { $('gen-note').textContent = 'The generation file has no readings on the same days as your usage data.'; return; }
  usage.curt = calib.curt;
  upgrade = null;
  $('gen-note').textContent = `Matched ${calib.matchedDays} days. Your panels produce ${Math.round(calib.factor * 100)}% of the standard model for ${kw} kW facing ${$('ex-dir').value}`
    + ` (shading, age, dirt and orientation all affect this). About ${Math.round(calib.curtKwh * 365 / usage.days).toLocaleString()} kWh a year of solar is being thrown away at your export limit; a battery can store it.`;
  run();
}

init();
