// burble-loads.js
// Main-process module fetching live jump-load status for a single dropzone
// from Burble's public jump board (the same board the "board windows" load).
//
// Public API (called from main.js):
//   getLoadSummary(dzId) → Promise<{ dzId, loadCount, nextLoad } | { dzId, error: true }>
//
// All network calls stay in the main process — never the renderer.

"use strict";

const https = require("https");
const { URL } = require("url");

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const TIMEOUT_MS = 8_000;

// In-memory cache: dzId → { ts, data }
const _cache = new Map();
const CACHE_TTL_MS = 60 * 1000; // 60 seconds

// Drop expired entries. Called on every write so the cache can't grow
// unbounded over a long session.
function pruneCache() {
  const now = Date.now();
  for (const [key, entry] of _cache) {
    if (now - entry.ts >= CACHE_TTL_MS) _cache.delete(key);
  }
}

// ─── Low-level HTTP helper ────────────────────────────────────────────────
// Returns { statusCode, headers, body } WITHOUT following redirects, so
// callers can inspect Location + Set-Cookie headers themselves (unlike
// weather.js's get(), which parses JSON and assumes a single 200 response).
function rawGet(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "User-Agent": USER_AGENT, ...extraHeaders } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on("error", reject);
    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error(`Timeout (${TIMEOUT_MS}ms): ${url}`));
    });
  });
}

// Extract the `burblesoft=...` cookie pair from a raw Set-Cookie header list.
function extractBurbleCookie(setCookieHeaders) {
  if (!setCookieHeaders) return null;
  for (const line of setCookieHeaders) {
    const match = /^burblesoft=([^;]+)/.exec(line);
    if (match) return `burblesoft=${match[1]}`;
  }
  return null;
}

// ─── Session bootstrap ────────────────────────────────────────────────────
// GETs the board page for one dzId and follows its 302 to
// us-displays.burblesoft.com, collecting the burblesoft session cookie along
// the way. The session is bound to the dzId used here — the getLoads
// endpoint ignores its own dz_id param and just returns whatever DZ the
// cookie was bootstrapped for — so this must run fresh per DZ, never shared.
async function bootstrapCookie(dzId) {
  const first = await rawGet(`https://dzm.burblesoft.com/jmp?dz_id=${dzId}`);
  let cookie = extractBurbleCookie(first.headers["set-cookie"]);

  const location = first.headers.location;
  if (first.statusCode >= 300 && first.statusCode < 400 && location) {
    const nextUrl = new URL(location, "https://dzm.burblesoft.com").toString();
    const second = await rawGet(nextUrl, cookie ? { Cookie: cookie } : {});
    cookie = extractBurbleCookie(second.headers["set-cookie"]) ?? cookie;
  }

  if (!cookie) throw new Error(`No burblesoft session cookie for dzId ${dzId}`);
  return cookie;
}

// ─── Load board fetch ─────────────────────────────────────────────────────
async function fetchLoads(dzId, cookie) {
  const url =
    `https://us-displays.burblesoft.com/ajax_dzm2_frontend_jumpermanifestpublic` +
    `?action=getLoads&dz_id=${dzId}`;
  const res = await rawGet(url, { Cookie: cookie });

  let data;
  try { data = JSON.parse(res.body); }
  catch (e) { throw new Error(`Bad JSON from getLoads: ${e.message}`); }

  if (!data || data.success !== true || !Array.isArray(data.loads)) {
    throw new Error("getLoads returned success:false or a malformed body");
  }
  return data.loads;
}

// Reduce the raw (padded) loads array to { dzId, loadCount, nextLoad }.
// The array is padded to the column count with empty arrays; real loads are
// objects with an `id`.
function reduceLoads(dzId, loads) {
  const realLoads = loads.filter((l) => l && typeof l === "object" && !Array.isArray(l) && l.id != null);
  const loadCount = realLoads.length;

  // Prefer the load with the smallest positive time_left; fall back to the
  // smallest expected take-off epoch if none have a usable time_left.
  let byTimeLeft = null, bestTimeLeft = Infinity;
  let byTakeOff  = null, bestTakeOff  = Infinity;

  for (const l of realLoads) {
    const timeLeft = Number(l.time_left);
    if (Number.isFinite(timeLeft) && timeLeft > 0 && timeLeft < bestTimeLeft) {
      bestTimeLeft = timeLeft;
      byTimeLeft = l;
    }
    const takeOff = Number(l.caculate_expected_take_off ?? l.expected_take_off);
    if (Number.isFinite(takeOff) && takeOff < bestTakeOff) {
      bestTakeOff = takeOff;
      byTakeOff = l;
    }
  }

  const chosen = byTimeLeft ?? byTakeOff;
  let nextLoad = null;
  if (chosen) {
    const timeLeftMin  = Number(chosen.time_left);
    const takeOffEpoch = Number(chosen.caculate_expected_take_off ?? chosen.expected_take_off);
    nextLoad = {
      name:         chosen.name ?? null,
      status:       chosen.status ?? null,
      timeLeftMin:  Number.isFinite(timeLeftMin)  ? timeLeftMin  : null,
      takeOffEpoch: Number.isFinite(takeOffEpoch) ? takeOffEpoch : null
    };
  }

  return { dzId, loadCount, nextLoad };
}

// ─── Public API ────────────────────────────────────────────────────────────
// Many catalog DZs aren't Burble-public (no session cookie, bad dz_id, board
// disabled, etc.) — any failure along the way must fail quietly so a single
// bad DZ doesn't break the ranking list.
async function getLoadSummary(dzId) {
  const hit = _cache.get(dzId);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.data;

  let result;
  try {
    const cookie = await bootstrapCookie(dzId);
    const loads  = await fetchLoads(dzId, cookie);
    result = reduceLoads(dzId, loads);
  } catch (_err) {
    result = { dzId, error: true };
  }

  pruneCache();
  _cache.set(dzId, { ts: Date.now(), data: result });
  return result;
}

module.exports = { getLoadSummary };
