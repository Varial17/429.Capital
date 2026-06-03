#!/usr/bin/env python3
"""Live price refresh for 429 Capital — standard library only (urllib).

Called from build.py BEFORE holdings are valued. It returns a resolver that
build.py uses to override each holding's `last_price` with a live mark where one
is available, falling back to the CSV value otherwise. Nothing here is ever
invented: a failed/missing fetch leaves the manual price untouched.

Sources (by asset type):
  * equities / ETFs  -> Alpha Vantage GLOBAL_QUOTE   (needs ALPHAVANTAGE_API_KEY)
  * spot crypto      -> CoinGecko simple/price        (keyless)
  * perp marks       -> Hyperliquid /info allMids     (keyless)
  * FX (AUDUSD)      -> Frankfurter latest            (keyless)

SECURITY: the Alpha Vantage key is read from the environment only. It must never
be committed or shipped to the browser. On Netlify set it as a build env var.

Gating (so we respect Alpha Vantage's 25-calls/day free limit and stay offline
-safe for local builds):
  * Network fetching only runs when REFRESH_PRICES is truthy.
  * Equity fetching additionally requires ALPHAVANTAGE_API_KEY, and can be
    pinned to a single UTC hour via EQUITY_REFRESH_HOUR_UTC so an hourly
    scheduled build still only hits Alpha Vantage once a day.
"""

import json
import os
import time
import urllib.request
import urllib.parse
import datetime

UA = {"User-Agent": "429-capital-build/1.0"}
TIMEOUT = 12

# --- symbol maps -----------------------------------------------------------
COINGECKO_IDS = {
    "BTC": "bitcoin",
    "ETH": "ethereum",
    "jitoSOL": "jito-staked-sol",
    "HYPE": "hyperliquid",
    "SYRUP": "syrup",
}
# Hyperliquid perp coins are keyed by ticker in allMids (e.g. "GOOGL", "NVDA").


def _truthy(name):
    return str(os.environ.get(name, "")).strip().lower() in ("1", "true", "yes", "on")


def enabled():
    """Master switch — only touch the network when explicitly asked."""
    return _truthy("REFRESH_PRICES")


def _get_json(url, data=None, headers=None):
    """GET (or POST if data given) JSON. Returns parsed object or None on any error."""
    hdrs = dict(UA)
    if headers:
        hdrs.update(headers)
    try:
        req = urllib.request.Request(url, data=data, headers=hdrs)
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:  # noqa: BLE001 - never let a fetch break the build
        print(f"    price fetch failed ({url.split('?')[0]}): {e}")
        return None


# --- individual sources ----------------------------------------------------
def fetch_crypto(symbols):
    """{SYMBOL: usd_price} for the subset we have CoinGecko ids for."""
    ids = {COINGECKO_IDS[s]: s for s in symbols if s in COINGECKO_IDS}
    if not ids:
        return {}
    url = ("https://api.coingecko.com/api/v3/simple/price?"
           + urllib.parse.urlencode({"ids": ",".join(ids), "vs_currencies": "usd"}))
    obj = _get_json(url)
    out = {}
    if isinstance(obj, dict):
        for cg_id, sym in ids.items():
            px = (obj.get(cg_id) or {}).get("usd")
            if isinstance(px, (int, float)):
                out[sym] = float(px)
    return out


def fetch_hl_mids():
    """{coin: mid_price} from Hyperliquid (perp marks). Keyless POST."""
    body = json.dumps({"type": "allMids"}).encode("utf-8")
    obj = _get_json("https://api.hyperliquid.xyz/info", data=body,
                    headers={"Content-Type": "application/json"})
    out = {}
    if isinstance(obj, dict):
        for coin, px in obj.items():
            try:
                out[coin] = float(px)
            except (TypeError, ValueError):
                continue
    return out


def fetch_fx_audusd():
    """AUDUSD (USD per 1 AUD) from Frankfurter (ECB), keyless. None on failure."""
    obj = _get_json("https://api.frankfurter.app/latest?from=AUD&to=USD")
    if isinstance(obj, dict):
        rate = (obj.get("rates") or {}).get("USD")
        if isinstance(rate, (int, float)):
            return float(rate), obj.get("date")
    return None, None


