#!/usr/bin/env python3
"""429 Capital build step.

One-way data flow:  data/*.csv  ->  build.py  ->  site/data/data.json

Reads the flat-CSV source of truth and computes real, marked-to-market metrics
wherever the inputs exist:

  * spot holdings  -> market value = quantity x last_price, converted to AUD via fx
  * perp holdings  -> margin (collateral at entry) + unrealised PnL = sleeve equity;
                      gross notional tracked separately for the exposure view
  * sleeves        -> value, cost, PnL and return per book (the "deviation" view)
  * fund NAV       -> Conviction + Tactical ; Wealth Base (passive) shown alongside

Anything still missing a price or cost is left as null and flagged, never invented.
Python 3 standard library only.

Run:  python3 build.py
"""

import csv
import json
import os
import datetime
from pathlib import Path

import pricefetch


def load_dotenv(path):
    """Minimal .env loader (stdlib). Lines of KEY=VALUE; existing env wins.
    The .env file is gitignored — it holds local secrets like the price API key."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
REPORTS = ROOT / "reports"
OUT = ROOT / "site" / "data" / "data.json"
OUT_REPORTS = ROOT / "site" / "data" / "reports"

BOOK_DISPLAY = {
    "passive": "Wealth Base",
    "conviction": "Conviction",
    "tactical": "Tactical",
}
BOOK_ORDER = ["passive", "conviction", "tactical"]
# Long-run target weights across the whole book (the mandate).
TARGET_WEIGHTS = {"passive": 0.50, "conviction": 0.35, "tactical": 0.15}


def read_csv(path):
    """Read a CSV into a list of dicts. Missing file -> empty list."""
    if not path.exists():
        return []
    with path.open(newline="", encoding="utf-8") as f:
        return [row for row in csv.DictReader(f)]


def num(value):
    """Parse a numeric cell. Blank / unparseable -> None (never invent)."""
    if value is None:
        return None
    s = value.strip()
    if s == "":
        return None
    try:
        return float(s)
    except ValueError:
        return None


def clean(value):
    """Trim a string cell; blank -> None."""
    if value is None:
        return None
    s = value.strip()
    return s or None


def r2(x):
    return round(x, 2) if x is not None else None


def load_fx(rows):
    """Return {'AUDUSD': rate, 'date': ...} using the most recent AUDUSD row."""
    audusd = None
    date = None
    for row in rows:
        if (clean(row.get("pair")) or "").upper() == "AUDUSD":
            rate = num(row.get("rate"))
            d = clean(row.get("date"))
            if rate and (date is None or (d or "") >= (date or "")):
                audusd, date = rate, d
    return {"AUDUSD": audusd, "date": date}


def make_to_aud(audusd):
    """USD/USDC -> AUD via AUDUSD (USD per 1 AUD). AUD passes through.
    Returns None if a conversion is needed but no rate is available."""
    def to_aud(amount, currency):
        if amount is None:
            return None
        cur = (currency or "").upper()
        if cur == "AUD":
            return amount
        if cur in ("USD", "USDC"):
            return amount / audusd if audusd else None
        return None
    return to_aud


def parse_holdings(rows, to_aud, price_resolver=None):
    out = []
    for r in rows:
        book = clean(r.get("book"))
        asset = clean(r.get("asset"))
        asset_class = clean(r.get("asset_class"))
        qty = num(r.get("quantity"))
        entry = num(r.get("avg_entry"))
        last = num(r.get("last_price"))
        currency = clean(r.get("currency"))
        ptype = clean(r.get("position_type"))
        lev = num(r.get("leverage"))
        is_perp = (asset_class or "").endswith("_perp")

        # Live price override: if a resolver returns a mark, it wins over the CSV
        # value; otherwise the manual last_price stands (never invented).
        price_source = "manual" if last is not None else None
        if price_resolver is not None:
            live_px, src = price_resolver(asset, asset_class, currency)
            if live_px is not None:
                last = live_px
                price_source = src

        cost_native = qty * entry if (qty is not None and entry is not None) else None
        mkt_native = qty * last if (qty is not None and last is not None) else None

        h = {
            "book": book,
            "asset": asset,
            "asset_class": asset_class,
            "venue": clean(r.get("venue")),
            "quantity": qty,
            "avg_entry": entry,
            "last_price": last,
            "price_source": price_source,
            "currency": currency,
            "position_type": ptype,
            "leverage": lev,
            "tac_id": clean(r.get("tac_id")),
            "as_of_date": clean(r.get("as_of_date")),
            "is_perp": is_perp,
            # derived (AUD), filled below
            "cost_aud": None,
            "value_aud": None,
            "pnl_aud": None,
            "pnl_pct": None,
            "notional_aud": None,
            "weight": None,   # share of total book value, filled after totals
            "flags": [],
        }

        if is_perp:
            # Cross-margined perp. The capital lives in the account's USDC
            # collateral (a separate holding), so the position itself adds NO
            # standalone value to the sleeve — double counting the margin would
            # inflate the book. We surface two things instead:
            #   * notional = current gross exposure (qty x mark) -> exposure view
            #   * pnl = unrealised PnL, with ROE measured on entry-margin
            # value_aud / cost_aud stay 0 so the sleeve value = collateral only.
            h["value_aud"] = 0.0
            h["cost_aud"] = 0.0
            h["is_collateralised"] = True
            if mkt_native is not None and entry is not None:
                direction = -1.0 if ptype == "short" else 1.0
                upnl_native = direction * (last - entry) * qty
                h["pnl_aud"] = r2(to_aud(upnl_native, currency))
                # ROE on the entry-margin (matches the venue's reported ROE).
                if cost_native is not None and lev:
                    margin_native = cost_native / lev
                    h["pnl_pct"] = r2(upnl_native / margin_native * 100) if margin_native else None
                h["notional_aud"] = r2(to_aud(mkt_native, currency))
            else:
                h["notional_aud"] = r2(to_aud(mkt_native if mkt_native is not None else cost_native, currency))
                if last is None:
                    h["flags"].append("no_price")
                if entry is None:
                    h["flags"].append("no_cost")
        else:
            # Spot: market value and (where we know entry) cost + PnL.
            h["value_aud"] = r2(to_aud(mkt_native, currency))
            h["cost_aud"] = r2(to_aud(cost_native, currency))
            if mkt_native is not None and cost_native is not None:
                h["pnl_aud"] = r2(to_aud(mkt_native - cost_native, currency))
                h["pnl_pct"] = r2((last / entry - 1) * 100) if entry else None
            if last is None:
                h["flags"].append("no_price")
            if entry is None:
                h["flags"].append("no_cost")

        out.append(h)
    return out


def summarise_sleeve(book, holdings):
    """Aggregate one book. Value = sum of marked positions; return is computed
    only over positions where BOTH cost and value are known, so unsized/uncosted
    legs (e.g. crypto with no entry) don't distort the percentage."""
    rows = [h for h in holdings if h["book"] == book]
    value = sum(h["value_aud"] for h in rows if h["value_aud"] is not None) or 0.0
    # cost/pnl only over positions carrying both numbers
    costed = [h for h in rows if h["cost_aud"] is not None and h["value_aud"] is not None]
    cost_basis = sum(h["cost_aud"] for h in costed) or 0.0
    pnl = sum((h["pnl_aud"] or 0.0) for h in costed) or 0.0
    ret_pct = (pnl / cost_basis * 100) if cost_basis else None
    unpriced = [h["asset"] for h in rows if "no_price" in h["flags"]]
    uncosted = [h["asset"] for h in rows if "no_cost" in h["flags"]]
    return {
        "book": book,
        "display": BOOK_DISPLAY.get(book, book),
        "count": len(rows),
        "value_aud": r2(value),
        "cost_aud": r2(cost_basis),
        "pnl_aud": r2(pnl),
        "return_pct": r2(ret_pct),
        "target_weight": TARGET_WEIGHTS.get(book),
        "weight": None,  # of total book value, filled after totals
        "unpriced": unpriced,
        "uncosted": uncosted,
    }


