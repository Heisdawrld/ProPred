'use strict';

const express  = require('express');
const fetch    = require('node-fetch');
const path     = require('path');
const db       = require('./db');

const app  = express();
const PORT = process.env.PORT || 10000;
const AI_KEY       = (process.env.ANTHROPIC_KEY || '').trim();
const GEMINI_KEY   = (process.env.GEMINI_KEY || '').trim();
const GROQ_KEY     = (process.env.GROQ_KEY || '').trim();
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
          leagueSlug: slug,
          leagueLogo: `https://a.espncdn.com/i/leaguelogos/soccer/500/${slug}.png`,
          date:       comp.date,
          homeTeam:   home.team.displayName,
          awayTeam:   away.team.displayName,
          homeEspnId: home.team.id,
          awayEspnId: away.team.id,
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
async function analyseWithAI(homeTeam, awayTeam, league, odds, h2h=[], homeForm=[], awayForm=[]) {
  const oddsStr = odds?.home
    ? `Home Win: ${odds.home} | Draw: ${odds.draw} | Away Win: ${odds.away}${odds.over25 ? ` | Over 2.5: ${odds.over25} | Under 2.5: ${odds.under25}` : ''}`
    : 'No odds available';

  const fmtH2H = h2h.slice(0,5).map(m=>`${m.homeTeam} ${m.homeGoals??'?'}-${m.awayGoals??'?'} ${m.awayTeam} (${m.date||''})`).join(' | ') || 'No data';

  const fmtForm = (form, name) => {
    if (!form || !form.length) return 'No data';
    return form.slice(0,5).map(f => {
      const loc = f.isHome ? 'H' : 'A';
      const opp = f.isHome ? f.awayTeam : f.homeTeam;
      return `${f.result||'?'}(${loc} vs ${opp} ${f.homeGoals??'?'}-${f.awayGoals??'?'})`;
    }).join(' | ');
  };

  // Work out goal stats from form
  const goalStats = (form) => {
    if (!form || form.length < 2) return null;
    const scored = form.map(f => f.isHome ? (f.homeGoals||0) : (f.awayGoals||0));
    const conceded = form.map(f => f.isHome ? (f.awayGoals||0) : (f.homeGoals||0));
    const avg_scored = (scored.reduce((a,b)=>a+b,0)/scored.length).toFixed(1);
    const avg_conceded = (conceded.reduce((a,b)=>a+b,0)/conceded.length).toFixed(1);
    const btts_count = form.filter(f => (f.homeGoals||0)>0 && (f.awayGoals||0)>0).length;
    const over25_count = form.filter(f => (f.homeGoals||0)+(f.awayGoals||0)>2).length;
    return { avg_scored, avg_conceded, btts_count, over25_count, total: form.length };
  };

  const hStats = goalStats(homeForm);
  const aStats = goalStats(awayForm);
  const statsStr = (hStats && aStats)
    ? `${homeTeam} stats (last ${hStats.total}): avg scored ${hStats.avg_scored} avg conceded ${hStats.avg_conceded} BTTS in ${hStats.btts_count}/${hStats.total} over2.5 in ${hStats.over25_count}/${hStats.total} | ${awayTeam} stats (last ${aStats.total}): avg scored ${aStats.avg_scored} avg conceded ${aStats.avg_conceded} BTTS in ${aStats.btts_count}/${aStats.total} over2.5 in ${aStats.over25_count}/${aStats.total}`
    : 'No stats available';

  const prompt = `You are an expert football betting analyst with deep knowledge of European football. Your job is to find the SAFEST, highest-value bet for this match - not the most exciting one.

MATCH: ${homeTeam} vs ${awayTeam} (${league})
DATE: Today

BOOKMAKER ODDS:
${oddsStr}

RECENT FORM:
${homeTeam} last 5: ${fmtForm(homeForm, homeTeam)}
${awayTeam} last 5: ${fmtForm(awayForm, awayTeam)}

GOAL STATISTICS:
${statsStr}

HEAD TO HEAD (last 5):
${fmtH2H}

AVAILABLE MARKETS TO CHOOSE FROM (pick the single safest bet):
1. "${homeTeam} Win" - use if home team is strong favourite with good form
2. "Draw" - use ONLY if both teams are very evenly matched AND odds are genuinely attractive
3. "${awayTeam} Win" - use if away team has significantly better form/quality
4. "Over 1.5 Goals" - very safe, use when both teams score regularly
5. "Over 2.5 Goals" - use when both teams average 1.5+ goals and have high-scoring h2h
6. "Under 2.5 Goals" - use when both defences are strong or matches tend to be low-scoring
7. "Both Teams to Score" - use when both teams have scored in 3+ of last 5 AND conceded regularly
8. "Both Teams NOT to Score" - use when either team has a strong defence or scores rarely
9. "${homeTeam} or Draw" - double chance, use when home team is likely but not certain to win
10. "${awayTeam} or Draw" - double chance, use when away team is likely but not certain to win

INSTRUCTIONS:
- Use your knowledge of these teams and their typical playing styles
- Consider home advantage seriously - home teams win ~46% of matches
- BTTS is usually the safest bet when both teams have scored in 4/5 recent games
- Over 1.5 Goals happens in ~75% of matches - consider it when odds are decent
- DO NOT pick Draw just because you are uncertain - that is lazy
- Pick the market where you have the most conviction based on the data
- confidence: how sure you are (50-80)
- model_prob: your estimated probability this bet wins (50-80)
- risk: "low" for goals markets and double chance, "medium" for 1X2, "high" for unlikely outcomes

Respond with ONLY valid JSON. No markdown. No extra text.
{"summary":"3 sentence analysis using the actual form data and goal stats","tip":"EXACT tip from the numbered list above","market":"h2h or totals or btts or dc","confidence":68,"model_prob":72,"reasoning":"specific data-backed reason: e.g. both teams scored in 4/5 recent games and h2h averages 3.1 goals","risk":"low"}`;

  // Try Groq first (free, no credit card)
  if (GROQ_KEY) {
    console.log('[AI] Calling Groq...');
    try {
      const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: 'You are an expert football betting analyst. You have deep knowledge of Premier League, La Liga, Bundesliga, Serie A and other European leagues. You know each team\'s playing style, typical formations, attacking and defensive tendencies. Always respond with valid JSON only.' },
            { role: 'user', content: prompt }
          ],
          max_tokens: 600, temperature: 0.4,
        }),
      });
      const data = await resp.json();
      console.log('[AI] Groq status:', resp.status, '| Body:', JSON.stringify(data).slice(0, 300));
      if (resp.status !== 200) { console.error('[AI] Groq error:', data); }
      else {
        const text = (data.choices?.[0]?.message?.content || '').trim();
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          console.log('[AI] Groq success:', parsed.tip);
          return parsed;
        }
      }
    } catch(e) { console.error('[AI] Groq exception:', e.message); }
  }

  // Try Gemini
  if (GEMINI_KEY) {
    console.log('[AI] Calling Gemini...');
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_KEY}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 512 } }),
      });
      const data = await resp.json();
      console.log('[AI] Gemini status:', resp.status);
      if (resp.status === 200) {
        const text = (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) { const parsed = JSON.parse(jsonMatch[0]); console.log('[AI] Gemini success:', parsed.tip); return parsed; }
      }
    } catch(e) { console.error('[AI] Gemini exception:', e.message); }
  }

  // Try Claude
  if (AI_KEY) {
    console.log('[AI] Calling Claude...');
    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': AI_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 512, messages: [{ role: 'user', content: prompt }] }),
      });
      const data = await resp.json();
      console.log('[AI] Claude status:', resp.status);
      if (resp.status === 200) {
        const text = (data.content?.[0]?.text || '').trim();
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) { const parsed = JSON.parse(jsonMatch[0]); console.log('[AI] Claude success:', parsed.tip); return parsed; }
      }
    } catch(e) { console.error('[AI] Claude exception:', e.message); }
  }

  console.log('[AI] All providers failed');
  return null;
}


