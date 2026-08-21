/* ==========================================================================
   Sink Charts — app.js
   Data grid -> Chart.js rendering -> save/load against Supabase.

   Storage: table `sink_charts_projects` (see schema.sql), one row per
   saved project, RLS-scoped to auth.uid(). Everything the user builds —
   the grid data, the chosen chart type, axis/series mapping, and style
   toggles — is serialized into a single `data` jsonb column.
   ========================================================================== */

const PROJECTS_TABLE = "sink_charts_projects";

const SERIES_COLORS = [
  getVar("--series-1"), getVar("--series-2"), getVar("--series-3"),
  getVar("--series-4"), getVar("--series-5"), getVar("--series-6"),
];

function getVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function $(id) { return document.getElementById(id); }

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  id: null,                 // Supabase row id once saved, else null
  name: "Untitled project",
  chartTitle: "Chart title",
  chartType: "bar",
  columns: ["Month", "Revenue", "Cost"],
  rows: [
    ["Jan", "4200", "3100"],
    ["Feb", "4800", "3300"],
    ["Mar", "5100", "3400"],
    ["Apr", "4700", "3200"],
  ],
  xAxisCol: 0,
  seriesEnabled: {},         // colIndex -> bool
  legend: true,
  grid: true,
  curve: false,
  dirty: false,
};

let chartInstance = null;

const CHART_TYPES = [
  { id: "bar", label: "Bar", icon: `<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M4 20V10M12 20V4M20 20v-7"/></svg>` },
  { id: "line", label: "Line", icon: `<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M3 17l5-6 4 3 8-9"/></svg>` },
  { id: "pie", label: "Pie", icon: `<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M12 2v10l7 7A10 10 0 1 0 12 2z"/></svg>` },
  { id: "doughnut", label: "Donut", icon: `<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.5"/></svg>` },
  { id: "radar", label: "Radar", icon: `<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M12 3l8 5-3 10H7L4 8z"/></svg>` },
  { id: "scatter", label: "Scatter", icon: `<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><circle cx="6" cy="17" r="1.4" fill="currentColor" stroke="none"/><circle cx="11" cy="8" r="1.4" fill="currentColor" stroke="none"/><circle cx="16" cy="14" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="6" r="1.4" fill="currentColor" stroke="none"/></svg>` },
];

// ---------------------------------------------------------------------------
// Data grid rendering
// ---------------------------------------------------------------------------

function ensureSeriesDefaults() {
  state.columns.forEach((_, i) => {
    if (i === state.xAxisCol) return;
    if (!(i in state.seriesEnabled)) state.seriesEnabled[i] = true;
  });
}

function renderGrid() {
  const headRow = $("grid-head-row");
  const body = $("grid-body");
  headRow.innerHTML = "";
  body.innerHTML = "";

  const corner = document.createElement("th");
  corner.className = "row-head";
  headRow.appendChild(corner);

  state.columns.forEach((name, colIdx) => {
    const th = document.createElement("th");
    const input = document.createElement("input");
    input.value = name;
    input.addEventListener("input", (e) => {
      state.columns[colIdx] = e.target.value;
      markDirty();
      renderConfigPanel();
    });
    th.appendChild(input);

    if (state.columns.length > 1) {
      const rm = document.createElement("button");
      rm.className = "col-remove";
      rm.textContent = "✕";
      rm.title = "Remove column";
      rm.addEventListener("click", () => removeColumn(colIdx));
      th.appendChild(rm);
    }
    headRow.appendChild(th);
  });

  state.rows.forEach((row, rowIdx) => {
    const tr = document.createElement("tr");
    const rowHead = document.createElement("td");
    rowHead.className = "row-head";
    const rmBtn = document.createElement("button");
    rmBtn.className = "row-remove";
    rmBtn.textContent = "✕";
    rmBtn.title = "Remove row";
    rmBtn.addEventListener("click", () => removeRow(rowIdx));
    rowHead.appendChild(rmBtn);
    tr.appendChild(rowHead);

    state.columns.forEach((_, colIdx) => {
      const td = document.createElement("td");
      const input = document.createElement("input");
      input.value = row[colIdx] ?? "";
      input.addEventListener("input", (e) => {
        state.rows[rowIdx][colIdx] = e.target.value;
        markDirty();
        renderChart();
      });
      td.appendChild(input);
      tr.appendChild(td);
    });
    body.appendChild(tr);
  });
}