def compute_exposure(holdings, to_aud):
    """Tactical exposure at CURRENT mark (notional now), in AUD.
    Only leveraged perp legs carry exposure; the USDC collateral does not."""
    tac = [h for h in holdings if h["book"] == "tactical" and h["is_perp"]]
    collateral = sum(
        h["value_aud"] for h in holdings
        if h["book"] == "tactical" and not h["is_perp"] and h["value_aud"] is not None
    )
    open_pnl = sum(h["pnl_aud"] for h in tac if h["pnl_aud"] is not None)
    gross_long = gross_short = 0.0
    long_count = short_count = 0
    positions = []
    for h in tac:
        notional = h["notional_aud"]
        if notional is None:
            continue
        if h["position_type"] == "short":
            gross_short += notional
            short_count += 1
        else:
            gross_long += notional
            long_count += 1
        positions.append({
            "asset": h["asset"],
            "position_type": h["position_type"],
            "leverage": h["leverage"],
            "venue": h["venue"],
            "notional_aud": notional,
            "pnl_aud": h["pnl_aud"],
            "pnl_pct": h["pnl_pct"],
        })
    unpriced = sum(1 for h in tac if h["notional_aud"] is None)
    return {
        "currency": "AUD",
        "basis": "current mark",
        "collateral_aud": r2(collateral),
        "open_pnl_aud": r2(open_pnl),
        "gross_long": r2(gross_long),
        "gross_short": r2(gross_short),
        "net": r2(gross_long - gross_short),
        "leverage": r2((gross_long + gross_short) / collateral) if collateral else None,
        "long_count": long_count,
        "short_count": short_count,
        "unpriced_count": unpriced,
        "positions": positions,
    }


