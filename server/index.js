'use strict';

const express  = require('express');
const fetch    = require('node-fetch');
const path     = require('path');
const db       = require('./db');

const app  = express();
const PORT = process.env.PORT || 10000;
const AI_KEY       = (process.env.ANTHROPIC_KEY || '').trim();
const GEMINI_KEY   = (process.env.GEMINI_KEY || '').trim();
const FOOTBALL_KEY = process.env.API_FOOTBALL_KEY || '';
const ODDS_KEY     = process.env.ODDS_API_KEY || '';

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

let fixtureStore = {};
let lastFetchDate = null;

const today = () => new Date().toISOString().split('T')[0];

const LEAGUE_MAP = {
  'eng.1':          'Premier League',
  'eng.2':          'Championship',
  'esp.1':          'La Liga',
  'ger.1':          'Bundesliga',
  'ita.1':          'Serie A',
  'fra.1':          'Ligue 1',
  'ned.1':          'Eredivisie',
  'tur.1':          'Super Lig',
  'sco.1':          'Scottish Prem',
  'por.1':          'Primeira Liga',
  'uefa.champions': 'Champions League',
  'uefa.europa':    'Europa League',
};

const ODDS_MAP = {
  'Premier League':   'soccer_epl',
  'Championship':     'soccer_efl_champ',
  'La Liga':          'soccer_spain_la_liga',
  'Bundesliga':       'soccer_germany_bundesliga',
  'Serie A':          'soccer_italy_serie_a',
  'Ligue 1':          'soccer_france_ligue_one',
  'Eredivisie':       'soccer_netherlands_eredivisie',
  'Champions League': 'soccer_uefa_champs_league',
  'Europa League':    'soccer_uefa_europa_league',
  'Scottish Prem':    'soccer_scotland_premiership',
};

// ── ESPN ───────────────────────────────────────────────────────────────────
async function fetchESPN(date) {
  const fixtures = [];
  for (const [slug, name] of Object.entries(LEAGUE_MAP)) {
    try {
      const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/scoreboard?dates=${date.replace(/-/g,'')}`;
      const res  = await fetch(url);
      const json = await res.json();
      const events = json.events || [];
      console.log(`[ESPN] ${name}: ${events.length}`);
      for (const ev of events) {
        const comp = ev.competitions?.[0];
        if (!comp) continue;
        const home = comp.competitors?.find(c=>c.homeAway==='home');
        const away = comp.competitors?.find(c=>c.homeAway==='away');
        if (!home || !away) continue;
        fixtures.push({
          id:         String(ev.id),
          league:     name,
          leagueLogo: `https://a.espncdn.com/i/leaguelogos/soccer/500/${slug}.png`,
          date:       comp.date,
          homeTeam:   home.team.displayName,
          awayTeam:   away.team.displayName,
          homeLogo:   home.team.logo,
          awayLogo:   away.team.logo,
          homeGoals:  home.score != null ? parseInt(home.score) : null,
          awayGoals:  away.score != null ? parseInt(away.score) : null,
          status:     comp.status?.type?.shortDetail || 'NS',
          venue:      comp.venue?.fullName || '',
          hasOdds:    false,
          odds:       {},
        });
      }
    } catch(e) { console.error(`[ESPN] ${name}:`, e.message); }
  }
  return fixtures;
}

