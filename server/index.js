'use strict';

const express  = require('express');
const path     = require('path');
const fetch    = require('node-fetch');

const db  = require('./db');
const bsd = require('./bsd');
const localdb = require('./localdb');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ─── ENV ──────────────────────────────────────────────────────────────────
const API_FOOTBALL_KEY = (process.env.API_FOOTBALL_KEY || '').trim();
const ODDS_API_KEY     = (process.env.ODDS_API_KEY     || '').trim();
const GROQ_KEY         = (process.env.GROQ_KEY         || '').trim();

const VERSION = '4.0.0-Flashscore'; // Major version bump

// ─── IN-MEMORY FIXTURE CACHE ──────────────────────────────────────────────
let fixtureCache = {};   
const FIXTURE_TTL = 30 * 60 * 1000; // 30 min

const today = () => new Date().toISOString().split('T')[0];

function norm(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

function fuzzyTeam(a, b) {
  const na = norm(a), nb = norm(b);
  if (na === nb) return true;
  if ((na.includes(nb) && nb.length > 3) || (nb.includes(na) && na.length > 3)) return true;
  const generic = ['united', 'city', 'fc', 'afc', 'rovers', 'athletic', 'real', 'cf', 'cd', 'sporting', 'club', 'de'];
  const strip = s => s.split(' ').filter(w => w.length > 2 && !generic.includes(w)).join(' ');
  const ca = strip(na); const cb = strip(nb);
  if (!ca || !cb) return false;
  if (ca === cb || ca.includes(cb) || cb.includes(ca)) return true;
  const w1 = ca.split(' ')[0]; const w2 = cb.split(' ')[0];
  if (w1 === w2) return true;
  const aliases = [['manchester', 'man'], ['nottingham', 'nottm'], ['wolverhampton', 'wolves'], ['sheffield', 'sheff'], ['tottenham', 'spurs']];
  for (const [full, abbr] of aliases) { if ((w1 === full && w2 === abbr) || (w2 === full && w1 === abbr)) return true; }
  if (w1.length >= 5 && w2.length >= 5 && (w1.startsWith(w2) || w2.startsWith(w1))) return true;
  return false;
}

// ─── ODDS API ─────────────────────────────────────────────────────────────
async function fetchOdds(homeTeam, awayTeam) {
  if (!ODDS_API_KEY) return null;
  try {
    const res = await fetch(`https://api.the-odds-api.com/v4/sports/soccer/odds/?apiKey=${ODDS_API_KEY}&regions=uk&markets=h2h,totals,btts,asian_handicap,double_chance&oddsFormat=decimal`, { timeout: 5000 });
    if (!res.ok) return null;
    const events = await res.json();
    const match = events.find(e => (fuzzyTeam(e.home_team, homeTeam) && fuzzyTeam(e.away_team, awayTeam)) || (fuzzyTeam(e.home_team, awayTeam) && fuzzyTeam(e.away_team, homeTeam)));
    if (!match) return null;

    const result = {};
    for (const bm of (match.bookmakers || [])) {
      for (const mkt of (bm.markets || [])) {
        if (mkt.key === 'h2h') {
          for (const o of mkt.outcomes) {
            if (fuzzyTeam(o.name, homeTeam)) result.home = o.price;
            else if (fuzzyTeam(o.name, awayTeam)) result.away = o.price;
            else if (o.name === 'Draw') result.draw = o.price;
          }
        }
        if (mkt.key === 'totals') {
          for (const o of mkt.outcomes) {
            const pt = parseFloat(o.point);
            if (pt === 1.5) { if (o.name === 'Over') result.over15 = o.price; else result.under15 = o.price; }
            if (pt === 2.5) { if (o.name === 'Over') result.over25 = o.price; else result.under25 = o.price; }
            if (pt === 3.5) { if (o.name === 'Over') result.over35 = o.price; else result.under35 = o.price; }
            if (pt === 4.5) { if (o.name === 'Over') result.over45 = o.price; else result.under45 = o.price; }
          }
        }
        if (mkt.key === 'btts') {
          for (const o of mkt.outcomes) {
            if (o.name === 'Yes') result.bttsYes = o.price;
            if (o.name === 'No')  result.bttsNo  = o.price;
          }
        }
        if (mkt.key === 'double_chance') {
          for (const o of mkt.outcomes) {
            if (o.name === '1X') result.dc1X = o.price;
            if (o.name === 'X2') result.dcX2 = o.price;
            if (o.name === '12') result.dc12 = o.price;
          }
        }
        if (mkt.key === 'asian_handicap') {
          for (const o of mkt.outcomes) {
            if (parseFloat(o.point) === -0.5) {
              if (fuzzyTeam(o.name, homeTeam)) result.ahHome = o.price;
              else result.ahAway = o.price;
            }
          }
        }
      }
      break; 
    }
    return Object.keys(result).length ? result : null;
  } catch(e) { return null; }
}

// ─── FORM ORCHESTRATOR (Tier 0: Local CSV -> Tier 1: API-Football) ──────────────
async function getFormAndH2H(homeTeam, awayTeam, league) {
  console.log(`[FORM] Lookup: ${homeTeam} vs ${awayTeam} | ${league}`);

  // Tier 0: localdb (Historical CSVs)
  try {
    if (localdb && typeof localdb.getLocalForm === 'function') {
      const r = localdb.getLocalForm(homeTeam, awayTeam, league);
      if (r && (r.homeForm.length > 0 || r.awayForm.length > 0)) {
        console.log(`[FORM] localdb hit: home=${r.homeForm.length} away=${r.awayForm.length} h2h=${r.h2h.length}`);
        return r;
      }
    }
  } catch(e) { console.error('[FORM] localdb err:', e.message); }

  // Tier 1: API-Football Fallback (Until we build the Apify deep scraper)
  if (!API_FOOTBALL_KEY) return { homeForm: [], awayForm: [], h2h: [] };
  
  try {
    const search = async name => {
      const r = await fetch(`https://v3.football.api-sports.io/teams?search=${encodeURIComponent(name)}`, { headers: { 'x-apisports-key': API_FOOTBALL_KEY }, timeout: 4000 });
      return (await r.json())?.response?.[0]?.team?.id || null;
    };
    const [homeId, awayId] = await Promise.all([search(homeTeam), search(awayTeam)]);
    if (!homeId || !awayId) return { homeForm: [], awayForm: [], h2h: [] };

    const headers = { 'x-apisports-key': API_FOOTBALL_KEY };
    const [homeRes, awayRes, h2hRes] = await Promise.all([
      fetch(`https://v3.football.api-sports.io/fixtures?team=${homeId}&last=6`, { headers, timeout: 5000 }),
      fetch(`https://v3.football.api-sports.io/fixtures?team=${awayId}&last=6`, { headers, timeout: 5000 }),
      fetch(`https://v3.football.api-sports.io/fixtures/headtohead?h2h=${homeId}-${awayId}&last=6`, { headers, timeout: 5000 }),
    ]);

    const parseForm = async (res, teamId) => {
      const data = await res.json();
      return (data.response || []).map(f => {
        const isHome = f.teams.home.id === teamId;
        const hg = f.goals.home, ag = f.goals.away;
        const gf = isHome ? hg : ag, ga = isHome ? ag : hg;
        return {
          date: f.fixture.date?.split('T')[0], homeTeam: f.teams.home.name, awayTeam: f.teams.away.name,
          homeGoals: hg, awayGoals: ag, isHome, result: gf > ga ? 'W' : gf < ga ? 'L' : 'D',
        };
      });
    };

    const homeForm = await parseForm(homeRes, homeId);
    const awayForm = await parseForm(awayRes, awayId);
    const h2hData  = await h2hRes.json();
    const h2h = (h2hData.response || []).map(f => ({
      date: f.fixture.date?.split('T')[0], homeTeam: f.teams.home.name, awayTeam: f.teams.away.name,
      homeGoals: f.goals.home, awayGoals: f.goals.away,
    }));

    if (homeForm.length || awayForm.length) {
       console.log(`[FORM] API-Football ok: home=${homeForm.length} away=${awayForm.length}`);
       return { homeForm, awayForm, h2h, source: 'api-football' };
    }
  } catch(e) { console.error('[FORM] API-Football err:', e.message); }

  return { homeForm: [], awayForm: [], h2h: [] };
}

// ─── AI ANALYSIS (GROQ) ───────────────────────────────────────────────────
async function analyseWithAI(fixture, formData) {
  if (!GROQ_KEY) return null;

  const { homeTeam, awayTeam, league, odds } = fixture;
  const { homeForm = [], awayForm = [], h2h = [] } = formData || {};

  const isBlind = !homeForm.length && !awayForm.length;

  const fmtForm = form => form.slice(0, 5).map(f => `${f.result} (${f.isHome ? 'vs' : '@'} ${f.isHome ? f.awayTeam : f.homeTeam} ${f.homeGoals}-${f.awayGoals})`).join(', ') || 'No data';
  const fmtH2H = h2h.slice(0, 5).map(g => `${g.homeTeam} ${g.homeGoals}-${g.awayGoals} ${g.awayTeam}`).join(' | ') || 'No data';

  const oddsBlk = odds ? `Odds: Home=${odds.home?.toFixed(2)||'—'} Draw=${odds.draw?.toFixed(2)||'—'} Away=${odds.away?.toFixed(2)||'—'} O2.5=${odds.over25?.toFixed(2)||'—'} BTTS=${odds.bttsYes?.toFixed(2)||'—'}` : 'No odds available';
  const statsBlk = homeForm.length ? (() => {
        const avgGoals = arr => arr.length ? (arr.reduce((s, f) => s + (f.homeGoals + f.awayGoals), 0) / arr.length).toFixed(1) : '?';
        const winRate  = (arr, team) => arr.length ? Math.round(arr.filter(f => f.result === 'W').length / arr.length * 100) + '%' : '?';
        return `${homeTeam} last ${homeForm.length}: ${winRate(homeForm)} wins, avg ${avgGoals(homeForm)} goals/g | ${awayTeam} last ${awayForm.length}: ${winRate(awayForm)} wins, avg ${avgGoals(awayForm)} goals/g`;
      })() : '';

  let localStatsHome = null; let localStatsAway = null;
  if (localdb && typeof localdb.getTeamStats === 'function') {
      localStatsHome = localdb.getTeamStats(homeTeam, league);
      localStatsAway = localdb.getTeamStats(awayTeam, league);
  }

  const localStatsBlk = (localStatsHome && localStatsAway)
    ? ` SEASON STATS (${localStatsHome.n} matches): ${homeTeam}: ${localStatsHome.avgScored} goals/g scored | ${localStatsHome.avgConceded} conceded | ${localStatsHome.avgShots} shots/g | ${localStatsHome.avgShotsT} on target | BTTS ${localStatsHome.bttsRate}% | O2.5 ${localStatsHome.over25Rate}% ${awayTeam}: ${localStatsAway.avgScored} goals/g scored | ${localStatsAway.avgConceded} conceded | ${localStatsAway.avgShots} shots/g | ${localStatsAway.avgShotsT} on target | BTTS ${localStatsAway.bttsRate}% | O2.5 ${localStatsAway.over25Rate}%`
    : '';

  const prompt = `Match: ${homeTeam} vs ${awayTeam} | League: ${league}\n${oddsBlk}\n${homeTeam} form: ${fmtForm(homeForm)}\n${awayTeam} form: ${fmtForm(awayForm)}\nH2H: ${fmtH2H}\n${statsBlk}${localStatsBlk}\n${isBlind ? 'NOTE: No live form data found. Use your training knowledge to estimate.' : ''}
Analyse this match and respond in this exact JSON format:
{
  "analysis": "2-3 sentence professional match analysis covering key factors",
  "reasoning": "1 sentence on why your pick has value vs the market",
  "tip": "Your recommended bet",
  "market": "h2h|totals|btts|dnb|asian_handicap|double_chance",
  "confidence": 55,
  "risk": "low|medium|high",
  "probs": { "home_win": 55, "draw": 25, "away_win": 20, "over15": 80, "under15": 20, "over25": 55, "under25": 45, "over35": 30, "under35": 70, "over45": 12, "btts_yes": 48, "btts_no": 52, "dc_home_draw": 70, "dc_away_draw": 45, "dnb_home": 68, "dnb_away": 40, "ah_home": 58, "ah_away": 42 }
}`;

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant', 
        messages: [
          { role: 'system', content: 'You are a professional football betting analyst. You study form, odds, and market value. Respond ONLY with valid JSON, no markdown, no preamble.' },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 800, temperature: 0.3,
      }),
      timeout: 15000,
    });
    if (!res.ok) { console.error('[AI] Groq error:', res.status); return null; }
    const data = await res.json();
    let text = data.choices?.[0]?.message?.content || '{}';
    text = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    return { ...JSON.parse(text), is_blind: isBlind };
  } catch(e) { return null; }
}