def count_by(holdings, key):
    counts = {}
    for h in holdings:
        k = h[key]
        counts[k] = counts.get(k, 0) + 1
    return counts


_MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun",
           "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def _fmt_month(date_str, show_year):
    """'2025-06-01' -> 'Jun 25' (year shown at boundaries) or 'Jun'."""
    try:
        y, m = int(date_str[:4]), int(date_str[5:7])
    except (ValueError, IndexError):
        return date_str
    label = _MONTHS[m] if 1 <= m <= 12 else date_str[5:7]
    return f"{label} {y % 100:02d}" if show_year else label


# Series we know how to label/colour, in chart draw order.
NAV_SERIES = ["wealth_base", "conviction", "tactical", "total_fund", "benchmark"]
NAV_DISPLAY = {
    "wealth_base": "Wealth Base",
    "conviction": "Conviction",
    "tactical": "Tactical",
    "total_fund": "Total Fund",
    "benchmark": "Benchmark · MSCI ACWI (AUD)",
}


def read_performance(nav_rows, sleeves, fund):
    """Build the NAV/unit chart payload from data/nav.csv (long format).

    Two layers:
      * series  — the RECONSTRUCTED indexed paths (growth of $1, buy-and-hold of
        today's holdings over the trailing window). Drawn as the chart lines.
      * marked  — the REAL since-cost NAV/unit per sleeve (1 + sleeve return),
        the genuine current mark. Shown as chips; struck monthly going forward.
    Falls back to a clearly-flagged sample if nav.csv has no reconstructed rows."""
    # marked NAV/unit from the authoritative sleeve aggregates (single source).
    def mk(pct):
        return r2(1 + pct / 100) if pct is not None else None
    marked = {
        "wealth_base": mk(sleeves["passive"]["return_pct"]),
        "conviction": mk(sleeves["conviction"]["return_pct"]),
        "tactical": mk(sleeves["tactical"]["return_pct"]),
        "total_fund": mk(fund["return_pct"]),
    }

    recon = [r for r in nav_rows if (clean(r.get("kind")) or "") == "reconstructed"]
    if not recon:
        labels = ["May 24", "Jul", "Sep", "Nov", "Jan 25", "Mar", "May",
                  "Jul", "Sep", "Nov", "Jan 26", "Mar", "May 26"]
        fundv = [1.0, 1.022, 1.018, 1.064, 1.051, 1.098, 1.124,
                 1.160, 1.143, 1.205, 1.238, 1.291, 1.384]
        bench = [1.0, 1.009, 1.024, 1.018, 1.041, 1.033, 1.056,
                 1.072, 1.065, 1.088, 1.102, 1.124, 1.143]
        return {
            "reconstructed": False,
            "placeholder": True,
            "base": 1.0,
            "note": "Sample data — run navbuild.py to populate data/nav.csv.",
            "series": {"labels": labels, "total_fund": fundv, "benchmark": bench},
            "marked": marked,
        }

    dates = sorted({r["date"] for r in recon})
    present = []
    for r in recon:
        s = r.get("series")
        if s not in present:
            present.append(s)
    table = {s: {} for s in present}
    note = {}
    for r in recon:
        table[r["series"]][r["date"]] = num(r.get("nav_per_unit"))
        n = clean(r.get("note"))
        if n and r["series"] not in note:
            note[r["series"]] = n

    labels = [_fmt_month(d, show_year=(i == 0 or d[5:7] == "01"))
              for i, d in enumerate(dates)]
    series = {"labels": labels}
    for s in NAV_SERIES:
        if s in table:
            series[s] = [table[s].get(d) for d in dates]

    return {
        "reconstructed": True,
        "placeholder": False,
        "base": 1.0,
        "window": {"start": dates[0][:7], "end": dates[-1][:7]},
        "note": ("Indexed to $1.00 at window start — a reconstruction: buy-and-hold "
                 "of today's holdings at historical monthly prices (AUD). "
                 "Tactical is excluded from the lines (leveraged, recently opened) "
                 "— see its marked NAV and the Exposure section."),
        "series": series,
        "series_notes": note,
        "display": {s: NAV_DISPLAY[s] for s in NAV_SERIES},
        "marked": marked,
    }


