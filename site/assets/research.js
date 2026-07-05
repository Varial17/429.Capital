// 429 Capital — research report page (429 Research thesis notes).
// Renders site/data/reports/<period>.json (?period=) where kind === "research".

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
const chartSpecs = [];

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// --- tiny markdown (same dialect as report.js) ---
function md(src) {
  const lines = (src || "").split("\n");
  let html = "", inList = false;
  const inline = (t) =>
    esc(t)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/_(.+?)_/g, "<em>$1</em>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>");
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

// --- entity colors (validated palette, see style.css) ---
function entityColor(key) {
  if (!key) return cssVar("--text");
  if (key.endsWith("-soft")) {
    const base = entityColor(key.slice(0, -5));
    return base + "73"; // ~45% alpha — lighter shade of the same hue
  }
  const map = { hubs: "--e-hubs", crm: "--e-crm", xro: "--e-xro", context: "--e-context" };
  return map[key] ? cssVar(map[key]) : cssVar("--text");
}
const entityVar = (e) => (e ? ` style="--edot:var(--e-${esc(e)})"` : "");

// --- value formats ---
const FMT = {
  pct: (v) => (v > 0 ? "+" : "") + v + "%",
  x: (v) => v + "×",
  busd: (v) => "$" + v + "B",
  k: (v) => (v >= 1000 ? (v / 1000).toLocaleString() + "k" : String(v)),
  raw: (v) => String(v),
};
const fmt = (f) => FMT[f] || FMT.raw;

(async function () {
  if (!PERIOD) { fail("No report specified. Add ?period=2026-R1 to the URL."); return; }
  let report, manifest = [];
  try {
    report = await (await fetch(`../data/reports/${PERIOD}.json`, { cache: "no-store" })).json();
  } catch (e) { fail(`Could not load report "${esc(PERIOD)}". Run build.py.`); return; }
  try {
    const d = await (await fetch("../data/data.json", { cache: "no-store" })).json();
    manifest = d.reports || [];
  } catch (e) { /* manifest optional */ }

  document.title = `${report.title || PERIOD} · 429 Research`;
  renderHero(report);
  renderSections(report);
  renderNav(report, manifest);
  $("#disclaimer").textContent = report.disclaimer || "";
  drawCharts();
  window.__redraw = () => { while (charts.length) charts.pop().destroy(); drawCharts(); };
})();

function fail(msg) { $("#report").innerHTML = `<p class="empty">${msg}</p>`; }

function renderHero(r) {
  $("#hero-sub").textContent = r.subtitle || "429 Research";
  $("#hero-title").textContent = r.title || r.period;
  $("#hero-date").textContent = r.date ? new Date(r.date).toLocaleDateString(undefined,
    { year: "numeric", month: "long", day: "numeric" }) : "";
  $("#hero-tickers").innerHTML = (r.tickers || []).map((t) => `
    <span class="rsch-tick"${entityVar(t.entity)}>
      <span class="dot"></span><b>${esc(t.sym)}</b> ${esc(t.name)} · ${esc(t.price)}
    </span>`).join("");
}

