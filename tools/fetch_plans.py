"""Download current residential electricity plans for a postcode from the AER's Consumer Data Right
plan data (hosted by Energy Made Easy). Public data only; no authentication.

Usage:  python tools/fetch_plans.py <postcode|all> [--distributor Energex]
        "all" keeps every residential plan for the distributor (with each plan's postcode list).
Writes: tools/cache/plan_lists/<retailer>.json and tools/cache/details/<planId>.json
Then:   python tools/build_plans.py tools/cache/details --current tools/cache/plan_lists --label "South East Queensland (Energex)"

Notes from building the household model:
- Several big retailers' own CDR endpoints return 404, so every retailer is fetched through
  https://cdr.energymadeeasy.gov.au/<slug>/ instead. tools/retailers.json lists the slugs.
- A refresh that silently falls back to cached lists looks like "nothing changed" - the log
  below reports any retailer that failed so stale data is visible.
"""
import json
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / 'cache'
BASE = 'https://cdr.energymadeeasy.gov.au'


def get(url, v):
    req = urllib.request.Request(url, headers={'x-v': v, 'x-min-v': '1', 'Accept': 'application/json'})
    for attempt in range(3):
        try:
            return json.load(urllib.request.urlopen(req, timeout=90))
        except Exception:  # noqa: BLE001 - retry, then let the caller record it
            if attempt == 2:
                raise
            time.sleep(2 * (attempt + 1))


def covers(p, postcode, distributor):
    g = p.get('geography') or {}
    if postcode == 'all':
        return distributor in (g.get('distributors') or [])
    pcs = g.get('includedPostcodes') or []
    if postcode in (g.get('excludedPostcodes') or []):
        return False
    if pcs:
        return postcode in pcs
    return not distributor or distributor in (g.get('distributors') or [])


def plan_list(slug):
    url = f'{BASE}/{slug}/cds-au/v1/energy/plans?fuelType=ELECTRICITY&type=MARKET&effective=CURRENT&page-size=1000'
    plans = []
    while url:
        d = get(url, '1')
        plans += d['data']['plans']
        nxt = d.get('links', {}).get('next')
        url = nxt if nxt and nxt != url else None
    return plans


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    postcode = sys.argv[1]
    distributor = sys.argv[sys.argv.index('--distributor') + 1] if '--distributor' in sys.argv else 'Energex'
    slugs = json.loads((ROOT / 'retailers.json').read_text(encoding='utf-8'))['slugs']
    (CACHE / 'plan_lists').mkdir(parents=True, exist_ok=True)
    (CACHE / 'details').mkdir(parents=True, exist_ok=True)

    def fetch_list(slug):
        try:
            plans = plan_list(slug)
        except Exception as e:  # noqa: BLE001
            return slug, None, str(e)[:120]
        mine = [p for p in plans if p.get('customerType') == 'RESIDENTIAL' and covers(p, postcode, distributor)]
        (CACHE / 'plan_lists' / f'{slug}.json').write_text(json.dumps(mine), encoding='utf-8')
        return slug, mine, None

    results = list(ThreadPoolExecutor(6).map(fetch_list, slugs))
    failed = [(s, e) for s, m, e in results if e]
    wanted = [(s, p['planId']) for s, m, e in results if m for p in m]
    print(f'{len(wanted)} plans for {postcode} from {len(slugs) - len(failed)} retailers; failed: {failed}')

    def fetch_detail(item):
        slug, pid = item
        path = CACHE / 'details' / (pid.replace('@', '_') + '.json')
        if path.exists():
            return None
        try:
            path.write_text(json.dumps(get(f'{BASE}/{slug}/cds-au/v1/energy/plans/{pid}', '3')), encoding='utf-8')
        except Exception as e:  # noqa: BLE001
            return pid, str(e)[:120]
        return None

    errs = [x for x in ThreadPoolExecutor(6).map(fetch_detail, wanted) if x]
    log = dict(postcode=postcode, distributor=distributor, fetched=time.strftime('%Y-%m-%d %H:%M'),
               plans=len(wanted), retailer_failures=failed, detail_failures=errs)
    (CACHE / 'fetch-log.json').write_text(json.dumps(log, indent=1), encoding='utf-8')
    print(f'details: {len(wanted) - len(errs)} ok, {len(errs)} failed. Log: {CACHE / "fetch-log.json"}')


if __name__ == '__main__':
    main()