function computeValue(ai, odds) {
  if (!ai || !odds) return { has_value: false, best_odds: null, implied_prob: null, edge_pct: null, model_prob: null };
  const tipL = (ai.tip || '').toLowerCase();
  let best_odds = null, market_key = null;
  if (tipL.includes('draw')) { best_odds = odds.draw; }
  else if (tipL.includes('over 4.5')) { best_odds = odds.over45; }
  else if (tipL.includes('over 3.5')) { best_odds = odds.over35; }
  else if (tipL.includes('over 2.5')) { best_odds = odds.over25; }
  else if (tipL.includes('under 2.5')) { best_odds = odds.under25; }
  else if (tipL.includes('over 1.5')) { best_odds = odds.over15; }
  else if (tipL.includes('under 1.5')) { best_odds = odds.under15; }
  else if (tipL.includes('btts') && tipL.includes('yes')) { best_odds = odds.bttsYes; }
  else if (tipL.includes('btts') && tipL.includes('no'))  { best_odds = odds.bttsNo; }
  else if (tipL.includes('1x') || (tipL.includes('or draw') && tipL.includes('home'))) { best_odds = odds.dc1X; }
  else if (tipL.includes('x2') || (tipL.includes('or draw') && tipL.includes('away'))) { best_odds = odds.dcX2; }
  else if (tipL.includes('dnb') || tipL.includes('draw no bet')) { best_odds = tipL.includes('away') ? odds.dnbAway : odds.dnbHome; }
  else if (tipL.includes('asian')) { best_odds = tipL.includes('away') ? odds.ahAway : odds.ahHome; }
  else { best_odds = odds.home; market_key = 'h2h'; }

  if (!best_odds || best_odds <= 1) return { has_value: false, best_odds: null, implied_prob: null, edge_pct: null, model_prob: null };
  const implied_prob = Math.round(100 / best_odds);
  const p = ai.probs || {};
  let model_prob = ai.confidence || 55;
  if (tipL.includes('draw')) model_prob = p.draw || model_prob;
  else if (tipL.includes('over 2.5')) model_prob = p.over25 || model_prob;
  else if (tipL.includes('under 2.5')) model_prob = p.under25 || model_prob;
  else if (tipL.includes('over 1.5')) model_prob = p.over15 || model_prob;
  else if (tipL.includes('btts') && tipL.includes('yes')) model_prob = p.btts_yes || model_prob;
  else if (tipL.includes('btts') && tipL.includes('no'))  model_prob = p.btts_no  || model_prob;
  else model_prob = p.home_win || model_prob;

  const edge_pct = Math.round(model_prob - implied_prob);
  return { has_value: edge_pct >= 3, best_odds, implied_prob, edge_pct, model_prob };
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function poisson(lambda, k) {
  const fact = (n) => {
    let out = 1;
    for (let i = 2; i <= n; i++) out *= i;
    return out;
  };
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / fact(k);
}

function extractOddsForMarket(odds, market, selection) {
  if (!odds) return null;
  if (market === '1x2') return odds[selection] || null;
  if (market === 'btts') return selection === 'yes' ? odds.bttsYes || null : odds.bttsNo || null;
  if (market === 'totals') return odds[selection] || null;
  return null;
}

function toSnapshot(base, market, selection, probability, odds, payload) {
  const implied = odds && odds > 1 ? (100 / odds) : null;
  const edge = implied != null ? (probability * 100) - implied : null;
  return {
    fixture_id: base.fixture_id,
    home_team: base.home_team,
    away_team: base.away_team,
    league: base.league,
    fixture_date: base.fixture_date,
    market,
    selection,
    probability: Number((probability * 100).toFixed(1)),
    confidence: base.confidence,
    odds,
    implied_prob: implied != null ? Number(implied.toFixed(1)) : null,
    edge_pct: edge != null ? Number(edge.toFixed(1)) : null,
    source: base.source || 'model',
    payload_json: payload,
  };
}

function buildMarketPredictions(matchData) {
  const probs = matchData.probs || {};
  const odds = matchData.odds || {};

  const aiHome = (probs.home_win ?? 0) / 100;
  const aiDraw = (probs.draw ?? 0) / 100;
  const aiAway = (probs.away_win ?? 0) / 100;
  const aiTotal = aiHome + aiDraw + aiAway;
  const nAiHome = aiTotal > 0 ? aiHome / aiTotal : 0.4;
  const nAiDraw = aiTotal > 0 ? aiDraw / aiTotal : 0.28;
  const nAiAway = aiTotal > 0 ? aiAway / aiTotal : 0.32;

  const over25Seed = clamp((probs.over25 ?? 55) / 100, 0.1, 0.9);
  const expectedTotalGoals = clamp(1.6 + over25Seed * 2.2, 1.2, 4.2);
  const homeBias = clamp((nAiHome - nAiAway) * 0.35, -0.2, 0.2);
  const homeShare = clamp(0.5 + homeBias, 0.25, 0.75);
  const lambdaHome = Number((expectedTotalGoals * homeShare).toFixed(3));
  const lambdaAway = Number((expectedTotalGoals * (1 - homeShare)).toFixed(3));

  const maxGoals = 6;
  const grid = [];
  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) {
      grid.push({ h, a, p: poisson(lambdaHome, h) * poisson(lambdaAway, a) });
    }
  }

  const pHome = grid.filter(x => x.h > x.a).reduce((s, x) => s + x.p, 0);
  const pDraw = grid.filter(x => x.h === x.a).reduce((s, x) => s + x.p, 0);
  const pAway = grid.filter(x => x.h < x.a).reduce((s, x) => s + x.p, 0);

  const bHome = 0.6 * nAiHome + 0.4 * pHome;
  const bDraw = 0.6 * nAiDraw + 0.4 * pDraw;
  const bAway = 0.6 * nAiAway + 0.4 * pAway;
  const norm = bHome + bDraw + bAway;

  const oneX2 = {
    home: Number((bHome / norm).toFixed(3)),
    draw: Number((bDraw / norm).toFixed(3)),
    away: Number((bAway / norm).toFixed(3)),
  };

  const pOver = (line) => Number(grid.filter(x => (x.h + x.a) > line).reduce((s, x) => s + x.p, 0).toFixed(3));
  const pBttsYes = Number(grid.filter(x => x.h > 0 && x.a > 0).reduce((s, x) => s + x.p, 0).toFixed(3));
  const pHomeOver = (line) => Number(grid.filter(x => x.h > line).reduce((s, x) => s + x.p, 0).toFixed(3));
  const pAwayOver = (line) => Number(grid.filter(x => x.a > line).reduce((s, x) => s + x.p, 0).toFixed(3));

  const exactScore = grid
    .sort((a, b) => b.p - a.p)
    .slice(0, 5)
    .map(x => ({ score: `${x.h}-${x.a}`, probability: Number(x.p.toFixed(3)) }));

  const markets = {
    match_result: oneX2,
    correct_score: exactScore,
    totals: {
      over_1_5: pOver(1.5), under_1_5: Number((1 - pOver(1.5)).toFixed(3)),
      over_2_5: pOver(2.5), under_2_5: Number((1 - pOver(2.5)).toFixed(3)),
      over_3_5: pOver(3.5), under_3_5: Number((1 - pOver(3.5)).toFixed(3)),
      over_4_5: pOver(4.5), under_4_5: Number((1 - pOver(4.5)).toFixed(3)),
    },
    btts: { yes: pBttsYes, no: Number((1 - pBttsYes).toFixed(3)) },
    home_team_goals: {
      over_0_5: pHomeOver(0.5), under_0_5: Number((1 - pHomeOver(0.5)).toFixed(3)),
      over_1_5: pHomeOver(1.5), under_1_5: Number((1 - pHomeOver(1.5)).toFixed(3)),
      over_2_5: pHomeOver(2.5), under_2_5: Number((1 - pHomeOver(2.5)).toFixed(3)),
      over_3_5: pHomeOver(3.5), under_3_5: Number((1 - pHomeOver(3.5)).toFixed(3)),
    },
    away_team_goals: {
      over_0_5: pAwayOver(0.5), under_0_5: Number((1 - pAwayOver(0.5)).toFixed(3)),
      over_1_5: pAwayOver(1.5), under_1_5: Number((1 - pAwayOver(1.5)).toFixed(3)),
      over_2_5: pAwayOver(2.5), under_2_5: Number((1 - pAwayOver(2.5)).toFixed(3)),
      over_3_5: pAwayOver(3.5), under_3_5: Number((1 - pAwayOver(3.5)).toFixed(3)),
    },
  };

  return {
    params: { lambda_home: lambdaHome, lambda_away: lambdaAway, expected_total_goals: Number(expectedTotalGoals.toFixed(2)) },
    markets,
  };
}

