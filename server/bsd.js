'use strict';

/**
 * BSD Predictions Module
 * Fetches predictions from the BSD Public API, enriches them with
 * API-Football team DNA (form + H2H), and generates a Groq "master tip".
 *
 * All keys come from environment variables — no hardcoded fallbacks.
 */

const fetch = require('node-fetch');

const BSD_KEY        = (process.env.BSD_API_KEY     || '').trim();
const API_FOOTBALL_KEY = (process.env.API_FOOTBALL_KEY || '').trim();
const GROQ_KEY       = (process.env.GROQ_KEY        || '').trim();

// ── In-memory cache (refreshed every 15 min) ──────────────────────────────
let matchCache   = [];
let lastFetched  = 0;
let isFetching   = false;
const CACHE_TTL  = 15 * 60 * 1000; // 15 minutes

// ── Tier 1: Static team-ID map (API-Football IDs) ─────────────────────────
const MASTER_TEAM_MAP = {
  'Real Madrid': 541, 'Manchester City': 50, 'Man City': 50, 'Arsenal': 42,
  'Leverkusen': 168, 'Bayer Leverkusen': 168, 'Santos': 128, 'Al-Ittihad': 1032,
  'Genk': 631, 'Freiburg': 160, 'Bayern': 157, 'Bayern Munich': 157,
  'Barcelona': 529, 'Atletico Madrid': 530, 'Liverpool': 40, 'Chelsea': 49,
  'Manchester United': 33, 'Tottenham': 47, 'Aston Villa': 66, 'Newcastle': 34,
  'Borussia Dortmund': 165, 'RB Leipzig': 173, 'Inter': 505, 'AC Milan': 489,
  'Juventus': 496, 'Napoli': 492, 'Roma': 497, 'Lazio': 487,
  'Paris Saint Germain': 85, 'PSG': 85, 'Marseille': 81, 'Monaco': 91,
  'Ajax': 194, 'PSV Eindhoven': 197, 'Feyenoord': 196,
  'Sporting CP': 228, 'Benfica': 226, 'Porto': 224,
};

// ── Tier 2: Form parser ───────────────────────────────────────────────────
function getDetailedForm(fixtures, teamId) {
  return (fixtures || []).map(f => {
    const isHome  = f.teams?.home?.id === teamId;
    const hG      = f.goals?.home;
    const aG      = f.goals?.away;
    const opponent = isHome ? f.teams?.away?.name : f.teams?.home?.name;
    let result = '?';
    if (hG !== null && aG !== null) {
      if (hG === aG) result = 'D';
      else if (isHome) result = hG > aG ? 'W' : 'L';
      else result = aG > hG ? 'W' : 'L';
    }
    return { result, score: `${hG}-${aG}`, opponent };
  });
}

// ── Resolve team ID (map → API fallback) ──────────────────────────────────
async function resolveTeamId(teamName) {
  for (const [key, id] of Object.entries(MASTER_TEAM_MAP)) {
    if (teamName.toLowerCase().includes(key.toLowerCase())) return id;
  }
  if (!API_FOOTBALL_KEY) return null;
  try {
    const res = await fetch(
      `https://v3.football.api-sports.io/teams?search=${encodeURIComponent(teamName)}`,
      { headers: { 'x-apisports-key': API_FOOTBALL_KEY }, timeout: 3000 }
    );
    const id = (await res.json())?.response?.[0]?.team?.id;
    if (id) { MASTER_TEAM_MAP[teamName] = id; return id; }
  } catch (e) {
    console.error('[BSD] resolveTeamId failed:', teamName, e.message);
  }
  return null;
}

// ── Fetch DNA (form + H2H) from API-Football ──────────────────────────────
async function fetchDNA(homeTeam, awayTeam) {
  if (!API_FOOTBALL_KEY) return null;
  try {
    const [homeId, awayId] = await Promise.all([
      resolveTeamId(homeTeam),
      resolveTeamId(awayTeam),
    ]);
    if (!homeId || !awayId) return null;

    const headers = { 'x-apisports-key': API_FOOTBALL_KEY };
    const [h2hRes, homeFix, awayFix] = await Promise.all([
      fetch(`https://v3.football.api-sports.io/fixtures/headtohead?h2h=${homeId}-${awayId}&last=5`, { headers, timeout: 3000 }).catch(() => null),
      fetch(`https://v3.football.api-sports.io/fixtures?team=${homeId}&last=5`,                     { headers, timeout: 3000 }).catch(() => null),
      fetch(`https://v3.football.api-sports.io/fixtures?team=${awayId}&last=5`,                     { headers, timeout: 3000 }).catch(() => null),
    ]);

    const h2hData    = (await h2hRes?.json())?.response || [];
    const homeFixtures = (await homeFix?.json())?.response || [];
    const awayFixtures = (await awayFix?.json())?.response || [];

    return {
      homeId, awayId,
      homeForm: getDetailedForm(homeFixtures, homeId),
      awayForm: getDetailedForm(awayFixtures, awayId),
      h2h: h2hData.map(f => ({
        date:      f.fixture?.date,
        home:      f.teams?.home?.name,
        away:      f.teams?.away?.name,
        homeGoals: f.goals?.home,
        awayGoals: f.goals?.away,
      })),
    };
  } catch (e) {
    console.error('[BSD] fetchDNA error:', e.message);
    return null;
  }
}

