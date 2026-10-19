"""Pre-compute hourly solar output per kW of panels for a postcode (public weather data only).

Usage:  python tools/fetch_solar.py <name> <lat> <lon> [--start 2025-10-01 --end 2026-09-30]
Writes: site/data/solar/<postcode>.json

Source: Open-Meteo historical weather API (ERA5-based reanalysis): hourly global tilted irradiance
and air temperature at the postcode's centre point. Output model per kWp:
  kWh = GTI/1000 x (1 - 0.0035 x (Tcell - 25)) x PR,  Tcell = Tair + GTI x 0.03125,  PR = 0.80
PR (performance ratio) covers inverter, wiring, soiling and mismatch losses for a new system.
Open-Meteo azimuth convention: 0 = south, -90 = east, 90 = west, 180 = north.
Each hourly value is the mean over the preceding hour.
"""
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ORIENTATIONS = {           # name: (tilt, open-meteo azimuth)
    'north': (20, 180), 'north-east': (20, -135), 'east': (20, -90),
    'west': (20, 90), 'north-west': (20, 135), 'flat': (5, 180),
}
PR = 0.80


def fetch(lat, lon, start, end, tilt, az):
    q = urllib.parse.urlencode(dict(latitude=lat, longitude=lon, start_date=start, end_date=end, tilt=tilt, azimuth=az,
                                    hourly='global_tilted_irradiance,temperature_2m', timezone='Australia/Brisbane'))
    return json.load(urllib.request.urlopen(f'https://archive-api.open-meteo.com/v1/archive?{q}', timeout=120))['hourly']


def main():
    args = sys.argv[1:]
    if len(args) < 3:
        sys.exit(__doc__)
    postcode, lat, lon = args[0], float(args[1]), float(args[2])
    start = args[args.index('--start') + 1] if '--start' in args else '2025-10-01'
    end = args[args.index('--end') + 1] if '--end' in args else '2026-09-30'
    out = dict(postcode=postcode, lat=lat, lon=lon, start=start, end=end, pr=PR,
               source='Open-Meteo historical weather API (ERA5 reanalysis), hourly, preceding-hour means',
               unit='kWh per kWp per hour', orientations={})
    for name, (tilt, az) in ORIENTATIONS.items():
        h = fetch(lat, lon, start, end, tilt, az)
        vals = []
        for g, t in zip(h['global_tilted_irradiance'], h['temperature_2m']):
            g, t = g or 0.0, t if t is not None else 25.0
            tc = t + g * 0.03125
            vals.append(round(max(g / 1000 * (1 - 0.0035 * (tc - 25)) * PR, 0), 4))
        out['orientations'][name] = dict(tilt=tilt, azimuth_openmeteo=az, annual_kwh_per_kwp=round(sum(vals)), hourly=vals)
        if name == 'north':
            out['times_first'], out['hours'] = h['time'][0], len(h['time'])
        print(f'{name:11s} tilt {tilt:2d}: {sum(vals):6.0f} kWh/kWp/yr')
    dest = Path(__file__).resolve().parents[1] / f'site/data/solar/{postcode}.json'
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(out, separators=(',', ':')), encoding='utf-8')
    print(f'wrote {dest} ({dest.stat().st_size / 1e3:.0f} kB)')


if __name__ == '__main__':
    main()
