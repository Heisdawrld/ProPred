'use strict';

const express  = require('express');
const fetch    = require('node-fetch');
const path     = require('path');
const db       = require('./db');

const app  = express();
const PORT = process.env.PORT || 10000;
const AI_KEY      = process.env.ANTHROPIC_KEY || '';
const FOOTBALL_KEY = process.env.API_FOOTBALL_KEY || '';
const ODDS_KEY    = process.env.ODDS_API_KEY || '';

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ═══════════════════════════════════════════════
// FIXTURE STORE (in-memory cache)
// ═══════════════════════════════════════════════
let fixtureStore = {};   // id -> fixture object
let lastFetchDate = null;

// ═══════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════
const today = () => new Date().toISOString().split('T')[0];

function mapStatus(s) {
  const short = s?.short || s;
  return short;
}

// ═══════════════════════════════════════════════
// ESPN / API-FOOTBALL FETCH
// ═══════════════════════════════════════════════
const LEAGUE_MAP = {
  'eng.1':  'Premier League',
  'eng.2':  'Championship',
  'esp.1':  'La Liga',
  'ger.1':  'Bundesliga',
  'ita.1':  'Serie A',
  'fra.1':  'Ligue 1',
  'ned.1':  'Eredivisie',
  'tur.1':  'Super Lig',
  'sco.1':  'Scottish Prem',
  'por.1':  'Primeira Liga',
  'uefa.champions': 'Champions League',
  'uefa.europa':    'Europa League',
};

async function fetchESPN(date) {
  const fixtures = [];
  for (const [slug, name] of Object.entries(LEAGUE_MAP)) {
    try {
      const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/scoreboard?dates=${date.replace(/-/g,'')}`;
      const res = await fetch(url, { timeout: 8000 });
      const json = await res.json();
      const events = json.events || [];
      console.log(`[ESPN] ${name}: ${events.length}`);
      for (const ev of events) {
        const comp = ev.competitions?.[0];
        if (!comp) continue;
        const home = comp.competitors?.find(c=>c.homeAway==='home');
        const away = comp.competitors?.find(c=>c.homeAway==='away');
        if (!home || !away) continue;
        const status = comp.status?.type?.shortDetail || comp.status?.type?.name || 'NS';
        const fixtureId = ev.id;
        fixtures.push({
          id:         fixtureId,
          league:     name,
          leagueLogo: `https://a.espncdn.com/i/leaguelogos/soccer/500/${slug}.png`,
          date:       comp.date,
          homeTeam:   home.team.displayName,
          awayTeam:   away.team.displayName,
          homeLogo:   home.team.logo,
          awayLogo:   away.team.logo,
          homeGoals:  home.score != null ? parseInt(home.score) : null,
          awayGoals:  away.score != null ? parseInt(away.score) : null,
          status:     status,
          venue:      comp.venue?.fullName || '',
          hasOdds:    false,
          odds:       {},
        });
      }
    } catch(e) {
      console.error(`[ESPN] ${name} error:`, e.message);
    }
  }
  return fixtures;
}

