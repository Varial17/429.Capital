// 429 Capital — report page. Renders site/data/reports/<period>.json (?period=).
// Self-contained: pulls the report JSON + the manifest (data.json) for prev/next.

const $ = (s, r = document) => r.querySelector(s);

// theme (shared with dashboard)
(function () {
  if (localStorage.getItem("429-theme") === "light")
    document.documentElement.setAttribute("data-theme", "light");
})();
function toggleTheme() {
  const el = document.documentElement;
  const next = el.getAttribute("data-theme") === "light" ? "dark" : "light";
  if (next === "light") el.setAttribute("data-theme", "light");
  else el.removeAttribute("data-theme");
  localStorage.setItem("429-theme", next);
  if (window.__redraw) window.__redraw();
}
window.toggleTheme = toggleTheme;
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

const params = new URLSearchParams(location.search);
const PERIOD = params.get("period");
const charts = [];

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtPct = (n) => (n == null ? "—" : (n > 0 ? "+" : "") + n.toFixed(1) + "%");
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

// --- tiny markdown: ## h2, ### h3, **bold**, _em_, - lists, blank-line paragraphs ---
function md(src) {
  const lines = (src || "").split("\n");
  let html = "", inList = false;
  const inline = (t) =>
    esc(t)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/_(.+?)_/g, "<em>$1</em>");
  const closeList = () => { if (inList) { html += "</ul>"; inList = false; } };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { closeList(); continue; }
    if (line.startsWith("### ")) { closeList(); html += `<h3>${inline(line.slice(4))}</h3>`; }
    else if (line.startsWith("## ")) { closeList(); html += `<h2>${inline(line.slice(3))}</h2>`; }
    else if (line.startsWith("- ")) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${inline(line.slice(2))}</li>`;
    } else { closeList(); html += `<p>${inline(line)}</p>`; }
  }
  closeList();
  return html;
}

(async function () {
  if (!PERIOD) { fail("No report specified. Add ?period=2026-Q2 to the URL."); return; }
  let report, manifest = [];
  try {
    report = await (await fetch(`../data/reports/${PERIOD}.json`, { cache: "no-store" })).json();
  } catch (e) { fail(`Could not load report "${esc(PERIOD)}". Run build.py.`); return; }
  try {
    const d = await (await fetch("../data/data.json", { cache: "no-store" })).json();
    manifest = d.reports || [];
  } catch (e) { /* manifest optional */ }

  document.title = `${report.title || PERIOD} · 429 Capital`;
  renderHero(report);
  renderNav(report, manifest);
  renderPerformance(report);
  renderCommentary(report);
  renderHoldings(report);
  renderAllocation(report);
  renderExposure(report);
  renderRegions(report);
  renderSectors(report);
  renderDisclaimer(report);
  window.__redraw = () => { while (charts.length) charts.pop().destroy(); renderAllocation(report); };
})();

function fail(msg) { $("#report").innerHTML = `<p class="empty">${msg}</p>`; }

function renderHero(r) {
  $("#hero-sub").textContent = r.subtitle || "Report";
  $("#hero-title").textContent = r.title || r.period;
  $("#hero-date").textContent = r.date ? new Date(r.date).toLocaleDateString(undefined,
    { year: "numeric", month: "long", day: "numeric" }) : "";
}

function renderNav(r, manifest) {
  const me = manifest.find((m) => m.period === r.period);
  const links = [
    ["performance", "Performance"], ["commentary", "Commentary"], ["holdings", "Top Holdings"],
    ["allocation", "Allocation"], ["exposure", "Exposure"], ["regions", "Regions"], ["sectors", "Sectors"],
  ];
  $("#anchors").innerHTML = links.map(([id, label]) =>
    `<a href="#${id}">${label}</a>`).join("");

  let pn = "";
  if (me && me.prev) pn += `<a class="pn" href="report.html?period=${me.prev}">← Previous</a>`;
  if (me && me.next) pn += `<a class="pn next" href="report.html?period=${me.next}">Next →</a>`;
  $("#prevnext").innerHTML = pn || `<span class="pn disabled">Only report</span>`;

  // scroll-spy
  const spy = () => {
    let cur = links[0][0];
    for (const [id] of links) {
      const el = document.getElementById(id);
      if (el && el.getBoundingClientRect().top <= 120) cur = id;
    }
    document.querySelectorAll("#anchors a").forEach((a) =>
      a.classList.toggle("active", a.getAttribute("href") === `#${cur}`));
  };
  document.addEventListener("scroll", spy, { passive: true });
  spy();
}

