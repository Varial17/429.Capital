#!/usr/bin/env python3
"""429 Capital build step.

One-way data flow:  data/*.csv  ->  build.py  ->  site/data/data.json

Reads the flat-CSV source of truth, computes the metrics it *can* derive from
the data present, and emits clearly-flagged placeholders for anything that needs
prices or NAV history we don't have yet. Python 3 standard library only.

Run:  python3 build.py
"""

import csv
import json
import datetime
from pathlib import Path

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
# Target weights across the whole book (per the spec / landing page).
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


def parse_holdings(rows):
    out = []
    for r in rows:
        qty = num(r.get("quantity"))
        entry = num(r.get("avg_entry"))
        cost_basis = qty * entry if (qty is not None and entry is not None) else None
        out.append({
            "book": clean(r.get("book")),
            "asset": clean(r.get("asset")),
            "asset_class": clean(r.get("asset_class")),
            "venue": clean(r.get("venue")),
            "quantity": qty,
            "avg_entry": entry,
            "currency": clean(r.get("currency")),
            "position_type": clean(r.get("position_type")),
            "leverage": num(r.get("leverage")),
            "tac_id": clean(r.get("tac_id")),
            "as_of_date": clean(r.get("as_of_date")),
            # Derived where possible; value/weight/pnl need live prices (pending).
            "cost_basis": round(cost_basis, 2) if cost_basis is not None else None,
            "value_aud": None,
            "weight": None,
            "pnl": None,
            "placeholder": {"value_aud": True, "weight": True, "pnl": True},
        })
    return out


