"""Map every postcode the plans cover to suburb names and a solar cell (0.25 deg grid).

Usage:  python tools/build_postcodes.py [--fetch-solar]
Inputs: site/data/plans.json (postcode union), tools/cache/au_postcodes.csv from
        https://github.com/matthewproctor/australianpostcodes (Matthew Proctor, CC BY 4.0).
Writes: site/data/postcodes.json; with --fetch-solar also site/data/solar/<cell>.json via fetch_solar.py.
"""
import csv
import json
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GRID = 0.25


def cell_id(lat, lon):
    la, lo = round(lat / GRID) * GRID, round(lon / GRID) * GRID
    return f'{abs(la):.2f}S{lo:.2f}E', la, lo


def main():
    plans = json.loads((ROOT / 'site/data/plans.json').read_text(encoding='utf-8'))
    wanted = set(plans.get('postcodes') or [])
    rows = defaultdict(list)
    with open(ROOT / 'tools/cache/au_postcodes.csv', encoding='utf-8') as f:
        for r in csv.DictReader(f):
            if r['postcode'] in wanted and r['state'] == 'QLD' and r['lat'] and r['long']:
                try:
                    name = r['locality'].replace('’', "'").replace('‘', "'").title()
                    rows[r['postcode']].append((name, float(r['lat']), float(r['long'])))
                except ValueError:
                    pass
    out, cells = {}, {}
    for pc in sorted(wanted):
        loc = rows.get(pc)
        if not loc:
            continue
        # median position, ignoring localities more than 1 degree away (the source has a few mislabelled ones)
        med = lambda v: sorted(v)[len(v) // 2]
        mlat, mlon = med([x[1] for x in loc]), med([x[2] for x in loc])
        loc = [x for x in loc if abs(x[1] - mlat) <= 1 and abs(x[2] - mlon) <= 1 and '�' not in x[0]] or loc
        lat = sum(x[1] for x in loc) / len(loc)
        lon = sum(x[2] for x in loc) / len(loc)
        cid, la, lo = cell_id(lat, lon)
        cells[cid] = (la, lo)
        out[pc] = dict(suburbs=sorted({x[0] for x in loc})[:8], lat=round(lat, 4), lon=round(lon, 4), cell=cid)
    missing = sorted(wanted - set(out))
    data = dict(source='Postcode locations: Matthew Proctor, australianpostcodes (CC BY 4.0)', grid_deg=GRID,
                cells={k: dict(lat=v[0], lon=v[1]) for k, v in sorted(cells.items())}, postcodes=out, missing=missing)
    (ROOT / 'site/data/postcodes.json').write_text(json.dumps(data, separators=(',', ':')), encoding='utf-8')
    print(f'{len(out)} postcodes in {len(cells)} solar cells; missing {missing}')
    if '--fetch-solar' in sys.argv:
        for cid, (la, lo) in sorted(cells.items()):
            if (ROOT / f'site/data/solar/{cid}.json').exists():
                continue
            subprocess.run([sys.executable, str(ROOT / 'tools/fetch_solar.py'), cid, str(la), str(lo)], check=True)


if __name__ == '__main__':
    main()