// ── Tier 3: Groq "master tip" ─────────────────────────────────────────────
async function fetchGroqVerdict(pred, dna) {
  if (!GROQ_KEY) return null;
  try {
    const bsdStr = `Home:${Number(pred.prob_home_win || 0).toFixed(0)}% Away:${Number(pred.prob_away_win || 0).toFixed(0)}% O2.5:${Number(pred.prob_over_25 || 0).toFixed(0)}% BTTS:${Number(pred.prob_btts_yes || 0).toFixed(0)}%`;
    const h2hStr     = JSON.stringify(dna?.h2h || 'No data');
    const homeFormStr = (dna?.homeForm || []).map(f => f.result).join('') || '?';
    const awayFormStr = (dna?.awayForm || []).map(f => f.result).join('') || '?';
    const prompt = `Math: ${bsdStr}, H2H: ${h2hStr}, Form: Home(${homeFormStr}) Away(${awayFormStr}). Give me a 1-sentence brutal value tip.`;

    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: 'You are a High-Stakes Football Betting Consultant. Blunt, rational, obsessed with Market Value. Format exactly as JSON: {"masterTip": "Your 1-sentence tip here."}.' },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 120,
        temperature: 0.2,
      }),
    });
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '{}';
    return JSON.parse(text);
  } catch (e) {
    console.error('[BSD] Groq verdict failed:', e.message);
    return { masterTip: 'Analysis unavailable.' };
  }
}

// ── Core enrichment pipeline ──────────────────────────────────────────────
async function enrichPrediction(pred) {
  const home = pred.event?.home_team;
  const away = pred.event?.away_team;

  // Value score (used for sorting before stripping)
  const apiConf    = Number(pred.confidence) || 0;
  const apiHomeWin = Number(pred.prob_home_win) || 0;
  const apiAwayWin = Number(pred.prob_away_win) || 0;
  const conflict   = (apiHomeWin > 75 && apiConf < 5) || (apiAwayWin > 75 && apiConf < 5);
  const valueScore = Math.min(100, Math.round(apiConf * 10)) + (conflict ? 15 : 0);

  let dna     = null;
  let verdict = null;

  if (home && away) {
    dna     = await fetchDNA(home, away);
    verdict = await fetchGroqVerdict(pred, dna);
  }

  return {
    ...pred,
    dna,
    verdict,
    _valueScore: valueScore,
    _conflictFlag: conflict ? 'Low Confidence Favorite' : null,
  };
}

// ── Main cache update ─────────────────────────────────────────────────────
async function updateCache() {
  if (isFetching) return;
  if (!BSD_KEY) {
    console.log('[BSD] BSD_API_KEY not set — skipping BSD cache update');
    return;
  }

  isFetching = true;
  console.log('[BSD] Updating prediction cache…');

  try {
    const res = await fetch('https://sports.bzzoiro.com/api/predictions/', {
      headers: { 'Authorization': `Token ${BSD_KEY}`, 'Content-Type': 'application/json' },
    });
    let preds = (await res.json())?.results || [];
    if (!Array.isArray(preds)) preds = [];

    // Score & sort, take top 20
    preds = preds
      .map(p => {
        const conf = Number(p.confidence) || 0;
        const hw   = Number(p.prob_home_win) || 0;
        const aw   = Number(p.prob_away_win) || 0;
        const conflict = (hw > 75 && conf < 5) || (aw > 75 && conf < 5);
        return { ...p, _preScore: Math.min(100, Math.round(conf * 10)) + (conflict ? 15 : 0) };
      })
      .sort((a, b) => b._preScore - a._preScore)
      .slice(0, 20);

    const enriched = await Promise.all(preds.map(enrichPrediction));
    matchCache  = enriched.sort((a, b) => b._valueScore - a._valueScore);
    lastFetched = Date.now();
    console.log(`[BSD] Cache updated — ${matchCache.length} predictions`);
  } catch (e) {
    console.error('[BSD] Cache update failed:', e.message);
  } finally {
    isFetching = false;
  }
}

// ── Public API ────────────────────────────────────────────────────────────

/** Returns cached predictions (refreshes if stale or empty). */
async function getPredictions() {
  const stale = Date.now() - lastFetched > CACHE_TTL;
  if (stale || matchCache.length === 0) await updateCache();
  return matchCache;
}

/** Force a background refresh (fire-and-forget). */
function scheduleRefresh() {
  updateCache();
  setInterval(updateCache, CACHE_TTL);
}

module.exports = { getPredictions, scheduleRefresh, updateCache };
