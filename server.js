const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');
const db      = require('./db');

const app      = express();
const PORT     = process.env.PORT || 3000;
const SM_KEY   = process.env.SPORTMONKS_KEY  || 'EbRqkfYJgeCOtHzoC1AXpk1OO4semN0DtJ1P84zrYVNRCT1x4dHVsP9FGJAV';
const ODDS_KEY = process.env.ODDS_API_KEY    || 'f40efeabae93fc096daa59c7e2ab6fc2';
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
    const response = await fetch(url);
    const data     = await response.json();
    res.json(data);
  } catch (err) {
    console.error('[SM ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── ODDS API ───────────────────────────────────────────────────────────────
// Maps Sportmonks league names → Odds API sport keys
const LEAGUE_MAP = {
  'premier league':          'soccer_epl',
  'la liga':                 'soccer_spain_la_liga',
  'bundesliga':              'soccer_germany_bundesliga',
  'serie a':                 'soccer_italy_serie_a',
  'ligue 1':                 'soccer_france_ligue_one',
  'champions league':        'soccer_uefa_champs_league',
  'europa league':           'soccer_uefa_europa_league',
  'championship':            'soccer_efl_champ',
  'eredivisie':              'soccer_netherlands_eredivisie',
  'primeira liga':           'soccer_portugal_primeira_liga',
  'scottish premiership':    'soccer_scotland_premiership',
  'premiership':             'soccer_scotland_premiership',
  'super lig':               'soccer_turkey_super_league',
  'pro league':              'soccer_belgium_first_div',
  'mls':                     'soccer_usa_mls',
  'brasileirao':             'soccer_brazil_campeonato',
  'russian premier league':  'soccer_russia_premier_league',
  'ukrainian premier league':'soccer_ukraine_premier_league',
  'ekstraklasa':             'soccer_poland_ekstraklasa',
};

// Cache odds per sport key to avoid hammering the API (cache 10 mins)
const oddsCache = {};

async function fetchOddsForSport(sportKey) {
  const now = Date.now();
  if (oddsCache[sportKey] && now - oddsCache[sportKey].ts < 10 * 60 * 1000) {
    return oddsCache[sportKey].data;
  }
  try {
    // Fetch all available markets for this sport
    const markets = 'h2h,totals,btts,asian_handicap,draw_no_bet,double_chance';
    const url = `${ODDS_BASE}/sports/${sportKey}/odds?apiKey=${ODDS_KEY}&regions=uk,eu&markets=${markets}&oddsFormat=decimal&dateFormat=iso`;
    console.log(`[ODDS] Fetching ${sportKey}`);
    const resp = await fetch(url);

    // Log remaining quota
    const remaining = resp.headers.get('x-requests-remaining');
    const used      = resp.headers.get('x-requests-used');
    console.log(`[ODDS] Quota — used: ${used}, remaining: ${remaining}`);

    if (!resp.ok) {
      console.error(`[ODDS] ${resp.status} for ${sportKey}`);
      return [];
    }
    const data = await resp.json();
    oddsCache[sportKey] = { ts: now, data };
    return data;
  } catch (e) {
    console.error('[ODDS ERROR]', e.message);
    return [];
  }
}

// Main odds endpoint — frontend sends league name, gets back matched odds
app.get('/odds/today', async (req, res) => {
  try {
    const leagues = req.query.leagues ? req.query.leagues.split(',') : [];
    if (!leagues.length) return res.json({ matches: [] });

    // Get unique sport keys needed
    const sportKeys = [...new Set(
      leagues.map(l => LEAGUE_MAP[l.toLowerCase()]).filter(Boolean)
    )];

    if (!sportKeys.length) return res.json({ matches: [], note: 'No matching leagues in Odds API' });

    // Fetch all in parallel
    const allOdds = (await Promise.all(sportKeys.map(fetchOddsForSport))).flat();
    res.json({ matches: allOdds, count: allOdds.length });
  } catch (err) {
    console.error('[ODDS ROUTE ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get odds for a specific sport key directly
app.get('/odds/sport/:sportKey', async (req, res) => {
  try {
    const data = await fetchOddsForSport(req.params.sportKey);
    res.json({ matches: data, count: data.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List all available sports on the Odds API
app.get('/odds/sports', async (req, res) => {
  try {
    const url  = `${ODDS_BASE}/sports?apiKey=${ODDS_KEY}`;
    const resp = await fetch(url);
    const data = await resp.json();
    const soccer = data.filter(s => s.key?.includes('soccer'));
    res.json(soccer);
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    status: 'ok', teams, predictions: preds.length,
    resolved: preds.filter(p=>p.result).length,
    overallRate: calib?.overall?.rate ?? null,
    oddsLeagues: Object.keys(LEAGUE_MAP).length,
    uptime: process.uptime(),
  });
});

app.listen(PORT, () => {
  console.log(`PROPRED v4 running on port ${PORT}`);
  setTimeout(() => {
    fetch(`http://localhost:${PORT}/predictions/auto-resolve`, { method:'POST' })
      .then(r=>r.json()).then(d=>console.log('[STARTUP AUTO-RESOLVE]', d))
      .catch(()=>{});
  }, 2000);
});
