// app.js — Burble Dashboard web app. A port of desktop/renderer.js: the same
// load-board grid (iframes through the server's /burble/ proxy instead of
// native windows) and the same DZ Weather Ranking tab. Everything the desktop
// keeps in its userData folder lives in this browser's localStorage instead;
// weather work runs on the server (see server.js /api/ routes).

// NOTE: these params are inert against us-displays.burblesoft.com -- verified by
// diffing the proxied response, which is byte-identical with the full string, with
// display_menu flipped, and with nothing but dz_id. Neither script the board loads
// reads them either. Burble takes its display config from the DZ's own server-side
// settings, not the URL. Kept because they're harmless and the desktop app sends
// the same string, but do NOT expect changing them to reflow anything.
const BOARD_OPTIONS =
  "columns=4&display_menu=0&display_sport=1&display_student=1&display_tandem=1&font_size=11";
const DEFAULT_BOARDS = [
  { dzId: 359, name: "Skydive Midwest" },
  { dzId: 11651, name: "Skydive Milwaukee / Sky Knights SPC" },
  { dzId: 43, name: "Wisconsin Skydiving Center" },
  { dzId: 13976, name: "Seven Hills Skydivers" },
  { dzId: 408, name: "CSC" }
];
const STORAGE_KEY = "burble-dashboard-boards-v1";
const COLUMNS_KEY = "burble-dashboard-columns-v1";
const WEATHER_KEY = "burble-dashboard-weather-v1";

// Same defaults as main.js's DEFAULT_WEATHER_SETTINGS / weather.DEFAULT_PREFERENCES.
const DEFAULT_PREFERENCES = {
  minimumCeilingFt:    8000,
  maximumWindKt:       18,
  maximumPrecipChance: 30,
  minimumVisibilitySm: 5
};
const DEFAULT_WEATHER_SETTINGS = {
  homeLat:       43.0731,   // Madison, WI
  homeLon:       -89.4012,
  maxDistanceMi: 250,
  preferences:   DEFAULT_PREFERENCES,
  hiddenDzIds:   [],
  dzOverrides:   {}         // { [dzId]: { lat, lon, label, icaoId? } }
};

// ─── DOM references — Boards tab ─────────────────────────────────────────────
const tabBoards   = document.getElementById("tab-boards");
const tabWeather  = document.getElementById("tab-weather");
const dashboard   = document.getElementById("dashboard");
const empty       = document.getElementById("empty");
const columnCount = document.getElementById("columnCount");
const reloadAll   = document.getElementById("reloadAll");
const install     = document.getElementById("install");
const manage      = document.getElementById("manage");
const manager     = document.getElementById("manager");
const search      = document.getElementById("search");
const results     = document.getElementById("results");
const boardsCtl   = document.getElementById("boards-controls");

// ─── DOM references — Weather tab ────────────────────────────────────────────
const wxDay              = document.getElementById("wx-day");
const wxRefresh          = document.getElementById("wx-refresh");
const wxStatus           = document.getElementById("wx-status");
const wxRanking          = document.getElementById("wx-ranking");
const wxSettingsToggle   = document.getElementById("wx-settings-toggle");
const wxSettingsBody     = document.getElementById("wx-settings-body");
const wxToggleArrow      = document.getElementById("wx-toggle-arrow");
const wxHomeLat          = document.getElementById("wx-home-lat");
const wxHomeLon          = document.getElementById("wx-home-lon");
const wxMaxDist          = document.getElementById("wx-max-dist");
const wxUseLocation      = document.getElementById("wx-use-location");
const wxUseLocationMsg   = document.getElementById("wx-use-location-msg");
const wxSaveSettings     = document.getElementById("wx-save-settings");
const wxResetPreferences = document.getElementById("wx-reset-preferences");
const pMinCeiling        = document.getElementById("p-min-ceiling");
const pMaxWind           = document.getElementById("p-max-wind");
const pMaxPrecip         = document.getElementById("p-max-precip");
const pMinVisibility     = document.getElementById("p-min-visibility");
const pMinCeilingVal     = document.getElementById("p-min-ceiling-val");
const pMaxWindVal        = document.getElementById("p-max-wind-val");
const pMaxPrecipVal      = document.getElementById("p-max-precip-val");
const pMinVisibilityVal  = document.getElementById("p-min-visibility-val");

