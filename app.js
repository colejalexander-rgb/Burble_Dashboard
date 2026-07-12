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

const dashboard = document.getElementById("dashboard");
const empty = document.getElementById("empty");
const columnCount = document.getElementById("columnCount");
const reloadAll = document.getElementById("reloadAll");
const install = document.getElementById("install");
const manage = document.getElementById("manage");
const manager = document.getElementById("manager");
const search = document.getElementById("search");
const results = document.getElementById("results");

let boards = loadBoards();
let dropzones = [];
let focusedId = null;
let installPrompt = null;

function normalizeBoard(input) {
  const dzId = Number.parseInt(input?.dzId, 10);
  const name = String(input?.name || "").trim();
  if (!Number.isSafeInteger(dzId) || dzId <= 0 || !name || name.length > 150) throw new Error("Invalid dropzone");
  return {
    id: `dz-${dzId}`,
    dzId,
    name,
    url: `burble/${dzId}/jmp?${BOARD_OPTIONS}&dz_id=${dzId}`
  };
}

function loadBoards() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return Array.isArray(saved) ? saved.map(normalizeBoard) : DEFAULT_BOARDS.map(normalizeBoard);
  } catch (_) {
    return DEFAULT_BOARDS.map(normalizeBoard);
  }
}

function saveBoards() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(boards.map(({ dzId, name }) => ({ dzId, name }))));
}

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
    button.onclick = () => {
      boards.push(normalizeBoard(dropzone));
      saveBoards();
      renderBoards();
    };
    return row;
  }));
  if (query && !matches.length) results.textContent = "No matching dropzones.";
}

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

(async () => {
  try {
    const response = await fetch("dropzones.json");
    dropzones = await response.json();
  } catch (_) {
    manager.querySelector("p").textContent = "The dropzone catalog could not be loaded.";
  }
  renderBoards();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("service-worker.js");
})();
