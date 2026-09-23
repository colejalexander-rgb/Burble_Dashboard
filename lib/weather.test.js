"use strict";

const assert = require("assert");
const { DEFAULT_PREFERENCES, normalizePreferences, scoreSlice } = require("./weather");

function slice(overrides = {}) {
  return {
    ceilingHeightFt: 8000,
    windKt: 12,
    gustKt: 12,
    precipitation: 0,
    precipProb: 20,
    visM: 16093.4,
    ...overrides
  };
}

// Each preference should be an understandable operational threshold: a
// condition meeting all four earns 4 × 25 = 100 points.
const ideal = scoreSlice(slice(), null, DEFAULT_PREFERENCES);
assert.equal(ideal.score, 100);
assert.deepEqual(
  Object.values(ideal.scoreBreakdown).map((part) => part.points),
  [25, 25, 25, 25]
);

// Ceiling halfway from the 2,500-ft safety limit to the user's 8,000-ft
// minimum earns half of its 25-point share (rounded normally).
const ceilingOnly = scoreSlice(slice({ ceilingHeightFt: 5250 }), null, DEFAULT_PREFERENCES);
assert.equal(ceilingOnly.scoreBreakdown.ceiling.points, 13);
assert.equal(ceilingOnly.score, 88);

// A personal threshold changes the relevant contribution, not the hidden
// importance of some other factor.
const lowerCeilingPreference = scoreSlice(slice({ ceilingHeightFt: 5250 }), null, {
  ...DEFAULT_PREFERENCES,
  minimumCeilingFt: 5000
});
assert.equal(lowerCeilingPreference.scoreBreakdown.ceiling.points, 25);
assert.equal(lowerCeilingPreference.score, 100);

// Safety gates remain non-negotiable even if the personal preference is more
// permissive. Active precipitation is a No-Go.
const precipitationGate = scoreSlice(slice({ precipitation: 0.2 }), null, DEFAULT_PREFERENCES);
assert.equal(precipitationGate.label, "No-Go");
assert.deepEqual(precipitationGate.gateHits, ["precip"]);

assert.deepEqual(normalizePreferences({ minimumCeilingFt: 99999, maximumWindKt: -1 }), {
  minimumCeilingFt: 14000,
  maximumWindKt: 8,
  maximumPrecipChance: DEFAULT_PREFERENCES.maximumPrecipChance,
  minimumVisibilitySm: DEFAULT_PREFERENCES.minimumVisibilitySm
});

console.log("weather scoring tests passed");