function addRow() {
  state.rows.push(state.columns.map(() => ""));
  markDirty();
  renderGrid();
  renderChart();
}

function addColumn() {
  const idx = state.columns.length;
  state.columns.push(`Series ${idx}`);
  state.rows.forEach((r) => r.push(""));
  state.seriesEnabled[idx] = true;
  markDirty();
  renderGrid();
  renderConfigPanel();
  renderChart();
}

function removeRow(idx) {
  if (state.rows.length <= 1) return;
  state.rows.splice(idx, 1);
  markDirty();
  renderGrid();
  renderChart();
}

function removeColumn(idx) {
  if (state.columns.length <= 1) return;
  state.columns.splice(idx, 1);
  state.rows.forEach((r) => r.splice(idx, 1));
  delete state.seriesEnabled[idx];

  // reindex seriesEnabled keys above idx down by one
  const reindexed = {};
  Object.keys(state.seriesEnabled).forEach((k) => {
    const n = Number(k);
    reindexed[n > idx ? n - 1 : n] = state.seriesEnabled[k];
  });
  state.seriesEnabled = reindexed;

  if (state.xAxisCol >= state.columns.length) state.xAxisCol = 0;
  else if (state.xAxisCol > idx) state.xAxisCol -= 1;

  markDirty();
  renderGrid();
  renderConfigPanel();
  renderChart();
}

function importCsv() {
  const raw = $("csv-input").value.trim();
  if (!raw) return;
  const lines = raw.split(/\r?\n/).filter((l) => l.length);
  if (!lines.length) return;

  const parseLine = (l) => l.split(",").map((c) => c.trim());
  state.columns = parseLine(lines[0]);
  state.rows = lines.slice(1).map(parseLine);
  state.seriesEnabled = {};
  state.xAxisCol = 0;
  ensureSeriesDefaults();

  markDirty();
  renderGrid();
  renderConfigPanel();
  renderChart();
  toast("CSV imported");
}

// ---------------------------------------------------------------------------
// Config panel (chart type, axis/series mapping, style toggles)
// ---------------------------------------------------------------------------

function renderChartTypeGrid() {
  const wrap = $("chart-type-grid");
  wrap.innerHTML = "";
  CHART_TYPES.forEach((t) => {
    const btn = document.createElement("button");
    btn.className = "chart-type-btn" + (state.chartType === t.id ? " active" : "");
    btn.innerHTML = `${t.icon}<span>${t.label}</span>`;
    btn.addEventListener("click", () => {
      state.chartType = t.id;
      markDirty();
      renderChartTypeGrid();
      renderChart();
    });
    wrap.appendChild(btn);
  });
}

function renderConfigPanel() {
  ensureSeriesDefaults();

  const xSelect = $("x-axis-select");
  xSelect.innerHTML = "";
  state.columns.forEach((name, idx) => {
    const opt = document.createElement("option");
    opt.value = idx;
    opt.textContent = name || `Column ${idx + 1}`;
    if (idx === state.xAxisCol) opt.selected = true;
    xSelect.appendChild(opt);
  });

  const list = $("series-list");
  list.innerHTML = "";
  state.columns.forEach((name, idx) => {
    if (idx === state.xAxisCol) return;
    const row = document.createElement("label");
    row.className = "series-item";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!state.seriesEnabled[idx];
    cb.addEventListener("change", (e) => {
      state.seriesEnabled[idx] = e.target.checked;
      markDirty();
      renderChart();
    });

    const swatch = document.createElement("span");
    swatch.className = "series-swatch";
    swatch.style.background = SERIES_COLORS[idx % SERIES_COLORS.length];

    const label = document.createElement("span");
    label.textContent = name || `Column ${idx + 1}`;

    row.appendChild(cb);
    row.appendChild(swatch);
    row.appendChild(label);
    list.appendChild(row);
  });

  renderChartTypeGrid();
}