def fetch_equity_av(symbol, key):
    """Latest price for one equity/ETF via Alpha Vantage GLOBAL_QUOTE.
    Returns float or None (None also covers throttle 'Note'/'Information')."""
    url = ("https://www.alphavantage.co/query?"
           + urllib.parse.urlencode({
               "function": "GLOBAL_QUOTE", "symbol": symbol, "apikey": key}))
    obj = _get_json(url)
    if not isinstance(obj, dict):
        return None
    if "Note" in obj or "Information" in obj:
        print(f"    Alpha Vantage throttled on {symbol}: "
              f"{obj.get('Note') or obj.get('Information')}")
        return None
    px = (obj.get("Global Quote") or {}).get("05. price")
    try:
        return float(px)
    except (TypeError, ValueError):
        return None


def _av_symbol(asset, currency):
    """Map our ticker to an Alpha Vantage symbol. AUD listings -> ASX (.AX)."""
    if (currency or "").upper() == "AUD":
        return f"{asset}.AX"
    return asset


# --- orchestration ---------------------------------------------------------
def refresh(holdings_rows):
    """Fetch live prices for the given holdings. Returns
    (resolver, meta) where resolver(asset, asset_class, currency) -> (price, source)
    with price None when no live mark is available (caller keeps CSV value)."""
    now = datetime.datetime.now(datetime.timezone.utc)
    meta = {"ran_at": now.isoformat(timespec="seconds"),
            "sources": [], "equity_fetched": False, "errors": []}

    crypto_syms, has_perp, equities = set(), False, []  # equities: (asset, currency)
    for r in holdings_rows:
        ac = (r.get("asset_class") or "").strip()
        asset = (r.get("asset") or "").strip()
        cur = (r.get("currency") or "").strip()
        if ac in ("crypto_spot",):
            crypto_syms.add(asset)
        elif ac.endswith("_perp"):
            has_perp = True
        elif ac in ("equity", "etf"):
            equities.append((asset, cur))

    crypto = fetch_crypto(crypto_syms) if crypto_syms else {}
    if crypto:
        meta["sources"].append("coingecko")
    mids = fetch_hl_mids() if has_perp else {}
    if mids:
        meta["sources"].append("hyperliquid")

    # FX (keyless) — caller decides whether to use it over fx.csv
    fx_rate, fx_date = fetch_fx_audusd()
    if fx_rate:
        meta["sources"].append("frankfurter")
    meta["fx"] = {"AUDUSD": fx_rate, "date": fx_date} if fx_rate else None

    # Equities (Alpha Vantage, keyed + rate-limited) — gated.
    equity_px = {}
    av_key = os.environ.get("ALPHAVANTAGE_API_KEY", "").strip()
    pin_hour = os.environ.get("EQUITY_REFRESH_HOUR_UTC", "").strip()
    hour_ok = (pin_hour == "" or pin_hour == str(now.hour))
    if av_key and equities and hour_ok:
        meta["equity_fetched"] = True
        meta["sources"].append("alphavantage")
        seen = {}
        for asset, cur in equities:
            sym = _av_symbol(asset, cur)
            if sym in seen:
                continue
            px = fetch_equity_av(sym, av_key)
            seen[sym] = px
            if px is not None:
                equity_px[asset] = px
            time.sleep(0.9)  # stay under 5 calls/min on the free tier
    elif av_key and equities and not hour_ok:
        meta["errors"].append(f"equities skipped (hour {now.hour} != {pin_hour})")

    def resolver(asset, asset_class, currency):
        ac = (asset_class or "")
        if ac.endswith("_perp"):
            px = mids.get(asset)
            return (px, "hyperliquid") if px is not None else (None, None)
        if ac == "crypto_spot":
            px = crypto.get(asset)
            return (px, "coingecko") if px is not None else (None, None)
        if ac in ("equity", "etf"):
            px = equity_px.get(asset)
            return (px, "alphavantage") if px is not None else (None, None)
        return (None, None)

    return resolver, meta
