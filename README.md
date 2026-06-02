# 429 Capital

A single-person mini family office. The operating research arm is **429 Research**.

This repo is the **single, centralised source of truth** for the whole operation:

1. **Data** — all holdings and trades as plain CSV (human- and agent-readable).
2. **Dashboard** — an internal site: NAV, returns, portfolio, exposure, charts.
3. **Reports** — quarterly and yearly investor write-ups, as interactive sectioned pages.

Everything lives in one repo so any AI agent (Claude Code, Codex, …) has one canonical place
for data, dashboard, and reports.

## Principles

- **Single source of truth = flat CSV** in `data/`. No database, no Notion-as-store. An agent
  reading the CSV is the query layer.
- **Static site only** — vanilla HTML/CSS/JS + Chart.js. No backend. Deploys to GitHub Pages.
- **One-way data flow:** `data/*.csv → build.py → site/data/data.json → pages render from JSON`.
- **Private repo** — live personal holdings. Never commit secrets / API keys.
- **Base currency: AUD.** USD / USDC converted via `data/fx.csv`.

## The three sleeves

A position has three independent axes: `book` (mandate), `venue` (where), `asset_class` (what).

| book         | display name | role |
|--------------|--------------|------|
| `passive`    | Wealth Base  | Index ETFs, owned outright. The benchmark — **not** in fund NAV. |
| `conviction` | Conviction   | Thesis-driven equities + spot crypto, owned outright. No leverage. |
| `tactical`   | Tactical     | Leveraged, catalyst-driven, `TAC-###` tagged. Target 2–3x. |

**Fund NAV = Conviction + Tactical.** Wealth Base + MSCI ACWI (AUD) are benchmarks.

## Repo map

```
429-capital/
├── README.md              # you are here
├── schema/README.md       # THE DATA CONTRACT — read this first
├── data/                  # source of truth (CSV)
│   ├── holdings.csv        # current position snapshot
│   ├── transactions.csv    # immutable trade log
│   ├── fx.csv              # AUD/USD rates
│   └── nav.csv             # monthly NAV-per-unit history
├── reports/               # one JSON per report period (e.g. 2026-Q2.json)
├── site/                  # deployable static site (GitHub Pages root)
│   ├── index.html          # public landing
│   ├── dashboard.html      # internal dashboard
│   ├── reports/            # report index + template
│   ├── assets/             # style.css, app.js
│   └── data/data.json      # GENERATED — do not hand-edit
└── build.py               # CSV + reports/*.json -> data.json + report pages
```

## Build

```sh
python3 build.py
```

Reads the CSVs in `data/` plus `reports/*.json`, computes derived metrics, and writes
`site/data/data.json`. Python 3 standard library only — no dependencies to install.

## Adding data

- **Update holdings:** edit `data/holdings.csv`, then re-run `python3 build.py`.
- **Add a report:** _coming in Phase 4_ — write `reports/<period>.json`, re-run `build.py`.

See [`schema/README.md`](schema/README.md) for the full data contract (columns, enums, rules).
