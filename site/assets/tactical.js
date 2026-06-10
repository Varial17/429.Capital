// 429 Capital — Tactical page.
// Two layers:
//   1. LIVE — read-only pull from Hyperliquid's public `info` endpoint (no key, no auth).
//   2. RECORD — the marked fill history baked into data.json by build.py.
// USD/USDC is converted to AUD at the fx.csv rate carried in data.json.

// ─────────────────────────────────────────────────────────────────────────────
//  CONFIG — paste your PUBLIC Hyperliquid wallet address here (the 0x… address).
//  This is read-only and already public on-chain. It is NOT a secret/API key —
//  never put a private key or API-wallet secret in this file (it ships to the browser).
//  Leave blank to show the recorded history only.
const HL_ADDRESS = "0x8359748E15F177001d34390E81e927FB235BAe1C";
// ─────────────────────────────────────────────────────────────────────────────

const HL_API = "https://api.hyperliquid.xyz/info";
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
const titleCase = (s) => (s || "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

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

  const t = DATA.tactical || {};
  renderRecord(t);
  renderByAsset(t);
  renderTopTrades(t);
  renderRecentFills(t.recent_trades || [], "record");

  $("#refresh-btn").addEventListener("click", goLive);

  if (HL_ADDRESS) {
    goLive();
    setInterval(() => { if (!document.hidden) goLive(); }, REFRESH_MS);
  } else {
    $("#live-note").innerHTML =
      `Add your public Hyperliquid wallet address in <code>assets/tactical.js</code> (<code>HL_ADDRESS</code>) to pull live positions. Showing the recorded track record below.`;
    $("#tac-status").textContent = "· record only";
    renderLiveCardsFromRecord(t);
  }
})();