function renderPerformance(r) {
  const rows = (r.performance && r.performance.rows) || [];
  $("#perf-rows").innerHTML = rows.map((x) => `
    <tr><td>${esc(x.period)}</td>
      <td class="num">${fmtPct(x.fund)}</td>
      <td class="num">${fmtPct(x.benchmark)}</td>
      <td class="num ${(x.fund - x.benchmark) >= 0 ? "pos" : "neg"}">${fmtPct(x.fund - x.benchmark)}</td>
    </tr>`).join("");
}

function renderCommentary(r) { $("#commentary-body").innerHTML = md(r.commentary); }

function renderHoldings(r) {
  const items = r.holdings || [];
  $("#holdings-cards").innerHTML = items.map((h, i) => {
    const open = h.expanded ? " open" : "";
    const tags = [
      h.sleeve && ["Sleeve", h.sleeve], h.country && ["Country", h.country],
      h.sector && ["Sector", h.sector], h.cap && ["Cap", h.cap],
    ].filter(Boolean);
    return `<details class="hcard"${open}>
      <summary>
        <span class="hc-name">${esc(h.name)}</span>
        <span class="hc-ticker">${esc(h.ticker || "")}</span>
        <span class="hc-chev">▾</span>
      </summary>
      <div class="hc-body">
        <p>${esc(h.description || "")}</p>
        <div class="hc-tags">${tags.map(([k, v]) =>
          `<span class="tag"><span class="tk">${k}</span> ${esc(v)}</span>`).join("")}</div>
      </div>
    </details>`;
  }).join("") || `<p class="empty">No holdings listed.</p>`;
}

function renderAllocation(r) {
  const a = r.allocation || {};
  drawDonut("alloc-sleeves", a.sleeves || {});
  drawDonut("alloc-class", a.asset_class || {});
}

function renderExposure(r) {
  const e = r.exposure || {};
  const cur = e.currency || "";
  $("#expo-cards").innerHTML = [
    ["Gross Long", e.gross_long], ["Gross Short", e.gross_short], ["Net Exposure", e.net],
  ].map(([l, v]) => `<div class="card"><div class="l">${l}</div>
      <div class="v">${v == null ? "—" : v.toLocaleString()} <span style="font-size:12px;color:var(--text-dim)">${cur}</span></div></div>`)
    .join("") + `<div class="card"><div class="l">Positions</div>
      <div class="v">${e.long_count || 0}L / ${e.short_count || 0}S</div></div>`;
}

function renderRegions(r) {
  const regs = r.regions || [];
  $("#regions-body").innerHTML = regs.map((g) => `
    <div class="region">
      <div class="region-head"><span>${esc(g.region)}</span><span class="bn">${g.total}%</span></div>
      ${(g.countries || []).map((c) => `
        <div class="bar-row sub">
          <span class="bl">${esc(c.country)}</span>
          <span class="bar-track"><span class="bar-fill" style="width:${c.pct}%"></span></span>
          <span class="bn">${c.pct}%</span>
        </div>`).join("")}
    </div>`).join("") || `<p class="empty">No region data.</p>`;
}

function renderSectors(r) {
  const secs = r.sectors || [];
  $("#sectors-body").innerHTML = secs.map((s) => `
    <div class="bar-row">
      <span class="bl">${esc(s.sector)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${s.pct}%"></span></span>
      <span class="bn">${s.pct}%</span>
    </div>`).join("") || `<p class="empty">No sector data.</p>`;
}

function renderDisclaimer(r) { $("#disclaimer").textContent = r.disclaimer || ""; }

function drawDonut(id, obj) {
  const ctx = document.getElementById(id);
  if (!ctx) return;
  const labels = Object.keys(obj), values = Object.values(obj);
  const base = [cssVar("--text"), cssVar("--text-muted"), cssVar("--text-dim"), cssVar("--border-strong")];
  const colors = labels.map((_, i) => base[i % base.length]);
  charts.push(new Chart(ctx, {
    type: "doughnut",
    data: { labels, datasets: [{ data: values, backgroundColor: colors,
      borderColor: cssVar("--bg"), borderWidth: 2, cutout: "60%" }] },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: "bottom", labels: { color: cssVar("--text-muted"),
        boxWidth: 10, boxHeight: 10, padding: 12, font: { family: cssVar("--sans"), size: 11 } } },
        tooltip: { callbacks: { label: (c) => `${c.label}: ${c.parsed}%` } } } },
  }));
}