async function fetchOddsForFixtures(fixtures) {
  if (!ODDS_KEY) return;
  const SPORT_MAP = {
    'Premier League':    'soccer_epl',
    'Championship':      'soccer_efl_champ',
    'La Liga':           'soccer_spain_la_liga',
    'Bundesliga':        'soccer_germany_bundesliga',
    'Serie A':           'soccer_italy_serie_a',
    'Ligue 1':           'soccer_france_ligue_one',
    'Eredivisie':        'soccer_netherlands_eredivisie',
    'Champions League':  'soccer_uefa_champs_league',
    'Europa League':     'soccer_uefa_europa_league',
  };
  const leagues = [...new Set(fixtures.map(f=>f.league))];
  for (const league of leagues) {
    const sport = SPORT_MAP[league];
    if (!sport) continue;
    try {
      const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${ODDS_KEY}&regions=uk&markets=h2h,totals&oddsFormat=decimal`;
      const res  = await fetch(url, { timeout: 8000 });
      const json = await res.json();
      if (!Array.isArray(json)) continue;
      for (const game of json) {
        const match = fixtures.find(f =>
          f.league === league &&
          (f.homeTeam.toLowerCase().includes(game.home_team.toLowerCase().split(' ')[0]) ||
           game.home_team.toLowerCase().includes(f.homeTeam.toLowerCase().split(' ')[0]))
        );
        if (!match) continue;
        const bk = game.bookmakers?.[0];
        if (!bk) continue;
        const h2h = bk.markets?.find(m=>m.key==='h2h');
        const tot = bk.markets?.find(m=>m.key==='totals');
        if (h2h) {
          match.odds.home  = h2h.outcomes?.find(o=>o.name===game.home_team)?.price;
          match.odds.draw  = h2h.outcomes?.find(o=>o.name==='Draw')?.price;
          match.odds.away  = h2h.outcomes?.find(o=>o.name===game.away_team)?.price;
          match.hasOdds = true;
        }
        if (tot) {
          match.odds.over25  = tot.outcomes?.find(o=>o.name==='Over'  && o.point===2.5)?.price;
          match.odds.under25 = tot.outcomes?.find(o=>o.name==='Under' && o.point===2.5)?.price;
        }
      }
    } catch(e) {
      console.error(`[ODDS] ${league}:`, e.message);
    }
  }
}

async function loadFixtures(date) {
  const fixtures = await fetchESPN(date);
  await fetchOddsForFixtures(fixtures);
  fixtureStore = {};
  for (const f of fixtures) fixtureStore[String(f.id)] = f;
  lastFetchDate = date;
  console.log(`[STARTUP] Loaded ${fixtures.length} fixtures into store`);
  return fixtures;
}

// ═══════════════════════════════════════════════
// AI ANALYSIS
// ═══════════════════════════════════════════════
async function analyseWithAI(homeTeam, awayTeam, league, h2h, homeForm, awayForm, odds) {
  if (!AI_KEY) return null;

  const fmtH2H = (h2h||[]).slice(0,5).map(m =>
    `${m.teams?.home?.name} ${m.goals?.home??'?'}-${m.goals?.away??'?'} ${m.teams?.away?.name}`
  ).join(' | ') || 'No H2H data';

  const fmtForm = (fixtures, teamName) => {
    const finished = (fixtures||[]).filter(m=>m.goals?.home!=null && m.goals?.away!=null).slice(0,5);
    return finished.map(m => {
      const isHome = m.teams?.home?.name?.toLowerCase().includes(teamName.split(' ')[0].toLowerCase());
      const gf = isHome ? m.goals.home : m.goals.away;
      const ga = isHome ? m.goals.away : m.goals.home;
      return `${gf>ga?'W':gf<ga?'L':'D'}(${gf}-${ga})`;
    }).join(' ') || 'No form data';
  };

  const oddsStr = odds?.home
    ? `Home:${odds.home} Draw:${odds.draw} Away:${odds.away}${odds.over25 ? ` O2.5:${odds.over25} U2.5:${odds.under25}` : ''}`
    : 'No odds available';

  const prompt = `You are a sharp football betting analyst. Analyse this match and find value.

MATCH: ${homeTeam} vs ${awayTeam} (${league})
H2H: ${fmtH2H}
${homeTeam} recent form: ${fmtForm(homeForm, homeTeam)}
${awayTeam} recent form: ${fmtForm(awayForm, awayTeam)}
Bookmaker odds: ${oddsStr}

You must respond with ONLY a raw JSON object. No markdown, no backticks, no explanation. Begin with { and end with }.

{"summary":"2 sentence analysis","tip":"e.g. Liverpool Win or Over 2.5 Goals","market":"h2h or totals","confidence":65,"model_prob":68,"reasoning":"one sentence on value","risk":"low|medium|high"}

Rules: confidence between 40-85. Be sharp and specific.`;

  try {
    console.log('[AI] Calling Claude for:', homeTeam, 'vs', awayTeam);
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':    'application/json',
        'x-api-key':       AI_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages:   [{ role: 'user', content: prompt }],
      }),
    });

    const data = await resp.json();
    console.log('[AI] HTTP status:', resp.status);

    if (resp.status !== 200) {
      console.error('[AI] API error:', JSON.stringify(data));
      return null;
    }

    const text = (data.content?.[0]?.text || '').trim();
    console.log('[AI] Raw response:', text.slice(0, 300));

    if (!text) { console.error('[AI] Empty response'); return null; }

    // Strip markdown fences if present
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) { console.error('[AI] No JSON found:', text.slice(0, 200)); return null; }

    const parsed = JSON.parse(jsonMatch[0]);
    console.log('[AI] Parsed OK:', JSON.stringify(parsed));
    return parsed;
  } catch(e) {
    console.error('[AI] Error:', e.message);
    return null;
  }
}

// ═══════════════════════════════════════════════
// FETCH MATCH DETAILS (H2H + form from API-Football)
// ═══════════════════════════════════════════════
async function fetchMatchDetails(fixture) {
  // Try to get H2H and form from API-Football if key is set
  // Returns { h2h, homeForm, awayForm }
  // Falls back to empty arrays if no key
  if (!FOOTBALL_KEY) return { h2h: [], homeForm: [], awayForm: [] };

  try {
    // Search for the match by team names
    const searchUrl = `https://v3.football.api-sports.io/fixtures?date=${today()}&league=39&season=2024`;
    // We'll just return empty for now - API-Football requires team IDs
    return { h2h: [], homeForm: [], awayForm: [] };
  } catch(e) {
    return { h2h: [], homeForm: [], awayForm: [] };
  }
}

// Build form array from ESPN scoreboard data
function buildFormFromStore(teamName) {
  // Returns basic form from any finished fixtures in store
  return Object.values(fixtureStore)
    .filter(f => (f.homeGoals != null) &&
      (f.homeTeam.toLowerCase().includes(teamName.toLowerCase().split(' ')[0]) ||
       f.awayTeam.toLowerCase().includes(teamName.toLowerCase().split(' ')[0])))
    .slice(0, 5)
    .map(f => {
      const isHome = f.homeTeam.toLowerCase().includes(teamName.toLowerCase().split(' ')[0]);
      const gf = isHome ? f.homeGoals : f.awayGoals;
      const ga = isHome ? f.awayGoals : f.homeGoals;
      return {
        result: gf > ga ? 'W' : gf < ga ? 'L' : 'D',
        homeTeam: f.homeTeam, awayTeam: f.awayTeam,
        homeGoals: f.homeGoals, awayGoals: f.awayGoals,
        isHome,
      };
    });
}

// ═══════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════

// GET /api/fixtures?date=YYYY-MM-DD
app.get('/api/fixtures', async (req, res) => {
  const date = req.query.date || today();
  try {
    if (lastFetchDate !== date || Object.keys(fixtureStore).length === 0) {
      await loadFixtures(date);
    }
    res.json({ fixtures: Object.values(fixtureStore), date });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/match/:id
app.get('/api/match/:id', async (req, res) => {
  const id = String(req.params.id);
  const fixture = fixtureStore[id];
  if (!fixture) return res.status(404).json({ error: 'Fixture not found' });

  // Check cache
  const cached = db.getCachedAnalysis(id);
  if (cached) {
    const odds = fixture.odds || {};
    const impliedProb = odds.home ? Math.round(100 / odds.home) : null;
    const modelProb   = cached.model_prob || 50;
    const edgePct     = impliedProb ? modelProb - impliedProb : null;
    const bestOdds    = odds.home;
    return res.json({
      id,
      home_team:    fixture.homeTeam,
      away_team:    fixture.awayTeam,
      league:       fixture.league,
      fixture_date: (fixture.date||'').split('T')[0],
      home_logo:    fixture.homeLogo,
      away_logo:    fixture.awayLogo,
      status:       fixture.status,
      home_goals:   fixture.homeGoals,
      away_goals:   fixture.awayGoals,
      venue:        fixture.venue,
      odds,
      analysis:     cached.analysis,
      tip:          cached.tip,
      market:       cached.market,
      best_odds:    bestOdds,
      implied_prob: impliedProb,
      model_prob:   modelProb,
      edge_pct:     edgePct,
      has_value:    edgePct != null && edgePct >= 3,
      confidence:   cached.confidence || null,
      reasoning:    cached.reasoning || null,
      risk:         cached.risk || null,
      h2h:          [],
      home_form:    buildFormFromStore(fixture.homeTeam),
      away_form:    buildFormFromStore(fixture.awayTeam),
    });
  }

  // Run AI analysis
  const { h2h, homeForm, awayForm } = await fetchMatchDetails(fixture);
  const ai = await analyseWithAI(
    fixture.homeTeam, fixture.awayTeam, fixture.league,
    h2h, homeForm, awayForm, fixture.odds
  );

  const odds = fixture.odds || {};
  const impliedProb = odds.home ? Math.round(100 / odds.home) : null;
  const modelProb   = ai?.model_prob || 50;
  const edgePct     = impliedProb != null ? modelProb - impliedProb : null;
  const bestOdds    = odds.home || null;
  const hasValue    = edgePct != null && edgePct >= 3;

  if (ai) {
    db.cacheAnalysis({
      fixture_id:   id,
      home_team:    fixture.homeTeam,
      away_team:    fixture.awayTeam,
      league:       fixture.league,
      fixture_date: (fixture.date||'').split('T')[0],
      analysis:     ai.summary || '',
      tip:          ai.tip || '',
      market:       ai.market || 'h2h',
      best_odds:    bestOdds,
      edge_pct:     edgePct,
      model_prob:   modelProb,
    });
  }

  res.json({
    id,
    home_team:    fixture.homeTeam,
    away_team:    fixture.awayTeam,
    league:       fixture.league,
    fixture_date: (fixture.date||'').split('T')[0],
    home_logo:    fixture.homeLogo,
    away_logo:    fixture.awayLogo,
    status:       fixture.status,
    home_goals:   fixture.homeGoals,
    away_goals:   fixture.awayGoals,
    venue:        fixture.venue,
    odds,
    analysis:     ai?.summary    || null,
    tip:          ai?.tip        || null,
    market:       ai?.market     || null,
    confidence:   ai?.confidence || null,
    model_prob:   modelProb,
    reasoning:    ai?.reasoning  || null,
    risk:         ai?.risk       || null,
    best_odds:    bestOdds,
    implied_prob: impliedProb,
    edge_pct:     edgePct,
    has_value:    hasValue,
    h2h:          h2h,
    home_form:    buildFormFromStore(fixture.homeTeam),
    away_form:    buildFormFromStore(fixture.awayTeam),
  });
});

// POST /api/bet
app.post('/api/bet', (req, res) => {
  try {
    const bet = db.placeBet(req.body);
    if (!bet) return res.json({ ok: false, reason: 'Insufficient bankroll or zero Kelly stake' });
    res.json({ ok: true, bet });
  } catch(e) {
    res.status(500).json({ ok: false, reason: e.message });
  }
});

// GET /api/bets
app.get('/api/bets', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json(db.getBets({ limit }));
});

// GET /api/portfolio
app.get('/api/portfolio', (req, res) => {
  res.json(db.getStats());
});

// POST /api/settle
app.post('/api/settle', async (req, res) => {
  // Re-fetch today's fixtures to get latest scores
  try {
    await loadFixtures(today());
  } catch(e) {}

  let settled = 0;
  const pending = db.getBets({ pending: true });
  for (const bet of pending) {
    const f = fixtureStore[String(bet.fixture_id)];
    if (!f) continue;
    const isFT = ['FT','AET','PEN','FT_PEN'].some(s => (f.status||'').includes(s));
    if (!isFT || f.homeGoals == null) continue;
    settled += db.settleBet(bet.fixture_id, f.homeGoals, f.awayGoals);
  }
  res.json({ settled });
});

// GET /api/status
app.get('/api/status', (req, res) => {
  const stats = db.getStats();
  res.json({
    hasAI:      !!AI_KEY,
    bankroll:   stats.bankroll,
    totalBets:  stats.totalBets,
  });
});

// POST /api/bankroll/reset
app.post('/api/bankroll/reset', (req, res) => {
  const amount = parseFloat(req.body.amount) || 1000;
  db.resetBankroll(amount);
  res.json({ ok: true, amount });
});

// ═══════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════
app.listen(PORT, async () => {
  console.log(`PROPRED v2 on :${PORT} | AI:${AI_KEY ? '✅' : '❌'}`);
  try {
    await loadFixtures(today());
    const settled = db.getBets({ pending: true }).length;
    console.log(`[STARTUP] Settled: ${settled}`);
  } catch(e) {
    console.error('[STARTUP] Error:', e.message);
  }
});
