// 429 Capital — shared Hyperliquid live layer.
// Read-only pull from Hyperliquid's public `info` endpoint (no key, no auth,
// CORS open). Used by BOTH the Tactical page and the Dashboard so the address
// and the maths live in exactly one place.
//
//  CONFIG — your PUBLIC Hyperliquid wallet address (the 0x… address).
//  Read-only, already public on-chain. NEVER a private key or API-wallet secret
//  (this file ships to the browser).
const HL_ADDRESS = "0x8359748E15F177001d34390E81e927FB235BAe1C";

(function () {
  const HL_API = "https://api.hyperliquid.xyz/info";
  const STABLES = new Set(["USDC", "USDT", "USDT0", "USDE", "USDH", "DAI", "USD"]);

  async function hlPost(body) {
    const res = await fetch(HL_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error("HL " + res.status);
    return res.json();
  }

  // Strip the "xyz:" perp-dex prefix; show bare spot-pair indices (@NNN) as "spot".
  const cleanCoin = (c) => (c || "").replace(/^xyz:/, "").replace(/^@\d+$/, "spot");
  function fmtFillTime(ms) {
    if (!ms) return "";
    const d = new Date(Number(ms));
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // Raw Hyperliquid userFills → summary (same shape build.py emits), in AUD.
  // Perp opens/closes drive the trade stats; spot buys/sells are holdings, not
  // closed trades, so they're kept out of realised/win-rate.
  function summariseFills(fills, toAud) {
    const sorted = [...fills].sort((a, b) => Number(a.time) - Number(b.time));
    const perp = [], byCoin = {};
    let realisedUsd = 0, feesUsd = 0, volumeUsd = 0, closeCount = 0, wins = 0, losses = 0;

    for (const f of sorted) {
      const dir = f.dir || "";
      if (!/Long|Short/.test(dir)) continue;       // skip spot Buy/Sell
      const coin = cleanCoin(f.coin);
      const px = Number(f.px), sz = Number(f.sz);
      const notional = px * sz;
      const pnl = Number(f.closedPnl) || 0;
      const fee = Number(f.fee) || 0;
      const isClose = dir.startsWith("Close");

      realisedUsd += pnl; feesUsd += fee; volumeUsd += notional;
      if (isClose) { closeCount++; if (pnl > 0) wins++; else if (pnl < 0) losses++; }

      const b = byCoin[coin] || (byCoin[coin] = {
        asset: coin, trade_count: 0, closes: 0, wins: 0,
        notionalUsd: 0, feesUsd: 0, realisedUsd: 0,
      });
      b.trade_count++; b.notionalUsd += notional; b.feesUsd += fee; b.realisedUsd += pnl;
      if (isClose) { b.closes++; if (pnl > 0) b.wins++; }

      perp.push({
        asset: coin, dir, size: sz, price: px,
        closed_pnl_aud: toAud(pnl), time: fmtFillTime(f.time), _pnlUsd: pnl, _isClose: isClose,
      });
    }

    const top_assets = Object.values(byCoin)
      .map((b) => ({
        asset: b.asset, trade_count: b.trade_count,
        win_rate: b.closes ? (b.wins / b.closes) * 100 : null,
        notional_aud: toAud(b.notionalUsd), fees_aud: toAud(b.feesUsd),
        realised_pnl_aud: toAud(b.realisedUsd),
      }))
      .sort((a, b) => (b.realised_pnl_aud || 0) - (a.realised_pnl_aud || 0));

    const top_trades = perp.filter((t) => t._isClose)
      .sort((a, b) => b._pnlUsd - a._pnlUsd).slice(0, 8);

    return {
      realised_pnl_aud: toAud(realisedUsd), fees_aud: toAud(feesUsd), volume_aud: toAud(volumeUsd),
      trade_count: perp.length, close_count: closeCount, wins, losses,
      win_rate: closeCount ? (wins / closeCount) * 100 : null,
      first_trade: perp.length ? perp[0].time : null,
      top_assets, top_trades,
    };
  }

  // Pull everything for the address and normalise it once. `fx` is AUDUSD
  // (AUD = USD / fx). Returns null fields gracefully if a sub-call fails.
  async function fetchSnapshot(fx) {
    const toAud = (usd) => (usd == null || isNaN(usd) ? null : Number(usd) / fx);
    const [perp, spot, fills, mids] = await Promise.all([
      hlPost({ type: "clearinghouseState", user: HL_ADDRESS }),
      hlPost({ type: "spotClearinghouseState", user: HL_ADDRESS }).catch(() => null),
      hlPost({ type: "userFills", user: HL_ADDRESS }).catch(() => null),
      hlPost({ type: "allMids" }).catch(() => ({})),
    ]);

    // open perp positions
    let perpPnlUsd = 0, longUsd = 0, shortUsd = 0;
    const positions = ((perp && perp.assetPositions) || []).map((ap) => {
      const p = ap.position || {};
      const szi = Number(p.szi);
      const notionalUsd = Math.abs(Number(p.positionValue));
      const upnlUsd = Number(p.unrealizedPnl);
      const mark = mids && mids[p.coin] != null ? Number(mids[p.coin])
        : (szi ? notionalUsd / Math.abs(szi) : null);
      perpPnlUsd += isNaN(upnlUsd) ? 0 : upnlUsd;
      if (szi >= 0) longUsd += notionalUsd; else shortUsd += notionalUsd;
      return {
        coin: p.coin, side: szi >= 0 ? "long" : "short", szi, sizeAbs: Math.abs(szi),
        entryPx: Number(p.entryPx), mark, notionalUsd, notionalAud: toAud(notionalUsd),
        upnlUsd, upnlAud: toAud(upnlUsd),
        roe: p.returnOnEquity != null ? Number(p.returnOnEquity) * 100 : null,
        lev: p.leverage && p.leverage.value ? p.leverage.value : null,
        liqPx: p.liquidationPx ? Number(p.liquidationPx) : null,
      };
    });

    // spot balances
    const balances = ((spot && spot.balances) || []).filter((b) => Number(b.total) > 0);
    let spotUsd = 0, spotPnlUsd = 0;
    const spotList = balances.map((b) => {
      const total = Number(b.total);
      const mark = STABLES.has(b.coin) ? 1 : (mids && mids[b.coin] != null ? Number(mids[b.coin]) : null);
      const valUsd = mark == null ? null : total * mark;
      if (valUsd != null) spotUsd += valUsd;
      const entryNtl = Number(b.entryNtl) || 0;
      if (valUsd != null && entryNtl > 0 && !STABLES.has(b.coin)) spotPnlUsd += valUsd - entryNtl;
      return { coin: b.coin, total, valUsd, valAud: toAud(valUsd), stable: STABLES.has(b.coin) };
    });

    const perpEquityUsd = Number(perp && perp.marginSummary && perp.marginSummary.accountValue) || 0;
    const accountUsd = perpEquityUsd + spotUsd;
    const openPnlUsd = perpPnlUsd + spotPnlUsd;
    const summary = Array.isArray(fills) ? summariseFills(fills, toAud) : null;

    return {
      address: HL_ADDRESS, fx, mids,
      account: {
        accountUsd, accountAud: toAud(accountUsd),
        perpEquityUsd, spotUsd,
        openPnlUsd, openPnlAud: toAud(openPnlUsd),
        netUsd: longUsd - shortUsd, netAud: toAud(longUsd - shortUsd),
        grossLongUsd: longUsd, grossLongAud: toAud(longUsd),
        grossShortUsd: shortUsd, grossShortAud: toAud(shortUsd),
        realisedAud: summary ? summary.realised_pnl_aud : null,
        longCount: positions.filter((p) => p.szi >= 0).length,
        shortCount: positions.filter((p) => p.szi < 0).length,
      },
      positions, spot: spotList, summary, fills: fills || [],
    };
  }

  window.HL_LIVE = { ADDRESS: HL_ADDRESS, fetchSnapshot, summariseFills, cleanCoin, fmtFillTime, STABLES };
})();
