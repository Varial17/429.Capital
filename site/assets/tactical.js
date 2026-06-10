// 429 Capital — Tactical page.
// The Hyperliquid address + live fetch live in assets/hl-live.js (HL_LIVE),
// shared with the dashboard. This file just renders the page from a snapshot.
// Two layers:
//   1. LIVE — read-only pull from Hyperliquid (HL_LIVE.fetchSnapshot).
//   2. RECORD — the marked fill history baked into data.json by build.py (fallback).
// USD/USDC is converted to AUD at the fx.csv rate carried in data.json.

const REFRESH_MS = 45000;

const $ = (sel, root = document) => root.querySelector(sel);

// ---- theme toggle (shared behaviour with the dashboard) ----
(function initTheme() {
  if (localStorage.getItem("429-theme") === "light")
    document.documentElement.setAttribute("data-theme", "light");
})();
function toggleTheme() {
  const el = document.documentElement;
  const next = el.getAttribute("data-theme") === "light" ? "dark" : "light";
  if (next === "light") el.setAttribute("data-theme", "light");
  else el.removeAttribute("data-theme");
  localStorage.setItem("429-theme", next);
}
window.toggleTheme = toggleTheme;

// ---- formatting ----
const fmtPct = (n, sign = true) =>
  n == null || isNaN(n) ? "—" : (sign && n > 0 ? "+" : "") + Number(n).toFixed(1) + "%";
const fmtNum = (n, dp = 2) =>
  n == null || isNaN(n) ? "—" : Number(n).toLocaleString(undefined, { maximumFractionDigits: dp });
const fmtAUD = (n, dp = 0) =>
  n == null || isNaN(n) ? "—" : "$" + Number(n).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
const fmtUSD = (n, dp = 2) =>
  n == null || isNaN(n) ? "—" : "$" + Number(n).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
const signClass = (n) => (n == null || isNaN(n) ? "" : n >= 0 ? "pos" : "neg");

let DATA = null;
let FX = 0.65; // AUDUSD; overwritten from data.json. AUD = USD / FX.
const usdToAud = (usd) => (usd == null || isNaN(usd) ? null : Number(usd) / FX);

// ---- boot ----
(async function () {
  try {
    const res = await fetch("data/data.json", { cache: "no-store" });
    DATA = await res.json();
    if (DATA.meta && DATA.meta.fx && DATA.meta.fx.AUDUSD) FX = DATA.meta.fx.AUDUSD;
  } catch (e) {
    $("#app").innerHTML = `<p class="empty">Could not load data.json. Run <code>python3 build.py</code> first.</p>`;
    return;
  }

  // Instant fallback from the last recorded snapshot, then overlay live.
  const t = DATA.tactical || {};
  renderRecord(t);
  renderByAsset(t);
  renderTopTrades(t);
  renderRecentFills(t.recent_trades || [], "record");

  $("#refresh-btn").addEventListener("click", goLive);

  if (window.HL_LIVE && HL_LIVE.ADDRESS) {
    goLive();
    setInterval(() => { if (!document.hidden) goLive(); }, REFRESH_MS);
  } else {
    $("#live-note").innerHTML =
      `Add your public Hyperliquid wallet address in <code>assets/hl-live.js</code> (<code>HL_ADDRESS</code>) to pull live positions. Showing the recorded track record below.`;
    $("#tac-status").textContent = "· record only";
    renderLiveCardsFromRecord(t);
  }
})();

// ════════════════════════════════════════════════════════════════════════════
//  LIVE  — render from a HL_LIVE snapshot
// ════════════════════════════════════════════════════════════════════════════
async function goLive() {
  const btn = $("#refresh-btn");
  btn.disabled = true; btn.textContent = "…";
  try {
    const snap = await HL_LIVE.fetchSnapshot(FX);
    renderLive(snap);
    if (snap.summary) {
      renderRecord(snap.summary);
      renderByAsset(snap.summary);
      renderTopTrades(snap.summary);
    }
    renderRecentFills(snap.fills.slice(0, 18), "live");
    const now = new Date();
    $("#tac-status").innerHTML = `· <span class="px-live">● live</span> ${now.toLocaleTimeString()}`;
    $("#live-note").innerHTML = `Everything on this page pulled read-only from Hyperliquid for <code>${snap.address.slice(0, 6)}…${snap.address.slice(-4)}</code> · auto-refresh every ${REFRESH_MS / 1000}s.`;
  } catch (e) {
    $("#tac-status").innerHTML = `· <span class="neg">live fetch failed</span>`;
    $("#live-note").innerHTML = `Couldn't reach Hyperliquid (${e.message}). Showing the recorded track record.`;
    if (DATA.tactical) renderLiveCardsFromRecord(DATA.tactical);
  } finally {
    btn.disabled = false; btn.textContent = "Refresh";
  }
}