// ---------------------------------------------------------------------------
// Chart rendering
// ---------------------------------------------------------------------------

function numeric(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function buildChartConfig() {
  const labels = state.rows.map((r) => r[state.xAxisCol] ?? "");
  const enabledSeries = state.columns
    .map((name, idx) => ({ name, idx }))
    .filter((c) => c.idx !== state.xAxisCol && state.seriesEnabled[c.idx]);

  const textColor = getVar("--text-muted");
  const gridColor = getVar("--bg-grid-line");

  const commonOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 550, easing: "easeOutQuart" },
    plugins: {
      legend: {
        display: state.legend,
        labels: { color: textColor, font: { family: "Inter" } },
      },
    },
  };

  if (state.chartType === "pie" || state.chartType === "doughnut") {
    const s = enabledSeries[0];
    const data = s ? state.rows.map((r) => numeric(r[s.idx])) : [];
    return {
      type: state.chartType,
      data: {
        labels,
        datasets: [{
          label: s ? s.name : "",
          data,
          backgroundColor: labels.map((_, i) => SERIES_COLORS[i % SERIES_COLORS.length]),
          borderColor: getVar("--panel"),
          borderWidth: 2,
        }],
      },
      options: commonOptions,
    };
  }

  if (state.chartType === "scatter") {
    const s = enabledSeries[0];
    const points = state.rows.map((r) => ({
      x: numeric(r[state.xAxisCol]),
      y: s ? numeric(r[s.idx]) : 0,
    }));
    return {
      type: "scatter",
      data: {
        datasets: [{
          label: s ? s.name : "",
          data: points,
          backgroundColor: SERIES_COLORS[0],
        }],
      },
      options: {
        ...commonOptions,
        scales: {
          x: { grid: { display: state.grid, color: gridColor }, ticks: { color: textColor } },
          y: { grid: { display: state.grid, color: gridColor }, ticks: { color: textColor } },
        },
      },
    };
  }

  // bar / line / radar share the same dataset shape
  const datasets = enabledSeries.map((s, i) => ({
    label: s.name || `Series ${s.idx + 1}`,
    data: state.rows.map((r) => numeric(r[s.idx])),
    backgroundColor: state.chartType === "radar"
      ? SERIES_COLORS[i % SERIES_COLORS.length] + "33"
      : SERIES_COLORS[i % SERIES_COLORS.length],
    borderColor: SERIES_COLORS[i % SERIES_COLORS.length],
    borderWidth: 2,
    tension: state.curve ? 0.4 : 0,
    fill: state.chartType === "radar",
    pointBackgroundColor: SERIES_COLORS[i % SERIES_COLORS.length],
  }));

  const scales = state.chartType === "radar"
    ? {
        r: {
          grid: { display: state.grid, color: gridColor },
          angleLines: { color: gridColor },
          pointLabels: { color: textColor },
          ticks: { color: textColor, backdropColor: "transparent" },
        },
      }
    : {
        x: { grid: { display: state.grid, color: gridColor }, ticks: { color: textColor } },
        y: { grid: { display: state.grid, color: gridColor }, ticks: { color: textColor } },
      };

  return {
    type: state.chartType,
    data: { labels, datasets },
    options: { ...commonOptions, scales },
  };
}

function hasRenderableData() {
  const enabled = Object.values(state.seriesEnabled).some(Boolean);
  return state.rows.length > 0 && enabled;
}

function renderChart() {
  const canvas = $("chart-canvas");
  const empty = $("chart-empty");

  if (!hasRenderableData()) {
    empty.classList.remove("hidden");
    canvas.classList.add("hidden");
    if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
    return;
  }

  empty.classList.add("hidden");
  canvas.classList.remove("hidden");

  const config = buildChartConfig();
  if (chartInstance) {
    chartInstance.destroy();
  }
  chartInstance = new Chart(canvas.getContext("2d"), config);
}