function findFixtureInCache(id) {
  for (const d of Object.keys(fixtureCache)) {
    const fixture = fixtureCache[d].fixtures.find(f => String(f.id) === String(id));
    if (fixture) return fixture;
  }
  return null;
}

async function getMatchAnalysisData(id) {
  const cached = db.getCachedAnalysis(id);
  if (cached) {
    let h2h = [], homeForm = [], awayForm = [], probs = {};
    try { h2h = JSON.parse(cached.h2h || '[]'); } catch (e) {}
    try { homeForm = JSON.parse(cached.home_form || '[]'); } catch (e) {}
    try { awayForm = JSON.parse(cached.away_form || '[]'); } catch (e) {}
    try { probs = JSON.parse(cached.probs || '{}'); } catch (e) {}
    return {
      id,
      home_team: cached.home_team,
      away_team: cached.away_team,
      league: cached.league,
      fixture_date: cached.fixture_date,
      analysis: cached.analysis,
      tip: cached.tip,
      market: cached.market,
      best_odds: cached.odds,
      edge_pct: cached.edge_pct,
      model_prob: cached.model_prob,
      confidence: cached.confidence,
      reasoning: cached.reasoning,
      risk: cached.risk,
      h2h,
      home_form: homeForm,
      away_form: awayForm,
      probs,
      odds: {},
      no_odds_tip: !cached.odds,
      has_value: !!(cached.odds && cached.edge_pct >= 3),
      snapshot_source: 'cache',
    };
  }

  const fixture = findFixtureInCache(id);
  if (!fixture) return null;

  const formData = await getFormAndH2H(fixture.homeTeam, fixture.awayTeam, fixture.league);
  const ai = await analyseWithAI(fixture, formData);
  const value = computeValue(ai, fixture.odds);

  const responseData = {
    id,
    home_team: fixture.homeTeam,
    away_team: fixture.awayTeam,
    home_logo: fixture.homeLogo,
    away_logo: fixture.awayLogo,
    league: fixture.league,
    fixture_date: fixture.date?.split(' ')[0],
    status: fixture.status,
    home_goals: fixture.homeGoals,
    away_goals: fixture.awayGoals,
    venue: fixture.venue,
    odds: fixture.odds,
    home_form: formData?.homeForm || [],
    away_form: formData?.awayForm || [],
    h2h: formData?.h2h || [],
    analysis: ai?.analysis || null,
    reasoning: ai?.reasoning || null,
    tip: ai?.tip || null,
    market: ai?.market || 'h2h',
    confidence: ai?.confidence || null,
    risk: ai?.risk || null,
    probs: ai?.probs || {},
    is_blind: ai?.is_blind || false,
    ...value,
    no_odds_tip: !!(ai?.tip && !value.best_odds),
    snapshot_source: 'live',
  };

  if (ai?.analysis) {
    db.cacheAnalysis({
      fixture_id: id,
      home_team: fixture.homeTeam,
      away_team: fixture.awayTeam,
      league: fixture.league,
      fixture_date: fixture.date?.split(' ')[0],
      analysis: ai.analysis,
      tip: ai.tip,
      market: ai.market,
      best_odds: value.best_odds,
      edge_pct: value.edge_pct,
      model_prob: value.model_prob,
      confidence: ai.confidence,
      reasoning: ai.reasoning,
      risk: ai.risk,
      h2h: JSON.stringify(formData?.h2h || []),
      home_form: JSON.stringify(formData?.homeForm || []),
      away_form: JSON.stringify(formData?.awayForm || []),
      probs: JSON.stringify(ai.probs || {}),
    });
  }

  return responseData;
}