function renderNav(r, manifest) {
  // side-nav: top-level sections only (sub-blocks carry a "-" in their id),
  // minus a few that sit inside a parent's flow
  const skip = new Set(["drawdown", "timeline", "pricing"]);
  const secs = (r.sections || []);
  const links = [["verdict", "Verdict"], ...secs
    .filter((s) => s.label && !s.id.includes("-") && !skip.has(s.id))
    .map((s) => [s.id, s.label])];
  $("#anchors").innerHTML = links.map(([id, label]) =>
    `<a href="#${id}">${esc(label)}</a>`).join("");

  const mine = manifest.filter((m) => m.kind === r.kind);
  const me = mine.find((m) => m.period === r.period) || manifest.find((m) => m.period === r.period);
  const hrefFor = (period) => {
    const entry = manifest.find((m) => m.period === period);
    const page = entry && entry.kind === "research" ? "research.html" : "report.html";
    return `${page}?period=${encodeURIComponent(period)}`;
  };
  let pn = "";
  if (me && me.prev) pn += `<a class="pn" href="${hrefFor(me.prev)}">← Previous</a>`;
  if (me && me.next) pn += `<a class="pn next" href="${hrefFor(me.next)}">Next →</a>`;
  $("#prevnext").innerHTML = pn || `<span class="pn disabled">Only research note</span>`;

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

// ---------------------------------------------------------------- sections --
function renderSections(r) {
  const out = [];
  out.push(renderVerdict(r.verdict));
  for (const s of r.sections || []) {
    const fn = RENDER[s.type];
    if (fn) out.push(fn(s));
  }
  $("#sections").innerHTML = out.join("");
}

function block(s, inner, opts = {}) {
  const label = s.label ? `<div class="sec-label">${esc(opts.navLabel || s.label)}</div>` : "";
  const title = s.title ? `<h2 class="sec-title">${esc(s.title)}</h2>` : "";
  return `<section id="${esc(s.id)}" class="block">${label}${title}${inner}</section>`;
}

function renderVerdict(v) {
  if (!v) return "";
  const stances = (v.stances || []).map((st) => `
    <div class="stance">
      <div class="stance-head"${entityVar(st.entity)}>
        <span class="dot"></span>
        <span class="tk">${esc(st.ticker)}</span>
        <span class="st">${esc(st.stance)}</span>
      </div>
      <div class="stance-line">${esc(st.line)}</div>
    </div>`).join("");
  return `<section id="verdict" class="block">
    <div class="sec-label">Verdict</div>
    <div class="verdict">
      <p class="verdict-thesis">${esc(v.thesis)}</p>
      <div class="verdict-stances">${stances}</div>
    </div>
  </section>`;
}

const RENDER = {
  prose: (s) => block(s, `<div class="prose">${md(s.body)}</div>`),

  stack: (s) => {
    const layer = (l) => `
      <div class="stack-layer ${l.k === "record" ? "is-record" : ""}">
        <div class="stack-t">${esc(l.title)}</div>
        <div class="stack-d">${esc(l.desc)}</div>
        <div class="stack-items">${(l.items || []).map((i) => `<span class="si">${esc(i)}</span>`).join("")}</div>
      </div>`;
    const flow = (f) => `
      <div class="stack-flow"><span class="arr">↓</span><span class="fl">${esc(f.label)}</span></div>`;
    let inner = `<div class="stack">`;
    (s.layers || []).forEach((l, i) => {
      inner += layer(l);
      if (s.flows && s.flows[i]) inner += flow(s.flows[i]);
    });
    inner += `</div>`;
    if (s.note) inner += `<p class="chart-note" style="margin-top:14px">${esc(s.note)}</p>`;
    return block(s, inner);
  },

  stats: (s) => {
    const cards = (s.cards || []).map((c) => `
      <div class="card"><div class="l">${esc(c.l)}</div>
        <div class="v">${esc(c.v)}</div>
        <div class="x">${esc(c.x || "")}</div></div>`).join("");
    let inner = "";
    if (s.note) inner += `<p class="chart-note" style="margin:0 0 16px">${esc(s.note)}</p>`;
    inner += `<div class="cards">${cards}</div>`;
    return block(s, inner);
  },

  chart: (s) => {
    chartSpecs.push(s);
    const short = s.kind === "hbar" ? " short" : "";
    const table = chartTable(s);
    return block(s, `
      <div class="panel"><div class="panel-body">
        <div class="rsch-chart${short}"><canvas id="c-${esc(s.id)}"></canvas></div>
        ${s.note ? `<p class="chart-note">${esc(s.note)}</p>` : ""}
        ${table}
      </div></div>`);
  },

  timeline: (s) => {
    const rows = (s.events || []).map((e) => `
      <div class="tl-row side-${esc(e.side || "mixed")}">
        <div class="tl-date">${esc(e.date)}</div>
        <div class="tl-spine"><div class="tl-dot"></div></div>
        <div class="tl-text">${esc(e.text)}${e.side && e.side !== "mixed"
          ? `<span class="tl-tag">${e.side === "bull" ? "for the thesis" : "against"}</span>` : ""}</div>
      </div>`).join("");
    return block(s, `<div class="tl">${rows}</div>`);
  },

  divider: (s) => `
    <section id="${esc(s.id)}" class="block">
      <div class="sec-label">${esc(s.label)}</div>
      <div class="rsch-divider"${entityVar(s.entity)}>
        <h2>${esc(s.title)}</h2>
        <p>${esc(s.body || "")}</p>
      </div>
    </section>`,

  scoreboard: (s) => {
    const col = (cls, head, items) => `
      <div class="sb-col ${cls}"${entityVar(s.entity)}>
        <h4><span class="dot"></span>${head}</h4>
        <ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>
      </div>`;
    return block(s, `<div class="scoreboard">
      ${col("bull", "What the bull owns", s.bull || [])}
      ${col("bear", "What the bear owns", s.bear || [])}
    </div>`);
  },

  ladders: (s) => {
    const ladders = (s.items || []).map(renderLadder).join("");
    let inner = "";
    if (s.note) inner += `<p class="chart-note" style="margin:0 0 18px">${esc(s.note)}</p>`;
    inner += `<div class="ladders">${ladders}</div>`;
    return block(s, inner);
  },

  callout: (s) => block({ ...s, title: null }, `
    <div class="callout"${entityVar(s.entity)}>
      <h3>${esc(s.title)}</h3>
      ${md(s.body)}
    </div>`),

  table: (s) => {
    const head = `<tr>${(s.head || []).map((h) => `<th>${esc(h)}</th>`).join("")}</tr>`;
    const rows = (s.rows || []).map((r) =>
      `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("");
    return block(s, `<div class="rsch-table-wrap"><table class="rsch-table">
      <thead>${head}</thead><tbody>${rows}</tbody></table></div>`);
  },

  sources: (s) => {
    const groups = (s.groups || []).map((g) => `
      <div class="src-group"><h4>${esc(g.title)}</h4>
        <ul>${(g.links || []).map((l) =>
          `<li><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a></li>`).join("")}</ul>
      </div>`).join("");
    let inner = "";
    if (s.note) inner += `<p class="src-note">${esc(s.note)}</p>`;
    inner += `<div class="src-groups">${groups}</div>`;
    return block(s, inner);
  },
};

// callout body: render markdown but drop the JSON title duplication safely
// (title is rendered separately in <h3>)

function chartTable(s) {
  const head = `<tr><th></th>${(s.series || []).map((d) => `<th>${esc(d.name)}</th>`).join("")}</tr>`;
  const f = fmt(s.valueFmt);
  const rows = (s.labels || []).map((l, i) =>
    `<tr><td>${esc(l)}</td>${(s.series || []).map((d) =>
      `<td>${esc(f(d.values[i]))}</td>`).join("")}</tr>`).join("");
  return `<details class="chart-table"><summary>View data</summary>
    <table><thead>${head}</thead><tbody>${rows}</tbody></table></details>`;
}

function renderLadder(it) {
  const span = it.scaleMax - it.scaleMin;
  const pos = (v) => Math.max(0, Math.min(100, ((v - it.scaleMin) / span) * 100));
  const cur = it.currency || "";
  const marksSorted = [...(it.marks || [])].sort((a, b) => a.value - b.value);
  const range = marksSorted.length
    ? `<div class="ladder-range" style="left:${pos(marksSorted[0].value)}%;width:${pos(marksSorted[marksSorted.length - 1].value) - pos(marksSorted[0].value)}%"></div>` : "";
  const marks = marksSorted.map((m, i) => {
    const above = i % 2 === 1;
    return `<div class="lmark ${esc(m.kind)}" style="left:${pos(m.value)}%"></div>
      <div class="lmark-lab ${above ? "above" : "below"}" style="left:${pos(m.value)}%">
        <b>${cur}${m.value}</b>${esc(m.label)}</div>`;
  }).join("");
  const now = `<div class="lnow" style="left:${pos(it.current)}%"></div>
    <div class="lnow-lab" style="left:${pos(it.current)}%">Now ${cur}${it.current}</div>`;
  const off = it.offscale
    ? `<span class="off">${esc(it.offscale.label)} →</span>` : "";
  const notes = marksSorted.map((m) => `
    <div class="lnote"><span class="dot lmark ${esc(m.kind)}" style="position:static;transform:none;border:none;width:8px;height:8px"></span>
      <span><b>${esc(m.label)} ${cur}${m.value}</b> — ${esc(m.note)}</span></div>`).join("");
  return `<div class="ladder"${entityVar(it.entity)}>
    <div class="ladder-head"><span class="nm">${esc(it.name)}</span>
      <span class="tk">${esc(it.ticker)}</span>${off}</div>
    <div class="ladder-track">${range}${marks}${now}</div>
    <div class="ladder-notes">${notes}</div>
  </div>`;
}

// ------------------------------------------------------------------ charts --
function baseFont() {
  return { family: cssVar("--sans"), size: 11 };
}

// draws value labels at bar ends / line endpoints (selective, per dataviz spec)
const valueLabelPlugin = {
  id: "valueLabels",
  afterDatasetsDraw(chart, _args, opts) {
    if (!opts || !opts.fmt) return;
    const f = fmt(opts.fmt);
    const { ctx } = chart;
    ctx.save();
    ctx.font = `600 11px ${cssVar("--mono")}`;
    ctx.fillStyle = cssVar("--text-muted");
    chart.data.datasets.forEach((ds, di) => {
      const meta = chart.getDatasetMeta(di);
      if (meta.hidden) return;
      meta.data.forEach((el, i) => {
        const v = ds.data[i];
        if (v == null) return;
        if (opts.lineEndsOnly) {
          if (i !== ds.data.length - 1) return;
          ctx.textAlign = "left"; ctx.textBaseline = "middle";
          ctx.fillText(f(v), el.x + 8, el.y);
        } else if (chart.options.indexAxis === "y") {
          ctx.textAlign = v < 0 ? "right" : "left"; ctx.textBaseline = "middle";
          ctx.fillText(f(v), el.x + (v < 0 ? -6 : 6), el.y);
        } else {
          ctx.textAlign = "center"; ctx.textBaseline = "bottom";
          ctx.fillText(f(v), el.x, el.y - 5);
        }
      });
    });
    ctx.restore();
  },
};

// solid hairline reference lines with labels (industry / market baselines)
const refLinePlugin = {
  id: "refLines",
  afterDraw(chart, _args, opts) {
    const lines = (opts && opts.lines) || [];
    if (!lines.length) return;
    const { ctx, chartArea, scales } = chart;
    ctx.save();
    for (const l of lines) {
      const y = scales.y.getPixelForValue(l.value);
      if (y < chartArea.top || y > chartArea.bottom) continue;
      ctx.strokeStyle = cssVar("--border-strong");
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(chartArea.left, y);
      ctx.lineTo(chartArea.right, y);
      ctx.stroke();
      ctx.font = `10px ${cssVar("--mono")}`;
      ctx.fillStyle = cssVar("--text-dim");
      ctx.textAlign = "right"; ctx.textBaseline = "bottom";
      ctx.fillText(l.label, chartArea.right, y - 3);
    }
    ctx.restore();
  },
};
Chart.register(valueLabelPlugin, refLinePlugin);

function drawCharts() {
  for (const s of chartSpecs) {
    const ctx = document.getElementById(`c-${s.id}`);
    if (!ctx) continue;
    const grid = { color: cssVar("--border"), drawTicks: false };
    const ticks = { color: cssVar("--text-muted"), font: baseFont(), padding: 8 };
    const multi = (s.series || []).length > 1;
    const f = fmt(s.valueFmt);

    const datasets = (s.series || []).map((d) => {
      const color = d.entities
        ? d.entities.map(entityColor)
        : entityColor(d.entity);
      if (s.kind === "line") {
        return {
          label: d.name, data: d.values,
          borderColor: color, backgroundColor: color,
          borderWidth: 2, tension: 0.3,
          pointRadius: 4, pointBorderWidth: 2, pointBorderColor: cssVar("--bg"),
          pointBackgroundColor: color,
        };
      }
      return {
        label: d.name, data: d.values,
        backgroundColor: color, borderColor: color,
        maxBarThickness: 22, borderRadius: 4, borderSkipped: "start",
        borderWidth: 0, categoryPercentage: 0.62, barPercentage: 0.82,
      };
    });

    const horizontal = s.kind === "hbar";
    const config = {
      type: s.kind === "line" ? "line" : "bar",
      data: { labels: s.labels, datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        indexAxis: horizontal ? "y" : "x",
        layout: { padding: { right: horizontal ? 8 : 44, top: s.kind === "line" ? 8 : 18 } },
        plugins: {
          legend: multi ? {
            position: "bottom",
            labels: { color: cssVar("--text-muted"), boxWidth: 10, boxHeight: 10,
              padding: 14, font: baseFont() },
          } : { display: false },
          tooltip: {
            callbacks: { label: (c) => `${c.dataset.label}: ${f(horizontal ? c.parsed.x : c.parsed.y)}` },
          },
          valueLabels: { fmt: s.valueFmt, lineEndsOnly: s.kind === "line" },
          refLines: { lines: s.refLines || [] },
        },
        scales: horizontal ? {
          x: { min: s.xMin, max: s.xMax, grid, ticks: { ...ticks, callback: (v) => f(v) } },
          y: { grid: { display: false }, ticks },
        } : {
          x: { grid: { display: false }, ticks },
          y: { beginAtZero: true, grid, ticks: { ...ticks, callback: (v) => f(v) } },
        },
      },
    };
    charts.push(new Chart(ctx, config));
  }
}