// ── ODDS ───────────────────────────────────────────────────────────────────
async function fetchOddsForFixtures(fixtures) {
  if (!ODDS_KEY) return;
  const leagues = [...new Set(fixtures.map(f=>f.league))];
  for (const league of leagues) {
    const sport = ODDS_MAP[league];
    if (!sport) continue;
    try {
      const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${ODDS_KEY}&regions=uk&markets=h2h,totals&oddsFormat=decimal`;
      const res  = await fetch(url);
      const json = await res.json();
      if (!Array.isArray(json)) continue;
      for (const game of json) {
        const norm = s => (s||'').toLowerCase().replace(/[^a-z0-9]/g,' ').trim();
        const match = fixtures.find(f =>
          f.league === league &&
          (norm(f.homeTeam).split(' ')[0] === norm(game.home_team).split(' ')[0])
        );
        if (!match) continue;
        const bk  = game.bookmakers?.[0];
        if (!bk) continue;
        const h2h = bk.markets?.find(m=>m.key==='h2h');
        const tot = bk.markets?.find(m=>m.key==='totals');
        if (h2h) {
          match.odds.home = h2h.outcomes?.find(o=>o.name===game.home_team)?.price || h2h.outcomes?.[0]?.price;
          match.odds.draw = h2h.outcomes?.find(o=>o.name==='Draw')?.price;
          match.odds.away = h2h.outcomes?.find(o=>o.name===game.away_team)?.price || h2h.outcomes?.[2]?.price;
          match.hasOdds   = true;
        }
        if (tot) {
          match.odds.over25  = tot.outcomes?.find(o=>o.name==='Over'  && o.point===2.5)?.price;
          match.odds.under25 = tot.outcomes?.find(o=>o.name==='Under' && o.point===2.5)?.price;
        }
      }
    } catch(e) { console.error(`[ODDS] ${league}:`, e.message); }
  }
}

async function loadFixtures(date) {
  const fixtures = await fetchESPN(date);
  await fetchOddsForFixtures(fixtures);
  fixtureStore = {};
  for (const f of fixtures) fixtureStore[f.id] = f;
  lastFetchDate = date;
  console.log(`[STORE] ${fixtures.length} fixtures loaded`);
  return fixtures;
}

// ── AI ANALYSIS ────────────────────────────────────────────────────────────
async function analyseWithAI(homeTeam, awayTeam, league, odds) {
  const key = GEMINI_KEY || AI_KEY;
  if (!key) { console.log('[AI] No key'); return null; }

  const oddsStr = odds?.home
    ? `Home Win: ${odds.home} | Draw: ${odds.draw} | Away Win: ${odds.away}${odds.over25 ? ` | Over 2.5: ${odds.over25} | Under 2.5: ${odds.under25}` : ''}`
    : 'No odds available';

  const prompt = `You are a sharp football betting analyst. Analyse this match.

MATCH: ${homeTeam} vs ${awayTeam}
LEAGUE: ${league}
BOOKMAKER ODDS: ${oddsStr}

Respond with ONLY a valid JSON object. No markdown. No extra text. Start with { end with }.

{"summary":"2 sentence match analysis","tip":"e.g. ${homeTeam} Win or Over 2.5 Goals","market":"h2h or totals","confidence":65,"model_prob":68,"reasoning":"why this bet has value","risk":"low"}`;

  // Use Gemini if key available, else Claude
  if (GEMINI_KEY) {
    console.log('[AI] Calling Gemini...');
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 512 },
        }),
      });
      const data = await resp.json();
      console.log('[AI] Gemini status:', resp.status, '| Body:', JSON.stringify(data).slice(0, 300));
      if (resp.status !== 200) { console.error('[AI] Gemini error:', data); return null; }
      const text = (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
      if (!text) { console.error('[AI] Gemini empty'); return null; }
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) { console.error('[AI] No JSON:', text.slice(0,200)); return null; }
      const parsed = JSON.parse(jsonMatch[0]);
      console.log('[AI] Gemini success:', parsed.tip);
      return parsed;
    } catch(e) { console.error('[AI] Gemini exception:', e.message); return null; }
  }

  // Claude fallback
  console.log('[AI] Calling Claude... key length:', AI_KEY.length);
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': AI_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 512, messages: [{ role: 'user', content: prompt }] }),
    });
    const data = await resp.json();
    console.log('[AI] Claude status:', resp.status);
    if (resp.status !== 200) { console.error('[AI] Claude error:', data); return null; }
    const text = (data.content?.[0]?.text || '').trim();
    if (!text) return null;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    console.log('[AI] Claude success:', parsed.tip);
    return parsed;
  } catch(e) { console.error('[AI] Claude exception:', e.message); return null; }
}

// ── ROUTES ─────────────────────────────────────────────────────────────────

app.get('/api/fixtures', async (req, res) => {
  const date = req.query.date || today();
  try {
    if (lastFetchDate !== date || Object.keys(fixtureStore).length === 0) {
      await loadFixtures(date);
    }
    res.json({ fixtures: Object.values(fixtureStore), date, count: Object.keys(fixtureStore).length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/match/:id', async (req, res) => {
  const id = String(req.params.id);
  console.log('[MATCH] Request for:', id, '| Store size:', Object.keys(fixtureStore).length);

  // Ensure store is populated
  if (Object.keys(fixtureStore).length === 0) {
    await loadFixtures(today());
  }

  const fixture = fixtureStore[id];
  if (!fixture) {
    console.error('[MATCH] Not found. Store keys:', Object.keys(fixtureStore).slice(0,5));
    return res.status(404).json({ error: 'Fixture not found — please go to Fixtures page first' });
  }

  // Check cache — only use if analysis is not empty
  const cached = db.getCachedAnalysis(id);
  if (cached && cached.analysis && cached.analysis.trim().length > 10) {
    console.log('[MATCH] Returning cached analysis for:', id);
    const odds = fixture.odds || {};
    const impliedProb = odds.home ? Math.round(100 / odds.home) : null;
    const edgePct = impliedProb ? (cached.model_prob || 50) - impliedProb : null;
    return res.json({
      id, home_team: fixture.homeTeam, away_team: fixture.awayTeam,
      league: fixture.league, fixture_date: (fixture.date||'').split('T')[0],
      home_logo: fixture.homeLogo, away_logo: fixture.awayLogo,
      status: fixture.status, home_goals: fixture.homeGoals, away_goals: fixture.awayGoals,
      venue: fixture.venue, odds,
      analysis: cached.analysis, tip: cached.tip, market: cached.market,
      confidence: cached.confidence, model_prob: cached.model_prob,
      reasoning: cached.reasoning, risk: cached.risk,
      best_odds: odds.home || null, implied_prob: impliedProb,
      edge_pct: edgePct, has_value: edgePct != null && edgePct >= 3,
      h2h: [], home_form: [], away_form: [],
    });
  }

  // Run fresh AI analysis
  console.log('[MATCH] Running fresh AI for:', fixture.homeTeam, 'vs', fixture.awayTeam);
  const ai = await analyseWithAI(fixture.homeTeam, fixture.awayTeam, fixture.league, fixture.odds);

  const odds = fixture.odds || {};
  const impliedProb = odds.home ? Math.round(100 / odds.home) : null;
  const modelProb   = ai?.model_prob || 50;
  const edgePct     = impliedProb != null ? modelProb - impliedProb : null;

  if (ai?.summary) {
    db.cacheAnalysis({
      fixture_id: id, home_team: fixture.homeTeam, away_team: fixture.awayTeam,
      league: fixture.league, fixture_date: (fixture.date||'').split('T')[0],
      analysis: ai.summary, tip: ai.tip || '', market: ai.market || 'h2h',
      best_odds: odds.home || null, edge_pct: edgePct, model_prob: modelProb,
    });
  }

  res.json({
    id, home_team: fixture.homeTeam, away_team: fixture.awayTeam,
    league: fixture.league, fixture_date: (fixture.date||'').split('T')[0],
    home_logo: fixture.homeLogo, away_logo: fixture.awayLogo,
    status: fixture.status, home_goals: fixture.homeGoals, away_goals: fixture.awayGoals,
    venue: fixture.venue, odds,
    analysis: ai?.summary    || null,
    tip:      ai?.tip        || null,
    market:   ai?.market     || null,
    confidence: ai?.confidence || null,
    model_prob: modelProb,
    reasoning:  ai?.reasoning  || null,
    risk:       ai?.risk       || null,
    best_odds:  odds.home      || null,
    implied_prob: impliedProb,
    edge_pct:   edgePct,
    has_value:  edgePct != null && edgePct >= 3,
    h2h: [], home_form: [], away_form: [],
  });
});

app.post('/api/bet', (req, res) => {
  try {
    const bet = db.placeBet(req.body);
    if (!bet) return res.json({ ok: false, reason: 'Insufficient bankroll or zero Kelly stake' });
    res.json({ ok: true, bet });
  } catch(e) { res.status(500).json({ ok: false, reason: e.message }); }
});

app.get('/api/bets', (req, res) => {
  res.json(db.getBets({ limit: parseInt(req.query.limit) || 50 }));
});

app.get('/api/portfolio', (req, res) => { res.json(db.getStats()); });

app.post('/api/settle', async (req, res) => {
  try {
    await loadFixtures(today());
    let settled = 0;
    const pending = db.getBets({ pending: true });
    for (const bet of pending) {
      const f = fixtureStore[String(bet.fixture_id)];
      if (!f || f.homeGoals == null) continue;
      const status = (f.status||'').toLowerCase();
      if (!status.includes('ft') && !status.includes('final') && !status.includes('full')) continue;
      settled += db.settleBet(bet.fixture_id, f.homeGoals, f.awayGoals);
    }
    res.json({ ok: true, settled });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/status', (req, res) => {
  const stats = db.getStats();
  res.json({ status: 'ok', version: '2.0', hasAI: !!AI_KEY, bankroll: stats.bankroll, totalBets: stats.totalBets, winRate: stats.winRate });
});

app.post('/api/bankroll/reset', (req, res) => {
  const amount = parseFloat(req.body.amount) || 1000;
  db.resetBankroll(amount);
  res.json({ ok: true, amount });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

app.listen(PORT, async () => {
  console.log(`PROPRED v2 on :${PORT} | AI: ${AI_KEY ? '✅ key length='+AI_KEY.length : '❌ NO KEY'}`);
  await loadFixtures(today());
});
