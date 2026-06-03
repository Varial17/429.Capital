# 429 Capital — Data Contract

This file is the **single authoritative description** of the data. Any agent (Claude Code,
Codex, etc.) editing this repo should read this file first. The flat CSVs in `../data/` are
the **single source of truth** for the whole operation — there is no database. An agent reading
the CSV *is* the query layer.

> One-way data flow: `data/*.csv → build.py → site/data/data.json → pages render from JSON`.
> Never hand-edit `site/data/data.json`. Edit the CSVs, then re-run `python3 build.py`.

---

## The three axes

A position is described by **three independent axes**. Do **not** collapse them into one label —
a single asset can be held under multiple books, at multiple venues, in multiple asset classes.

### 1. `book` — the mandate (*why* it is held)

| value        | display name | meaning |
|--------------|--------------|---------|
| `passive`    | Wealth Base  | Index ETFs, owned outright, set-and-forget. The long-term foundation. **This is the benchmark — NOT part of the fund NAV.** |
| `conviction` | Conviction   | Owned-outright, thesis-driven equities + spot crypto. No leverage, high patience. |
| `tactical`   | Tactical     | Leveraged, catalyst-driven, marked-to-market positions. `TAC-###` tagged. Target 2–3x. |

### 2. `venue` — *where* it is held

`commsec_au` · `commsec_intl` · `stake` · `ibkr` · `hyperliquid` · `phantom` · `exchange`

### 3. `asset_class` — *what* it is

`etf` · `equity` · `crypto_spot` · `crypto_perp` · `equity_perp` · `cash`

`cash` = a stablecoin / cash balance held at a venue (e.g. USDC collateral in the
Hyperliquid perp account). It carries the sleeve's value; the perp legs sitting on
top of it are cross-margined, so they add **exposure**, not a second stack of value.

---

## Fund NAV definition

**Fund NAV = Conviction + Tactical.**

- **Wealth Base (`passive`) is the benchmark**, tracked alongside but **excluded** from fund NAV.
- Secondary benchmark: **MSCI ACWI (AUD)** — the global standard.
- **Base reporting currency: AUD.** USD / USDC values are converted via `fx.csv`.

---

## Files

### `data/holdings.csv` — current position snapshot

| column          | type / enum | notes |
|-----------------|-------------|-------|
| `book`          | `passive` \| `conviction` \| `tactical` | the mandate axis |
| `asset`         | string (ticker / symbol) | e.g. `IVV`, `GOOGL`, `ETH` |
| `asset_class`   | `etf` \| `equity` \| `crypto_spot` \| `crypto_perp` \| `equity_perp` \| `cash` | `cash` = stablecoin/cash collateral; carries value. Perp legs add exposure, not value. |
| `venue`         | `commsec_au` \| `commsec_intl` \| `stake` \| `ibkr` \| `hyperliquid` \| `phantom` \| `exchange` | |
| `quantity`      | number (blank if unknown) | units / coins / contracts held |
| `avg_entry`     | number (blank if unknown) | average entry price (cost basis), in `currency` |
| `last_price`    | number (blank if unknown) | latest market price per unit, in `currency`. Drives market value & P&L. Refresh from venue/wallet. |
| `currency`      | `AUD` \| `USD` \| `USDC` | currency of `avg_entry` / `last_price` (and the position) |
| `position_type` | `spot` \| `long` \| `short` | |
| `leverage`      | number, **blank for spot/cash** | e.g. `10`, `15` for perps |
| `tac_id`        | `TAC-###`, blank unless tactical | tags a tactical position |
| `as_of_date`    | `YYYY-MM-DD` | snapshot date for the row |

### `data/transactions.csv` — immutable trade log (eventual source of truth)

| column        | type / enum | notes |
|---------------|-------------|-------|
| `date`        | `YYYY-MM-DD` | |
| `tac_id`      | `TAC-###`, blank unless tactical | |
| `book`        | `passive` \| `conviction` \| `tactical` | |
| `asset`       | string | |
| `asset_class` | `etf` \| `equity` \| `crypto_spot` \| `crypto_perp` \| `equity_perp` | |
| `venue`       | `commsec_au` \| `commsec_intl` \| `stake` \| `ibkr` \| `hyperliquid` \| `phantom` \| `exchange` | |
| `action`      | `buy` \| `sell` \| `open` \| `close` \| `add` \| `trim` | |
| `quantity`    | number | |
| `price`       | number | execution price, in `currency` |
| `currency`    | `AUD` \| `USD` \| `USDC` | |
| `fees`        | number | |
| `notes`       | string | free text |