// ---------------------------------------------------------------------------
// Persistence — save / load / list / delete against Supabase
// ---------------------------------------------------------------------------

function serializeProject() {
  return {
    chartTitle: state.chartTitle,
    chartType: state.chartType,
    columns: state.columns,
    rows: state.rows,
    xAxisCol: state.xAxisCol,
    seriesEnabled: state.seriesEnabled,
    legend: state.legend,
    grid: state.grid,
    curve: state.curve,
  };
}

function loadFromSerialized(payload) {
  Object.assign(state, {
    chartTitle: payload.chartTitle ?? "Chart title",
    chartType: payload.chartType ?? "bar",
    columns: payload.columns ?? ["A", "B"],
    rows: payload.rows ?? [["", ""]],
    xAxisCol: payload.xAxisCol ?? 0,
    seriesEnabled: payload.seriesEnabled ?? {},
    legend: payload.legend ?? true,
    grid: payload.grid ?? true,
    curve: payload.curve ?? false,
  });
}

function markDirty() {
  state.dirty = true;
  $("save-status").textContent = "unsaved changes";
}

function markSaved() {
  state.dirty = false;
  const t = new Date();
  $("save-status").textContent = `saved ${t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

async function saveProject() {
  const { sb, user } = window.SinkAuth;
  const payload = {
    user_id: user.id,
    name: state.name,
    data: serializeProject(),
    updated_at: new Date().toISOString(),
  };

  const saveBtn = $("save-project-btn");
  saveBtn.disabled = true;

  try {
    let result;
    if (state.id) {
      result = await sb.from(PROJECTS_TABLE).update(payload).eq("id", state.id).select().single();
    } else {
      result = await sb.from(PROJECTS_TABLE).insert(payload).select().single();
    }
    if (result.error) throw result.error;
    state.id = result.data.id;
    markSaved();
    toast("Project saved");
  } catch (err) {
    console.error(err);
    toast("Couldn't save — check your connection", true);
  } finally {
    saveBtn.disabled = false;
  }
}

async function fetchProjects() {
  const { sb, user } = window.SinkAuth;
  const { data, error } = await sb
    .from(PROJECTS_TABLE)
    .select("id, name, updated_at")
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false });
  if (error) {
    console.error(error);
    toast("Couldn't load projects", true);
    return [];
  }
  return data;
}

async function openProject(id) {
  const { sb } = window.SinkAuth;
  const { data, error } = await sb.from(PROJECTS_TABLE).select("*").eq("id", id).single();
  if (error) {
    console.error(error);
    toast("Couldn't open that project", true);
    return;
  }
  state.id = data.id;
  state.name = data.name;
  loadFromSerialized(data.data || {});
  $("project-name").value = state.name;
  $("chart-title").value = state.chartTitle;
  renderGrid();
  renderConfigPanel();
  applyToggleUi();
  renderChart();
  markSaved();
  closeProjectsModal();
  toast(`Opened “${state.name}”`);
}

async function deleteProject(id, name) {
  const { sb } = window.SinkAuth;
  const ok = window.confirm(`Delete “${name}”? This can't be undone.`);
  if (!ok) return;
  const { error } = await sb.from(PROJECTS_TABLE).delete().eq("id", id);
  if (error) {
    console.error(error);
    toast("Couldn't delete that project", true);
    return;
  }
  if (state.id === id) {
    state.id = null;
  }
  renderProjectsList();
  toast("Project deleted");
}

function newProject() {
  if (state.dirty && !window.confirm("Discard unsaved changes and start a new project?")) return;
  state.id = null;
  state.name = "Untitled project";
  loadFromSerialized({});
  state.columns = ["Month", "Revenue", "Cost"];
  state.rows = [["Jan", "4200", "3100"], ["Feb", "4800", "3300"]];
  $("project-name").value = state.name;
  $("chart-title").value = state.chartTitle;
  renderGrid();
  renderConfigPanel();
  applyToggleUi();
  renderChart();
  $("save-status").textContent = "not saved";
  state.dirty = false;
}