function renderLive(snap) {
  // open perp positions
  $("#pos-body").innerHTML = snap.positions.length
    ? snap.positions.map((p) => `<tr>
        <td style="font-family:var(--mono)">${p.coin}</td>
        <td><span class="tag book-tactical">${p.side}</span></td>
        <td class="num">${fmtNum(p.sizeAbs, 4)}</td>
        <td class="num">${fmtUSD(p.entryPx, 4)}</td>
        <td class="num">${fmtUSD(p.mark, 4)}</td>
        <td class="num">${fmtUSD(p.notionalUsd)}</td>
        <td class="num ${signClass(p.upnlUsd)}">${fmtUSD(p.upnlUsd)}</td>
        <td class="num ${signClass(p.roe)}">${fmtPct(p.roe)}</td>
        <td class="num">${p.lev ? p.lev + "×" : "—"}</td>
        <td class="num">${p.liqPx ? fmtUSD(p.liqPx, 4) : "—"}</td>
      </tr>`).join("")
    : `<tr><td colspan="10" class="empty">No open perp positions right now — flat on leverage.</td></tr>`;

  // spot balances (USDC, HYPE, …)
  const usdc = snap.spot.find((b) => b.coin === "USDC");
  const bits = snap.spot.filter((b) => !b.stable)
    .map((b) => `<code>${fmtNum(b.total, 4)} ${b.coin}</code>${b.valUsd != null ? " (" + fmtUSD(b.valUsd) + ")" : ""}`);
  $("#spot-note").innerHTML = snap.spot.length
    ? `Spot: <code>${fmtUSD(usdc ? usdc.total : 0)} USDC</code>` +
      (bits.length ? " · " + bits.join(" · ") : "") +
      ` — held on Hyperliquid, marked at spot.`
    : "";

  liveCards({
    accountAud: snap.account.accountAud,
    openPnlAud: snap.account.openPnlAud,
    realisedAud: snap.account.realisedAud != null ? snap.account.realisedAud
      : (DATA.tactical && DATA.tactical.realised_pnl_aud) || 0,
    netAud: snap.account.netAud,
    live: true,
  });
}

function liveCards({ accountAud, openPnlAud, realisedAud, netAud, live }) {
  $("#live-cards").innerHTML = `
    <div class="card">
      <div class="l">Account value</div>
      <div class="v">${fmtAUD(accountAud)} <span style="font-size:12px;color:var(--text-dim)">AUD</span></div>
      <div class="x">${live ? "perp equity + spot, live" : "from last record"}</div>
    </div>
    <div class="card">
      <div class="l">Open P&amp;L</div>
      <div class="v ${signClass(openPnlAud)}">${fmtAUD(openPnlAud)}</div>
      <div class="x">unrealised on open perps + spot</div>
    </div>
    <div class="card">
      <div class="l">Realised P&amp;L</div>
      <div class="v ${signClass(realisedAud)}">${fmtAUD(realisedAud)}</div>
      <div class="x">closed trades, all-time</div>
    </div>
    <div class="card">
      <div class="l">Net exposure</div>
      <div class="v">${fmtAUD(netAud)}</div>
      <div class="x">long − short, at mark</div>
    </div>`;
}

function renderLiveCardsFromRecord(t) {
  const a = t.account || {};
  liveCards({
    accountAud: a.collateral_aud,
    openPnlAud: a.open_pnl_aud,
    realisedAud: a.realised_pnl_aud,
    netAud: a.net_exposure_aud,
    live: false,
  });
  $("#pos-body").innerHTML = `<tr><td colspan="10" class="empty">Live positions appear once a wallet address is set.</td></tr>`;
}