// ─── State ────────────────────────────────────────────────────────────────────
let boards        = loadBoards();
let dropzones     = [];
let focusedId     = null;
let installPrompt = null;
let wxSettings    = loadWeatherSettings();
let wxLastDay     = null;          // last fetched day string
let wxLastRanking = null;          // cached ranking array from last fetch
let hiddenDzIds   = new Set();     // dzIds the user has hidden from the ranking
let wxRenderGeneration = 0;        // guards against stale load fills after a re-render

// ─── Storage (stands in for main.js's boards.json / weather-settings.json) ───
function readStorage(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch (_) { return null; }
}

function writeStorage(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
}

function boardUrlForDzId(dzId) {
  return `burble/${dzId}/jmp?${BOARD_OPTIONS}&dz_id=${dzId}`;
}

function normalizeBoard(input) {
  const dzId = Number.parseInt(input?.dzId, 10);
  const name = String(input?.name || "").trim();
  if (!Number.isSafeInteger(dzId) || dzId <= 0 || !name || name.length > 150) throw new Error("Invalid dropzone");
  return { id: `dz-${dzId}`, dzId, name, url: boardUrlForDzId(dzId) };
}

function loadBoards() {
  try {
    const saved = readStorage(STORAGE_KEY);
    return Array.isArray(saved) ? saved.map(normalizeBoard) : DEFAULT_BOARDS.map(normalizeBoard);
  } catch (_) {
    return DEFAULT_BOARDS.map(normalizeBoard);
  }
}

function saveBoards() {
  writeStorage(STORAGE_KEY, boards.map(({ dzId, name }) => ({ dzId, name })));
}

function addBoard(dropzone) {
  const board = normalizeBoard(dropzone);
  if (!boards.some((item) => item.dzId === board.dzId)) {
    boards.push(board);
    saveBoards();
  }
  renderBoards();
}

// Merge over defaults so keys added in later versions are always present.
function mergeWeatherSettings(current, incoming) {
  return {
    ...current,
    ...incoming,
    preferences: { ...current.preferences, ...(incoming?.preferences ?? {}) },
    dzOverrides: { ...current.dzOverrides, ...(incoming?.dzOverrides ?? {}) },
    hiddenDzIds: incoming?.hiddenDzIds ?? current.hiddenDzIds ?? []
  };
}

function loadWeatherSettings() {
  const saved = readStorage(WEATHER_KEY);
  return mergeWeatherSettings(DEFAULT_WEATHER_SETTINGS, saved && typeof saved === "object" ? saved : {});
}

function setWeatherSettings(incoming) {
  wxSettings = mergeWeatherSettings(wxSettings, incoming);
  writeStorage(WEATHER_KEY, wxSettings);
  return wxSettings;
}

// ─── Server API ───────────────────────────────────────────────────────────────
async function api(path, body) {
  const options = body === undefined
    ? {}
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const response = await fetch(path, options);
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
  return data;
}

async function getWeatherRanking({ day, preferences }) {
  const data = await api("api/weather/ranking", {
    day,
    homeLat:       wxSettings.homeLat,
    homeLon:       wxSettings.homeLon,
    maxDistanceMi: wxSettings.maxDistanceMi,
    preferences,
    boardDzIds:    boards.map((board) => board.dzId),
    dzOverrides:   wxSettings.dzOverrides
  });
  const rows = data.rows;
  rows.excludedLowConfidence = data.excludedLowConfidence;
  return rows;
}

// Resolve by airport ident or "lat, lon" and store the override; a blank
// query clears it. Same contract as main.js's resolve-dz-location.
async function resolveDzLocation(dzId, query) {
  if (!String(query ?? "").trim()) {
    const { [dzId]: _removed, ...dzOverrides } = wxSettings.dzOverrides;
    wxSettings = { ...wxSettings, dzOverrides };
    writeStorage(WEATHER_KEY, wxSettings);
    return { ok: true, override: null };
  }
  const res = await api("api/resolve-location", { query });
  if (res.ok) setWeatherSettings({ dzOverrides: { [dzId]: res.override } });
  return res;
}

const getDzLoads = (dzId) => api(`api/loads/${dzId}`);

// ─── Tab switching ────────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === name);
  });
  tabBoards.hidden  = name !== "boards";
  tabWeather.hidden = name !== "weather";
  boardsCtl.hidden  = name !== "boards";
  history.replaceState(null, "", name === "weather" ? "#weather" : location.pathname + location.search);
  if (name === "weather" && wxLastDay !== wxDay.value) fetchWeather();
}

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.onclick = () => switchTab(btn.dataset.tab);
});