### `data/fx.csv` — currency rates

| column | type | notes |
|--------|------|-------|
| `date` | `YYYY-MM-DD` | |
| `pair` | e.g. `AUDUSD` | base→quote |
| `rate` | number | units of quote per 1 unit of base |

### `data/nav.csv` — NAV-per-unit history (drives the Performance chart)

Long format — **one row per (date, series)** so multiple lines (each sleeve, the
Total Fund, and the benchmark) live in one file. Each value is a NAV per unit,
indexed to **$1.00** at the start of its series (growth-of-$1).

| column              | type | notes |
|---------------------|------|-------|
| `date`              | `YYYY-MM-DD` | month spine (use the 1st; the label is the month) |
| `series`            | enum | `wealth_base` \| `conviction` \| `tactical` \| `total_fund` \| `benchmark` |
| `nav_per_unit`      | number | NAV per unit (rebased to 1.00 at series start) |
| `units_outstanding` | number | blank for reconstructed rows; filled for struck rows |
| `fund_value_aud`    | number | blank for reconstructed rows; filled for struck rows |
| `kind`              | enum | `reconstructed` (back-cast) \| `struck` (real month-end mark) |
| `note`              | string | optional; methodology note on the first row of a series |

Two kinds of row, by design — the **"both"** model:

- **`reconstructed`** — a back-cast indexed path written by `navbuild.py`: a
  buy-and-hold of *today's* holdings valued at real historical monthly prices
  (AUD), chain-linked from $1.00. It gives an immediate chart but its endpoint is
  a *window return*, not the since-cost mark. Tactical is intentionally **not**
  reconstructed (a buy-and-hold of a 10–15× perp is not a real path); the Total
  Fund line blends Conviction with the *unlevered* tactical underlyings.
- **`struck`** — a real month-end valuation you append over time. This is the
  genuine track record: each strike records `nav_per_unit`, `units_outstanding`
  and `fund_value_aud`. Contributions/withdrawals issue or redeem units **at the
  prevailing NAV** so cashflows never move the unit price (time-weighted return).

`build.py` plots the `reconstructed` rows as the chart lines and shows the real
**marked NAV/unit per sleeve** (computed live from `holdings.csv`: `1 + sleeve
return`) as the chips above the chart.

#### Regenerating the reconstruction

```sh
REFRESH_PRICES=1 python3 navbuild.py            # uses ALPHAVANTAGE_API_KEY from .env
REFRESH_PRICES=1 python3 navbuild.py --no-cache # force a refetch (ignores navcache.json)
```

~13 Alpha Vantage calls (monthly equity history) + keyless CoinGecko/Frankfurter;
results cache to `navcache.json` (gitignored) so reruns don't re-burn the API.
Window = trailing 12 months (CoinGecko's free history cap), monthly points.

#### Striking the monthly NAV (going forward)

At each month-end, append one `struck` row per series with the real marked value.
The first strike of a series sets `units_outstanding = fund_value_aud / 1.00`
(NAV starts at $1.00); subsequent strikes carry units forward and only change
them when capital is added/removed (new units = contribution ÷ current NAV).
Run this from the scheduled Netlify build (or by hand) so the track record grows.

---

## Invariants & notes

- **Same asset can appear in multiple books.** Total exposure to an asset = filter on `asset`
  across all books (e.g. `GOOGL` is held both `conviction` and `tactical`).
- **`holdings.csv` should eventually be *derived* from `transactions.csv`** so the two cannot
  drift. Until that derivation exists, treat `holdings.csv` as the current snapshot and keep
  `transactions.csv` append-only.
- **Never invent numbers.** Leave `quantity` / `avg_entry` blank where unknown; the build emits
  clearly-flagged placeholders for blanks rather than guessing.
- **Never commit secrets / API keys.** This is a private repo of live personal holdings.