// ─── LOAD FIXTURES FOR DATE (From Flashscore Local Registry) ──────────────
async function loadFixtures(date) {
  const cached = fixtureCache[date];
  if (cached && Date.now() - cached.fetchedAt < FIXTURE_TTL) return cached.fixtures;

  console.log(`[FIXTURES] Fetching ${date} from Local Flashscore Registry…`);
  
  let rawFixtures = [];
  if (localdb && typeof localdb.getFlashscoreFixtures === 'function') {
      rawFixtures = localdb.getFlashscoreFixtures(date);
  }

  if (!rawFixtures || rawFixtures.length === 0) {
    console.log(`[FIXTURES] No fixtures found in local DB for ${date}. (Did Apify sync run?)`);
  } else {
    console.log(`[FIXTURES] Got ${rawFixtures.length} matches from Flashscore database`);
  }

  const fixtures = rawFixtures.map(f => ({
    id: `fs-${f.match_id}`, 
    fsMatchId: f.match_id,
    league: f.league || f.category || 'Unknown',
    homeTeam: f.home_team,
    awayTeam: f.away_team,
    homeLogo: null, 
    awayLogo: null,
    homeId: f.home_id,
    awayId: f.away_id,
    date: f.match_date,
    status: f.status || 'NS',
    homeGoals: f.home_goals ?? null,
    awayGoals: f.away_goals ?? null,
    venue: null,
    slug: (f.league || '').toLowerCase().replace(/\s+/g, '-'),
    matchUrl: f.match_url 
  }));

  const enriched = [];
  for (const f of fixtures) {
    try {
      const odds = await fetchOdds(f.homeTeam, f.awayTeam);
      enriched.push({ ...f, odds: odds || {}, hasOdds: !!odds });
    } catch(e) { enriched.push({ ...f, odds: {}, hasOdds: false }); }
  }

  fixtureCache[date] = { fixtures: enriched, fetchedAt: Date.now() };
  return enriched;
}

