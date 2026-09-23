const http = require("http");
const fs = require("fs");
const path = require("path");
// Shared with the desktop app: lib/ holds byte-identical copies of
// desktop/weather.js, airports.js and burble-loads.js (scripts/deploy-web.ps1
// refuses to deploy if they drift).
const weather = require("./lib/weather");
const airports = require("./lib/airports");
const burbleLoads = require("./lib/burble-loads");

const PORT = Number(process.env.PORT) || 4174;
const ROOT = __dirname;
const UPSTREAM = "https://us-displays.burblesoft.com";
const sessions = new Map();
const CATALOG = JSON.parse(fs.readFileSync(path.join(ROOT, "dropzones.json"), "utf8").replace(/^﻿/, ""));
// This server is public, and one ranking request fans out to a forecast fetch
// per dropzone, so bound everything a client can send.
const MAX_BODY_BYTES = 64 * 1024;
const MAX_BOARD_IDS = 50;
const MAX_OVERRIDES = 200;
const DEFAULT_HOME = { lat: 43.0731, lon: -89.4012 };
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json; charset=utf-8"
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Cache-Control": "no-store", ...headers });
  res.end(body);
}

function serveStatic(req, res) {
  const requestPath = new URL(req.url, `http://${req.headers.host}`).pathname;
  const relativePath = requestPath === "/" ? "index.html" : decodeURIComponent(requestPath.slice(1));
  const filePath = path.resolve(ROOT, relativePath);
  if (!filePath.startsWith(`${ROOT}${path.sep}`) && filePath !== path.join(ROOT, "index.html")) {
    send(res, 403, "Forbidden");
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      send(res, error.code === "ENOENT" ? 404 : 500, error.code === "ENOENT" ? "Not found" : "Server error");
      return;
    }
    const type = MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
    res.end(data);
  });
}

function updateCookie(dzId, headers) {
  const values = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : [headers.get("set-cookie")].filter(Boolean);
  for (const value of values) {
    const match = value.match(/(?:^|,\s*)(burblesoft=[^;,\s]+)/i);
    if (match) sessions.set(dzId, match[1]);
  }
}

async function requestUpstream(dzId, target, options) {
  let url = target;
  let method = options.method;
  let body = options.body;
  for (let redirects = 0; redirects < 10; redirects += 1) {
    const headers = { ...options.headers };
    const cookie = sessions.get(dzId);
    if (cookie) headers.cookie = cookie;
    const response = await fetch(url, { method, headers, body, redirect: "manual" });
    updateCookie(dzId, response.headers);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    url = new URL(location, url).href;
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
      delete options.headers["content-length"];
      delete options.headers["content-type"];
    }
  }
  throw new Error("Too many Burble redirects");
}

