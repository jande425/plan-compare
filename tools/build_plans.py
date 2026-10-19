"""Convert AER Consumer Data Right (CDR) plan details into the compact site/data/plans.json.

Usage:  python tools/build_plans.py <details_dir> [--current <plan_lists_dir>] [--today YYYY-MM-DD] [--label "..."]

--current limits the output to plan IDs in today's plan lists (so withdrawn plans that are still
cached in <details_dir> are dropped).

<details_dir> holds one JSON file per plan, as returned by
  https://cdr.energymadeeasy.gov.au/<retailer>/cds-au/v1/energy/plans/<planId>
(see tools/fetch_plans.py). Public data only.

Pricing conventions (ported from the household model that reconciles to real bills):
- CDR usage, supply and controlled-load prices are ex GST -> x1.1. Household feed-ins carry no GST.
- Time-of-use rules: the first matching rule wins. Gaps are priced at the plan's highest usage rate.
- Two-tier blocks collapse to a daily cap (first-tier kWh/day) and an after-cap rate.
- Guaranteed discounts are applied. Conditional discounts (pay on time etc.) are listed, not applied.
- Government premium feed-in schemes (44c Solar Bonus) are excluded; new customers can't get them.
"""
import json
import re
import sys
from pathlib import Path

ALLM, ALLD = list(range(1, 13)), list(range(7))
DAYMAP = {'MON': [0], 'TUE': [1], 'WED': [2], 'THU': [3], 'FRI': [4], 'SAT': [5], 'SUN': [6],
          'BUSINESS_DAYS': [0, 1, 2, 3, 4], 'WEEKDAYS': [0, 1, 2, 3, 4], 'WEEKENDS': [5, 6], 'PUBLIC_HOLIDAYS': []}
RECURRING = {'MEMBERSHIP', 'ACCOUNT_FEE', 'OTHER', 'METERING'}
TERM_MULT = {'ANNUAL': 1, 'MONTHLY': 12, 'DAILY': 365, 'WEEKLY': 52, 'QUARTERLY': 4}
CL31 = re.compile(r'tariff ?31|load ?1\b|cl ?1\b|super economy')
CL33 = re.compile(r'tariff ?33|load ?2|cl ?2|economy')
RESTRICTED = re.compile(r'senior|concession|pension|health ?care card|\bmembers?\b|membership|'
                        r'existing customers? only|current customers? only|employee|\bstaff\b|\bclub\b|\bunion\b|'
                        r'\bstudents?\b|community energy|ev owners?|electric vehicle owner', re.I)


def hours(s, end=False):
    h, m = map(int, s[:5].split(':'))
    v = h + m / 60
    if end and m % 30 == 29:          # inclusive xx:29 / xx:59 endings
        v += 1 / 60
    return 24.0 if end and v == 0 else v


def days(spec):
    out = []
    for d in spec:
        if d not in DAYMAP:
            raise ValueError(f'day {d}')
        out += DAYMAP[d]
    return sorted(set(out))


def tiers(rates, period, gst):
    """First-tier rate, daily cap and second-tier rate (multi-tier collapsed to two)."""
    r0 = float(rates[0]['unitPrice']) * gst
    if len(rates) < 2 or rates[0].get('volume') in (None, '') or float(rates[0]['unitPrice']) == float(rates[1]['unitPrice']):
        return r0, None, None, False
    vol = float(rates[0]['volume'])
    per = (period or 'P1D').upper()
    cap = vol if per == 'P1D' else vol / 30.4 if per == 'P1M' else vol / 91.3 if per == 'P3M' else vol / 365 if per == 'P1Y' else vol
    return r0, cap, float(rates[1]['unitPrice']) * gst, per != 'P1D'


def rule(s, e, r, d=ALLD, m=ALLM, cap=None, after=None):
    out = dict(s=round(s, 4), e=round(e, 4), r=round(r, 6))
    if d != ALLD:
        out['d'] = d
    if m != ALLM:
        out['m'] = m
    if cap is not None and after is not None:
        out['cap'], out['after'] = round(cap, 4), round(after, 6)
    return out


def window_rules(r, cap, after, variations):
    out = []
    for v in variations:
        s, e = hours(v['startTime']), hours(v['endTime'], True)
        dd = days(v.get('days', list(DAYMAP)[:7]))
        for a, b in ([(s, e)] if e > s else [(s, 24.0), (0.0, e)]):
            if b > a:
                out.append(rule(a, b, r, dd, ALLM, cap, after))
    return out


def controlled(cls, which):
    """Rate and supply (incl GST) for Tariff 31 or Tariff 33, or None."""
    blob = lambda q: json.dumps(q).lower()
    if which == 'cl33':
        pick = [q for q in cls if CL33.search(blob(q)) and not CL31.search(blob(q))]
    else:
        pick = [q for q in cls if CL31.search(blob(q))]
    generic = False
    if not pick and len(cls) == 1 and not (CL31.search(blob(cls[0])) or CL33.search(blob(cls[0]))):
        pick, generic = cls, True
    if not pick:
        return None
    q = pick[0]
    block = q.get('singleRate') or (q.get('timeOfUseRates') or [{}])[0]
    rates = block.get('rates') or []
    if not rates:
        return None
    out = dict(r=round(float(rates[0]['unitPrice']) * 1.1, 6),
               s=round(float(block.get('dailySupplyCharge') or q.get('dailySupplyCharge') or 0) * 1.1, 6))
    if generic:
        out['generic'] = True
    return out


