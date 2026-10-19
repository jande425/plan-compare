"""Write site/data/sample-usage.csv: a SYNTHETIC South East Queensland household (not real data).

6.6 kW rooftop solar, ~17 kWh/day household use with evening peak, air-con in summer,
electric hot water on controlled load (~4.5 kWh/day). One year, 30-minute intervals.
"""
import math
import random
from datetime import datetime, timedelta
from pathlib import Path

random.seed(2026)
start = datetime(2025, 10, 1)
rows = ['start,import_kwh,export_kwh,controlled_kwh']
for day in range(365):
    d = start + timedelta(days=day)
    doy = d.timetuple().tm_yday
    season = math.cos(2 * math.pi * (doy - 355) / 365)        # +1 midsummer, -1 midwinter
    cloud = random.choice([1, 1, 1, 0.85, 0.6, 0.3])
    daylen = 12.2 + 1.4 * season
    sunrise = 12 - daylen / 2 - 0.4
    weekend = d.weekday() >= 5
    for slot in range(48):
        h = slot / 2 + 0.25
        x = (h - sunrise) / daylen
        pv = 6.6 * 0.78 * (0.82 + 0.18 * season) * cloud * math.sin(math.pi * x) ** 1.4 if 0 < x < 1 else 0.0
        base = 0.35 + (0.25 if weekend and 9 <= h <= 17 else 0)
        evening = 1.3 * math.exp(-((h - 19) / 2.2) ** 2)
        morning = 0.6 * math.exp(-((h - 7) / 1.2) ** 2)
        aircon = max(season, 0) * 1.6 * math.exp(-((h - 17) / 3.5) ** 2) + max(-season, 0) * 0.5 * math.exp(-((h - 20) / 2) ** 2)
        load = (base + evening + morning + aircon) * random.uniform(0.85, 1.15)
        net = (load - pv) * 0.5
        imp, exp = max(net, 0), min(max(-net, 0), 2.5)
        cl = 0.75 if 10 <= h < 13 else 0.0                        # hot water heats late morning
        rows.append(f"{d + timedelta(minutes=30 * slot):%Y-%m-%dT%H:%M},{imp:.3f},{exp:.3f},{cl * 0.5 * random.uniform(0.9, 1.1):.3f}")
dest = Path(__file__).resolve().parents[1] / 'site/data/sample-usage.csv'
dest.write_text('\n'.join(rows) + '\n', encoding='utf-8')
print(f'wrote {dest}')
