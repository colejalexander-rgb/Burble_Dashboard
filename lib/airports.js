// airports.js
// Main-process module resolving a DZ location from an airport identifier or
// a raw lat/lon pair, using the aviationweather.gov station-info API.
//
// Public API (called from main.js):
//   resolveLocation(query) → Promise<{ lat, lon, label, icaoId?, source } | null>
//
// All network calls stay in the main process — never the renderer.

"use strict";

const https = require("https");

const TIMEOUT_MS = 8_000;

// ─── HTTP helper (mirrors weather.js's get()) ────────────────────────────────
// aviationweather.gov's stationinfo endpoint returns HTTP 204 (empty body,
// not `200` + `[]`) for an ident with no match at all — treat that as an
// empty result rather than an error so the K-prefix retry still runs.
function get(url, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "User-Agent": "BurbleDashboard/2.0 (airport-lookup)" } },
      (res) => {
        if (res.statusCode === 204) {
          res.resume();
          return resolve([]);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error(`Bad JSON from ${url}: ${e.message}`)); }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`Timeout (${timeoutMs}ms): ${url}`));
    });
  });
}

// In-memory cache: "id:<IDENT>" → resolved result or null (idents don't move,
// so both hits and confirmed misses are safe to cache for the app's lifetime).
const _cache = new Map();

// ─── "lat, lon" parsing ───────────────────────────────────────────────────────
function parseCoordsQuery(raw) {
  const m = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/.exec(raw);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon, label: `${lat}, ${lon}`, source: "coords" };
}

// ─── aviationweather.gov stationinfo lookup ──────────────────────────────────
async function lookupIdent(ident) {
  const url = `https://aviationweather.gov/api/data/stationinfo?ids=${encodeURIComponent(ident)}&format=json`;
  const data = await get(url);
  return Array.isArray(data) ? data : [];
}

// query: an airport identifier (KENW, C29, 57C — case-insensitive) or a
// "lat, lon" pair. Never throws — resolves to null on any failure/no-match.
async function resolveLocation(query) {
  const raw = String(query ?? "").trim();
  if (!raw) return null;

  const coords = parseCoordsQuery(raw);
  if (coords) return coords;

  const ident = raw.toUpperCase();
  const cacheKey = `id:${ident}`;
  if (_cache.has(cacheKey)) return _cache.get(cacheKey);

  let result = null;
  let definitive = false; // only cache a confirmed hit or confirmed no-match

  try {
    let hits = await lookupIdent(ident);
    if (!hits.length && !ident.startsWith("K")) {
      // Many US idents (57C, C29, ...) don't resolve bare; retry with K prefix.
      hits = await lookupIdent(`K${ident}`);
    }
    definitive = true;

    const hit = hits[0];
    if (hit && hit.lat != null && hit.lon != null) {
      result = {
        lat: Number(hit.lat),
        lon: Number(hit.lon),
        label: `${hit.icaoId ?? ident} — ${hit.site ?? "?"}, ${hit.state ?? "?"}`,
        icaoId: hit.icaoId ?? null,
        source: "airport"
      };
    }
  } catch (_err) {
    result = null; // never throw to the caller; treat as "couldn't resolve"
  }

  if (definitive) _cache.set(cacheKey, result);
  return result;
}

module.exports = { resolveLocation };
