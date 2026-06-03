// 429 Capital — dashboard rendering. Reads site/data/data.json, draws with Chart.js v4.
// Values are marked to market from prices + fx in the CSVs; anything still missing a
// price or cost is shown as "—" and flagged, never invented.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---- theme toggle (persisted) ----
(function initTheme() {
  const saved = localStorage.getItem("429-theme");
  if (saved === "light") document.documentElement.setAttribute("data-theme", "light");
})();
function toggleTheme() {
  const el = document.documentElement;
  const next = el.getAttribute("data-theme") === "light" ? "dark" : "light";
  if (next === "light") el.setAttribute("data-theme", "light");
  else el.removeAttribute("data-theme");
  localStorage.setItem("429-theme", next);
  if (window.__redrawCharts) window.__redrawCharts();
}
window.toggleTheme = toggleTheme;

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const titleCase = (s) =>
  (s || "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const fmtPct = (n, sign = true) =>
  n == null ? "—" : (sign && n > 0 ? "+" : "") + n.toFixed(1) + "%";
const fmtNum = (n, dp = 2) =>
  n == null ? "—" : n.toLocaleString(undefined, { maximumFractionDigits: dp });
const fmtAUD = (n, dp = 0) =>
  n == null ? "—" : "$" + n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
const signClass = (n) => (n == null ? "" : n >= 0 ? "pos" : "neg");

// ---- boot ----
let DATA = null;
const charts = [];

(async function () {
  try {
    const res = await fetch("data/data.json", { cache: "no-store" });
    DATA = await res.json();
  } catch (e) {
    $("#app").innerHTML =
      `<p class="empty">Could not load data.json. Run <code>python3 build.py</code> first.</p>`;
    return;
  }
  renderMeta();
  renderHeadline();
  renderSleeves();
  renderSleevePerf();
  renderPerformance();
  renderHoldings();
  renderExposure();
  window.__redrawCharts = redrawCharts;
})();

function renderMeta() {
  const m = DATA.meta;
  const fx = m.fx && m.fx.AUDUSD ? ` · AUDUSD ${m.fx.AUDUSD}` : "";
  const p = m.prices || {};
  let prices;
  if (p.live && p.live_count) {
    prices = ` · <span class="px-live" title="${(p.sources || []).join(', ')}${p.ran_at ? ' — ' + p.ran_at : ''}">● ${p.live_count} live</span>`;
  } else {
    prices = ` · <span class="px-manual" title="prices entered by hand in data/holdings.csv">○ manual prices</span>`;
  }
  $("#asof").innerHTML = (m.as_of_date ? `As of ${m.as_of_date}` : "") + fx + prices;
}

// ---------- Headline ----------
function renderHeadline() {
  const f = DATA.fund;
  const cards = [
    { l: "Book Value (AUD)", v: fmtAUD(DATA.book_total_aud), x: "All three sleeves" },
    { l: "Fund NAV (AUD)", v: fmtAUD(f.value_aud), x: f.definition },
    { l: "Fund P&L", v: fmtAUD(f.pnl_aud), x: "Return " + fmtPct(f.return_pct), cls: signClass(f.pnl_aud) },
    { l: "Positions", v: String(f.position_count), x: "In the fund" },
  ];
  $("#headline-cards").innerHTML = cards.map((c) => `
    <div class="card">
      <div class="l">${c.l}</div>
      <div class="v ${c.cls || ""}">${c.v}</div>
      <div class="x">${c.x || ""}</div>
    </div>`).join("");
}

// ---------- Sleeves (the deviation between the three) ----------
const ROLE = { passive: "Benchmark", conviction: "Owned outright", tactical: "Leveraged" };

function renderSleeves() {
  const order = DATA.meta.book_order || ["passive", "conviction", "tactical"];
  const total = DATA.book_total_aud || 0;
  $("#sleeve-grid").innerHTML = order.map((b) => {
    const s = DATA.sleeves[b];
    const wt = s.weight == null ? 0 : s.weight;
    const tgt = s.target_weight == null ? null : s.target_weight * 100;
    const ret = s.return_pct;
    const retStr = ret == null
      ? `<span class="dash" title="cost basis incomplete">—</span>`
      : `<span class="${signClass(ret)}">${fmtPct(ret)}</span>`;
    const note = s.uncosted && s.uncosted.length
      ? `<div class="sc-meta">return excl. ${s.uncosted.join(", ")} (no cost recorded)</div>` : "";
    return `<div class="sleeve-card ${b === "passive" ? "is-bench" : ""}">
      <div class="sc-head">
        <span class="sc-name">${s.display}</span>
        <span class="sc-role">${ROLE[b] || ""}</span>
      </div>
      <div class="sc-value">${fmtAUD(s.value_aud)}</div>
      <div class="sc-sub">Return ${retStr} · ${s.count} positions</div>
      ${note}
      <div class="wbar">
        <span class="wbar-fill" style="width:${Math.min(wt, 100)}%"></span>
        ${tgt == null ? "" : `<span class="wbar-target" style="left:${Math.min(tgt, 100)}%" title="target ${tgt}%"></span>`}
      </div>
      <div class="wrow"><span>Weight ${fmtNum(wt, 1)}%</span><span>${tgt == null ? "" : `Target ${tgt}%`}</span></div>
    </div>`;
  }).join("");

  $("#sleeves-note").textContent =
    "Bar = current weight of total book; tick = long-run target. Fund NAV counts Conviction + Tactical; Wealth Base runs as the benchmark.";
}

// ---------- Sleeve performance table ----------
function renderSleevePerf() {
  const order = DATA.meta.book_order || ["passive", "conviction", "tactical"];
  const rows = order.map((b) => {
    const s = DATA.sleeves[b];
    return `<tr>
      <td><span class="tag book-${b}">${s.display}</span></td>
      <td class="num">${fmtAUD(s.value_aud)}</td>
      <td class="num">${fmtAUD(s.cost_aud)}</td>
      <td class="num ${signClass(s.pnl_aud)}">${fmtAUD(s.pnl_aud)}</td>
      <td class="num ${signClass(s.return_pct)}">${fmtPct(s.return_pct)}</td>
      <td class="num">${fmtNum(s.weight, 1)}%</td>
      <td class="num">${s.target_weight == null ? "—" : Math.round(s.target_weight * 100) + "%"}</td>
    </tr>`;
  });
  const f = DATA.fund;
  rows.push(`<tr style="border-top:1px solid var(--border-strong)">
    <td><strong>Fund NAV</strong></td>
    <td class="num">${fmtAUD(f.value_aud)}</td>
    <td class="num">${fmtAUD(f.cost_aud)}</td>
    <td class="num ${signClass(f.pnl_aud)}">${fmtAUD(f.pnl_aud)}</td>
    <td class="num ${signClass(f.return_pct)}">${fmtPct(f.return_pct)}</td>
    <td class="num">—</td><td class="num">—</td>
  </tr>`);
  $("#sleeve-perf-body").innerHTML = rows.join("");
}

// ---------- Performance chart (still sample until nav.csv) ----------
function renderPerformance() {
  const p = DATA.performance;
  if (p.placeholder) $("#perf-badge").style.display = "inline-block";
  const c = p.series;
  drawLine("perf-line", c.labels, c.fund, c.benchmark);
}

// ---------- Holdings ----------
const filters = { book: new Set(), asset_class: new Set(), venue: new Set() };
let sortKey = "value_aud";
let sortDir = -1;

function renderHoldings() {
  const fdef = DATA.filters;
  const groups = [
    ["book", fdef.book],
    ["asset_class", fdef.asset_class],
    ["venue", fdef.venue],
  ];
  $("#chips").innerHTML = groups.map(([key, vals]) => `
    <div class="chip-group">
      <span class="gl">${titleCase(key)}</span>
      ${vals.map((v) => `<button class="chip" data-key="${key}" data-val="${v}">${titleCase(v)}</button>`).join("")}
    </div>`).join("");

  $$(".chip").forEach((chip) =>
    chip.addEventListener("click", () => {
      const { key, val } = chip.dataset;
      if (filters[key].has(val)) { filters[key].delete(val); chip.classList.remove("on"); }
      else { filters[key].add(val); chip.classList.add("on"); }
      drawHoldingsTable();
    }));

  $$("#holdings-table th.sortable").forEach((th) =>
    th.addEventListener("click", () => {
      const k = th.dataset.key;
      if (sortKey === k) sortDir *= -1; else { sortKey = k; sortDir = k === "asset" ? 1 : -1; }
      drawHoldingsTable();
    }));

  $("#holdings-note").textContent = DATA.meta.has_fx
    ? "Marked to market from latest recorded prices, converted to AUD at the fx.csv rate. Dashes = price or cost not yet recorded."
    : "No fx rate in data/fx.csv — non-AUD values cannot be converted yet.";

  drawHoldingsTable();
}

function passesFilters(h) {
  return ["book", "asset_class", "venue"].every(
    (k) => filters[k].size === 0 || filters[k].has(h[k]));
}

function drawHoldingsTable() {
  let rows = DATA.holdings.filter(passesFilters);
  rows.sort((a, b) => {
    const av = a[sortKey], bv = b[sortKey];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * sortDir;
    return String(av).localeCompare(String(bv)) * sortDir;
  });

  $("#holdings-count").textContent = `${rows.length} / ${DATA.holdings.length}`;
  $$("#holdings-table th.sortable .arrow").forEach((a) => (a.textContent = ""));
  const active = $(`#holdings-table th[data-key="${sortKey}"] .arrow`);
  if (active) active.textContent = sortDir > 0 ? "▲" : "▼";

  if (!rows.length) {
    $("#holdings-body").innerHTML = `<tr><td colspan="9" class="empty">No positions match the filters.</td></tr>`;
    return;
  }
  $("#holdings-body").innerHTML = rows.map((h) => {
    const lev = h.leverage ? ` ${h.leverage}×` : "";
    // Perps are cross-margined: capital lives in the USDC collateral line, so
    // show their leveraged notional (muted) instead of a misleading $0 value.
    let valueCell;
    if (h.is_collateralised) {
      valueCell = h.notional_aud == null
        ? '<span class="dash" title="needs price">—</span>'
        : `<span class="dash" title="leveraged notional — capital sits in the USDC collateral line">${fmtAUD(h.notional_aud)} exp.</span>`;
    } else {
      valueCell = h.value_aud == null
        ? '<span class="dash" title="needs price">—</span>'
        : fmtAUD(h.value_aud);
    }
    const weightCell = h.is_collateralised
      ? '<span class="dash">—</span>'
      : (h.weight == null ? '<span class="dash">—</span>' : fmtNum(h.weight, 1) + "%");
    return `<tr>
      <td><span class="tag book-${h.book}">${DATA.meta.books_display[h.book] || h.book}</span></td>
      <td style="font-family:var(--mono)">${h.asset}</td>
      <td>${titleCase(h.asset_class)}</td>
      <td>${titleCase(h.venue)}</td>
      <td>${h.position_type}${lev}</td>
      <td class="num">${h.quantity == null ? '<span class="dash">—</span>' : fmtNum(h.quantity, 4)}</td>
      <td class="num">${valueCell}</td>
      <td class="num">${weightCell}</td>
      <td class="num ${signClass(h.pnl_pct)}">${h.pnl_pct == null ? '<span class="dash" title="no cost recorded">—</span>' : fmtPct(h.pnl_pct)}</td>
    </tr>`;
  }).join("");
}

// ---------- Exposure ----------
function renderExposure() {
  const e = DATA.exposure;
  const cur = e.currency;
  const levTxt = e.leverage != null ? `${e.leverage}× on collateral` : "";
  $("#expo-cards").innerHTML = `
    <div class="card">
      <div class="l">Collateral</div>
      <div class="v">${fmtAUD(e.collateral_aud)} <span style="font-size:12px;color:var(--text-dim)">${cur}</span></div>
      <div class="x">account equity backing the book</div>
    </div>
    <div class="card">
      <div class="l">Gross Long</div>
      <div class="v">${fmtAUD(e.gross_long)} <span style="font-size:12px;color:var(--text-dim)">${cur}</span></div>
      <div class="x">${levTxt}</div>
    </div>
    <div class="card">
      <div class="l">Open P&amp;L</div>
      <div class="v ${signClass(e.open_pnl_aud)}">${fmtAUD(e.open_pnl_aud)} <span style="font-size:12px;color:var(--text-dim)">${cur}</span></div>
      <div class="x">unrealised, marked now</div>
    </div>
    <div class="card">
      <div class="l">Positions</div>
      <div class="v">${e.long_count}L / ${e.short_count}S</div>
      <div class="x">${e.unpriced_count ? e.unpriced_count + " unpriced" : "all marked"}</div>
    </div>`;

  $("#expo-note").innerHTML = e.positions.length
    ? `Perp legs are cross-margined against the collateral above — their margin isn't double-counted in sleeve value. Notional shown at current mark, ROE on entry margin. ` +
      e.positions.map((p) =>
        `${p.asset} ${p.leverage || ""}× ${p.position_type} ${fmtAUD(p.notional_aud)} (${fmtPct(p.pnl_pct)})`).join(" · ")
    : "No tactical positions with prices yet.";

  const counts = DATA.breakdowns.asset_class_counts;
  const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  $("#expo-bars").innerHTML = entries.map(([k, n]) => {
    const pct = Math.round((n / total) * 100);
    return `<div class="bar-row">
      <span class="bl">${titleCase(k)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${pct}%"></span></span>
      <span class="bn">${n}</span>
    </div>`;
  }).join("");
}

// ---------- Charts ----------
function drawLine(id, labels, fund, bench) {
  const ctx = document.getElementById(id);
  if (!ctx) return;
  const text = cssVar("--text"), dim = cssVar("--text-dim"), grid = cssVar("--border");
  charts.push(new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "429 Capital", data: fund, borderColor: text, borderWidth: 2.4,
          tension: 0.25, pointRadius: 0, pointHoverRadius: 4, fill: false },
        { label: "Benchmark", data: bench, borderColor: dim, borderWidth: 1.4,
          borderDash: [5, 4], tension: 0.25, pointRadius: 0, pointHoverRadius: 4, fill: false },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: false },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y}` } } },
      scales: {
        x: { grid: { display: false }, ticks: { color: dim, maxRotation: 0, autoSkip: true,
          font: { family: cssVar("--mono"), size: 10 } } },
        y: { grid: { color: grid }, ticks: { color: dim,
          font: { family: cssVar("--mono"), size: 10 } } },
      },
    },
  }));
}

function redrawCharts() {
  while (charts.length) charts.pop().destroy();
  renderPerformance();
}