// ─── Load board cards ─────────────────────────────────────────────────────────
function makeCard(board) {
  const card = document.createElement("section");
  card.className = "board";
  card.dataset.id = board.id;
  card.innerHTML = `
    <div class="board-header">
      <h2 class="board-title"></h2>
      <div class="board-actions">
        <button class="reload" type="button">Reload</button>
        <button class="focus" type="button">Focus</button>
        <button class="open" type="button">Open</button>
        <button class="remove danger" type="button">Remove</button>
      </div>
    </div>
    <iframe class="viewport" title="" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>
  `;
  card.querySelector(".board-title").textContent = board.name;
  const frame = card.querySelector(".viewport");
  frame.title = `${board.name} load board`;

  frame.src = board.url;
  card.reloadBoard = () => {
    frame.src = `${board.url}&reload=${Date.now()}`;
  };

  card.querySelector(".reload").onclick = () => card.reloadBoard();
  card.querySelector(".open").onclick = () => window.open(board.url, "_blank", "noopener");
  card.querySelector(".remove").onclick = () => {
    if (!confirm(`Remove ${board.name} from the dashboard?`)) return;
    boards = boards.filter((item) => item.id !== board.id);
    saveBoards();
    renderBoards();
  };
  card.querySelector(".focus").onclick = () => {
    focusedId = focusedId === board.id ? null : board.id;
    updateFocus();
  };
  return card;
}

function renderBoards() {
  if (focusedId && !boards.some((board) => board.id === focusedId)) focusedId = null;
  dashboard.replaceChildren(...boards.map(makeCard));
  empty.hidden = boards.length > 0;
  updateFocus();
  renderResults();
}

function updateFocus() {
  dashboard.classList.toggle("focused", Boolean(focusedId));
  document.querySelectorAll(".board").forEach((card) => {
    const selected = card.dataset.id === focusedId;
    card.classList.toggle("hidden", Boolean(focusedId) && !selected);
    card.querySelector(".focus").textContent = selected && focusedId ? "Grid" : "Focus";
  });
}

function renderResults() {
  const query = search.value.trim().toLocaleLowerCase();
  const matches = query
    ? dropzones.filter((dropzone) =>
        dropzone.name.toLocaleLowerCase().includes(query) || String(dropzone.dzId).includes(query)
      ).slice(0, 30)
    : [];
  results.replaceChildren(...matches.map((dropzone) => {
    const row = document.createElement("div");
    const isAdded = boards.some((board) => board.dzId === dropzone.dzId);
    row.className = "result";
    row.innerHTML = `<span></span><button type="button"></button>`;
    row.querySelector("span").textContent = `${dropzone.name} (ID ${dropzone.dzId})`;
    const button = row.querySelector("button");
    button.textContent = isAdded ? "Added" : "Add";
    button.disabled = isAdded;
    button.onclick = () => addBoard(dropzone);
    return row;
  }));
  if (query && !matches.length) results.textContent = "No matching dropzones.";
}

// ─── Boards tab control wiring ────────────────────────────────────────────────
columnCount.value = localStorage.getItem(COLUMNS_KEY) || (innerWidth <= 900 ? "1" : "2");
document.documentElement.style.setProperty("--columns", columnCount.value);
columnCount.onchange = () => {
  localStorage.setItem(COLUMNS_KEY, columnCount.value);
  document.documentElement.style.setProperty("--columns", columnCount.value);
};
reloadAll.onclick = () => document.querySelectorAll(".board").forEach((card) => card.reloadBoard());

// Focus mode sizes the board against the viewport, so it needs the real header
// height -- on a phone the header wraps to two rows and is much taller than it is
// on a desktop. Measuring beats hardcoding a number that's only right on one.
const headerElement = document.querySelector("header");
new ResizeObserver(() => {
  document.documentElement.style.setProperty("--header-h", `${headerElement.offsetHeight}px`);
}).observe(headerElement);
manage.onclick = () => {
  manager.hidden = !manager.hidden;
  manage.textContent = manager.hidden ? "Manage dropzones" : "Close manager";
  if (!manager.hidden) search.focus();
};
search.oninput = renderResults;

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
  install.hidden = false;
});
install.onclick = async () => {
  await installPrompt?.prompt();
  installPrompt = null;
  install.hidden = true;
};
window.addEventListener("appinstalled", () => { install.hidden = true; });