def normalise(d, today):
    c = d['electricityContract']
    flags, cond = [], []
    periods = c['tariffPeriod']
    if len(periods) != 1:
        raise ValueError('multiple tariff periods')
    p = periods[0]
    supply = p.get('dailySupplyCharge')
    if supply is None and isinstance(p.get('dailySupplyCharges'), list) and p['dailySupplyCharges']:
        supply = p['dailySupplyCharges'][0].get('amount')
        if len(p['dailySupplyCharges']) > 1:
            flags.append('banded supply charge: first band used')
    if supply is None:
        raise ValueError('no supply charge')

    usage = []
    if p['rateBlockUType'] == 'singleRate':
        r, cap, after, approx = tiers(p['singleRate']['rates'], p['singleRate'].get('period'), 1.1)
        usage.append(rule(0, 24, r, cap=cap, after=after))
        flags += ['usage block approximated daily'] if approx else []
    elif p['rateBlockUType'] == 'timeOfUseRates':
        for t in p['timeOfUseRates']:
            r, cap, after, approx = tiers(t['rates'], t.get('period'), 1.1)
            usage += window_rules(r, cap, after, t['timeOfUse'])
            flags += ['usage block approximated daily'] if approx else []
    else:
        raise ValueError(p['rateBlockUType'])
    usage.append(rule(0, 24, max(x['r'] for x in usage)))

    fits = [f for f in c.get('solarFeedInTariff', []) if f.get('payerType') == 'RETAILER' and f.get('scheme') != 'PREMIUM']
    fit, stale = [], False
    singles = [f for f in fits if f['tariffUType'] == 'singleTariff']
    for i, f in enumerate(singles):
        stale |= f.get('endDate', '9999') < today
        rates = f['singleTariff']['rates']
        if i and singles[i - 1]['singleTariff']['rates'][0].get('volume'):
            continue
        r, cap, after, approx = tiers(rates, f['singleTariff'].get('period'), 1.0)
        if cap is None and rates[0].get('volume') and i + 1 < len(singles):
            vol, per = float(rates[0]['volume']), f['singleTariff'].get('period', 'P1D')
            cap = vol if per == 'P1D' else vol / 30.4 if per == 'P1M' else vol / 365
            after = float(singles[i + 1]['singleTariff']['rates'][0]['unitPrice'])
            approx = per != 'P1D'
        fit.append(rule(0, 24, r, cap=cap, after=after))
        flags += ['feed-in cap approximated daily'] if approx else []
    tv, used = [], set()
    blocks = [(i, t) for i, f in enumerate(fits) if f['tariffUType'] == 'timeVaryingTariffs' for t in f['timeVaryingTariffs']]
    for k, (i, t) in enumerate(blocks):
        if k in used:
            continue
        stale |= fits[i].get('endDate', '9999') < today
        r, cap, after, approx = tiers(t['rates'], t.get('period'), 1.0)
        if cap is None and len(t['rates']) == 1 and t['rates'][0].get('volume'):
            twin = next((j for j in range(k + 1, len(blocks)) if j not in used
                         and blocks[j][1].get('timeVariations') == t.get('timeVariations')), None)
            if twin is not None:
                used.add(twin)
                cap, after = float(t['rates'][0]['volume']), float(blocks[twin][1]['rates'][0]['unitPrice'])
                flags.append('feed-in first-tier volume treated as daily')
        tv += window_rules(r, cap, after, t.get('timeVariations', []))
        flags += ['feed-in cap approximated daily'] if approx else []
    fit = tv + fit + [rule(0, 24, 0.0)]
    if stale:
        flags.append('a feed-in component has an end date in the past')

    fee = 0.0
    for f in c.get('fees', []) or []:
        if f.get('type') in RECURRING and f.get('term') in TERM_MULT and f.get('amount'):
            fee += float(f['amount']) * TERM_MULT[f['term']]
    factor = 1.0
    for disc in c.get('discounts', []) or []:
        rate = (disc.get('percentOfBill') or disc.get('percentOfUse') or {}).get('rate')
        if disc.get('type') == 'GUARANTEED' and rate:
            factor *= 1 - float(rate)
            flags.append(f"guaranteed {float(rate):.0%} discount applied")
        else:
            cond.append(f"{disc.get('displayName', '')}: {disc.get('description', '')}".strip(': ')[:240])
    for x in usage:
        x['r'] = round(x['r'] * factor, 6)
        if 'after' in x:
            x['after'] = round(x['after'] * factor, 6)

    demand = []
    for dc in p.get('demandCharges') or []:
        s0, e0 = dc.get('startTime', '00:00'), dc.get('endTime', '00:00')
        if s0 == e0:
            m = re.search(r'(\d{1,2}):?(\d{2})\s*-\s*(\d{1,2}):?(\d{2})', dc.get('description', ''))
            s0, e0 = (f'{m.group(1)}:{m.group(2)}', f'{m.group(3)}:{m.group(4)}') if m else ('00:00', '00:00')
        a, b = hours(s0), hours(e0, True)
        demand.append(dict(r=round(float(dc['amount']) * 1.1 * factor, 6), s=a, e=b if b > a else 24.0,
                           d=days(dc['days']) if dc.get('days') else ALLD,
                           measure=dc.get('measurementPeriod', 'DAY'), charge=dc.get('chargePeriod', 'DAY'),
                           min=float(dc.get('minDemand') or 0)))
    if demand:
        flags.append('demand charge')

    cls = c.get('controlledLoad') or []
    cl = {k: v for k, v in (('cl31', controlled(cls, 'cl31')), ('cl33', controlled(cls, 'cl33'))) if v}
    for v in cl.values():
        v['r'] = round(v['r'] * factor, 6)
        v['s'] = round(v['s'] * factor, 6)

    text = ' '.join([d.get('description') or '', json.dumps(c.get('incentives') or []),
                     ' '.join(f.get('description', '') for f in fits), c.get('pricingModel') or '']).lower()
    wholesale = bool(re.search(r'wholesale|spot price|variable prices', text + ' ' + d.get('displayName', '').lower()))
    if wholesale:
        flags.append('wholesale / variable pricing: published rates are indicative only')

    elig_text = ' '.join([d.get('displayName', '')] + [(e.get('type') or '') + ' ' + (e.get('information') or '') + ' '
                                                     + (e.get('description') or '') for e in (c.get('eligibility') or [])])
    restricted = bool(RESTRICTED.search(elig_text))
    if restricted:
        flags.append('special eligibility (check you qualify)')

    return dict(
        id=d['planId'], brand=d['brandName'], name=d['displayName'], eff=(d.get('effectiveFrom') or '')[:10],
        url=f"https://cdr.energymadeeasy.gov.au/{d.get('brand', '').strip()}/cds-au/v1/energy/plans/{d['planId']}",
        supply=round(float(supply) * 1.1 * factor, 6), fee=round(fee, 2), disc=round(factor, 6), imp=usage, fit=fit, demand=demand, cl=cl,
        flags=sorted(set(flags)), cond=cond[:4],
        inc=[f"{i.get('displayName', '')}: {i.get('description', '')}"[:200] for i in (c.get('incentives') or [])][:4],
        elig=[(e.get('description') or e.get('information') or '')[:200] for e in (c.get('eligibility') or [])][:4],
        wholesale=wholesale, restricted=restricted, ranked=not wholesale,
        _pcs=sorted((d.get('geography') or {}).get('includedPostcodes') or []),
        _excl=sorted((d.get('geography') or {}).get('excludedPostcodes') or []))


