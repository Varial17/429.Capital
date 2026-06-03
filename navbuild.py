#!/usr/bin/env python3
"""Reconstruct an indexed NAV-per-unit history for 429 Capital — stdlib only.

This is the *reconstruction* half of the NAV track record. It answers the
fund-manager question "if a unit started at $1.00 twelve months ago, what would
each sleeve be worth per unit today?" using REAL historical monthly prices of
the holdings we own right now (a buy-and-hold of today's basket).

Method (standard chain-linked, value-weighted basket return):
  * For each consecutive month-end pair, each sleeve's return is
        Σ value_aud(t)  /  Σ value_aud(t-1)  − 1
    over the constituents that have a price at BOTH month-ends (so newly listed
    names simply join the basket once they have data — no invented history).
  * value_aud = current_quantity × historical_price × fx(month-end).
  * Each sleeve's NAV/unit is then chain-linked forward from $1.00.

Sleeves:
  * Wealth Base (passive)  — IVV (proxied by US-listed IVV × FX), QQMG; CRED, an
    AUD investment-grade bond ETF with no free history, is held flat (low vol).
  * Conviction             — the US equity/ETF book + spot crypto.
  * Tactical               — the leveraged perps (GOOGL/NVDA), reconstructed as
    unrealised PnL on constant USDC collateral; clamped per month because a
    naive buy-and-hold of a 10–15× position over a year is not a real path. This
    line is illustrative; the Tactical *forward* record is what's struck monthly.
  * Total Fund (Conv+Tac)  — value-weighted blend of Conviction and Tactical
    monthly returns (Tactical is a small weight, so this tracks Conviction with a
    tactical tilt).
  * Benchmark              — iShares MSCI ACWI ETF (US) × FX, i.e. ACWI in AUD.

Sources:  equities → Alpha Vantage TIME_SERIES_MONTHLY (needs ALPHAVANTAGE_API_KEY,
free 25/day) ; crypto → CoinGecko market_chart (keyless, 365-day window) ;
FX → Frankfurter range (keyless).

Output: data/nav.csv in long format
    date,series,nav_per_unit,units_outstanding,fund_value_aud,kind,note
Reconstructed rows carry kind=reconstructed (units/value blank). The monthly
forward strike appends kind=struck rows (see README).

Run:  REFRESH_PRICES=1 python3 navbuild.py     (uses .env for the AV key)
A local cache (navcache.json, gitignored) avoids re-burning API calls on reruns;
pass --no-cache to force a refetch.
"""

import csv
import json
import os
import sys
import time
import datetime
import urllib.request
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
CACHE = ROOT / "navcache.json"
UA = {"User-Agent": "429-capital-navbuild/1.0"}
TIMEOUT = 20

WINDOW_MONTHS = 12  # 13 month-end points -> 12 monthly steps

# Crypto symbol -> CoinGecko id.
COINGECKO_IDS = {
    "BTC": "bitcoin", "ETH": "ethereum", "jitoSOL": "jito-staked-sol",
    "HYPE": "hyperliquid", "SYRUP": "syrup",
}
# ASX listings Alpha Vantage's free tier can't serve -> US proxy in USD.
US_PROXY = {"IVV": "IVV"}  # IVV.AX (AUD) ≈ US-listed IVV (USD) × AUDUSD
# AUD holdings with no free history -> held flat (price constant, 0 return).
HOLD_FLAT = {"CRED"}
BENCHMARK_SYMBOL = "ACWI"  # iShares MSCI ACWI ETF (US, USD)


# --------------------------------------------------------------------------- #
# fetching
# --------------------------------------------------------------------------- #
def _get_json(url, data=None, headers=None):
    hdrs = dict(UA)
    if headers:
        hdrs.update(headers)
    try:
        req = urllib.request.Request(url, data=data, headers=hdrs)
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:  # noqa: BLE001
        print(f"    fetch failed ({url.split('?')[0]}): {e}")
        return None