// ════════════════════════════════════════════════════════════════════════════
//  TRACK RECORD  — from a summary (live HL_LIVE summary, or data.json fallback)
// ════════════════════════════════════════════════════════════════════════════
function renderRecord(t) {
  $("#record-cards").innerHTML = `
    <div class="card">
      <div class="l">Realised P&amp;L</div>
      <div class="v ${signClass(t.realised_pnl_aud)}">${fmtAUD(t.realised_pnl_aud)}</div>
      <div class="x">${t.close_count || 0} closed trades</div>
    </div>
    <div class="card">
      <div class="l">Win rate</div>
      <div class="v">${t.win_rate == null ? "—" : t.win_rate.toFixed(0) + "%"}</div>
      <div class="x">${t.wins || 0}W / ${t.losses || 0}L</div>
    </div>
    <div class="card">
      <div class="l">Volume</div>
      <div class="v">${fmtAUD(t.volume_aud)}</div>
      <div class="x">${t.trade_count || 0} fills traded</div>
    </div>
    <div class="card">
      <div class="l">Fees paid</div>
      <div class="v">${fmtAUD(t.fees_aud, 2)}</div>
      <div class="x">${t.first_trade ? "since " + t.first_trade.slice(0, 10) : ""}</div>
    </div>`;
}

function renderByAsset(t) {
  const assets = t.top_assets || [];
  $("#byasset-body").innerHTML = assets.length
    ? assets.map((a) => `<tr>
        <td><span style="font-family:var(--mono)">${a.asset}</span></td>
        <td class="num">${a.trade_count}</td>
        <td class="num">${a.win_rate == null ? "—" : a.win_rate.toFixed(0) + "%"}</td>
        <td class="num">${fmtAUD(a.notional_aud)}</td>
        <td class="num">${fmtAUD(a.fees_aud, 2)}</td>
        <td class="num ${signClass(a.realised_pnl_aud)}">${fmtAUD(a.realised_pnl_aud, 2)}</td>
      </tr>`).join("")
    : `<tr><td colspan="6" class="empty">No closed trades recorded yet.</td></tr>`;
}

function renderTopTrades(t) {
  const trades = t.top_trades || [];
  $("#top-trades").innerHTML = trades.length
    ? trades.map((x) => tradeRow(x)).join("")
    : `<p class="empty">No trades recorded.</p>`;
}

function renderRecentFills(trades, src) {
  $("#fills-src").textContent = src === "live" ? "Live from Hyperliquid" : "From record";
  if (!trades.length) { $("#recent-fills").innerHTML = `<p class="empty">No fills.</p>`; return; }
  $("#recent-fills").innerHTML = trades.map((x) => tradeRow(normFill(x))).join("");
}

// Normalise a raw Hyperliquid userFills row into the same shape as record trades.
function normFill(x) {
  if (x.closed_pnl_aud !== undefined) return x; // already a record-shape trade
  return {
    asset: HL_LIVE.cleanCoin(x.coin),
    dir: x.dir,
    size: Number(x.sz),
    price: Number(x.px),
    closed_pnl_aud: usdToAud(Number(x.closedPnl)),
    time: HL_LIVE.fmtFillTime(x.time),
  };
}

function tradeRow(x) {
  const pnl = x.closed_pnl_aud;
  const hasPnl = pnl != null && !isNaN(pnl) && (x.dir || "").startsWith("Close");
  return `<div class="trade-row">
    <div class="tr-main">
      <span class="tr-coin">${x.asset || "—"}</span>
      <span class="tr-dir">${x.dir || ""}</span>
    </div>
    <div class="tr-meta">${fmtNum(x.size, 4)} @ ${fmtUSD(x.price, 4)} · ${(x.time || "").slice(0, 16)}</div>
    <div class="tr-pnl ${hasPnl ? signClass(pnl) : ""}">${hasPnl ? fmtAUD(pnl, 2) : ""}</div>
  </div>`;
}