// ─── Weather tab — settings helpers ──────────────────────────────────────────
function populateSettingsUI(s) {
  wxHomeLat.value      = s.homeLat;
  wxHomeLon.value      = s.homeLon;
  wxMaxDist.value      = s.maxDistanceMi;
  pMinCeiling.value    = s.preferences.minimumCeilingFt;
  pMaxWind.value       = s.preferences.maximumWindKt;
  pMaxPrecip.value     = s.preferences.maximumPrecipChance;
  pMinVisibility.value = s.preferences.minimumVisibilitySm;
  hiddenDzIds          = new Set(s.hiddenDzIds ?? []);
  updatePreferenceLabels();
}

function updatePreferenceLabels() {
  pMinCeilingVal.textContent    = `${Number(pMinCeiling.value).toLocaleString()} ft`;
  pMaxWindVal.textContent       = `${pMaxWind.value} kt`;
  pMaxPrecipVal.textContent     = `${pMaxPrecip.value}%`;
  pMinVisibilityVal.textContent = `${pMinVisibility.value} SM`;
}

function readPreferencesFromUI() {
  return {
    minimumCeilingFt:    Number(pMinCeiling.value),
    maximumWindKt:       Number(pMaxWind.value),
    maximumPrecipChance: Number(pMaxPrecip.value),
    minimumVisibilitySm: Number(pMinVisibility.value)
  };
}

// Live labels make each slider's actual preference clear while editing.
[pMinCeiling, pMaxWind, pMaxPrecip, pMinVisibility].forEach((el) => {
  el.oninput = updatePreferenceLabels;
});

function toggleSettings() {
  const open = !wxSettingsBody.hidden;
  wxSettingsBody.hidden = open;
  wxToggleArrow.textContent = open ? "▶" : "▼";
}
wxSettingsToggle.onclick = toggleSettings;
wxSettingsToggle.onkeydown = (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleSettings(); }
};

// The desktop default home is one fixed spot; on the web, visitors can be
// anywhere, so offer the browser's location as a one-click fill.
wxUseLocation.onclick = () => {
  if (!navigator.geolocation) {
    wxUseLocationMsg.textContent = "This browser can't share its location.";
    return;
  }
  wxUseLocation.disabled = true;
  wxUseLocationMsg.textContent = "Locating…";
  navigator.geolocation.getCurrentPosition((position) => {
    wxHomeLat.value = position.coords.latitude.toFixed(4);
    wxHomeLon.value = position.coords.longitude.toFixed(4);
    wxUseLocationMsg.textContent = "Filled in — press Save & re-rank.";
    wxUseLocation.disabled = false;
  }, (error) => {
    wxUseLocationMsg.textContent = `Couldn't get your location: ${error.message}`;
    wxUseLocation.disabled = false;
  }, { timeout: 15000, maximumAge: 600000 });
};

// Save settings + re-rank
wxSaveSettings.onclick = () => {
  setWeatherSettings({
    homeLat:       Number(wxHomeLat.value),
    homeLon:       Number(wxHomeLon.value),
    maxDistanceMi: Number(wxMaxDist.value),
    preferences:   readPreferencesFromUI(),
    hiddenDzIds:   [...hiddenDzIds]
  });
  wxLastDay = null;          // force re-fetch with new settings
  wxSettingsBody.hidden = true;
  wxToggleArrow.textContent = "▶";
  fetchWeather();
};

// Reset plain-language flying preferences to the app defaults.
wxResetPreferences.onclick = () => {
  populateSettingsUI(setWeatherSettings({ preferences: DEFAULT_PREFERENCES }));
  wxLastDay = null;
  fetchWeather();
};

// ─── Weather tab — day picker ─────────────────────────────────────────────────
// Local calendar date. toISOString() would give the UTC date, which is already
// tomorrow on a US evening.
function localIsoDate(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function getUpcomingSaturday() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun,6=Sat
  const sat = new Date(now);
  sat.setDate(now.getDate() + (day === 6 ? 0 : 6 - day));
  return localIsoDate(sat);
}

function initDayPicker() {
  wxDay.min = localIsoDate(new Date());
  const tenDays = new Date();
  tenDays.setDate(tenDays.getDate() + 9);
  wxDay.max   = localIsoDate(tenDays);
  wxDay.value = getUpcomingSaturday();
}

wxDay.onchange = () => fetchWeather();
wxRefresh.onclick = () => { wxLastDay = null; fetchWeather(); };