def fetch_equity_monthly(symbol, key):
    """{ 'YYYY-MM': close } from Alpha Vantage TIME_SERIES_MONTHLY."""
    url = ("https://www.alphavantage.co/query?"
           + urllib.parse.urlencode({
               "function": "TIME_SERIES_MONTHLY", "symbol": symbol, "apikey": key}))
    obj = _get_json(url)
    if not isinstance(obj, dict):
        return {}
    if "Note" in obj or "Information" in obj:
        print(f"    AV throttled on {symbol}: {obj.get('Note') or obj.get('Information')}")
        return {}
    series = obj.get("Monthly Time Series") or {}
    out = {}
    for d, row in series.items():
        try:
            out[d[:7]] = float(row["4. close"])  # key by YYYY-MM
        except (KeyError, TypeError, ValueError):
            continue
    return out


def fetch_crypto_monthly(cg_id):
    """{ 'YYYY-MM': month_end_price } from CoinGecko market_chart (365d daily)."""
    url = (f"https://api.coingecko.com/api/v3/coins/{cg_id}/market_chart?"
           + urllib.parse.urlencode({"vs_currency": "usd", "days": 365, "interval": "daily"}))
    obj = _get_json(url)
    prices = (obj or {}).get("prices") if isinstance(obj, dict) else None
    if not prices:
        return {}
    # Keep the LAST observation in each calendar month (closest to month-end).
    by_month = {}
    for ts, px in prices:
        d = datetime.datetime.fromtimestamp(ts / 1000, datetime.timezone.utc)
        ym = f"{d.year:04d}-{d.month:02d}"
        # later timestamps overwrite earlier ones -> month-end value
        by_month[ym] = float(px)
    return by_month


def fetch_fx_monthly(start, end):
    """{ 'YYYY-MM': month_end AUDUSD } from Frankfurter daily range."""
    url = (f"https://api.frankfurter.app/{start}..{end}?"
           + urllib.parse.urlencode({"from": "AUD", "to": "USD"}))
    obj = _get_json(url)
    rates = (obj or {}).get("rates") if isinstance(obj, dict) else None
    if not rates:
        return {}
    out = {}
    for d in sorted(rates):  # ascending -> last in month wins
        usd = rates[d].get("USD")
        if isinstance(usd, (int, float)):
            out[d[:7]] = float(usd)
    return out


# --------------------------------------------------------------------------- #
# holdings + assembly
# --------------------------------------------------------------------------- #
def load_dotenv(path):
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def read_holdings():
    with (DATA / "holdings.csv").open(newline="", encoding="utf-8") as f:
        return [r for r in csv.DictReader(f)]


def _f(x):
    try:
        return float(str(x).strip())
    except (TypeError, ValueError):
        return None


def gather(no_cache=False):
    """Fetch (or load cached) monthly histories for everything we need.
    Returns dict: { 'equity': {sym:{ym:px}}, 'crypto': {sym:{ym:px}}, 'fx': {ym:rate} }."""
    if CACHE.exists() and not no_cache:
        print(f"  using cache {CACHE.name} (pass --no-cache to refetch)")
        return json.loads(CACHE.read_text(encoding="utf-8"))

    holdings = read_holdings()
    equity_syms, crypto_syms = set(), set()
    for r in holdings:
        ac = (r.get("asset_class") or "").strip()
        asset = (r.get("asset") or "").strip()
        if ac in ("equity", "etf", "equity_perp"):
            equity_syms.add(US_PROXY.get(asset, asset))
        elif ac == "crypto_spot":
            crypto_syms.add(asset)
    equity_syms.discard("")  # safety
    equity_syms -= HOLD_FLAT               # CRED held flat, no fetch
    equity_syms.add(BENCHMARK_SYMBOL)      # benchmark ETF

    key = os.environ.get("ALPHAVANTAGE_API_KEY", "").strip()
    if not key:
        sys.exit("ERROR: ALPHAVANTAGE_API_KEY not set (check .env). Needed for equity history.")

    print(f"  equities ({len(equity_syms)} AV calls): {', '.join(sorted(equity_syms))}")
    equity = {}
    for i, sym in enumerate(sorted(equity_syms)):
        equity[sym] = fetch_equity_monthly(sym, key)
        got = len(equity[sym])
        print(f"    {sym:<6} {got} months")
        if i < len(equity_syms) - 1:
            time.sleep(13)  # free tier 5/min -> ~13s spacing keeps us safe

    print(f"  crypto ({len(crypto_syms)} CoinGecko calls): {', '.join(sorted(crypto_syms))}")
    crypto = {}
    for sym in sorted(crypto_syms):
        cg = COINGECKO_IDS.get(sym)
        crypto[sym] = fetch_crypto_monthly(cg) if cg else {}
        print(f"    {sym:<8} {len(crypto[sym])} months")
        time.sleep(2)

    today = datetime.date.today()
    start = (today - datetime.timedelta(days=400)).isoformat()
    fx = fetch_fx_monthly(start, today.isoformat())
    print(f"  fx: {len(fx)} months AUDUSD")

    out = {"equity": equity, "crypto": crypto, "fx": fx,
           "fetched_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")}
    CACHE.write_text(json.dumps(out), encoding="utf-8")
    print(f"  cached -> {CACHE.name}")
    return out