// ---------------------------------------------------------------------------
// Projects modal
// ---------------------------------------------------------------------------

async function renderProjectsList() {
  const list = $("projects-list");
  list.innerHTML = `<p class="modal-empty">Loading…</p>`;
  const projects = await fetchProjects();

  if (!projects.length) {
    list.innerHTML = `<p class="modal-empty">No saved projects yet.<br>Build something and hit Save.</p>`;
    return;
  }

  list.innerHTML = "";
  projects.forEach((p) => {
    const row = document.createElement("div");
    row.className = "project-row";

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.innerHTML = `
      <div class="p-name">${escapeHtml(p.name)}</div>
      <div class="p-date">${new Date(p.updated_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</div>
    `;
    meta.addEventListener("click", () => openProject(p.id));
    meta.style.cursor = "pointer";

    const actions = document.createElement("div");
    actions.className = "p-actions";

    const delBtn = document.createElement("button");
    delBtn.className = "icon-btn danger";
    delBtn.innerHTML = "✕";
    delBtn.title = "Delete";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteProject(p.id, p.name);
    });

    actions.appendChild(delBtn);
    row.appendChild(meta);
    row.appendChild(actions);
    list.appendChild(row);
  });
}

function openProjectsModal() {
  $("projects-modal").classList.remove("hidden");
  renderProjectsList();
}

function closeProjectsModal() {
  $("projects-modal").classList.add("hidden");
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function exportPng() {
  if (!chartInstance) {
    toast("Nothing to export yet", true);
    return;
  }
  const url = chartInstance.toBase64Image("image/png", 1);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${(state.name || "chart").replace(/\s+/g, "-").toLowerCase()}.png`;
  a.click();
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

let toastTimer = null;
function toast(msg, isError = false) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

// ---------------------------------------------------------------------------
// Misc UI wiring
// ---------------------------------------------------------------------------

function applyToggleUi() {
  $("toggle-legend").checked = state.legend;
  $("toggle-grid").checked = state.grid;
  $("toggle-curve").checked = state.curve;
}

function wireUi() {
  $("project-name").addEventListener("input", (e) => {
    state.name = e.target.value;
    markDirty();
  });
  $("chart-title").addEventListener("input", (e) => {
    state.chartTitle = e.target.value;
    markDirty();
  });

  $("add-row-btn").addEventListener("click", addRow);
  $("add-col-btn").addEventListener("click", addColumn);
  $("csv-import-btn").addEventListener("click", importCsv);

  $("x-axis-select").addEventListener("change", (e) => {
    state.xAxisCol = Number(e.target.value);
    markDirty();
    renderConfigPanel();
    renderChart();
  });

  $("toggle-legend").addEventListener("change", (e) => { state.legend = e.target.checked; markDirty(); renderChart(); });
  $("toggle-grid").addEventListener("change", (e) => { state.grid = e.target.checked; markDirty(); renderChart(); });
  $("toggle-curve").addEventListener("change", (e) => { state.curve = e.target.checked; markDirty(); renderChart(); });

  $("new-project-btn").addEventListener("click", newProject);
  $("save-project-btn").addEventListener("click", saveProject);
  $("open-projects-btn").addEventListener("click", openProjectsModal);
  $("close-projects-btn").addEventListener("click", closeProjectsModal);
  $("projects-modal").addEventListener("click", (e) => {
    if (e.target.id === "projects-modal") closeProjectsModal();
  });
  $("export-png-btn").addEventListener("click", exportPng);

  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      saveProject();
    }
  });
}

// ---------------------------------------------------------------------------
// Boot — wait for the auth gate to resolve, then wire everything up
// ---------------------------------------------------------------------------

window.SinkAuth.ready.then(({ user, profile }) => {
  $("app").classList.remove("hidden");
  $("account-chip").textContent = profile?.username ? `@${profile.username}` : user.email;

  ensureSeriesDefaults();
  wireUi();
  renderGrid();
  renderConfigPanel();
  applyToggleUi();
  renderChart();
});