// ─── Weather tab — fetch & render ─────────────────────────────────────────────
async function fetchWeather() {
  const day = wxDay.value;
  if (!day) return;
  wxLastDay = day;
  wxStatus.textContent = "Fetching forecasts… (the first request after the server has been idle can take up to a minute)";
  wxRanking.replaceChildren();
  wxRefresh.disabled = true;

  try {
    const ranking = await getWeatherRanking({ day, preferences: readPreferencesFromUI() });
    wxLastRanking = ranking;
    renderRanking(ranking, day);
  } catch (err) {
    wxLastDay = null; // let switching back to the tab retry
    wxStatus.textContent = `⚠ Error fetching weather: ${err.message}`;
  } finally {
    wxRefresh.disabled = false;
  }
}

function scoreClass(row) {
  if (row.score == null)     return "score-nodata";
  if (row.label === "No-Go") return "score-nogo";
  if (row.score >= 80)       return "score-excellent";
  if (row.score >= 60)       return "score-good";
  if (row.score >= 35)       return "score-marginal";
  return "score-poor";
}

function formatCeil(ft) {
  if (ft == null) return "—";
  if (ft >= 14000) return ">14k ft";
  return `${Math.round(ft / 100) * 100} ft`;
}

function formatVis(sm) {
  if (sm == null) return "—";
  if (sm >= 10)   return ">10 SM";
  return `${sm.toFixed(1)} SM`;
}

// Number of ranked rows to fetch live load status for, bounding request
// volume (each fetch is 2 HTTP requests: bootstrap + getLoads).
const LOADS_FETCH_LIMIT = 15;