def process_reports():
    """Discover reports/*.json, copy each into site/data/reports/, build an
    ordered manifest with prev/next links."""
    if not REPORTS.exists():
        return []
    OUT_REPORTS.mkdir(parents=True, exist_ok=True)
    for stale in OUT_REPORTS.glob("*.json"):
        stale.unlink()

    parsed = []
    for p in sorted(REPORTS.glob("*.json")):
        try:
            obj = json.loads(p.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            print(f"  WARN: skipping {p.name} (invalid JSON): {e}")
            continue
        period = obj.get("period") or p.stem
        (OUT_REPORTS / f"{period}.json").write_text(
            json.dumps(obj, indent=2) + "\n", encoding="utf-8")
        parsed.append(obj)

    parsed.sort(key=lambda o: (o.get("date") or o.get("period") or ""))
    manifest = []
    for i, obj in enumerate(parsed):
        manifest.append({
            "period": obj.get("period"),
            "title": obj.get("title"),
            "subtitle": obj.get("subtitle"),
            "date": obj.get("date"),
            "prev": parsed[i - 1].get("period") if i > 0 else None,
            "next": parsed[i + 1].get("period") if i < len(parsed) - 1 else None,
        })
    manifest.reverse()
    return manifest


def build():
    load_dotenv(ROOT / ".env")
    holdings_rows = read_csv(DATA / "holdings.csv")
    fx_rows = read_csv(DATA / "fx.csv")
    nav_rows = read_csv(DATA / "nav.csv")

    fx = load_fx(fx_rows)

    # ---- optional live price refresh (off unless REFRESH_PRICES is set) ----
    price_resolver = None
    price_meta = {"enabled": False}
    if pricefetch.enabled():
        print("  refreshing live prices…")
        price_resolver, price_meta = pricefetch.refresh(holdings_rows)
        price_meta["enabled"] = True
        live_fx = price_meta.get("fx")
        if live_fx and live_fx.get("AUDUSD"):
            fx = {"AUDUSD": live_fx["AUDUSD"], "date": live_fx.get("date")}

    audusd = fx["AUDUSD"]
    to_aud = make_to_aud(audusd)

    holdings = parse_holdings(holdings_rows, to_aud, price_resolver)
    as_of = max((h["as_of_date"] for h in holdings if h["as_of_date"]), default=None)
    live_count = sum(1 for h in holdings if h.get("price_source") not in (None, "manual"))
    # Report only sources that actually marked a position (+ FX if live).
    used_sources = sorted({h["price_source"] for h in holdings
                           if h.get("price_source") not in (None, "manual")})
    if price_meta.get("enabled") and price_meta.get("fx"):
        used_sources.append("frankfurter (fx)")

    # ---- sleeve aggregates + weights ----
    sleeves = {b: summarise_sleeve(b, holdings) for b in BOOK_ORDER}
    book_total = sum(s["value_aud"] or 0.0 for s in sleeves.values())
    for s in sleeves.values():
        s["weight"] = r2((s["value_aud"] or 0.0) / book_total * 100) if book_total else None
    for h in holdings:
        if h["value_aud"] is not None and book_total:
            h["weight"] = r2(h["value_aud"] / book_total * 100)

    # ---- fund NAV = conviction + tactical ----
    fund_value = (sleeves["conviction"]["value_aud"] or 0.0) + (sleeves["tactical"]["value_aud"] or 0.0)
    fund_cost = (sleeves["conviction"]["cost_aud"] or 0.0) + (sleeves["tactical"]["cost_aud"] or 0.0)
    fund_pnl = (sleeves["conviction"]["pnl_aud"] or 0.0) + (sleeves["tactical"]["pnl_aud"] or 0.0)
    fund_positions = [h for h in holdings if h["book"] in ("conviction", "tactical")]

    data_fund = {
        "definition": "Conviction + Tactical",
        "value_aud": r2(fund_value),
        "cost_aud": r2(fund_cost),
        "pnl_aud": r2(fund_pnl),
        "return_pct": r2(fund_pnl / fund_cost * 100) if fund_cost else None,
        "position_count": len(fund_positions),
    }

    data = {
        "meta": {
            "generated_at": datetime.datetime.now(datetime.timezone.utc)
                .isoformat(timespec="seconds"),
            "base_currency": "AUD",
            "as_of_date": as_of,
            "fx": fx,
            "fx_note": ("live — Frankfurter (ECB)" if price_meta.get("enabled")
                        and price_meta.get("fx") else
                        "market rate — update data/fx.csv to refresh"),
            "has_fx": audusd is not None,
            "has_nav": len(nav_rows) > 0,
            "prices": {
                "live": price_meta.get("enabled", False),
                "live_count": live_count,
                "sources": used_sources,
                "equity_fetched": price_meta.get("equity_fetched", False),
                "ran_at": price_meta.get("ran_at"),
            },
            "books_display": BOOK_DISPLAY,
            "book_order": BOOK_ORDER,
        },
        "book_total_aud": r2(book_total),
        "fund": data_fund,
        "sleeves": sleeves,
        "holdings": holdings,
        "filters": {
            "book": [b for b in BOOK_ORDER if any(h["book"] == b for h in holdings)],
            "asset_class": sorted({h["asset_class"] for h in holdings if h["asset_class"]}),
            "venue": sorted({h["venue"] for h in holdings if h["venue"]}),
        },
        "exposure": compute_exposure(holdings, to_aud),
        "breakdowns": {
            "asset_class_counts": count_by(holdings, "asset_class"),
            "venue_counts": count_by(holdings, "venue"),
        },
        "performance": read_performance(nav_rows, sleeves, data_fund),
        "reports": process_reports(),
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")

    print(f"Wrote {OUT.relative_to(ROOT)}")
    if price_meta.get("enabled"):
        print(f"  live prices: {live_count} marked from {', '.join(price_meta.get('sources') or ['none'])}")
    else:
        print("  live prices: OFF (set REFRESH_PRICES=1 to fetch). Using CSV last_price.")
    print(f"  fx: AUDUSD={audusd}  |  book total: {data['book_total_aud']} AUD")
    for b in BOOK_ORDER:
        s = sleeves[b]
        print(f"    {s['display']:<12} value={s['value_aud']} AUD  "
              f"weight={s['weight']}%  return={s['return_pct']}%  ({s['count']} pos)")
    print(f"  fund NAV (Conv+Tac): {data['fund']['value_aud']} AUD  "
          f"return={data['fund']['return_pct']}%")
    print(f"  tactical exposure: gross_long={data['exposure']['gross_long']} AUD "
          f"net={data['exposure']['net']} AUD")
    print(f"  reports: {len(data['reports'])}")
    if not data["meta"]["has_nav"]:
        print("  NOTE: no nav.csv — the NAV-over-time chart is still SAMPLE.")


if __name__ == "__main__":
    build()
