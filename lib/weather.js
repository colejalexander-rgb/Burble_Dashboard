// weather.js
// Main-process weather module for Burble Dashboard.
//
// Fetches Open-Meteo forecast (free, no API key) + aviationweather.gov METARs
// (official ceilings/vis/wind), scores each dropzone by skydiving flyability
// using a nonlinear, gated algorithm, and returns a ranked result list.
// Falls back to NWS gridpoint forecasts when Open-Meteo is unavailable for a
// DZ, and always includes every board dropzone in the result — even ones
// with no known coordinates, as a "Location needed" row.
//
// Public API (called from main.js):
//   getRanking({ day, catalog, homeLat, homeLon, maxDistanceMi, preferences,
//                boardDzIds, dzOverrides }) → Promise<DzResult[]>
//
// All network calls stay in the main process — never the renderer.

"use strict";

const https = require("https");

// ─── Hard gate thresholds ─────────────────────────────────────────────────────
// Any single gate being tripped forces the DZ to score 0 / "No-Go".
// These are safety minimums — NOT user-adjustable in v1.
const CEILING_GATE_FT = 2500;  // ft AGL: minimum for typical full-altitude operations
const GUST_GATE_KT    = 28;    // kt:     above this, most DZs ground aircraft
const VIS_GATE_SM     = 3.0;   // statute miles
const PRECIP_MM_GATE  = 0.1;   // mm/hr: any measurable active precip = No-Go

// Use METAR data to *trust* a ceiling only when the nearest reporting
// station is within this distance. Beyond that, the station can still be
// linked to (see nearestMETAR / Task 3) but isn't used for scoring.
const METAR_RADIUS_KM = 65;

// Labels applied to final scores
const LABEL_EXCELLENT = 80;
const LABEL_GOOD      = 60;
const LABEL_MARGINAL  = 35;

// In-memory cache: key → { timestamp, data }
const _cache = new Map();
const CACHE_TTL_MS = 20 * 60 * 1000; // 20 minutes

// Drop expired entries. Called on every write so the cache can't grow
// unbounded over a long session (TTL was previously only checked on read).
function pruneCache() {
  const now = Date.now();
  for (const [key, entry] of _cache) {
    if (now - entry.ts >= CACHE_TTL_MS) _cache.delete(key);
  }
}

// ─── Default personal flying preferences ──────────────────────────────────────
// These are operational thresholds the user can reason about, rather than
// opaque weights. Each factor earns an equal 25 points toward the 100-point
// score. The hard safety gates above always take precedence.
const DEFAULT_PREFERENCES = {
  minimumCeilingFt:  8000,
  maximumWindKt:       18,
  maximumPrecipChance: 30,
  minimumVisibilitySm:  5
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function preferredNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? clamp(parsed, min, max) : fallback;
}

