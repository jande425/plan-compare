# Plan Compare (draft)

Compare every electricity plan available at an address against the household's **own half-hourly
meter data**, with a **10-year cost range** built from real price history. Usage files are read in
the browser and never uploaded.

Status: working draft covering the 201 Energex postcodes of South East Queensland (residential plans).

## Run it locally

```
python -m http.server 8765 -d site      # then open http://127.0.0.1:8765
node --test tests/engine.test.mjs tests/battery.test.mjs tests/bills.test.mjs   # 17 tests
```

Refresh plan data (public CDR data, about 10 minutes) and the postcode's solar profile:

```
python tools/fetch_plans.py all --distributor Energex
python tools/build_plans.py tools/cache/details --current tools/cache/plan_lists --label "South East Queensland (Energex)"
python tools/build_postcodes.py --fetch-solar     # postcode -> suburbs + solar cell; downloads missing cells
```

## How it works

| Part | File | What it does |
|---|---|---|
| Plan download | `tools/fetch_plans.py` | Current residential plans for a postcode from the AER Consumer Data Right data on Energy Made Easy (31 retailers). Logs any retailer that failed so stale data is visible. |
| Plan normaliser | `tools/build_plans.py` | Converts each plan into compact pricing rules (`site/data/plans.json`): GST, time-of-use windows, daily caps / tiers, feed-in tiers, Tariff 31/33 controlled load, guaranteed discounts, demand charges, fees. Flags wholesale plans and plans with special eligibility. |
| Usage parser | `site/usage.js` | NEM12 (E1 import, B1 export, other E registers = controlled load; 5/15/30-min, Wh/kWh) and simple CSV. Keeps complete days only. Never stores the NMI. |
| Tariff engine | `site/engine.js` | Prices every half-hour against each plan. **Validated against the household model that reconciles to six real bills: all 1,040 plans match within 1 cent on a full reconstructed year.** |
| 10-year range | `site/forecast.js` + `site/data/history.json` | Re-samples 10 years of SEQ retail price changes (AER DMO 2019–2027, ABS CPI electricity 2016–2019) 2,000 times; reports the 10th–90th percentile. Feed-in credits flat or falling (user choice). |
| Battery model | `site/battery.js`, `site/worker.js` | Half-hourly dispatch per plan: self-use, solar + battery export (keeps a 90th-percentile overnight reserve, 6c wear hurdle, export limit, optional daily export allowance), and cheap-rate grid charging. Best of the three is kept. **Validated: all 1,030 plans within 1 cent of the household model with a 34.8 kWh / 5 kW battery.** Runs in a Web Worker. Rebate estimate uses the May–Dec 2026 STC factors printed on quotes (matches the STC counts printed on real installer quotes). |
| Equipment library | `site/data/equipment.json` | FoxESS KH10 + CQ7, GoodWe ESA (GW9.0 / GW8.3), Sigenergy SigenStor, Sungrow SH10RS + SBH, Tesla Powerwall 3, plus custom. Every spec carries its source document and date and a confidence tag (datasheet / installer / assumed). |
| Solar | `tools/fetch_solar.py`, `site/solar.js`, `site/data/solar/<postcode>.json` | Hourly output per kW for six roof directions from Open-Meteo historical weather at the postcode centre (no address used), PR 0.80. Added panels are netted off the meter data with the household load unchanged; solar above the export limit is offered to the battery. South East Queensland: ~1,500–1,620 kWh/kW/yr north 20°, lower east/west. |
| Postcodes | `tools/build_postcodes.py`, `site/data/postcodes.json` | All 201 Energex postcodes (every plan covers the same set; per-plan exceptions are stored as `not_pc`). Suburb names and locations from Matthew Proctor's australianpostcodes dataset (CC BY 4.0). Postcodes are grouped into 0.25° solar cells (42 cells). |
| From your bills | `site/bills.js` | Builds an estimated half-hourly year from bill totals (peak / off-peak / shoulder or a single total, controlled load, solar exported): typical SEQ shape within each time band, exports follow the postcode's weather on those dates. **Tested on a real household's six bills vs its meter data: same top-10 plans, median cost error $0.90 over 181 days**; demand-charge plans are flagged as less reliable. |
| Inverter calibration | `site/calibrate.js` | Optional generation CSV from the inverter app: scales the solar model to the actual roof and estimates solar thrown away at the export limit (fed to the battery model). |
| Nightly refresh | `.github/workflows/refresh-plans.yml` | Ready for GitHub Actions: downloads plans at 03:30 Brisbane time, fails loudly on any download error, rebuilds, tests, commits. Inactive until the folder is pushed to a repo. |
| UI | `site/index.html`, `site/app.js` | Upload or sample data → usage summary → options → optional solar/battery upgrade (rebate, payback) → ranked plans, savings vs current plan, 10-year chart, plan detail. |

## Privacy

- Usage files are parsed and priced in the browser. No server, no database, no analytics.
- `site/data/sample-usage.csv` is synthetic (`tools/make_sample.py`), not a real household.
- `.gitignore` blocks `*usage*.csv` and NEM12 files so real data can't be committed by accident.

## Known limits (draft)

- Solar output uses PR 0.80 (typical new system). The Clean Energy Regulator's deemed Brisbane rating is lower (~1,330–1,380 kWh/kW/yr) and real roofs vary with shading.
- Energex (South East Queensland) only. Ergon and other states need their own plan sets and testing.
- Public holidays are priced as their weekday.
- Wholesale-price plans (Amber, Flow, GloBird WholeSave) use published indicative rates, so they're hidden by default.
- Conditional discounts (pay on time, direct debit) and one-off credits are listed, not applied.
- Less than a year of data is scaled up to a year (a warning is shown).
- The 10-year range is a spread of historical outcomes, not a forecast.

## Next steps

1. Add the CEC approved-list check by model code; replace remaining installer-sourced specs (GoodWe GW9.0 module) with datasheets.
2. Ergon (regional QLD) and other states: network tariffs, postcode sets and testing.
3. Battery degradation and replacement in the 10-year view.
4. Check the CDR / Energy Made Easy data terms before any public or commercial launch, and add plain-English disclaimers.
