// Deterministic PRNG utilities for the Brocade demo generator. Ported from
// backend/demo/generators/core.js — ONLY the seeded-random helpers are
// copied (per the plugin conversion skill's demo-generator porting rule);
// seedCore()'s services/encryption require and shared-scope seeding stay
// host-only and are NOT dragged in here (would fail the esbuild bundle).
function seedFromString(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return (h ^ (h >>> 16)) >>> 0;
}

// mulberry32: small, fast, deterministic PRNG. Same seed -> same sequence.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rngFor(name) {
  return mulberry32(seedFromString(name));
}

function randInt(rng, min, max) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function randFloat(rng, min, max, digits = 2) {
  const v = rng() * (max - min) + min;
  const p = 10 ** digits;
  return Math.round(v * p) / p;
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function chance(rng, probability) {
  return rng() < probability;
}

module.exports = { seedFromString, mulberry32, rngFor, randInt, randFloat, pick, chance };