// ── ESPN FORM + H2H ──────────────────────────────────────────────────────────
// Uses ESPN team schedule endpoint to get last 5 results for each team
async function getFormAndH2H(homeTeam, awayTeam, homeEspnId, awayEspnId, leagueSlug) {
  if (!homeEspnId || !awayEspnId || !leagueSlug) return { h2h: [], homeForm: [], awayForm: [] };
  try {
    const [hRes, aRes] = await Promise.all([
      fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${leagueSlug}/teams/${homeEspnId}/schedule`),
      fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${leagueSlug}/teams/${awayEspnId}/schedule`),
    ]);
    const hData = await hRes.json();
    const aData = await aRes.json();

    const parseForm = (data, teamId) => {
      const events = (data.events || []).filter(ev => {
        const comp = ev.competitions?.[0];
        const status = comp?.status?.type?.completed;
        return status === true;
      });
      return events.slice(-6).reverse().slice(0,5).map(ev => {
        const comp = ev.competitions[0];
        const home = comp.competitors.find(c => c.homeAway === 'home');
        const away = comp.competitors.find(c => c.homeAway === 'away');
        const isHome = home?.team?.id === String(teamId);
        const hG = home?.score != null ? parseInt(home.score) : null;
        const aG = away?.score != null ? parseInt(away.score) : null;
        const gf = isHome ? hG : aG;
        const ga = isHome ? aG : hG;
        const result = gf == null ? null : gf > ga ? 'W' : gf < ga ? 'L' : 'D';
        return {
          date: comp.date?.split('T')[0],
          homeTeam: home?.team?.displayName,
          awayTeam: away?.team?.displayName,
          homeGoals: hG, awayGoals: aG,
          isHome, result,
        };
      });
    };

    const homeForm = parseForm(hData, homeEspnId);
    const awayForm = parseForm(aData, awayEspnId);

    // H2H: find matches where both teams played each other
    const allHomeEvents = (hData.events || []).filter(ev => ev.competitions?.[0]?.status?.type?.completed);
    const h2h = allHomeEvents.filter(ev => {
      const comp = ev.competitions[0];
      return comp.competitors.some(c => c.team?.id === String(awayEspnId));
    }).slice(-5).map(ev => {
      const comp = ev.competitions[0];
      const home = comp.competitors.find(c => c.homeAway === 'home');
      const away = comp.competitors.find(c => c.homeAway === 'away');
      return {
        date: comp.date?.split('T')[0],
        homeTeam: home?.team?.displayName,
        awayTeam: away?.team?.displayName,
        homeGoals: home?.score != null ? parseInt(home.score) : null,
        awayGoals: away?.score != null ? parseInt(away.score) : null,
      };
    });

    console.log(`[FORM] ${homeTeam}: ${homeForm.length} results | ${awayTeam}: ${awayForm.length} results | H2H: ${h2h.length}`);
    return { h2h, homeForm, awayForm };
  } catch(e) {
    console.error('[FORM] Error:', e.message);
    return { h2h: [], homeForm: [], awayForm: [] };
  }
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

  // Fetch form + H2H
  const { h2h, homeForm, awayForm } = await getFormAndH2H(fixture.homeTeam, fixture.awayTeam, fixture.homeEspnId, fixture.awayEspnId, fixture.leagueSlug);
  console.log('[MATCH] Running fresh AI for:', fixture.homeTeam, 'vs', fixture.awayTeam, '| H2H:', h2h.length, 'homeForm:', homeForm.length);
  const ai = await analyseWithAI(fixture.homeTeam, fixture.awayTeam, fixture.league, fixture.odds, h2h, homeForm, awayForm);

  const odds = fixture.odds || {};
  const modelProb = ai?.model_prob || 50;

  // Pick best odds based on the AI's chosen tip
  const getBestOdds = (tip, odds, homeTeam, awayTeam) => {
    const t = (tip || '').toLowerCase();
    const h = homeTeam.toLowerCase();
    const a = awayTeam.toLowerCase();
    if (t.includes('over 2.5')) return { odds: odds.over25, label: 'Over 2.5' };
    if (t.includes('under 2.5')) return { odds: odds.under25, label: 'Under 2.5' };
    if (t.includes('over 1.5')) return { odds: odds.over25 ? parseFloat((odds.over25 * 0.62).toFixed(2)) : null, label: 'Over 1.5' };
    if (t.includes('both teams to score') && !t.includes('not')) {
      return { odds: odds.over25 ? parseFloat((odds.over25 * 0.88).toFixed(2)) : null, label: 'BTTS Yes' };
    }
    if (t.includes('both teams not')) {
      return { odds: odds.under25 ? parseFloat((odds.under25 * 0.88).toFixed(2)) : null, label: 'BTTS No' };
    }
    if (t.includes(' or draw')) {
      if (t.includes(h.split(' ')[0]) || t.startsWith(h.split(' ')[0])) {
        const dc = (odds.home && odds.draw) ? parseFloat((1/(1/odds.home + 1/odds.draw)).toFixed(2)) : null;
        return { odds: dc, label: homeTeam + ' or Draw' };
      }
      if (t.includes(a.split(' ')[0]) || t.includes(a.split(' ').pop())) {
        const dc = (odds.away && odds.draw) ? parseFloat((1/(1/odds.away + 1/odds.draw)).toFixed(2)) : null;
        return { odds: dc, label: awayTeam + ' or Draw' };
      }
    }
    if (t.includes('draw')) return { odds: odds.draw, label: 'Draw' };
    // Check home team name words
    const homeWords = h.split(' ');
    if (homeWords.some(w => w.length > 2 && t.includes(w))) return { odds: odds.home, label: homeTeam + ' Win' };
    // Check away team name words
    const awayWords = a.split(' ');
    if (awayWords.some(w => w.length > 2 && t.includes(w))) return { odds: odds.away, label: awayTeam + ' Win' };
    return { odds: odds.home, label: homeTeam + ' Win' };
  };

  const { odds: bestOdds, label: betLabel } = getBestOdds(ai?.tip, odds, fixture.homeTeam, fixture.awayTeam);
  const impliedProb = bestOdds ? Math.round(100 / bestOdds) : null;
  const edgePct = impliedProb != null ? modelProb - impliedProb : null;

  if (ai?.summary) {
    db.cacheAnalysis({
      fixture_id: id, home_team: fixture.homeTeam, away_team: fixture.awayTeam,
      league: fixture.league, fixture_date: (fixture.date||'').split('T')[0],
      analysis: ai.summary, tip: ai.tip || '', market: ai.market || 'h2h',
      best_odds: bestOdds || null, edge_pct: edgePct, model_prob: modelProb,
      confidence: ai.confidence, reasoning: ai.reasoning, risk: ai.risk,
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
    best_odds:  bestOdds       || null,
    bet_label:  betLabel       || null,
    implied_prob: impliedProb,
    edge_pct:   edgePct,
    has_value:  edgePct != null && edgePct >= 2,
    h2h, home_form: homeForm, away_form: awayForm,
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