def month_axis(hist):
    """The trailing WINDOW_MONTHS+1 calendar months that FX covers (our spine)."""
    months = sorted(hist["fx"].keys())
    return months[-(WINDOW_MONTHS + 1):]


def price_lookup(hist, asset, asset_class):
    """Return ('equity'|'crypto'|'flat', {ym: price_usd_or_native})."""
    if asset in HOLD_FLAT:
        return "flat", None
    if asset_class == "crypto_spot":
        return "crypto", hist["crypto"].get(asset, {})
    sym = US_PROXY.get(asset, asset)
    return "equity", hist["equity"].get(sym, {})


def sleeve_returns(constituents, months, hist, flat_price=None):
    """constituents: list of (asset, asset_class, qty, currency).
    Returns list of monthly returns (len = len(months)-1); None where no data."""
    rets = []
    for i in range(1, len(months)):
        m0, m1 = months[i - 1], months[i]
        f0 = hist["fx"].get(m0)
        f1 = hist["fx"].get(m1)
        num = den = 0.0
        used = 0
        for asset, ac, qty, cur in constituents:
            kind, pmap = price_lookup(hist, asset, ac)
            if kind == "flat":
                continue  # constant price -> 0 contribution to return
            p0 = pmap.get(m0)
            p1 = pmap.get(m1)
            if p0 is None or p1 is None:
                continue
            if (cur or "AUD").upper() == "AUD":
                v0, v1 = qty * p0, qty * p1
            else:
                if not f0 or not f1:
                    continue
                v0, v1 = qty * p0 / f0, qty * p1 / f1
            num += v1
            den += v0
            used += 1
        rets.append((num / den - 1) if (den and used) else None)
    return rets


def unlevered_returns(perps, months, hist):
    """Tactical UNDERLYING (spot) return, value-weighted by current notional.

    We deliberately do NOT reconstruct the leveraged path: a buy-and-hold of a
    10–15× perp over a year is not a real track record (it would have been
    liquidated and re-opened many times). For the Total-Fund blend we use the
    bounded, unlevered return of the underlying names; Tactical's real leveraged
    result lives in the marked NAV chip + the Exposure section, and its genuine
    forward record is struck monthly."""
    rets = []
    for i in range(1, len(months)):
        m0, m1 = months[i - 1], months[i]
        num = den = 0.0
        used = 0
        for asset, qty, direction in perps:
            pmap = hist["equity"].get(US_PROXY.get(asset, asset), {})
            p0, p1 = pmap.get(m0), pmap.get(m1)
            if p0 is None or p1 is None:
                continue
            # weight by current notional; shorts invert the move
            num += qty * (p0 + direction * (p1 - p0))
            den += qty * p0
            used += 1
        rets.append((num / den - 1) if (den and used) else None)
    return rets


def chain(rets):
    """Chain-link monthly returns from 1.00. None steps carry the level flat."""
    nav = [1.0]
    for r in rets:
        nav.append(nav[-1] * (1 + r) if r is not None else nav[-1])
    return nav


def r4(x):
    return round(x, 4) if x is not None else None