function normalizePreferences(preferences) {
  return {
    minimumCeilingFt: preferredNumber(preferences?.minimumCeilingFt, DEFAULT_PREFERENCES.minimumCeilingFt, CEILING_GATE_FT + 500, 14000),
    maximumWindKt: preferredNumber(preferences?.maximumWindKt, DEFAULT_PREFERENCES.maximumWindKt, 8, GUST_GATE_KT - 1),
    maximumPrecipChance: preferredNumber(preferences?.maximumPrecipChance, DEFAULT_PREFERENCES.maximumPrecipChance, 5, 95),
    minimumVisibilitySm: preferredNumber(preferences?.minimumVisibilitySm, DEFAULT_PREFERENCES.minimumVisibilitySm, VIS_GATE_SM + 1, 10)
  };
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────
function get(url, timeoutMs = 12_000) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "User-Agent": "BurbleDashboard/2.0 (weather-ranking)" } },
      (res) => {
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

// ─── Haversine helpers ────────────────────────────────────────────────────────
function haversineMi(lat1, lon1, lat2, lon2) {
  const R   = 3958.8;
  const φ1  = lat1 * Math.PI / 180;
  const φ2  = lat2 * Math.PI / 180;
  const dφ  = (lat2 - lat1) * Math.PI / 180;
  const dλ  = (lon2 - lon1) * Math.PI / 180;
  const a   = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function haversineKm(lat1, lon1, lat2, lon2) {
  return haversineMi(lat1, lon1, lat2, lon2) * 1.60934;
}

// ─── Open-Meteo forecast fetch ────────────────────────────────────────────────
// Fetches hourly forecast for one lat/lon. Returns the raw API response.
async function fetchForecast(lat, lon) {
  const params = new URLSearchParams({
    latitude:        lat,
    longitude:       lon,
    hourly:          "cloud_cover_low,cloud_cover_mid,cloud_cover_high,precipitation_probability,precipitation,wind_speed_10m,wind_gusts_10m,visibility",
    wind_speed_unit: "kn",
    precipitation_unit: "mm",
    timezone:        "auto",
    forecast_days:   10
  });
  return get(`https://api.open-meteo.com/v1/forecast?${params}`);
}

// Extract the "representative" value for a day — mean/max across prime jump hours (10:00-15:00).
function extractDaySlice(forecast, day) {
  const { hourly } = forecast;
  const times = hourly.time;
  const PRIME = ["T10:", "T11:", "T12:", "T13:", "T14:", "T15:"];
  const idx = times.reduce((acc, t, i) => {
    if (t.startsWith(day) && PRIME.some((h) => t.includes(h))) acc.push(i);
    return acc;
  }, []);

  if (idx.length === 0) return null; // day out of forecast range

  const avg = (key) => {
    const vals = idx.map((i) => hourly[key][i]).filter((v) => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  const max = (key) => {
    const vals = idx.map((i) => hourly[key][i]).filter((v) => v != null);
    return vals.length ? Math.max(...vals) : null;
  };

  return {
    cloudCoverLow:  avg("cloud_cover_low"),              // % — 0-2 km layer
    cloudCoverMid:  avg("cloud_cover_mid"),              // % — 2-6 km layer
    cloudCoverHigh: avg("cloud_cover_high"),             // % — >6 km layer
    precipProb:     max("precipitation_probability"),    // % — worst prime-hour value
    precipitation:  max("precipitation"),               // mm — worst prime-hour value
    windKt:         avg("wind_speed_10m"),              // kt — avg
    gustKt:         max("wind_gusts_10m"),              // kt — worst
    visM:           avg("visibility"),                  // metres
  };
}

// ─── NWS gridpoint forecast fetch (fallback when Open-Meteo fails) ──────────
// US-only (aviationweather-style METAR coverage doesn't apply here — this is
// straight api.weather.gov). Best-effort: any failure just means no slice,
// and the caller keeps the row as "No data"/"Out of range".
async function fetchNWSGridData(lat, lon) {
  const points = await get(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`);
  const gridUrl = points?.properties?.forecastGridData;
  if (!gridUrl) throw new Error("NWS points response had no forecastGridData URL");
  return get(gridUrl);
}

// Parse an ISO-8601 duration of the form PnDTnHnM (only D/H/M are used by
// NWS gridpoint data) into a fractional number of hours.
function parseISODurationHours(iso) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(String(iso ?? ""));
  if (!m) return 0;
  const days    = Number(m[1] || 0);
  const hours   = Number(m[2] || 0);
  const minutes = Number(m[3] || 0);
  return days * 24 + hours + minutes / 60;
}

// NWS gridpoint values are UTC and don't carry the station's local offset.
// Approximate local time from longitude (15° per hour, ignoring DST) — this
// is a fallback path only, so an hour or so of skew near the DZ's prime
// window is an acceptable trade-off against pulling in a timezone library.
function nwsLocalHourAndDay(utcDate, lon) {
  const utcOffsetHours = Math.round(lon / 15);
  const local = new Date(utcDate.getTime() + utcOffsetHours * 3_600_000);
  return { day: local.toISOString().slice(0, 10), hour: local.getUTCHours() };
}

// Expand one gridpoint property's `values` array (each { validTime, value })
// into the raw values that fall within the 10:00–15:00 local window of `day`.
function expandGridValuesForPrimeWindow(values, lon, day) {
  const out = [];
  for (const v of values ?? []) {
    if (!v || v.value == null) continue;
    const [startIso, durIso] = String(v.validTime).split("/");
    const start = new Date(startIso);
    if (Number.isNaN(start.getTime())) continue;
    const durHours = Math.max(1, Math.round(parseISODurationHours(durIso)));
    for (let h = 0; h < durHours; h++) {
      const t = new Date(start.getTime() + h * 3_600_000);
      const { day: localDay, hour: localHour } = nwsLocalHourAndDay(t, lon);
      if (localDay === day && localHour >= 10 && localHour <= 15) out.push(v.value);
    }
  }
  return out;
}

function avgArr(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
}
function maxArr(arr) {
  return arr.length ? Math.max(...arr) : null;
}

const KMH_TO_KT = 0.539957;
const M_TO_FT   = 3.28084;

// Map NWS gridpoint properties onto the same slice shape extractDaySlice
// produces, so scoreSlice doesn't need to know which source it came from.
function extractNWSDaySlice(gridData, day, lon) {
  const props = gridData?.properties ?? {};
  const skyCoverVals = expandGridValuesForPrimeWindow(props.skyCover?.values, lon, day);
  // NWS reports a sentinel of -30.48 m (-100 ft) for "unlimited ceiling" /
  // unknown — not a real measurement. Drop non-positive values so an
  // unlimited-ceiling report falls back to the skyCover heuristic below
  // instead of producing a negative ceiling.
  const ceilingVals  = expandGridValuesForPrimeWindow(props.ceilingHeight?.values, lon, day)
    .filter((v) => v > 0);
  const visVals      = expandGridValuesForPrimeWindow(props.visibility?.values, lon, day);
  const windVals     = expandGridValuesForPrimeWindow(props.windSpeed?.values, lon, day);
  const gustVals     = expandGridValuesForPrimeWindow(props.windGust?.values, lon, day);
  const popVals      = expandGridValuesForPrimeWindow(props.probabilityOfPrecipitation?.values, lon, day);
  const qpfVals      = expandGridValuesForPrimeWindow(props.quantitativePrecipitation?.values, lon, day);

  // No usable data for this day at all → treat like "out of range".
  if (!skyCoverVals.length && !visVals.length && !windVals.length) return null;

  const windAvg = avgArr(windVals);
  const gustMax = maxArr(gustVals);
  const ceilAvg = avgArr(ceilingVals);

  return {
    cloudCoverLow:   avgArr(skyCoverVals),  // treat overall sky cover as the "low" layer
    cloudCoverMid:   null,
    cloudCoverHigh:  null,
    precipProb:      maxArr(popVals),
    precipitation:   maxArr(qpfVals),
    windKt:          windAvg != null ? windAvg * KMH_TO_KT : null,
    gustKt:          gustMax != null ? gustMax * KMH_TO_KT : null,
    visM:            avgArr(visVals),
    // Extra (not part of the Open-Meteo slice shape): when NWS reports an
    // explicit ceiling height, prefer it over the cloud-cover-percentage
    // heuristic in estimateCeilingFt — see that function.
    ceilingHeightFt: ceilAvg != null ? ceilAvg * M_TO_FT : null
  };
}

// Fetches + reduces an NWS gridpoint forecast into a day slice. Returns null
// (never throws) so the caller can fall through to a "No data" row.
async function fetchNWSSlice(lat, lon, day) {
  const gridData = await fetchNWSGridData(lat, lon);
  return extractNWSDaySlice(gridData, day, lon);
}

// ─── aviationweather.gov METAR fetch ─────────────────────────────────────────
// Fetches all METARs within a bounding-box (padded to cover all DZs + margin).
// Returns array of raw station objects.
async function fetchMETARs(minLat, minLon, maxLat, maxLon) {
  const url =
    `https://aviationweather.gov/api/data/metar` +
    `?bbox=${minLat},${minLon},${maxLat},${maxLon}&format=json&hours=2`;
  try {
    const data = await get(url);
    return Array.isArray(data) ? data : [];
  } catch {
    return []; // METAR is best-effort; fall back to Open-Meteo estimate
  }
}

// Find the closest METAR station to a DZ — no radius cap. Used for the
// "link to nearest station" behaviour (Task 3); trusting it for the ceiling
// value is a separate, radius-capped decision made by the caller.
function nearestMETAR(metars, lat, lon) {
  let station = null;
  let distKm  = Infinity;
  for (const m of metars) {
    if (m.lat == null || m.lon == null) continue;
    const d = haversineKm(lat, lon, Number(m.lat), Number(m.lon));
    if (d < distKm) {
      distKm  = d;
      station = m;
    }
  }
  return station ? { station, distKm } : null;
}

// Extract ceiling in feet from a METAR object (aviationweather.gov JSON format).
// The API reports sky condition as a `clouds` array, e.g.
// [{ cover: "SCT", base: 3500 }, { cover: "BKN", base: 5000 }].
// A "ceiling" is the lowest layer whose cover is BKN, OVC, or VV (vertical
// visibility) — SCT/FEW layers do not count as a ceiling.
const CEILING_COVER_CODES = new Set(["BKN", "OVC", "VV"]);

function metarCeilingFt(m) {
  if (m == null || !Array.isArray(m.clouds)) return null;
  let lowest = null;
  for (const layer of m.clouds) {
    if (!layer || !CEILING_COVER_CODES.has(layer.cover)) continue;
    const base = Number(layer.base);
    if (!Number.isFinite(base)) continue;
    if (lowest == null || base < lowest) lowest = base;
  }
  return lowest;
}

// ─── Ceiling estimation from cloud cover ─────────────────────────────────────
// Used when no METAR is available. Translates layered cloud cover percentages
// into a rough effective ceiling estimate. When the slice carries an explicit
// ceilingHeightFt (NWS gridpoint fallback — see extractNWSDaySlice), prefer
// that directly-reported value over the percentage-bucket heuristic; this
// does not change the curve math, only which raw ceiling feeds it.
//
// Key: skydiving cares about BKN/OVC layers *below the jump altitude* (~14,000 ft AGL).
// High thin cirrus (cloud_cover_high) has almost no effect on operations.
function estimateCeilingFt(slice) {
  if (slice.ceilingHeightFt != null) return slice.ceilingHeightFt;

  const low  = slice.cloudCoverLow  ?? 0;   // 0-2 km (~0-6500 ft)
  const mid  = slice.cloudCoverMid  ?? 0;   // 2-6 km (~6500-20000 ft)

  if (low >= 75) return 1500;    // BKN/OVC at ~1500 ft — well below gate
  if (low >= 50) return 3500;    // Scattered/broken low — marginal
  if (low >= 25) return 6000;    // Few/scattered low cloud — decent
  if (mid >= 75) return 9000;    // Overcast mid-level — limits high-altitude jumps
  if (mid >= 50) return 12000;   // Scattered mid — not ideal but workable
  return 16000;                  // Clear or high cirrus only — no ceiling issue
}

// ─── Preference-based score curves ───────────────────────────────────────────
// Every factor contributes up to 25 points. A condition at or better than the
// user's preference earns all 25; it declines linearly toward the hard safety
// boundary (or 100% precipitation probability). This makes a row explainable
// without needing to understand weighting or nonlinear curve math.
function ceilingPreferenceScore(ft, minimumCeilingFt) {
  if (ft >= minimumCeilingFt) return 1;
  return clamp((ft - CEILING_GATE_FT) / (minimumCeilingFt - CEILING_GATE_FT), 0, 1);
}

function windPreferenceScore(kt, maximumWindKt) {
  if (kt <= maximumWindKt) return 1;
  return clamp((GUST_GATE_KT - kt) / (GUST_GATE_KT - maximumWindKt), 0, 1);
}

function precipPreferenceScore(pct, maximumPrecipChance) {
  if (pct <= maximumPrecipChance) return 1;
  return clamp((100 - pct) / (100 - maximumPrecipChance), 0, 1);
}

function visibilityPreferenceScore(sm, minimumVisibilitySm) {
  if (sm >= minimumVisibilitySm) return 1;
  return clamp((sm - VIS_GATE_SM) / (minimumVisibilitySm - VIS_GATE_SM), 0, 1);
}

// ─── Score a single DZ for one time slice ────────────────────────────────────
// `metar` here is the *trusted* station (within METAR_RADIUS_KM) or null —
// the nearest-for-linking station is tracked separately by the caller.
function scoreSlice(slice, metar, preferences) {
  const p = normalizePreferences(preferences);
  // 1. Determine ceiling
  let ceilFt     = metarCeilingFt(metar);
  let ceilSource = ceilFt != null ? "metar" : "estimated";
  if (ceilFt == null) ceilFt = estimateCeilingFt(slice);

  // 2. Raw weather values
  const windKt    = slice.windKt       ?? 5;
  const gustKt    = slice.gustKt       ?? windKt;
  const precipMm  = slice.precipitation ?? 0;
  const precipP   = slice.precipProb   ?? 0;
  const visSm     = slice.visM != null ? slice.visM / 1609.34 : 10;

  // Effective wind: gusts dominate when they exceed sustained by >3 kt
  const effectiveWind = gustKt > windKt + 3 ? gustKt * 0.85 : windKt;

  // 3. Hard gate check (any gate → No-Go)
  const gateHits = [];
  if (ceilFt        <= CEILING_GATE_FT) gateHits.push("ceiling");
  if (effectiveWind >= GUST_GATE_KT)    gateHits.push("wind");
  if (precipMm       > PRECIP_MM_GATE)  gateHits.push("precip");
  if (visSm         <  VIS_GATE_SM)     gateHits.push("visibility");

  if (gateHits.length > 0) {
    return {
      score: 0, label: "No-Go", limitingFactor: gateHits[0], gateHits,
      subScores: null, scoreBreakdown: null, ceilFt, ceilSource,
      windKt, gustKt, precipProb: precipP, visSm,
      metarStation: metar?.icaoId ?? null
    };
  }

  // 4. Four equal, preference-based score contributions.
  const subs = {
    ceiling:    ceilingPreferenceScore(ceilFt, p.minimumCeilingFt),
    wind:       windPreferenceScore(effectiveWind, p.maximumWindKt),
    precip:     precipPreferenceScore(precipP, p.maximumPrecipChance),
    visibility: visibilityPreferenceScore(visSm, p.minimumVisibilitySm)
  };

  const scoreBreakdown = {
    ceiling:    { points: Math.round(subs.ceiling    * 25), maxPoints: 25, actual: ceilFt,        target: p.minimumCeilingFt },
    wind:       { points: Math.round(subs.wind       * 25), maxPoints: 25, actual: effectiveWind, target: p.maximumWindKt },
    precip:     { points: Math.round(subs.precip     * 25), maxPoints: 25, actual: precipP,       target: p.maximumPrecipChance },
    visibility: { points: Math.round(subs.visibility * 25), maxPoints: 25, actual: visSm,         target: p.minimumVisibilitySm }
  };
  const score = Object.values(scoreBreakdown).reduce((sum, factor) => sum + factor.points, 0);

  // Limiting factor = whichever sub-score is lowest
  const limitingFactor = Object.entries(subs).sort((a, b) => a[1] - b[1])[0][0];

  const label =
    score >= LABEL_EXCELLENT ? "Excellent" :
    score >= LABEL_GOOD      ? "Good"      :
    score >= LABEL_MARGINAL  ? "Marginal"  : "Poor";

  return {
    score, label, limitingFactor, gateHits: [],
    subScores: subs, scoreBreakdown, ceilFt, ceilSource,
    windKt, gustKt, precipProb: precipP, visSm,
    metarStation: metar?.icaoId ?? null
  };
}

// ─── Location resolution (catalog vs. override) ──────────────────────────────
// Precedence: dzOverrides[dzId] > catalog lat/lon. Returns null when neither
// is available.
function resolveDzLocation(dz, overrides) {
  const dzId = Number(dz.dzId);
  const override = overrides[dzId] ?? overrides[String(dzId)];
  if (override && override.lat != null && override.lon != null) {
    return {
      lat: Number(override.lat),
      lon: Number(override.lon),
      locationSource: "override",
      geoConfidence:  "override",
      label: override.label ?? null
    };
  }
  if (dz.lat != null && dz.lon != null) {
    return {
      lat: dz.lat,
      lon: dz.lon,
      locationSource: "catalog",
      geoConfidence:  dz.geoConfidence ?? null,
      label: null
    };
  }
  return null;
}

// Note: deliberately does NOT include `label` — callers set that themselves
// after spreading this in, so it isn't clobbered by a stray `label: null`.
function emptyScoreFields() {
  return {
    score: null, limitingFactor: null, gateHits: [], subScores: null, scoreBreakdown: null,
    ceilFt: null, ceilSource: null, windKt: null, gustKt: null,
    precipProb: null, visSm: null,
    metarStation: null, metarStationName: null, metarStationDistMi: null,
    forecastSource: null
  };
}

// ─── Main public function ─────────────────────────────────────────────────────
// catalog: array of { name, dzId, lat, lon, state?, geoConfidence? }.
// day: "YYYY-MM-DD" in the user's local time.
// boardDzIds: dzIds currently on the load-board grid — every one of these
//   appears in the result, even with no location (as a needsLocation row).
// dzOverrides: { [dzId]: { lat, lon, label } } — user-set locations that take
//   precedence over the catalog's own lat/lon.
// Returns: Promise<DzResult[]> sorted: scorable rows by score desc, then
//   needsLocation rows, then no-data rows. Also carries an
//   `excludedLowConfidence` count (non-board low-confidence catalog geocodes
//   skipped) for the UI to surface.
async function getRanking({ day, catalog, homeLat, homeLon, maxDistanceMi, preferences, boardDzIds, dzOverrides }, log) {
  const effectivePreferences = normalizePreferences(preferences);
  const boardIds = new Set((boardDzIds ?? []).map((id) => Number(id)));
  const overrides = dzOverrides ?? {};

  // Build cache key (must vary with boardDzIds/dzOverrides — they change
  // which rows are included and how they're located).
  const cacheKey = [
    day, homeLat, homeLon, maxDistanceMi, JSON.stringify(effectivePreferences),
    [...boardIds].sort((a, b) => a - b).join(","),
    JSON.stringify(overrides)
  ].join("|");
  const hit = _cache.get(cacheKey);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) {
    log(`Weather: cache hit for ${day}`);
    return hit.data;
  }

  // Union of the catalog and any board dzIds that aren't in the catalog at
  // all (stubbed with just an id/name so they still surface as needsLocation).
  const catalogById = new Map(catalog.map((dz) => [Number(dz.dzId), dz]));
  const allIds = new Set(catalogById.keys());
  for (const id of boardIds) allIds.add(id);

  const candidates = [];
  const needsLocationRows = [];
  let excludedLowConfidence = 0;

  for (const id of allIds) {
    const dz = catalogById.get(id) ?? { dzId: id, name: `DZ ${id}`, lat: null, lon: null, state: null, geoConfidence: null };
    const isBoard = boardIds.has(id);
    const loc = resolveDzLocation(dz, overrides);

    if (!loc) {
      if (isBoard) {
        needsLocationRows.push({
          dzId: id, name: dz.name, state: dz.state ?? null,
          lat: null, lon: null, distanceMi: null,
          isBoard: true, locationSource: null, geoConfidence: dz.geoConfidence ?? null,
          needsLocation: true, locationLabel: null,
          label: "Location needed",
          ...emptyScoreFields()
        });
      }
      // Non-board catalog entries with no coordinates were never rankable —
      // unchanged from prior behaviour; not counted as "excluded" either
      // (that count is specifically for low-confidence *geocoded* entries).
      continue;
    }

    const distanceMi = Math.round(haversineMi(homeLat, homeLon, loc.lat, loc.lon));
    const lowConfidence = loc.geoConfidence === "low";

    if (lowConfidence && !isBoard) {
      // Known-bad geocode on a non-board DZ — exclude, same as before.
      excludedLowConfidence += 1;
      continue;
    }

    if (isBoard || distanceMi <= maxDistanceMi) {
      candidates.push({
        dzId: id, name: dz.name, state: dz.state ?? null,
        lat: loc.lat, lon: loc.lon, distanceMi,
        isBoard, locationSource: loc.locationSource, geoConfidence: loc.geoConfidence,
        locationLabel: loc.label
      });
    }
    // else: non-board, in-range-checked catalog DZ beyond maxDistanceMi — silently
    // dropped, same as prior behaviour.
  }

  candidates.sort((a, b) => a.distanceMi - b.distanceMi);

  if (candidates.length === 0 && needsLocationRows.length === 0) {
    log("Weather: no candidates within range (check lat/lon in dropzones.json)");
    const empty = [];
    empty.excludedLowConfidence = excludedLowConfidence;
    return empty;
  }

  const results = [];

  if (candidates.length > 0) {
    log(`Weather: fetching forecasts for ${candidates.length} DZs (home ${homeLat}, ${homeLon}; ${boardIds.size} board DZs)`);

    // METAR bboxes, one per cluster of DZs.
    //
    // A single bbox spanning every candidate does not work: the API caps a bbox
    // response at 400 stations and truncates silently. A board DZ two states away
    // stretches the box until dense areas fall off the end — verified: a
    // Wisconsin→Colorado box drops KMSN, 10 mi from Madison, so nearby DZs would
    // link to the wrong airport and lose their trusted ceiling. Bucketing to a 2°
    // grid keeps each box small and dense however far apart the DZs are, and costs
    // one request per occupied cell rather than one per DZ.
    const CELL_DEG = 2;
    const cells = new Map();
    for (const dz of candidates) {
      const key = `${Math.floor(dz.lat / CELL_DEG)},${Math.floor(dz.lon / CELL_DEG)}`;
      if (!cells.has(key)) {
        cells.set(key, {
          minLat: Math.floor(dz.lat / CELL_DEG) * CELL_DEG - 1,
          maxLat: Math.floor(dz.lat / CELL_DEG) * CELL_DEG + CELL_DEG + 1,
          minLon: Math.floor(dz.lon / CELL_DEG) * CELL_DEG - 1,
          maxLon: Math.floor(dz.lon / CELL_DEG) * CELL_DEG + CELL_DEG + 1
        });
      }
    }

    // Fetch Open-Meteo forecasts concurrently (in batches) + one METAR call per cell.
    const BATCH = 10; // respect Open-Meteo rate limits
    const forecasts = new Map();
    for (let i = 0; i < candidates.length; i += BATCH) {
      const batch = candidates.slice(i, i + BATCH);
      await Promise.all(
        batch.map(async (dz) => {
          try {
            forecasts.set(dz.dzId, await fetchForecast(dz.lat, dz.lon));
          } catch (err) {
            log(`Weather: Open-Meteo forecast failed for ${dz.name}: ${err.message}`);
            forecasts.set(dz.dzId, null);
          }
        })
      );
    }

    log(`Weather: fetching METARs for ${cells.size} region(s)`);
    const byStation = new Map();
    const cellResults = await Promise.all(
      [...cells.values()].map((c) => fetchMETARs(c.minLat, c.minLon, c.maxLat, c.maxLon))
    );
    for (const batch of cellResults) {
      for (const m of batch) {
        if (m?.icaoId && !byStation.has(m.icaoId)) byStation.set(m.icaoId, m);
      }
    }
    const metars = [...byStation.values()];
    log(`Weather: received ${metars.length} METAR reports across ${cells.size} region(s)`);

    // Score each DZ
    for (const dz of candidates) {
      const forecast = forecasts.get(dz.dzId);
      let slice = forecast ? extractDaySlice(forecast, day) : null;
      let forecastSource = "open-meteo";
      const openMeteoFetchFailed = !forecast;

      if (!slice) {
        // Open-Meteo failed outright, or the day fell outside its range —
        // try NWS gridpoint as a fallback rather than giving up (US-only;
        // silently stays null outside the US).
        try {
          const nwsSlice = await fetchNWSSlice(dz.lat, dz.lon, day);
          if (nwsSlice) {
            slice = nwsSlice;
            forecastSource = "nws";
          }
        } catch (err) {
          log(`Weather: NWS fallback failed for ${dz.name}: ${err.message}`);
        }
      }

      if (!slice) {
        results.push({
          dzId: dz.dzId, name: dz.name, state: dz.state,
          lat: dz.lat, lon: dz.lon, distanceMi: dz.distanceMi,
          isBoard: dz.isBoard, locationSource: dz.locationSource,
          geoConfidence: dz.geoConfidence, locationLabel: dz.locationLabel,
          needsLocation: false,
          label: openMeteoFetchFailed ? "No data" : "Out of range",
          ...emptyScoreFields(),
          limitingFactor: openMeteoFetchFailed ? "fetch-error" : "no-forecast"
        });
        continue;
      }

      // Nearest METAR station — for the link, no distance cap.
      let nearest = nearestMETAR(metars, dz.lat, dz.lon);
      if (!nearest) {
        // Far-flung board DZ with nothing in the region-wide bbox — try a
        // tight per-DZ bbox. Best-effort/quiet: fetchMETARs already
        // swallows its own errors and returns [].
        const extra = await fetchMETARs(dz.lat - 1.2, dz.lon - 1.2, dz.lat + 1.2, dz.lon + 1.2);
        nearest = nearestMETAR(extra, dz.lat, dz.lon);
      }
      const trustedMetar = nearest && nearest.distKm <= METAR_RADIUS_KM ? nearest.station : null;

      const scored = scoreSlice(slice, trustedMetar, effectivePreferences);

      results.push({
        dzId: dz.dzId, name: dz.name, state: dz.state,
        lat: dz.lat, lon: dz.lon, distanceMi: dz.distanceMi,
        isBoard: dz.isBoard, locationSource: dz.locationSource,
        geoConfidence: dz.geoConfidence, locationLabel: dz.locationLabel,
        needsLocation: false,
        ...scored,
        metarStation:       nearest?.station?.icaoId ?? null,
        metarStationName:   nearest?.station?.name ?? null,
        metarStationDistMi: nearest ? Math.round(nearest.distKm * 0.621371) : null,
        forecastSource
      });
    }
  }

  // Combine with needsLocation rows, then sort: scorable rows by score desc,
  // then needsLocation rows, then no-data rows.
  const combined = [...results, ...needsLocationRows];
  combined.sort((a, b) => {
    const aScored = a.score != null;
    const bScored = b.score != null;
    if (aScored && bScored) return b.score - a.score;
    if (aScored !== bScored) return aScored ? -1 : 1;
    const aNeeds = Boolean(a.needsLocation);
    const bNeeds = Boolean(b.needsLocation);
    if (aNeeds !== bNeeds) return aNeeds ? -1 : 1;
    if (a.distanceMi != null && b.distanceMi != null) return a.distanceMi - b.distanceMi;
    return 0;
  });

  combined.excludedLowConfidence = excludedLowConfidence;
  pruneCache();
  _cache.set(cacheKey, { ts: Date.now(), data: combined });
  return combined;
}

module.exports = {
  getRanking,
  DEFAULT_PREFERENCES,
  normalizePreferences,
  scoreSlice
};