function rewriteText(text, dzId) {
  const prefix = `/burble/${dzId}/`;
  return text
    .replace(/https:\/\/us-displays\.burblesoft\.com(?::443)?\//gi, prefix)
    .replace(/https:\/\/dzm\.burblesoft\.com(?::443)?\//gi, prefix)
    .replace(/https:\\\/\\\/us-displays\.burblesoft\.com(?::443)?\\\//gi, prefix.replaceAll("/", "\\/"))
    .replace(/https:\\\/\\\/dzm\.burblesoft\.com(?::443)?\\\//gi, prefix.replaceAll("/", "\\/"));
}

async function proxyBurble(req, res, match) {
  const dzId = match[1];
  const suffix = match[2] || "";
  const incoming = new URL(req.url, `http://${req.headers.host}`);
  const target = new URL(`/${suffix}${incoming.search}`, UPSTREAM).href;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = {};
  for (const name of ["accept", "accept-language", "content-type", "user-agent"]) {
    if (req.headers[name]) headers[name] = req.headers[name];
  }

  const response = await requestUpstream(dzId, target, { method: req.method, headers, body });
  const contentType = response.headers.get("content-type") || "application/octet-stream";
  const isText = /(?:text\/|javascript|json|xml|css)/i.test(contentType);
  const responseBody = isText
    ? Buffer.from(rewriteText(await response.text(), dzId))
    : Buffer.from(await response.arrayBuffer());
  const outputHeaders = {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  };
  send(res, response.status, responseBody, outputHeaders);
}

// ─── Weather API (the desktop app's IPC handlers, as JSON endpoints) ─────────

function log(message, error = null) {
  console.log(error ? `${message}: ${error.message || error}` : message);
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function sendJson(res, status, data) {
  send(res, status, JSON.stringify(data), { "Content-Type": "application/json; charset=utf-8" });
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw httpError(413, "Request too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch (_) {
    throw httpError(400, "Invalid JSON");
  }
}

function numberIn(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

// Settings live in the browser, so the client sends them with each request.
// Mirrors main.js's get-weather-ranking handler.
async function apiRanking(req, res) {
  const body = await readJson(req);
  const day = String(body.day ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw httpError(400, "Invalid day");

  const boardDzIds = (Array.isArray(body.boardDzIds) ? body.boardDzIds : [])
    .map(Number)
    .filter((id) => Number.isSafeInteger(id) && id > 0)
    .slice(0, MAX_BOARD_IDS);

  const dzOverrides = {};
  const rawOverrides = body.dzOverrides && typeof body.dzOverrides === "object" ? body.dzOverrides : {};
  for (const [id, override] of Object.entries(rawOverrides).slice(0, MAX_OVERRIDES)) {
    const dzId = Number(id);
    const lat = numberIn(override?.lat, -90, 90, null);
    const lon = numberIn(override?.lon, -180, 180, null);
    if (!Number.isSafeInteger(dzId) || dzId <= 0 || lat == null || lon == null) continue;
    dzOverrides[dzId] = { lat, lon, label: String(override.label ?? "").slice(0, 120) || null };
  }

  const ranking = await weather.getRanking({
    day,
    catalog:       CATALOG,
    homeLat:       numberIn(body.homeLat, -90, 90, DEFAULT_HOME.lat),
    homeLon:       numberIn(body.homeLon, -180, 180, DEFAULT_HOME.lon),
    maxDistanceMi: numberIn(body.maxDistanceMi, 25, 1000, 250),
    preferences:   weather.normalizePreferences(body.preferences),
    boardDzIds,
    dzOverrides
  }, log);
  // excludedLowConfidence is a property on the array, which JSON would drop.
  sendJson(res, 200, { rows: ranking, excludedLowConfidence: ranking.excludedLowConfidence ?? 0 });
}

// Mirrors main.js's resolve-dz-location, minus persistence (the browser
// stores the override).
async function apiResolveLocation(req, res) {
  const body = await readJson(req);
  const query = String(body.query ?? "").trim().slice(0, 60);
  let resolved = null;
  try {
    resolved = query ? await airports.resolveLocation(query) : null;
  } catch (error) {
    log(`resolve-location: lookup threw for "${query}"`, error);
  }
  if (!resolved) {
    sendJson(res, 200, { ok: false, message: `Couldn't find an airport or coordinates for "${query}"` });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    override: { lat: resolved.lat, lon: resolved.lon, label: resolved.label, icaoId: resolved.icaoId ?? null }
  });
}

async function apiLoads(res, dzId) {
  sendJson(res, 200, await burbleLoads.getLoadSummary(dzId));
}

async function routeApi(req, res, pathname) {
  if (pathname === "/api/weather/ranking" && req.method === "POST") return apiRanking(req, res);
  if (pathname === "/api/resolve-location" && req.method === "POST") return apiResolveLocation(req, res);
  const loads = pathname.match(/^\/api\/loads\/(\d{1,9})$/);
  if (loads && req.method === "GET") return apiLoads(res, Number(loads[1]));
  throw httpError(404, "Unknown API route");
}

const server = http.createServer(async (req, res) => {
  let pathname = "/";
  try {
    pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
    if (pathname.startsWith("/api/")) {
      await routeApi(req, res, pathname);
      return;
    }
    const match = pathname.match(/^\/burble\/(\d+)\/?(.*)$/);
    if (match) {
      await proxyBurble(req, res, match);
      return;
    }
    serveStatic(req, res);
  } catch (error) {
    // 4xx are the client's fault (bad input, unknown route); no stack needed.
    if (error.status && error.status < 500) console.log(`${req.method} ${pathname}: ${error.status} ${error.message}`);
    else console.error(error);
    if (res.headersSent) return;
    if (pathname.startsWith("/api/")) {
      sendJson(res, error.status || 500, { error: error.status ? error.message : `Server error: ${error.message}` });
      return;
    }
    send(res, 502, `Burble proxy error: ${error.message}`, { "Content-Type": "text/plain; charset=utf-8" });
  }
});

server.listen(PORT, () => {
  console.log(`Burble Dashboard running at http://localhost:${PORT}/`);
});