def main():
    no_cache = "--no-cache" in sys.argv
    load_dotenv(ROOT / ".env")
    print("Reconstructing NAV/unit history…")
    hist = gather(no_cache=no_cache)
    months = month_axis(hist)
    if len(months) < 3:
        sys.exit("ERROR: not enough monthly FX points to build a window.")
    print(f"  window: {months[0]} → {months[-1]} ({len(months)} points)")

    holdings = read_holdings()
    def rows_for(book):
        out = []
        for r in holdings:
            if (r.get("book") or "").strip() != book:
                continue
            ac = (r.get("asset_class") or "").strip()
            if ac == "cash" or ac.endswith("_perp"):
                continue  # collateral / perps handled separately
            out.append((r.get("asset").strip(), ac, _f(r.get("quantity")),
                        (r.get("currency") or "AUD").strip()))
        return out

    wb = rows_for("passive")
    conv = rows_for("conviction")

    # Tactical perps + collateral
    perps = []
    collateral_native = 0.0
    for r in holdings:
        if (r.get("book") or "").strip() != "tactical":
            continue
        ac = (r.get("asset_class") or "").strip()
        if ac.endswith("_perp"):
            direction = -1.0 if (r.get("position_type") or "").strip() == "short" else 1.0
            perps.append((r.get("asset").strip(), _f(r.get("quantity")), direction))
        elif ac == "cash":
            collateral_native += _f(r.get("quantity")) or 0.0

    ret_wb = sleeve_returns(wb, months, hist)
    ret_conv = sleeve_returns(conv, months, hist)
    ret_tac = unlevered_returns(perps, months, hist)  # underlying tilt, bounded
    ret_bench = sleeve_returns(
        [(BENCHMARK_SYMBOL, "etf", 1.0, "USD")], months, hist)

    # Total Fund = value-weighted blend of Conviction & Tactical (current weights).
    fx_now = hist["fx"].get(months[-1]) or 0.658
    def book_value_aud(rows):
        tot = 0.0
        for asset, ac, qty, cur in rows:
            kind, pmap = price_lookup(hist, asset, ac)
            px = (pmap or {}).get(months[-1]) if pmap else None
            if kind == "flat" or px is None:
                # fall back to current last_price from holdings for weighting
                for r in holdings:
                    if r.get("asset", "").strip() == asset:
                        px = _f(r.get("last_price"))
                        break
            if px is None or qty is None:
                continue
            tot += (qty * px) if (cur or "AUD").upper() == "AUD" else (qty * px / fx_now)
        return tot
    conv_val = book_value_aud(conv)
    tac_val = collateral_native / fx_now  # collateral is the sleeve equity
    w_conv = conv_val / (conv_val + tac_val) if (conv_val + tac_val) else 1.0
    w_tac = 1.0 - w_conv
    ret_total = []
    for rc, rt in zip(ret_conv, ret_tac):
        if rc is None and rt is None:
            ret_total.append(None)
        else:
            ret_total.append(w_conv * (rc or 0.0) + w_tac * (rt or 0.0))
    print(f"  total-fund weights: conviction {w_conv:.1%} / tactical {w_tac:.1%}")

    # Tactical is intentionally NOT drawn as a reconstructed line (leveraged,
    # recently opened — a buy-and-hold backcast would be a fiction). It shows up
    # as a marked NAV chip (real since-cost) and is struck monthly going forward.
    navs = {
        "wealth_base": chain(ret_wb),
        "conviction": chain(ret_conv),
        "total_fund": chain(ret_total),
        "benchmark": chain(ret_bench),
    }

    notes = {
        "wealth_base": "buy-and-hold of current Wealth Base basket; CRED held flat",
        "conviction": "buy-and-hold of current Conviction basket",
        "total_fund": f"Conviction+Tactical value-weighted ({w_conv:.0%}/{w_tac:.0%}), Tactical unlevered",
        "benchmark": "iShares MSCI ACWI ETF in AUD",
    }
    order = ["wealth_base", "conviction", "total_fund", "benchmark"]

    out_path = DATA / "nav.csv"
    with out_path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["date", "series", "nav_per_unit", "units_outstanding",
                    "fund_value_aud", "kind", "note"])
        for i, m in enumerate(months):
            date = f"{m}-01"  # month spine; label is the month
            for s in order:
                w.writerow([date, s, r4(navs[s][i]), "", "",
                            "reconstructed", notes[s] if i == 0 else ""])
    print(f"\nWrote {out_path.relative_to(ROOT)}  ({len(months)} months × {len(order)} series)")
    print("  endpoints (NAV/unit, growth of $1):")
    for s in order:
        print(f"    {s:<12} {navs[s][0]:.3f} → {navs[s][-1]:.3f}")


if __name__ == "__main__":
    main()