def compute_exposure(holdings):
    """Tactical sleeve exposure — the one block we can compute for real.

    Notional is taken at entry price (no live mark yet), in the position's
    native currency. Long/short netted; counts are exact.
    """
    tac = [h for h in holdings if h["book"] == "tactical"]
    priced = [h for h in tac if h["quantity"] is not None and h["avg_entry"] is not None]

    gross_long = 0.0
    gross_short = 0.0
    long_count = 0
    short_count = 0
    positions = []
    currencies = set()

    for h in priced:
        notional = h["quantity"] * h["avg_entry"]
        currencies.add(h["currency"])
        if h["position_type"] == "short":
            gross_short += notional
            short_count += 1
        else:  # long (default for non-short tactical)
            gross_long += notional
            long_count += 1
        positions.append({
            "asset": h["asset"],
            "position_type": h["position_type"],
            "leverage": h["leverage"],
            "venue": h["venue"],
            "notional": round(notional, 2),
            "currency": h["currency"],
        })

    # Count tactical rows missing prices so the UI can disclose incompleteness.
    unpriced = len(tac) - len(priced)
    currency = currencies.pop() if len(currencies) == 1 else "mixed"

    return {
        "currency": currency,
        "basis": "entry",          # notional at entry price; live mark pending
        "gross_long": round(gross_long, 2),
        "gross_short": round(gross_short, 2),
        "net": round(gross_long - gross_short, 2),
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


def sample_performance():
    """Illustrative NAV-vs-benchmark series so the chart renders end-to-end.

    Flagged placeholder=True everywhere. Replace by populating data/nav.csv.
    """
    labels = ["May 24", "Jul", "Sep", "Nov", "Jan 25", "Mar", "May",
              "Jul", "Sep", "Nov", "Jan 26", "Mar", "May 26"]
    fund = [100.0, 102.2, 101.8, 106.4, 105.1, 109.8, 112.4,
            116.0, 114.3, 120.5, 123.8, 129.1, 138.4]
    bench = [100.0, 100.9, 102.4, 101.8, 104.1, 103.3, 105.6,
             107.2, 106.5, 108.8, 110.2, 112.4, 114.3]
    periods = [
        {"period": "1M", "fund": 4.2, "benchmark": 1.9},
        {"period": "3M", "fund": 7.2, "benchmark": 3.7},
        {"period": "6M", "fund": 11.8, "benchmark": 5.4},
        {"period": "12M", "fund": 22.6, "benchmark": 9.1},
        {"period": "Inception", "fund": 38.4, "benchmark": 14.3},
        {"period": "Inception p.a.", "fund": 17.1, "benchmark": 6.8},
    ]
    for p in periods:
        p["outperformance"] = round(p["fund"] - p["benchmark"], 1)
    return {
        "placeholder": True,
        "note": "Sample data — populate data/nav.csv for real figures.",
        "series": {"labels": labels, "fund": fund, "benchmark": bench},
        "periods": periods,
    }


def process_reports():
    """Discover reports/*.json, copy each into site/data/reports/, and build an
    ordered manifest with prev/next links so the report pages are self-contained.

    reports/ lives at repo root and is NOT served by Pages/Netlify (only site/ is),
    so the JSON must be copied under site/data/reports/ to be fetchable.
    """
    if not REPORTS.exists():
        return []
    OUT_REPORTS.mkdir(parents=True, exist_ok=True)
    # clear stale copies so deleted reports don't linger in the deploy
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

    # chronological order for prev/next (oldest -> newest)
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
    # newest first for the index listing
    manifest.reverse()
    return manifest


def build():
    holdings_rows = read_csv(DATA / "holdings.csv")
    fx_rows = read_csv(DATA / "fx.csv")
    nav_rows = read_csv(DATA / "nav.csv")

    holdings = parse_holdings(holdings_rows)
    has_fx = len(fx_rows) > 0
    has_nav = len(nav_rows) > 0

    as_of = max((h["as_of_date"] for h in holdings if h["as_of_date"]), default=None)

    fund_holdings = [h for h in holdings if h["book"] in ("conviction", "tactical")]

    data = {
        "meta": {
            "generated_at": datetime.datetime.now(datetime.timezone.utc)
                .isoformat(timespec="seconds"),
            "base_currency": "AUD",
            "as_of_date": as_of,
            "has_fx": has_fx,
            "has_nav": has_nav,
            "books_display": BOOK_DISPLAY,
        },
        "fund": {
            # Fund NAV = Conviction + Tactical. Real value needs live prices (pending).
            "definition": "Conviction + Tactical",
            "value_aud": None,
            "nav_per_unit": None,
            "monthly_return": None,
            "ytd_return": None,
            "placeholder": True,
            "position_count": len(fund_holdings),
        },
        "sleeves": {
            "display": BOOK_DISPLAY,
            "target_weights": TARGET_WEIGHTS,
            "counts": count_by(holdings, "book"),
            "current_weights": None,
            "current_weights_placeholder": True,
        },
        "holdings": holdings,
        "filters": {
            "book": sorted({h["book"] for h in holdings if h["book"]}),
            "asset_class": sorted({h["asset_class"] for h in holdings if h["asset_class"]}),
            "venue": sorted({h["venue"] for h in holdings if h["venue"]}),
        },
        "exposure": compute_exposure(holdings),
        "breakdowns": {
            "asset_class_counts": count_by(holdings, "asset_class"),
            "venue_counts": count_by(holdings, "venue"),
        },
        "performance": sample_performance(),
        "reports": process_reports(),
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")

    print(f"Wrote {OUT.relative_to(ROOT)}")
    print(f"  holdings: {len(holdings)}  |  fund positions: {len(fund_holdings)}")
    print(f"  tactical exposure: gross_long={data['exposure']['gross_long']} "
          f"{data['exposure']['currency']} (long {data['exposure']['long_count']}, "
          f"short {data['exposure']['short_count']})")
    print(f"  fx rows: {len(fx_rows)}  |  nav rows: {len(nav_rows)}  "
          f"|  reports: {len(data['reports'])}")
    if not has_nav:
        print("  NOTE: no nav.csv data — performance is SAMPLE/placeholder.")


if __name__ == "__main__":
    build()
