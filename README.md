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

## Live prices (optional)

By default the dashboard uses the `last_price` you type into `data/holdings.csv`
(the header shows `○ manual prices`). Turn on live marking and `build.py` will
refresh prices at build time via `pricefetch.py` (stdlib `urllib`, no deps):

```sh
REFRESH_PRICES=1 python3 build.py            # crypto + perp + FX (all keyless)
ALPHAVANTAGE_API_KEY=xxxx REFRESH_PRICES=1 python3 build.py   # + equities/ETFs
```

| Asset type | Source | Key |
|---|---|---|
| Spot crypto (BTC, ETH, jitoSOL, HYPE, SYRUP) | CoinGecko | none |
| FX (AUDUSD) | Frankfurter (ECB) | none |
| Equities / ETFs | Alpha Vantage `GLOBAL_QUOTE` | `ALPHAVANTAGE_API_KEY` |

Rules: a failed or missing fetch **falls back to the CSV `last_price`** — never
invented. The header badge flips to `● N live` and lists the sources used.

**Security:** the Alpha Vantage key is read from the environment only. Never put
it in `data/`, `site/`, or any committed file — `data.json` and `app.js` are
publicly downloadable.

### Alpha Vantage free-tier limit

Free tier = **25 calls/day, 5/min**. We have ~11 US equity symbols, so a full
equity refresh is ~11 calls — budget for **~2 builds/day**. To run a frequent
schedule (crypto/FX hourly) while only hitting Alpha Vantage once a day, pin the
equity fetch to a single UTC hour:

```sh
EQUITY_REFRESH_HOUR_UTC=21   # only fetch equities when the build runs at 21:00 UTC
```

ASX tickers (`IVV`, `CRED`, in AUD) are queried as `IVV.AX` etc.; Alpha Vantage's
free ASX coverage is patchy, so those may stay on the manual `last_price`.

### On Netlify (auto-refresh)

1. **Site settings → Environment variables:** add `REFRESH_PRICES=1`,
   `ALPHAVANTAGE_API_KEY=…`, and optionally `EQUITY_REFRESH_HOUR_UTC=21`.
   (Build-only — never exposed to the browser.)
2. **Build hook:** Site settings → Build & deploy → *Build hooks* → create one,
   copy the URL.
3. **Schedule it:** point a cron at that hook — either a Netlify Scheduled
   Function that `POST`s the hook, or a GitHub Actions `schedule:` workflow doing
   `curl -X POST <hook-url>`. Each trigger rebuilds with fresh prices.

## NAV per unit (performance chart)

The Performance section charts **NAV per unit** — each sleeve, the Total Fund, and
the MSCI ACWI (AUD) benchmark, all indexed to **$1.00** like a fund manager's
unit price. The data lives in `data/nav.csv` (long format) and is built in two
halves — the **"both"** model:

1. **Reconstructed history** (`navbuild.py`) — an immediate chart. A buy-and-hold
   of *today's* holdings, valued at real historical monthly prices in AUD and
   chain-linked from $1.00. Honest but back-cast: the endpoint is a window return,
   not the since-cost mark. Tactical is excluded from the lines (a buy-and-hold of
   a 10–15× perp isn't a real path); its real mark shows as a chip + in Exposure.

   ```sh
   REFRESH_PRICES=1 python3 navbuild.py        # writes data/nav.csv (caches to navcache.json)
   python3 build.py                            # picks it up into site/data/data.json
   ```

2. **Monthly strikes** (going forward) — the genuine track record. Each month-end,
   append one real marked `struck` row per series to `data/nav.csv`; units are
   issued/redeemed at the prevailing NAV so contributions don't move the unit
   price (time-weighted). Over time the struck path supersedes the reconstruction.

The **marked NAV/unit** chips above the chart are the real since-cost mark per
sleeve, computed live from `holdings.csv`. See [`schema/README.md`](schema/README.md)
for the `nav.csv` column contract and the strike procedure.

## Preview locally

```sh
python3 serve.py            # serves site/ at http://localhost:8753
```

Then open `http://localhost:8753/` (landing) or `/dashboard.html` (internal dashboard).
The dashboard fetches `data/data.json`, so it must be served over HTTP, not opened as a file.

## Adding data

- **Update holdings:** edit `data/holdings.csv`, then re-run `python3 build.py`.
- **Add a report:** _coming in Phase 4_ — write `reports/<period>.json`, re-run `build.py`.

See [`schema/README.md`](schema/README.md) for the full data contract (columns, enums, rules).
