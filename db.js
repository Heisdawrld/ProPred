const fs   = require('fs');
const path = require('path');

const DATA_DIR  = path.join(__dirname, 'data');
const TEAMS_F   = path.join(DATA_DIR, 'teams.json');
const PREDS_F   = path.join(DATA_DIR, 'predictions.json');
const CALIB_F   = path.join(DATA_DIR, 'calibration.json');

// Ensure data dir exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ── TEAM MEMORY ────────────────────────────────────────────────────────────
// Stores computed stats per team, updated every time we process a fixture
function getTeam(teamId) {
  const teams = readJSON(TEAMS_F, {});
  return teams[teamId] || null;
}

function saveTeam(teamId, stats) {
  const teams = readJSON(TEAMS_F, {});
  teams[teamId] = {
    ...stats,
    teamId,
    lastUpdated: new Date().toISOString(),
    // track how many times we've seen this team
    observationCount: (teams[teamId]?.observationCount || 0) + 1,
  };
  writeJSON(TEAMS_F, teams);
}

function getAllTeams() {
  return readJSON(TEAMS_F, {});
}

// ── PREDICTION STORAGE ─────────────────────────────────────────────────────
// Each prediction: { id, fixtureId, date, homeTeam, awayTeam, tip, tipType,
//                    safeTip, conf, hLambda, aLambda, savedAt, result, resolvedAt }
function savePrediction(pred) {
  const preds = readJSON(PREDS_F, []);
  // Avoid duplicates for same fixture
  const idx = preds.findIndex(p => p.fixtureId === pred.fixtureId);
  if (idx >= 0) preds[idx] = { ...preds[idx], ...pred, updatedAt: new Date().toISOString() };
  else preds.push({ ...pred, savedAt: new Date().toISOString(), result: null });
  writeJSON(PREDS_F, preds);
  return preds.find(p => p.fixtureId === pred.fixtureId);
}

// Mark a prediction as won/lost/push after the match
function resolvePrediction(fixtureId, homeGoals, awayGoals) {
  const preds = readJSON(PREDS_F, []);
  const pred  = preds.find(p => p.fixtureId === fixtureId);
  if (!pred) return null;

  const result = evaluateTip(pred.tip, pred.tipType, homeGoals, awayGoals, pred.homeTeam, pred.awayTeam);
  pred.result     = result;   // 'win' | 'loss' | 'push'
  pred.homeGoals  = homeGoals;
  pred.awayGoals  = awayGoals;
  pred.resolvedAt = new Date().toISOString();

  writeJSON(PREDS_F, preds);
  rebuildCalibration(preds);
  return pred;
}

// Determine if a tip won/lost given the actual scoreline
function evaluateTip(tip, tipType, hG, aG, homeTeam, awayTeam) {
  const tipLower = tip.toLowerCase();
  const total    = hG + aG;
  const homeWon  = hG > aG;
  const awayWon  = aG > hG;
  const draw     = hG === aG;
  const btts     = hG > 0 && aG > 0;

  if (tipLower.includes('over 3.5')) return total > 3.5 ? 'win' : 'loss';
  if (tipLower.includes('over 2.5')) return total > 2.5 ? 'win' : 'loss';
  if (tipLower.includes('over 1.5')) return total > 1.5 ? 'win' : 'loss';
  if (tipLower.includes('under 2.5')) return total < 2.5 ? 'win' : 'loss';
  if (tipLower.includes('under 3.5')) return total < 3.5 ? 'win' : 'loss';
  if (tipLower.includes('both teams to score') && !tipLower.includes('no')) return btts ? 'win' : 'loss';
  if (tipLower.includes('no — btts') || tipLower.includes('no btts')) return !btts ? 'win' : 'loss';
  if (tipLower.includes('draw') && tipType === 'draw') return draw ? 'win' : 'loss';
  if (tipLower.includes('win & btts')) {
    const teamWon = tipLower.includes(homeTeam?.toLowerCase()||'home') ? homeWon : awayWon;
    return (teamWon && btts) ? 'win' : 'loss';
  }
  if (tipLower.includes('win & over 2.5')) {
    const teamWon = tipLower.includes(homeTeam?.toLowerCase()||'home') ? homeWon : awayWon;
    return (teamWon && total > 2.5) ? 'win' : 'loss';
  }
  if (tipLower.includes('win or draw')) {
    const isHome = tipLower.includes(homeTeam?.toLowerCase()||'xxxxx');
    return (isHome ? !awayWon : !homeWon) ? 'win' : 'loss';
  }
  if (tipLower.includes('draw no bet')) {
    const isHome = tipLower.includes(homeTeam?.toLowerCase()||'xxxxx') || tipLower.includes('home');
    if (draw) return 'push';
    return (isHome ? homeWon : awayWon) ? 'win' : 'loss';
  }
  if (tipLower.includes('asian handicap')) {
    const isHome = tipLower.includes(homeTeam?.split(' ').pop()?.toLowerCase()||'xxxxx');
    if (isHome) return hG > aG + 0.5 ? 'win' : 'loss'; // -0.5 AH
    else return aG > hG + 0.5 ? 'win' : 'loss';
  }
  if (tipLower.includes('to score')) {
    const isHome = tipLower.includes(homeTeam?.toLowerCase()||'xxxxx');
    return (isHome ? hG > 0 : aG > 0) ? 'win' : 'loss';
  }
  // Generic win
  if (tipLower.includes(homeTeam?.split(' ').pop()?.toLowerCase()||'xxxxx') || tipLower.includes('home win')) {
    return homeWon ? 'win' : 'loss';
  }
  if (tipLower.includes(awayTeam?.split(' ').pop()?.toLowerCase()||'xxxxx') || tipLower.includes('away win')) {
    return awayWon ? 'win' : 'loss';
  }
  return 'push'; // can't determine
}

