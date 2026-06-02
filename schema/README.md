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

`etf` · `equity` · `crypto_spot` · `crypto_perp` · `equity_perp`

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
| `asset_class`   | `etf` \| `equity` \| `crypto_spot` \| `crypto_perp` \| `equity_perp` | |
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

### `data/nav.csv` — monthly NAV-per-unit history (drives performance + charts)

| column              | type | notes |
|---------------------|------|-------|
| `date`              | `YYYY-MM-DD` | one row per month |
| `nav_per_unit`      | number | fund NAV ÷ units outstanding |
| `units_outstanding` | number | |
| `fund_value_aud`    | number | total fund value in AUD (= Conviction + Tactical) |

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