function formatLoadSummary(summary) {
  const { loadCount, nextLoad } = summary;
  if (!nextLoad) return "Board open · no loads scheduled";

  const timeLeftMin = nextLoad.timeLeftMin;
  const timing = (timeLeftMin != null && timeLeftMin > 0)
    ? `T-${timeLeftMin} min`
    : (nextLoad.takeOffEpoch != null
        ? new Date(nextLoad.takeOffEpoch * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
        : "—");

  return `▲ Next load: ${nextLoad.name ?? "?"} (${nextLoad.status ?? "?"}) · ${timing} · ${loadCount} load(s) on board`;
}

function condClass(row, factor) {
  if (row.limitingFactor === factor) return "cond-bad";
  if (!row.subScores) return "";
  const s = row.subScores[factor];
  if (s == null) return "";
  if (s < 0.4) return "cond-warn";
  return "";
}

function factorName(factor) {
  return {
    ceiling: "Ceiling",
    wind: "Wind",
    precip: "Precip",
    visibility: "Visibility"
  }[factor] ?? factor;
}

function gateExplanation(factor) {
  return {
    ceiling: "ceiling at or below 2,500 ft",
    wind: "effective wind at or above 28 kt",
    precip: "active precipitation forecast",
    visibility: "visibility below 3 SM"
  }[factor] ?? factor;
}

function makeScoreBreakdown(row) {
  const box = document.createElement("div");
  box.className = "score-breakdown";

  if (row.label === "No-Go") {
    const hits = (row.gateHits?.length ? row.gateHits : [row.limitingFactor])
      .filter(Boolean)
      .map(gateExplanation);
    box.textContent = `No-Go safety limit: ${hits.join("; ")}.`;
    return box;
  }
  if (!row.scoreBreakdown) return box;

  const factors = ["ceiling", "wind", "precip", "visibility"];
  for (const factor of factors) {
    const points = row.scoreBreakdown[factor]?.points;
    if (points == null) continue;
    const part = document.createElement("span");
    part.append(`${factorName(factor)} `);
    const amount = document.createElement("strong");
    amount.textContent = `${points}/25`;
    part.appendChild(amount);
    box.appendChild(part);
  }

  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = `How this ${row.score}/100 score was calculated`;
  const formula = document.createElement("div");
  formula.className = "formula";
  const d = row.scoreBreakdown;
  formula.textContent =
    `Ceiling ${Math.round(d.ceiling.actual).toLocaleString()} ft vs your ${Math.round(d.ceiling.target).toLocaleString()} ft minimum = ${d.ceiling.points}/25; ` +
    `wind ${Math.round(d.wind.actual)} kt vs your ${Math.round(d.wind.target)} kt maximum = ${d.wind.points}/25; ` +
    `precip ${Math.round(d.precip.actual)}% vs your ${Math.round(d.precip.target)}% maximum = ${d.precip.points}/25; ` +
    `visibility ${d.visibility.actual.toFixed(1)} SM vs your ${d.visibility.target.toFixed(1)} SM minimum = ${d.visibility.points}/25. ` +
    "Values use the 10 AM–3 PM forecast.";
  details.append(summary, formula);
  box.appendChild(details);
  return box;
}

function externalLink(text, url) {
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = text;
  return a;
}

// ─── Locate control: airport ID or "lat, lon" → dzOverrides ─────────────────
// Shared between the always-visible needsLocation row and the "⚠ fix" link
// revealed on unverified-geocode rows.
function createLocateControl(row) {
  const wrap = document.createElement("div");
  wrap.className = "dz-locate";

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = 'Airport ID (e.g. C29) or "43.07, -89.40"';

  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "Locate";

  const msg = document.createElement("span");
  msg.className = "dz-locate-msg";

  async function submit() {
    const value = input.value.trim();
    btn.disabled = true;
    msg.textContent = "";
    msg.classList.remove("dz-locate-error");
    try {
      const res = await resolveDzLocation(row.dzId, value);
      if (res.ok) {
        msg.textContent = res.override ? `✓ ${res.override.label}` : "✓ location cleared";
        wxLastDay = null; // force a full re-fetch with the new override
        setTimeout(() => fetchWeather(), 500);
      } else {
        msg.textContent = res.message || "Could not resolve location";
        msg.classList.add("dz-locate-error");
        btn.disabled = false;
      }
    } catch (err) {
      msg.textContent = err?.message || "Error resolving location";
      msg.classList.add("dz-locate-error");
      btn.disabled = false;
    }
  }

  btn.onclick = submit;
  input.onkeydown = (e) => { if (e.key === "Enter") submit(); };

  wrap.append(input, btn, msg);
  return wrap;
}

function makeBoardTag() {
  const tag = document.createElement("span");
  tag.className = "dz-board-tag";
  tag.textContent = "★ board";
  return tag;
}

// A board DZ with no known location at all — muted score badge + inline
// airport-ID/lat-lon input instead of the usual conditions/links/actions.
function makeNeedsLocationRow(row) {
  const el = document.createElement("div");
  el.className = "dz-row dz-row-needs-location";

  const scoreEl = document.createElement("div");
  scoreEl.className = "dz-score score-nodata";
  scoreEl.innerHTML = `<span class="score-label" style="font-size:.7rem">—</span>`;

  const info = document.createElement("div");
  info.className = "dz-info";

  const name = document.createElement("div");
  name.className = "dz-name";
  name.append(document.createTextNode(row.name + " "));
  if (row.isBoard) name.appendChild(makeBoardTag());

  const meta = document.createElement("div");
  meta.className = "dz-meta";
  meta.textContent = "Location needed — no coordinates on file for this dropzone.";

  info.append(name, meta, createLocateControl(row));
  el.append(scoreEl, info, document.createElement("div"), document.createElement("div"));
  return el;
}

function makeRow(row, index, gen) {
  if (row.needsLocation) return makeNeedsLocationRow(row);

  const el = document.createElement("div");
  el.className = "dz-row";

  // Score badge
  const scoreEl = document.createElement("div");
  scoreEl.className = `dz-score ${scoreClass(row)}`;
  if (row.score != null) {
    scoreEl.innerHTML = `${row.score}<span class="score-label">${row.label}</span>`;
  } else {
    scoreEl.innerHTML = `<span class="score-label" style="font-size:.7rem">${row.label}</span>`;
  }

  // Info block
  const info = document.createElement("div");
  info.className = "dz-info";

  const name = document.createElement("div");
  name.className = "dz-name";
  name.append(document.createTextNode(row.name + (row.isBoard ? " " : "")));
  if (row.isBoard) name.appendChild(makeBoardTag());

  const meta = document.createElement("div");
  meta.className = "dz-meta";
  const statePart = row.state ? ` · ${row.state}` : "";
  meta.appendChild(document.createTextNode(`${row.distanceMi} mi away${statePart}${row.ceilSource === "estimated" ? " · ceiling estimated" : ""}`));

  // Location provenance: an override shows its label; otherwise an
  // unverified catalog geocode (low/medium/absent confidence) shows a
  // "fix" link that reveals the same locate control used above.
  let locateBox = null;
  if (row.locationSource === "override") {
    const note = document.createElement("span");
    note.className = "dz-location-note";
    note.textContent = ` · 📍 ${row.locationLabel || "custom location"}`;
    meta.appendChild(note);
  } else if (row.geoConfidence !== "manual") {
    meta.appendChild(document.createTextNode(" · "));
    const warn = document.createElement("a");
    warn.href = "#";
    warn.className = "dz-location-warn";
    warn.textContent = "⚠ location unverified — fix";
    warn.onclick = (e) => {
      e.preventDefault();
      locateBox.hidden = !locateBox.hidden;
    };
    meta.appendChild(warn);
    locateBox = createLocateControl(row);
    locateBox.hidden = true;
  }

  const conds = document.createElement("div");
  conds.className = "dz-conditions";

  if (row.ceilFt != null) {
    const s = document.createElement("span");
    s.className = condClass(row, "ceiling");
    s.textContent = `Ceiling ${formatCeil(row.ceilFt)}`;
    conds.appendChild(s);
  }
  if (row.windKt != null) {
    const s = document.createElement("span");
    s.className = condClass(row, "wind");
    const gustPart = row.gustKt && row.gustKt > row.windKt + 2 ? ` G${Math.round(row.gustKt)}` : "";
    s.textContent = `Wind ${Math.round(row.windKt)}${gustPart} kt`;
    conds.appendChild(s);
  }
  if (row.precipProb != null) {
    const s = document.createElement("span");
    s.className = condClass(row, "precip");
    s.textContent = `Precip ${Math.round(row.precipProb)}%`;
    conds.appendChild(s);
  }
  if (row.visSm != null) {
    const s = document.createElement("span");
    s.className = condClass(row, "visibility");
    s.textContent = `Vis ${formatVis(row.visSm)}`;
    conds.appendChild(s);
  }

  info.append(name, meta);
  if (locateBox) info.appendChild(locateBox);
  info.appendChild(conds);
  info.appendChild(makeScoreBreakdown(row));

  // Source links — skip entirely for "No data" rows (nothing to link to).
  const isNoData = row.score == null && row.limitingFactor === "fetch-error";
  if (!isNoData) {
    const links = document.createElement("div");
    links.className = "dz-links";

    const isNWS = row.forecastSource === "nws";
    const forecastUrl = isNWS
      ? `https://forecast.weather.gov/MapClick.php?lat=${row.lat}&lon=${row.lon}`
      : `https://open-meteo.com/en/docs#latitude=${row.lat}&longitude=${row.lon}` +
        `&hourly=cloud_cover_low,cloud_cover_mid,cloud_cover_high,precipitation_probability,precipitation,wind_speed_10m,wind_gusts_10m,visibility` +
        `&wind_speed_unit=kn&forecast_days=10`;
    links.appendChild(externalLink(isNWS ? "NWS ↗" : "Open-Meteo ↗", forecastUrl));

    if (row.metarStation) {
      const metarUrl = `https://aviationweather.gov/data/metar/?id=${row.metarStation}&hours=12&decoded=yes`;
      const distPart = row.metarStationDistMi != null ? ` · ${row.metarStationDistMi} mi` : "";
      const metarLink = externalLink(`METAR ${row.metarStation}${distPart} ↗`, metarUrl);
      if (row.metarStationName) metarLink.title = row.metarStationName;
      links.appendChild(metarLink);
    }

    info.appendChild(links);
  }

  // Live load status — only for scored rows, and only the first
  // LOADS_FETCH_LIMIT rows (bounds request volume).
  if (row.score != null && index < LOADS_FETCH_LIMIT) {
    const loadsEl = document.createElement("div");
    loadsEl.className = "dz-loads";
    loadsEl.textContent = "checking board…";
    info.appendChild(loadsEl);

    getDzLoads(row.dzId).then((summary) => {
      if (gen !== wxRenderGeneration) return; // a newer render superseded this fetch
      if (!summary || summary.error) {
        loadsEl.remove();
        return;
      }
      loadsEl.textContent = formatLoadSummary(summary);
    }).catch(() => {
      if (gen === wxRenderGeneration) loadsEl.remove();
    });
  }

  // Limiting factor badge (only when not null and not a No-Go gate — we show the gate reason separately)
  const limitEl = document.createElement("div");
  if (row.limitingFactor && row.score != null && row.score > 0) {
    const badge = document.createElement("div");
    badge.className = "limiting-factor";
    badge.textContent = `↓ ${row.limitingFactor}`;
    limitEl.appendChild(badge);
  } else if (row.label === "No-Go" && row.limitingFactor) {
    const badge = document.createElement("div");
    badge.className = "limiting-factor";
    badge.textContent = `✕ ${row.limitingFactor}`;
    limitEl.appendChild(badge);
  }

  // Actions
  const actions = document.createElement("div");
  actions.className = "dz-actions";

  const isAdded = boards.some((b) => b.dzId === row.dzId);
  const addBtn  = document.createElement("button");
  addBtn.type   = "button";
  addBtn.textContent = isAdded ? "On boards" : "Add board";
  addBtn.disabled    = isAdded;
  if (!isAdded) {
    addBtn.onclick = () => {
      addBoard({ dzId: row.dzId, name: row.name });
      addBtn.textContent = "On boards";
      addBtn.disabled    = true;
    };
  }

  const openBtn   = document.createElement("button");
  openBtn.type    = "button";
  openBtn.textContent = "Open ↗";
  openBtn.onclick = () => window.open(boardUrlForDzId(row.dzId), "_blank", "noopener");

  const hideBtn   = document.createElement("button");
  hideBtn.type    = "button";
  hideBtn.textContent = "Hide";
  hideBtn.title   = "Remove from list (persists across refreshes)";
  hideBtn.onclick = () => {
    hiddenDzIds.add(row.dzId);
    setWeatherSettings({ hiddenDzIds: [...hiddenDzIds] });
    if (wxLastRanking) renderRanking(wxLastRanking, wxLastDay);
  };

  actions.append(addBtn, openBtn, hideBtn);
  el.append(scoreEl, info, limitEl, actions);
  return el;
}

function renderRanking(ranking, day) {
  const excludedLowConfidence = ranking?.excludedLowConfidence ?? 0;

  if (!ranking || ranking.length === 0) {
    const suffix = excludedLowConfidence > 0
      ? ` (${excludedLowConfidence} excluded — low-confidence geocode)`
      : "";
    wxStatus.textContent = `No dropzones with coordinates found within range. Check Settings.${suffix}`;
    return;
  }

  // Sort by distance ascending (closest first); rows with no location
  // (needsLocation) have no distanceMi and sort to the end, preserving the
  // needsLocation-before-no-data order getRanking already produced for them.
  const sorted = [...ranking].sort((a, b) => {
    if (a.distanceMi == null && b.distanceMi == null) return 0;
    if (a.distanceMi == null) return 1;
    if (b.distanceMi == null) return -1;
    return a.distanceMi - b.distanceMi;
  });
  const visible = sorted.filter((r) => !hiddenDzIds.has(r.dzId));
  const hiddenCount = sorted.length - visible.length;

  const date    = new Date(day + "T12:00:00");
  const dateStr = date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  const scored   = visible.filter((r) => r.score != null);
  const needsLoc = visible.filter((r) => r.needsLocation);
  const noData   = visible.filter((r) => r.score == null && !r.needsLocation);

  const statusParts = [
    `${dateStr} — ${scored.length} DZ${scored.length !== 1 ? "s" : ""} ranked`
  ];
  if (noData.length)   statusParts.push(`${noData.length} no data`);
  if (needsLoc.length) statusParts.push(`${needsLoc.length} need location`);
  if (hiddenCount > 0) statusParts.push(`${hiddenCount} hidden`);
  if (excludedLowConfidence > 0) statusParts.push(`${excludedLowConfidence} excluded (low-confidence geocode)`);

  // Build status line with optional "Show all" link
  wxStatus.replaceChildren();
  wxStatus.appendChild(document.createTextNode(statusParts.join(" · ")));
  if (hiddenCount > 0) {
    const showAll = document.createElement("a");
    showAll.href        = "#";
    showAll.textContent = " Show all";
    showAll.className   = "wx-show-all";
    showAll.onclick = (e) => {
      e.preventDefault();
      hiddenDzIds.clear();
      setWeatherSettings({ hiddenDzIds: [] });
      renderRanking(wxLastRanking, wxLastDay);
    };
    wxStatus.appendChild(showAll);
  }

  wxRenderGeneration += 1;
  const gen = wxRenderGeneration;
  wxRanking.replaceChildren(...visible.map((row, i) => makeRow(row, i, gen)));
}

// ─── Startup ──────────────────────────────────────────────────────────────────
(async () => {
  try {
    const response = await fetch("dropzones.json");
    dropzones = await response.json();
  } catch (_) {
    manager.querySelector("p").textContent = "The dropzone catalog could not be loaded.";
  }
  renderBoards();
  initDayPicker();
  populateSettingsUI(wxSettings);
  if (location.hash === "#weather") switchTab("weather");
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("service-worker.js");
})();
