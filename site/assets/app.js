// 429 Capital — dashboard rendering. Reads site/data/data.json, draws with Chart.js v4.
// All price/NAV-dependent values are placeholders until the CSVs are filled; the UI
// marks them clearly rather than inventing numbers.

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
  // redraw charts so they pick up new colours
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
const fmtNum = (n) =>
  n == null ? "—" : n.toLocaleString(undefined, { maximumFractionDigits: 2 });

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
  renderOverview();
  renderPerformance();
  renderHoldings();
  renderExposure();
  window.__redrawCharts = redrawCharts;
})();

function renderMeta() {
  const m = DATA.meta;
  $("#asof").textContent = m.as_of_date ? `As of ${m.as_of_date}` : "";
}

// ---------- Overview ----------
function renderOverview() {
  const f = DATA.fund;
  const s = DATA.sleeves;
  const cards = [
    { l: "Fund Value (AUD)", v: f.value_aud == null ? "—" : "$" + fmtNum(f.value_aud),
      ph: f.placeholder, x: f.definition },
    { l: "NAV / Unit", v: f.nav_per_unit == null ? "—" : fmtNum(f.nav_per_unit),
      ph: f.placeholder, x: "Monthly series" },
    { l: "Monthly Return", v: fmtPct(f.monthly_return), ph: f.placeholder, x: "Latest month" },
    { l: "YTD Return", v: fmtPct(f.ytd_return), ph: f.placeholder, x: "Year to date" },
  ];
  $("#overview-cards").innerHTML = cards.map((c) => `
    <div class="card ${c.ph ? "is-placeholder" : ""}">
      <div class="l">${c.l}</div>
      <div class="v">${c.v}</div>
      <div class="x">${c.x || ""}</div>
    </div>`).join("");

  // sleeve allocation donut — target weights (current weights need live prices)
  const books = ["passive", "conviction", "tactical"];
  const labels = books.map((b) => s.display[b]);
  const values = books.map((b) => Math.round((s.target_weights[b] || 0) * 100));
  drawDonut("donut-sleeves", labels, values);
  $("#donut-counts").innerHTML = books.map((b) => `
    <div class="bar-row">
      <span class="bl">${s.display[b]}</span>
      <span class="bn">${s.counts[b] || 0} pos · target ${Math.round((s.target_weights[b]||0)*100)}%</span>
    </div>`).join("");
}

// ---------- Performance ----------
function renderPerformance() {
  const p = DATA.performance;
  if (p.placeholder) $("#perf-badge").style.display = "inline-block";

  const c = p.series;
  drawLine("perf-line", c.labels, c.fund, c.benchmark);

  $("#perf-table-body").innerHTML = p.periods.map((row) => `
    <tr>
      <td>${row.period}</td>
      <td class="num">${fmtPct(row.fund)}</td>
      <td class="num">${fmtPct(row.benchmark)}</td>
      <td class="num ${row.outperformance >= 0 ? "pos" : "neg"}">${fmtPct(row.outperformance)}</td>
    </tr>`).join("");
}

// ---------- Holdings ----------
const filters = { book: new Set(), asset_class: new Set(), venue: new Set() };
let sortKey = "book";
let sortDir = 1;

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
      if (sortKey === k) sortDir *= -1; else { sortKey = k; sortDir = 1; }
      drawHoldingsTable();
    }));

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
    $("#holdings-body").innerHTML = `<tr><td colspan="8" class="empty">No positions match the filters.</td></tr>`;
    return;
  }
  $("#holdings-body").innerHTML = rows.map((h) => `
    <tr>
      <td><span class="tag book-${h.book}">${DATA.meta.books_display[h.book] || h.book}</span></td>
      <td style="font-family:var(--mono)">${h.asset}</td>
      <td>${titleCase(h.asset_class)}</td>
      <td>${titleCase(h.venue)}</td>
      <td>${h.position_type}${h.leverage ? ` ${h.leverage}×` : ""}</td>
      <td class="num">${h.quantity == null ? '<span class="dash">—</span>' : fmtNum(h.quantity)}</td>
      <td class="num">${h.value_aud == null ? '<span class="dash" title="needs live price">—</span>' : "$" + fmtNum(h.value_aud)}</td>
      <td class="num">${h.pnl == null ? '<span class="dash" title="needs live price">—</span>' : fmtPct(h.pnl)}</td>
    </tr>`).join("");
}

// ---------- Exposure ----------
function renderExposure() {
  const e = DATA.exposure;
  const cur = e.currency;
  $("#expo-cards").innerHTML = [
    { l: "Gross Long", v: e.gross_long },
    { l: "Gross Short", v: e.gross_short },
    { l: "Net Exposure", v: e.net },
  ].map((c) => `
    <div class="card">
      <div class="l">${c.l}</div>
      <div class="v">${fmtNum(c.v)} <span style="font-size:12px;color:var(--text-dim)">${cur}</span></div>
    </div>`).join("") + `
    <div class="card">
      <div class="l">Positions</div>
      <div class="v">${e.long_count}L / ${e.short_count}S</div>
      <div class="x">${e.unpriced_count ? e.unpriced_count + " unpriced" : "all priced"}</div>
    </div>`;

  $("#expo-note").innerHTML = e.positions.length
    ? `Notional at entry price (live mark pending). ` +
      e.positions.map((p) => `${p.asset} ${p.leverage || ""}× ${p.position_type}`).join(" · ")
    : "No tactical positions with prices yet.";

  // asset-class breakdown (counts — value-weighted needs live prices)
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

function drawDonut(id, labels, values) {
  const ctx = document.getElementById(id);
  if (!ctx) return;
  const text = cssVar("--text"), muted = cssVar("--text-muted"), dim = cssVar("--text-dim");
  const palette = [text, muted, dim];
  charts.push(new Chart(ctx, {
    type: "doughnut",
    data: { labels, datasets: [{ data: values, backgroundColor: palette,
      borderColor: cssVar("--bg"), borderWidth: 2, cutout: "62%" }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom",
          labels: { color: muted, boxWidth: 10, boxHeight: 10, padding: 14,
            font: { family: cssVar("--sans"), size: 12 } } },
        tooltip: { callbacks: { label: (c) => `${c.label}: ${c.parsed}%` } },
      },
    },
  }));
}

function redrawCharts() {
  while (charts.length) charts.pop().destroy();
  renderOverview();
  renderPerformance();
  renderExposure();
}