// ── CALIBRATION ────────────────────────────────────────────────────────────
// Rebuilds calibration buckets from all resolved predictions
// Buckets: confidence ranges 40-50, 50-60, 60-70, 70-80, 80-90, 90+
// For each bucket, track predicted% vs actual win%
function rebuildCalibration(preds) {
  const resolved = preds.filter(p => p.result && p.result !== 'push');
  const buckets  = {};

  resolved.forEach(p => {
    const bucket = Math.floor(p.conf / 10) * 10; // 40, 50, 60...
    if (!buckets[bucket]) buckets[bucket] = { predicted: bucket + 5, wins: 0, total: 0, tipTypes: {} };
    buckets[bucket].total++;
    if (p.result === 'win') buckets[bucket].wins++;
    // Track by tip type
    if (!buckets[bucket].tipTypes[p.tipType]) buckets[bucket].tipTypes[p.tipType] = { wins: 0, total: 0 };
    buckets[bucket].tipTypes[p.tipType].total++;
    if (p.result === 'win') buckets[bucket].tipTypes[p.tipType].wins++;
  });

  // Calculate actual win rate per bucket
  Object.keys(buckets).forEach(b => {
    buckets[b].actualRate = buckets[b].total > 0
      ? Math.round(buckets[b].wins / buckets[b].total * 100)
      : null;
    // calibration error: how much we're over/under-confident
    buckets[b].error = buckets[b].actualRate !== null
      ? buckets[b].actualRate - buckets[b].predicted
      : 0;
  });

  // Overall stats
  const overallWins  = resolved.filter(p => p.result === 'win').length;
  const overallTotal = resolved.length;

  // Per tip type accuracy
  const byType = {};
  resolved.forEach(p => {
    if (!byType[p.tipType]) byType[p.tipType] = { wins: 0, total: 0 };
    byType[p.tipType].total++;
    if (p.result === 'win') byType[p.tipType].wins++;
  });

  const calib = {
    buckets,
    overall: {
      wins: overallWins,
      total: overallTotal,
      rate: overallTotal > 0 ? Math.round(overallWins / overallTotal * 100) : null,
    },
    byType: Object.fromEntries(
      Object.entries(byType).map(([t, v]) => [t, {
        wins: v.wins, total: v.total,
        rate: Math.round(v.wins / v.total * 100)
      }])
    ),
    lastBuilt: new Date().toISOString(),
  };

  writeJSON(CALIB_F, calib);
  return calib;
}

function getCalibration() {
  return readJSON(CALIB_F, null);
}

function getPredictions(limit = 50) {
  const preds = readJSON(PREDS_F, []);
  return preds
    .sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt))
    .slice(0, limit);
}

function getRecentResults(limit = 20) {
  const preds = readJSON(PREDS_F, []);
  return preds
    .filter(p => p.result)
    .sort((a, b) => new Date(b.resolvedAt) - new Date(a.resolvedAt))
    .slice(0, limit);
}

module.exports = {
  getTeam, saveTeam, getAllTeams,
  savePrediction, resolvePrediction,
  getCalibration, getPredictions, getRecentResults,
};