// ════════════════════════════════════════════════════════════════════════════
//  LIVE  — Hyperliquid public info endpoint
// ════════════════════════════════════════════════════════════════════════════
async function hlPost(body) {
  const res = await fetch(HL_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("HL " + res.status);
  return res.json();
}

async function goLive() {
  const btn = $("#refresh-btn");
  btn.disabled = true; btn.textContent = "…";
  try {
    const [perp, spot, fills, mids] = await Promise.all([
      hlPost({ type: "clearinghouseState", user: HL_ADDRESS }),
      hlPost({ type: "spotClearinghouseState", user: HL_ADDRESS }).catch(() => null),
      hlPost({ type: "userFills", user: HL_ADDRESS }).catch(() => null),
      hlPost({ type: "allMids" }).catch(() => ({})),
    ]);
    renderLive(perp, spot, mids);
    if (Array.isArray(fills) && fills.length) renderRecentFills(fills.slice(0, 16), "live");
    const now = new Date();
    $("#tac-status").innerHTML = `· <span class="px-live">● live</span> ${now.toLocaleTimeString()}`;
    $("#live-note").innerHTML = `Pulled read-only from Hyperliquid for <code>${HL_ADDRESS.slice(0, 6)}…${HL_ADDRESS.slice(-4)}</code> · auto-refresh every ${REFRESH_MS / 1000}s.`;
  } catch (e) {
    $("#tac-status").innerHTML = `· <span class="neg">live fetch failed</span>`;
    $("#live-note").innerHTML = `Couldn't reach Hyperliquid (${e.message}). Showing the recorded track record.`;
    if (DATA.tactical) renderLiveCardsFromRecord(DATA.tactical);
  } finally {
    btn.disabled = false; btn.textContent = "Refresh";
  }
}

const STABLES = new Set(["USDC", "USDT", "USDT0", "USDE", "USDH", "DAI", "USD"]);

function renderLive(perp, spot, mids) {
  const ms = (perp && perp.marginSummary) || {};
  const perpEquityUsd = Number(ms.accountValue) || 0;
  const positions = (perp && perp.assetPositions) || [];

  // ── perp open positions ──
  let perpPnlUsd = 0, longUsd = 0, shortUsd = 0;
  const rows = positions.map((ap) => {
    const p = ap.position || {};
    const szi = Number(p.szi);                       // signed size
    const side = szi >= 0 ? "long" : "short";
    const notional = Math.abs(Number(p.positionValue));
    const upnl = Number(p.unrealizedPnl);
    const mark = mids && mids[p.coin] != null ? Number(mids[p.coin])
      : (szi ? notional / Math.abs(szi) : null);
    perpPnlUsd += isNaN(upnl) ? 0 : upnl;
    if (szi >= 0) longUsd += notional; else shortUsd += notional;
    const lev = p.leverage || {};
    const roe = p.returnOnEquity != null ? Number(p.returnOnEquity) * 100 : null;
    return `<tr>
      <td style="font-family:var(--mono)">${p.coin}</td>
      <td><span class="tag book-tactical">${side}</span></td>
      <td class="num">${fmtNum(Math.abs(szi), 4)}</td>
      <td class="num">${fmtUSD(Number(p.entryPx), 4)}</td>
      <td class="num">${fmtUSD(mark, 4)}</td>
      <td class="num">${fmtUSD(notional)}</td>
      <td class="num ${signClass(upnl)}">${fmtUSD(upnl)}</td>
      <td class="num ${signClass(roe)}">${fmtPct(roe)}</td>
      <td class="num">${lev.value ? lev.value + "×" : "—"}</td>
      <td class="num">${p.liquidationPx ? fmtUSD(Number(p.liquidationPx), 4) : "—"}</td>
    </tr>`;
  });
  $("#pos-body").innerHTML = rows.length
    ? rows.join("")
    : `<tr><td colspan="10" class="empty">No open perp positions right now — flat on leverage.</td></tr>`;

  // ── spot balances (USDC, HYPE, …) ──
  const balances = ((spot && spot.balances) || []).filter((b) => Number(b.total) > 0);
  let spotUsd = 0, spotPnlUsd = 0;
  const spotBits = [];
  for (const b of balances) {
    const total = Number(b.total);
    const mark = STABLES.has(b.coin) ? 1 : (mids && mids[b.coin] != null ? Number(mids[b.coin]) : null);
    const val = mark == null ? null : total * mark;
    if (val != null) spotUsd += val;
    const entryNtl = Number(b.entryNtl) || 0;
    if (val != null && entryNtl > 0 && !STABLES.has(b.coin)) spotPnlUsd += val - entryNtl;
    if (!STABLES.has(b.coin)) {
      spotBits.push(`<code>${fmtNum(total, 4)} ${b.coin}</code>${val != null ? " (" + fmtUSD(val) + ")" : ""}`);
    }
  }
  const usdcBal = balances.find((b) => b.coin === "USDC");
  $("#spot-note").innerHTML = balances.length
    ? `Spot: <code>${fmtUSD(usdcBal ? Number(usdcBal.total) : 0)} USDC</code>` +
      (spotBits.length ? " · " + spotBits.join(" · ") : "") +
      ` — held on Hyperliquid, marked at spot.`
    : "";

  // ── headline cards: perp equity + spot, combined ──
  const accountUsd = perpEquityUsd + spotUsd;
  const openPnlUsd = perpPnlUsd + spotPnlUsd;
  const realisedAud = (DATA.tactical && DATA.tactical.realised_pnl_aud) || 0;
  liveCards({
    accountAud: usdToAud(accountUsd),
    openPnlAud: usdToAud(openPnlUsd),
    realisedAud,
    netAud: usdToAud(longUsd - shortUsd),
    live: true,
  });
}

function liveCards({ accountAud, openPnlAud, realisedAud, netAud, withdrawableAud, live }) {
  const totalPnl = (openPnlAud || 0) + (realisedAud || 0);
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
//  RECORD  — from data.json (build.py / hyperliquid_trades.csv)
// ════════════════════════════════════════════════════════════════════════════
function renderRecord(t) {
  const a = t.account || {};
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
  const pnlUsd = Number(x.closedPnl);
  const t = x.time ? new Date(Number(x.time)) : null;
  // Strip the "xyz:" perp-dex prefix; show bare spot-pair indices (@NNN) as "spot".
  const coin = (x.coin || "").replace(/^xyz:/, "").replace(/^@\d+$/, "spot");
  return {
    asset: coin,
    dir: x.dir,
    size: Number(x.sz),
    price: Number(x.px),
    closed_pnl_aud: usdToAud(pnlUsd),
    time: t ? t.toISOString().slice(0, 16).replace("T", " ") : "",
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
