const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');
const db      = require('./db');

const app      = express();
const PORT     = process.env.PORT || 3000;
const SM_KEY   = process.env.SPORTMONKS_KEY || 'EbRqkfYJgeCOtHzoC1AXpk1OO4semN0DtJ1P84zrYVNRCT1x4dHVsP9FGJAV';
const ODDS_KEY = process.env.ODDS_API_KEY   || 'f40efeabae93fc096daa59c7e2ab6fc2';
const SM_BASE  = 'https://api.sportmonks.com/v3/football';
const ODDS_BASE= 'https://api.the-odds-api.com/v4';

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT');
  next();
});

// ── SPORTMONKS PROXY ───────────────────────────────────────────────────────
app.get('/api/*', async (req, res) => {
  try {
    const endpoint    = req.path.replace('/api', '');
    const queryString = new URLSearchParams(req.query).toString();
    const sep         = queryString ? '&' : '';
    const url         = `${SM_BASE}${endpoint}?api_token=${SM_KEY}${sep}${queryString}`;
    console.log(`[SM] ${endpoint}`);
    const resp = await fetch(url);
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    console.error('[SM ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── ODDS API — QUOTA-EFFICIENT ─────────────────────────────────────────────
//
// Strategy:
//   1. ONE call to /sports/soccer_*/odds per UNIQUE league (not per fixture)
//   2. Only fetch h2h + totals (2 credits per region)
//   3. Use uk region only (1 region = half the cost)
//   4. Cache aggressively — 30 min TTL per league (odds don't change that fast)
//   5. Use "upcoming" endpoint as catch-all for leagues not in our map
//   Total cost per page load: ~2-6 credits vs 20-50 with naive approach
//
// Confirmed available markets on standard plan:
//   h2h     — match winner (home/draw/away)       outcome keys: home team name / "Draw" / away team name
//   totals  — over/under goals                    outcome keys: "Over X.5" / "Under X.5"
//   spreads — asian handicap (where available)    outcome keys: home team name / away team name + point

const LEAGUE_MAP = {
  // Top 5 European leagues
  'premier league':           'soccer_epl',
  'la liga':                  'soccer_spain_la_liga',
  'bundesliga':               'soccer_germany_bundesliga',
  'serie a':                  'soccer_italy_serie_a',
  'ligue 1':                  'soccer_france_ligue_one',
  // European cups
  'uefa champions league':    'soccer_uefa_champs_league',
  'champions league':         'soccer_uefa_champs_league',
  'uefa europa league':       'soccer_uefa_europa_league',
  'europa league':            'soccer_uefa_europa_league',
  'uefa conference league':   'soccer_uefa_europa_conference_league',
  // Other European
  'championship':             'soccer_efl_champ',
  'efl championship':         'soccer_efl_champ',
  'eredivisie':               'soccer_netherlands_eredivisie',
  'primeira liga':            'soccer_portugal_primeira_liga',
  'scottish premiership':     'soccer_scotland_premiership',
  'premiership':              'soccer_scotland_premiership',
  'super lig':                'soccer_turkey_super_league',
  'pro league':               'soccer_belgium_first_div',
  'jupiler pro league':       'soccer_belgium_first_div',
  'ekstraklasa':              'soccer_poland_ekstraklasa',
  'russian premier league':   'soccer_russia_premier_league',
  'ukrainian premier league': 'soccer_ukraine_premier_league',
  'süper lig':                'soccer_turkey_super_league',
  // Other
  'mls':                      'soccer_usa_mls',
  'brasileirao':              'soccer_brazil_campeonato',
  'serie a (brazil)':         'soccer_brazil_campeonato',
};

// Cache: sportKey → { ts, data }  (30 min TTL)
const oddsCache   = {};
const CACHE_TTL   = 30 * 60 * 1000;
// Track quota usage across the session
let quotaUsed     = 0;
let quotaRemaining= '?';

async function fetchOddsForLeague(sportKey) {
  const now = Date.now();

  // Return cached if fresh
  if (oddsCache[sportKey] && (now - oddsCache[sportKey].ts) < CACHE_TTL) {
    console.log(`[ODDS] Cache hit: ${sportKey}`);
    return oddsCache[sportKey].data;
  }

  try {
    // Only h2h + totals — costs 2 credits (2 markets × 1 region)
    const markets = 'h2h,totals';
    const url = `${ODDS_BASE}/sports/${sportKey}/odds?apiKey=${ODDS_KEY}&regions=uk&markets=${markets}&oddsFormat=decimal&dateFormat=iso`;

    console.log(`[ODDS] Fetching: ${sportKey} (cost: 2 credits)`);
    const resp = await fetch(url);

    // Track quota
    quotaUsed      = resp.headers.get('x-requests-used')      || quotaUsed;
    quotaRemaining = resp.headers.get('x-requests-remaining') || quotaRemaining;
    console.log(`[ODDS] Quota — used: ${quotaUsed}, remaining: ${quotaRemaining}`);

    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`[ODDS] Error ${resp.status} for ${sportKey}:`, errText);
      oddsCache[sportKey] = { ts: now, data: [] }; // cache empty to avoid hammering
      return [];
    }

    const data = await resp.json();
    console.log(`[ODDS] Got ${data.length} matches for ${sportKey}`);
    oddsCache[sportKey] = { ts: now, data };
    return data;

  } catch (e) {
    console.error('[ODDS ERROR]', e.message);
    return [];
  }
}

// ── /odds/today ────────────────────────────────────────────────────────────
// Frontend calls this once with all league names it has fixtures for.
// Returns a flat array of all matched odds events.
// Deduplicates so each sport key is only fetched once.
app.get('/odds/today', async (req, res) => {
  try {
    const leagues = req.query.leagues
      ? req.query.leagues.split(',').map(l => l.trim().toLowerCase())
      : [];

    if (!leagues.length) return res.json({ matches: [], quota: { used: quotaUsed, remaining: quotaRemaining } });

    // Map league names → unique sport keys
    const sportKeys = [...new Set(
      leagues.map(l => LEAGUE_MAP[l]).filter(Boolean)
    )];

    console.log(`[ODDS] Leagues requested: ${leagues.length} → Sport keys: ${sportKeys.join(', ') || 'none matched'}`);

    if (!sportKeys.length) {
      return res.json({
        matches: [],
        note: `No league mappings found for: ${leagues.join(', ')}`,
        quota: { used: quotaUsed, remaining: quotaRemaining }
      });
    }

    // Fetch all in parallel (each cached independently)
    const results = await Promise.all(sportKeys.map(fetchOddsForLeague));
    const matches  = results.flat();

    res.json({
      matches,
      count:   matches.length,
      leagues: sportKeys,
      quota:   { used: quotaUsed, remaining: quotaRemaining }
    });

  } catch (err) {
    console.error('[ODDS ROUTE ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── /odds/quota ────────────────────────────────────────────────────────────
// Check remaining quota without burning credits
app.get('/odds/quota', async (req, res) => {
  try {
    // /sports endpoint is free — use it to get current quota headers
    const resp = await fetch(`${ODDS_BASE}/sports?apiKey=${ODDS_KEY}`);
    const remaining = resp.headers.get('x-requests-remaining');
    const used      = resp.headers.get('x-requests-used');
    quotaUsed      = used      || quotaUsed;
    quotaRemaining = remaining || quotaRemaining;
    res.json({ used, remaining, cached: Object.keys(oddsCache).length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /odds/sports ───────────────────────────────────────────────────────────
// List all available soccer sports (free endpoint)
app.get('/odds/sports', async (req, res) => {
  try {
    const resp  = await fetch(`${ODDS_BASE}/sports?apiKey=${ODDS_KEY}`);
    const data  = await resp.json();
    const soccer = data.filter(s => s.key?.includes('soccer'));
    res.json(soccer);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── TEAM MEMORY ────────────────────────────────────────────────────────────
app.post('/memory/team', (req, res) => {
  try {
    const { teamId, stats } = req.body;
    if (!teamId || !stats) return res.status(400).json({ error: 'teamId and stats required' });
    db.saveTeam(teamId, stats);
    res.json({ ok: true, teamId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/memory/team/:teamId', (req, res) => {
  const team = db.getTeam(req.params.teamId);
  if (!team) return res.json({ found: false });
  res.json({ found: true, team });
});

app.get('/memory/teams', (req, res) => res.json(db.getAllTeams()));

// ── PREDICTION TRACKING ────────────────────────────────────────────────────
app.post('/predictions/save', (req, res) => {
  try {
    const pred = req.body;
    if (!pred.fixtureId) return res.status(400).json({ error: 'fixtureId required' });
    const saved = db.savePrediction(pred);
    res.json({ ok: true, saved });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/predictions/resolve', (req, res) => {
  try {
    const { fixtureId, homeGoals, awayGoals } = req.body;
    if (fixtureId == null || homeGoals == null || awayGoals == null)
      return res.status(400).json({ error: 'fixtureId, homeGoals, awayGoals required' });
    const resolved = db.resolvePrediction(fixtureId, homeGoals, awayGoals);
    if (!resolved) return res.status(404).json({ error: 'Prediction not found' });
    res.json({ ok: true, resolved });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/predictions/auto-resolve', async (req, res) => {
  try {
    const preds   = db.getPredictions(200);
    const pending = preds.filter(p => !p.result && p.fixtureId);
    let resolved  = 0;
    for (const pred of pending) {
      try {
        const url  = `${SM_BASE}/fixtures/${pred.fixtureId}?include=scores;state&api_token=${SM_KEY}`;
        const resp = await fetch(url);
        const data = await resp.json();
        const fix  = data.data;
        if (!fix) continue;
        const state = (fix.state?.short_name || '').toUpperCase();
        if (!['FT','AET','AP'].includes(state)) continue;
        const hG = fix.scores?.find(s=>s.description==='CURRENT'&&s.score?.participant==='home')?.score?.goals;
        const aG = fix.scores?.find(s=>s.description==='CURRENT'&&s.score?.participant==='away')?.score?.goals;
        if (hG == null || aG == null) continue;
        db.resolvePrediction(pred.fixtureId, hG, aG);
        resolved++;
        console.log(`[RESOLVE] ${pred.homeTeam} vs ${pred.awayTeam}: ${hG}-${aG}`);
      } catch(e) { console.error(`[RESOLVE FAIL] ${pred.fixtureId}`, e.message); }
    }
    res.json({ ok: true, checked: pending.length, resolved });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/predictions/recent', (req, res) => {
  res.json(db.getPredictions(parseInt(req.query.limit)||50));
});

app.get('/predictions/results', (req, res) => {
  res.json(db.getRecentResults(parseInt(req.query.limit)||20));
});

// ── CALIBRATION ────────────────────────────────────────────────────────────
app.get('/calibration', (req, res) => {
  const calib = db.getCalibration();
  res.json(calib || { message: 'No calibration data yet.' });
});

// ── HEALTH ─────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  const preds = db.getPredictions(999);
  const teams = Object.keys(db.getAllTeams()).length;
  const calib = db.getCalibration();
  res.json({
    status:        'ok',
    version:       'v4',
    teams,
    predictions:   preds.length,
    resolved:      preds.filter(p=>p.result).length,
    overallRate:   calib?.overall?.rate ?? null,
    oddsLeagues:   Object.keys(LEAGUE_MAP).length,
    oddsCache:     Object.keys(oddsCache).length,
    quotaUsed,
    quotaRemaining,
    uptime:        Math.round(process.uptime()),
  });
});

app.listen(PORT, () => {
  console.log(`PROPRED v4 running on port ${PORT}`);
  // Check quota on startup (free call)
  fetch(`http://localhost:${PORT}/odds/quota`)
    .then(r=>r.json())
    .then(d=>console.log(`[STARTUP] Odds quota — used: ${d.used}, remaining: ${d.remaining}`))
    .catch(()=>{});
  // Auto-resolve pending predictions
  setTimeout(() => {
    fetch(`http://localhost:${PORT}/predictions/auto-resolve`, { method:'POST' })
      .then(r=>r.json()).then(d=>console.log('[STARTUP AUTO-RESOLVE]', d))
      .catch(()=>{});
  }, 3000);
});