def main():
    args = sys.argv[1:]
    if not args:
        sys.exit(__doc__)
    src = Path(args[0])
    today = args[args.index('--today') + 1] if '--today' in args else '2026-10-19'
    label = args[args.index('--label') + 1] if '--label' in args else 'South East Queensland (Energex)'
    current = None
    if '--current' in args:
        current = set()
        for f in Path(args[args.index('--current') + 1]).glob('*.json'):
            try:
                current |= {p['planId'] for p in json.loads(f.read_text(encoding='utf-8') or '[]')}
            except (ValueError, KeyError, TypeError):
                pass
    plans, fails = [], []
    for f in sorted(src.glob('*.json')):
        d = json.loads(f.read_text(encoding='utf-8'))['data']
        if current is not None and d.get('planId') not in current:
            continue
        if d.get('customerType') not in (None, 'RESIDENTIAL'):
            continue
        try:
            plans.append(normalise(d, today))
        except Exception as e:  # noqa: BLE001 - record, don't hide
            fails.append(dict(id=d.get('planId'), brand=d.get('brandName'), name=d.get('displayName'), reason=str(e)[:120]))
    union = sorted({pc for p in plans for pc in p['_pcs']})
    for p in plans:   # store only the exceptions: postcodes in the union this plan does not serve
        pcs, excl = set(p.pop('_pcs')), set(p.pop('_excl'))
        missing = sorted((set(union) - pcs if pcs else set()) | excl)
        if missing:
            p['not_pc'] = missing
    out = dict(built=today, area=label, source='AER Consumer Data Right plan data via Energy Made Easy',
               postcodes=union, count=len(plans), not_priced=fails, plans=plans)
    dest = Path(__file__).resolve().parents[1] / 'site/data/plans.json'
    dest.write_text(json.dumps(out, separators=(',', ':')), encoding='utf-8')
    print(f'{len(plans)} plans written to {dest} ({dest.stat().st_size / 1e6:.1f} MB); {len(fails)} not priced')


if __name__ == '__main__':
    main()