// ─── ROUTES ───────────────────────────────────────────────────────────────
app.get('/api/fixtures', async (req, res) => {
  try { res.json({ fixtures: await loadFixtures(req.query.date || today()), date: req.query.date || today() }); } 
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Manual trigger for Apify ingestion
app.post('/api/sync-apify', async (req, res) => {
  try {
    if (localdb && typeof localdb.syncApifyFixtures === 'function') {
      await localdb.syncApifyFixtures();
      res.json({ ok: true, message: 'Apify sync completed successfully' });
    } else {
      res.status(500).json({ error: 'syncApifyFixtures is not available in localdb' });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/match/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const responseData = await getMatchAnalysisData(id);
    if (!responseData) return res.status(404).json({ error: 'Fixture not found. Sync database.' });
    res.json(responseData);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/predict/:id/markets', async (req, res) => {
  try {
    const id = req.params.id;
    const matchData = await getMatchAnalysisData(id);
    if (!matchData) return res.status(404).json({ error: 'Fixture not found. Sync database.' });

    const bundle = buildMarketPredictions(matchData);
    const snapshotBase = {
      fixture_id: id,
      home_team: matchData.home_team,
      away_team: matchData.away_team,
      league: matchData.league,
      fixture_date: matchData.fixture_date,
      confidence: matchData.confidence,
      source: matchData.snapshot_source || 'model',
    };

    db.savePredictionSnapshot(toSnapshot(snapshotBase, '1x2', 'home', bundle.markets.match_result.home, extractOddsForMarket(matchData.odds, '1x2', 'home'), bundle.params));
    db.savePredictionSnapshot(toSnapshot(snapshotBase, '1x2', 'draw', bundle.markets.match_result.draw, extractOddsForMarket(matchData.odds, '1x2', 'draw'), bundle.params));
    db.savePredictionSnapshot(toSnapshot(snapshotBase, '1x2', 'away', bundle.markets.match_result.away, extractOddsForMarket(matchData.odds, '1x2', 'away'), bundle.params));
    db.savePredictionSnapshot(toSnapshot(snapshotBase, 'btts', 'yes', bundle.markets.btts.yes, extractOddsForMarket(matchData.odds, 'btts', 'yes'), bundle.params));
    db.savePredictionSnapshot(toSnapshot(snapshotBase, 'btts', 'no', bundle.markets.btts.no, extractOddsForMarket(matchData.odds, 'btts', 'no'), bundle.params));
    db.savePredictionSnapshot(toSnapshot(snapshotBase, 'totals', 'over25', bundle.markets.totals.over_2_5, extractOddsForMarket(matchData.odds, 'totals', 'over25'), bundle.params));
    db.savePredictionSnapshot(toSnapshot(snapshotBase, 'totals', 'under25', bundle.markets.totals.under_2_5, extractOddsForMarket(matchData.odds, 'totals', 'under25'), bundle.params));

    res.json({
      fixture_id: id,
      fixture: `${matchData.home_team} vs ${matchData.away_team}`,
      league: matchData.league,
      fixture_date: matchData.fixture_date,
      model: 'hybrid-poisson-v1',
      ...bundle,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/predictions/snapshots', (req, res) => {
  try {
    const rows = db.getPredictionSnapshots({
      fixture_id: req.query.fixture_id,
      limit: req.query.limit,
    });
    res.json({ count: rows.length, snapshots: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/bet', (req, res) => {
  try {
    const bet = req.body;
    if (!bet.fixture_id || !bet.tip || !bet.odds) return res.status(400).json({ ok: false, reason: 'Missing required fields' });
    const result = db.placeBet(bet);
    if (!result) return res.json({ ok: false, reason: 'Insufficient bankroll or zero Kelly stake' });
    res.json({ ok: true, bet: result });
  } catch(e) { res.status(500).json({ ok: false, reason: e.message }); }
});

app.get('/api/bets', (req, res) => { try { res.json(db.getBets({ limit: parseInt(req.query.limit) || 50 })); } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/api/portfolio', (req, res) => { try { res.json(db.getStats()); } catch(e) { res.status(500).json({ error: e.message }); } });

// SETTLE logic updated to just check the Flashscore DB instead of FDORG!
app.post('/api/settle', async (req, res) => {
  try {
    const pending = db.getBets({ pending: true });
    let settled = 0;
    if (localdb && typeof localdb.getFlashscoreFixtures === 'function') {
      const rawFixtures = [...localdb.getFlashscoreFixtures(today())]; 
      
      for (const bet of pending) {
        const fsId = bet.fixture_id.toString().replace('fs-', '');
        const match = rawFixtures.find(f => f.match_id === fsId);
        if (match && (match.status === 'FT' || match.status === 'FINISHED')) {
            if (match.home_goals != null && match.away_goals != null) {
                settled += db.settleBet(bet.fixture_id, match.home_goals, match.away_goals);
            }
        }
      }
    }
    res.json({ settled });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/bankroll/reset', (req, res) => { try { db.resetBankroll(parseFloat(req.body.amount) || 1000); res.json({ ok: true, amount: parseFloat(req.body.amount) || 1000 }); } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/api/status', (req, res) => { try { const stats = db.getStats(); res.json({ hasAI: !!GROQ_KEY, hasBSD: !!process.env.BSD_API_KEY, bankroll: stats.bankroll, totalBets: stats.totalBets, version: VERSION }); } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/api/bsd-predictions', async (req, res) => { try { if (!process.env.BSD_API_KEY) return res.json({ ok: false, error: 'BSD_API_KEY not set', predictions: [] }); res.json({ ok: true, predictions: await bsd.getPredictions() }); } catch(e) { res.status(500).json({ ok: false, error: e.message, predictions: [] }); } });
app.post('/api/bsd-predictions/refresh', async (req, res) => { try { if (bsd && typeof bsd.updateCache === 'function') { bsd.updateCache(); } res.json({ ok: true }); } catch(e) { res.status(500).json({ ok: false, error: e.message }); } });

app.get('*', (req, res) => { res.sendFile(path.join(__dirname, '../public/index.html')); });

// ─── STARTUP ──────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`[PROPRED] v${VERSION} running on port ${PORT}`);
  
  if (localdb && typeof localdb.init === 'function') {
    localdb.init(); 
  } else {
    console.warn('[PROPRED] Warning: localdb.init is missing. Database will not sync automatically.');
  }

  if (process.env.BSD_API_KEY && bsd && typeof bsd.scheduleRefresh === 'function') {
    bsd.scheduleRefresh();
  }
  
  try {
    await loadFixtures(today());
    console.log('[PROPRED] Boot sequence complete.');
  } catch(e) {}
});
 
