const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');
const db      = require('./db');

const app  = express();
const PORT = process.env.PORT || 3000;

// API Keys
const AF_KEY    = process.env.API_FOOTBALL_KEY || 'dld7aaea599eb42ce6a723c2935ee70e';
const ODDS_KEY  = process.env.ODDS_API_KEY     || 'f40efeabae93fc096daa59c7e2ab6fc2';
const AI_KEY    = process.env.ANTHROPIC_KEY    || '';

const AF_BASE   = 'https://v3.football.api-sports.io';
const ODDS_BASE = 'https://api.the-odds-api.com/v4';

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── API-FOOTBALL HELPER ────────────────────────────────────────────────────
async function afFetch(endpoint) {
  const resp = await fetch(`${AF_BASE}${endpoint}`, {
    headers: { 'x-apisports-key': AF_KEY }
  });
  const data = await resp.json();
  console.log(`[AF] ${endpoint} → ${data.results} results`);
  return data.response || [];
}

// ── ODDS API HELPER ────────────────────────────────────────────────────────
const oddsCache = {};
async function getOdds(sportKey) {
  const now = Date.now();
  if(oddsCache[sportKey] && now-oddsCache[sportKey].ts < 30*60*1000)
    return oddsCache[sportKey].data;
  try {
    const resp = await fetch(
      `${ODDS_BASE}/sports/${sportKey}/odds?apiKey=${ODDS_KEY}&regions=uk&markets=h2h,totals&oddsFormat=decimal`
    );
    console.log(`[ODDS] ${sportKey} quota remaining: ${resp.headers.get('x-requests-remaining')}`);
    const data = await resp.json();
    oddsCache[sportKey] = { ts:now, data };
    return data;
  } catch(e) { return []; }
}

// Map API-Football league ID → Odds API sport key
const LEAGUE_ODDS_MAP = {
  39:  'soccer_epl',
  140: 'soccer_spain_la_liga',
  78:  'soccer_germany_bundesliga',
  135: 'soccer_italy_serie_a',
  61:  'soccer_france_ligue_one',
  2:   'soccer_uefa_champs_league',
  3:   'soccer_uefa_europa_league',
  40:  'soccer_efl_champ',
  88:  'soccer_netherlands_eredivisie',
  94:  'soccer_portugal_primeira_liga',
  179: 'soccer_scotland_premiership',
  203: 'soccer_turkey_super_league',
  144: 'soccer_belgium_first_div',
};

// ── CLAUDE AI ANALYSIS ─────────────────────────────────────────────────────
async function analyseWithAI(fixture, h2h, homeForm, awayForm, oddsMatch) {
  // Build context for Claude
  const homeTeam = fixture.teams.home.name;
  const awayTeam = fixture.teams.away.name;
  const league   = fixture.league.name;

  // Format H2H
  const h2hSummary = h2h.slice(0,5).map(m => {
    const hg = m.goals.home ?? '?', ag = m.goals.away ?? '?';
    const ht = m.teams.home.name, at = m.teams.away.name;
    return `${ht} ${hg}-${ag} ${at}`;
  }).join(' | ') || 'No H2H data';

  // Format form
  const fmtForm = (fixtures, teamId) => fixtures.slice(0,5).map(m => {
    const hg=m.goals?.home??0, ag=m.goals?.away??0;
    const isHome = m.teams.home.id===teamId;
    const gf=isHome?hg:ag, ga=isHome?ag:hg;
    const res = gf>ga?'W':gf<ga?'L':'D';
    return `${res}(${gf}-${ga})`;
  }).join(' ') || 'Unknown';

  const homeFormStr = fmtForm(homeForm, fixture.teams.home.id);
  const awayFormStr = fmtForm(awayForm, fixture.teams.away.id);

  // Format odds
  let oddsStr = 'No odds available';
  if(oddsMatch) {
    const bm = oddsMatch.bookmakers?.[0];
    const h2hMkt = bm?.markets?.find(m=>m.key==='h2h');
    const totMkt = bm?.markets?.find(m=>m.key==='totals');
    if(h2hMkt) {
      const outcomes = h2hMkt.outcomes;
      const homeOdds = outcomes?.find(o=>o.name===homeTeam)?.price;
      const drawOdds = outcomes?.find(o=>o.name==='Draw')?.price;
      const awayOdds = outcomes?.find(o=>o.name===awayTeam)?.price;
      oddsStr = `1X2: ${homeOdds||'?'} / ${drawOdds||'?'} / ${awayOdds||'?'}`;
    }
    if(totMkt) {
      const over25 = totMkt.outcomes?.find(o=>o.name==='Over'&&o.point===2.5)?.price;
      const under25 = totMkt.outcomes?.find(o=>o.name==='Under'&&o.point===2.5)?.price;
      if(over25) oddsStr += ` | O2.5: ${over25} U2.5: ${under25}`;
    }
  }

  const prompt = `You are a professional football betting analyst. Analyse this match and find the BEST VALUE bet.

MATCH: ${homeTeam} vs ${awayTeam} (${league})
H2H (last 5): ${h2hSummary}
${homeTeam} form (last 5): ${homeFormStr}
${awayTeam} form (last 5): ${awayFormStr}
Current odds: ${oddsStr}

Analyse the match and respond in this EXACT JSON format (no other text):
{
  "summary": "2-3 sentence sharp analysis mentioning key factors",
  "tip": "exact tip name e.g. 'Manchester City Win' or 'Over 2.5 Goals'",
  "market": "h2h or totals",
  "confidence": 65,
  "model_prob": 68,
  "reasoning": "1 sentence why this has value",
  "risk": "low|medium|high"
}

Only pick a tip if you genuinely see value. Confidence should reflect real probability (40-85% range only).`;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': AI_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await resp.json();
    const text = data.content?.[0]?.text || '';
    const clean = text.replace(/```json|```/g,'').trim();
    return JSON.parse(clean);
  } catch(e) {
    console.error('[AI] Failed:', e.message);
    return null;
  }
}

// Find odds match for a fixture
function matchOdds(oddsData, homeTeam, awayTeam) {
  if(!oddsData?.length) return null;
  const norm = s => (s||'').toLowerCase().replace(/[^a-z0-9]/g,' ').replace(/\s+/g,' ').trim();
  const hn = norm(homeTeam), an = norm(awayTeam);
  for(const m of oddsData) {
    const mhn=norm(m.home_team), man=norm(m.away_team);
    const hMatch = mhn===hn || mhn.includes(hn.split(' ')[0]) || hn.includes(mhn.split(' ')[0]);
    const aMatch = man===an || man.includes(an.split(' ')[0]) || an.includes(man.split(' ')[0]);
    if(hMatch && aMatch) return m;
  }
  return null;
}

// Get best odds + edge for a pick
function getBestOddsForTip(oddsMatch, tip, market, modelProb) {
  if(!oddsMatch) return null;
  let bestOdds = null;
  const tipL = (tip||'').toLowerCase();
  for(const bm of oddsMatch.bookmakers||[]) {
    const mkt = bm.markets?.find(m=>m.key===market);
    if(!mkt) continue;
    for(const o of mkt.outcomes||[]) {
      const nameL = (o.name||'').toLowerCase();
      // Match outcome name to tip
      const isMatch = market==='totals'
        ? (tipL.includes('over') && nameL==='over' && o.point===2.5) ||
          (tipL.includes('under') && nameL==='under' && o.point===2.5) ||
          (tipL.includes('over 1.5') && nameL==='over' && o.point===1.5) ||
          (tipL.includes('over 3.5') && nameL==='over' && o.point===3.5)
        : tipL.includes(nameL) || nameL.includes(tipL.split(' ')[0]);
      if(isMatch && o.price && (!bestOdds || o.price > bestOdds)) bestOdds = o.price;
    }
  }
  if(!bestOdds) return null;
  const implied = Math.round(1/bestOdds*100);
  const edge = modelProb - implied;
  return { odds: parseFloat(bestOdds.toFixed(2)), implied, edge, edgePct: Math.round(edge) };
}

// ── ROUTES ─────────────────────────────────────────────────────────────────

// GET /api/fixtures?date=YYYY-MM-DD
app.get('/api/fixtures', async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const fixtures = await afFetch(`/fixtures?date=${date}&timezone=Europe/London`);

    // Filter to leagues we care about
    const filtered = fixtures.filter(f => LEAGUE_ODDS_MAP[f.league.id] || f.league.country === 'England');

    // Fetch odds for relevant leagues
    const leagueIds = [...new Set(filtered.map(f=>f.league.id))];
    const sportKeys = [...new Set(leagueIds.map(id=>LEAGUE_ODDS_MAP[id]).filter(Boolean))];
    const allOdds   = (await Promise.all(sportKeys.map(getOdds))).flat();

    // Attach odds to each fixture
    const enriched = filtered.map(f => {
      const oddsMatch = matchOdds(allOdds, f.teams.home.name, f.teams.away.name);
      let homeOdds, drawOdds, awayOdds, over25, under25;
      if(oddsMatch) {
        const bm = oddsMatch.bookmakers?.[0];
        const h2hMkt = bm?.markets?.find(m=>m.key==='h2h');
        const totMkt = bm?.markets?.find(m=>m.key==='totals');
        if(h2hMkt) {
          homeOdds = h2hMkt.outcomes?.find(o=>o.name===f.teams.home.name)?.price;
          drawOdds = h2hMkt.outcomes?.find(o=>o.name==='Draw')?.price;
          awayOdds = h2hMkt.outcomes?.find(o=>o.name===f.teams.away.name)?.price;
        }
        if(totMkt) {
          over25  = totMkt.outcomes?.find(o=>o.name==='Over'  && o.point===2.5)?.price;
          under25 = totMkt.outcomes?.find(o=>o.name==='Under' && o.point===2.5)?.price;
        }
      }
      return {
        id:        f.fixture.id,
        date:      f.fixture.date,
        status:    f.fixture.status.short,
        homeTeam:  f.teams.home.name,
        awayTeam:  f.teams.away.name,
        homeLogo:  f.teams.home.logo,
        awayLogo:  f.teams.away.logo,
        homeGoals: f.goals.home,
        awayGoals: f.goals.away,
        league:    f.league.name,
        leagueId:  f.league.id,
        leagueLogo:f.league.logo,
        venue:     f.fixture.venue?.name,
        odds:      { home: homeOdds, draw: drawOdds, away: awayOdds, over25, under25 },
        hasOdds:   !!homeOdds,
      };
    });

    res.json({ date, fixtures: enriched, count: enriched.length });
  } catch(e) {
    console.error('[FIXTURES]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/match/:id — full match data + AI analysis
app.get('/api/match/:id', async (req, res) => {
  try {
    const fixtureId = req.params.id;

    // Check cache first
    const cached = db.getCachedAnalysis(fixtureId);
    if(cached) return res.json({ ...cached, fromCache: true });

    // Fetch fixture details
    const [fixtureData, h2hData] = await Promise.all([
      afFetch(`/fixtures?id=${fixtureId}`),
      afFetch(`/fixtures/headtohead?h2h=placeholder`), // placeholder - need team IDs
    ]);

    const fixture = fixtureData[0];
    if(!fixture) return res.status(404).json({ error: 'Fixture not found' });

    const homeId = fixture.teams.home.id;
    const awayId = fixture.teams.away.id;

    // Fetch H2H, home form, away form in parallel
    const [h2h, homeForm, awayForm] = await Promise.all([
      afFetch(`/fixtures/headtohead?h2h=${homeId}-${awayId}&last=10`),
      afFetch(`/fixtures?team=${homeId}&last=8`),
      afFetch(`/fixtures?team=${awayId}&last=8`),
    ]);

    // Get odds
    const sportKey = LEAGUE_ODDS_MAP[fixture.league.id];
    const oddsData = sportKey ? await getOdds(sportKey) : [];
    const oddsMatch = matchOdds(oddsData, fixture.teams.home.name, fixture.teams.away.name);

    // AI analysis (needs ANTHROPIC_KEY)
    let aiResult = null;
    if(AI_KEY) {
      aiResult = await analyseWithAI(fixture, h2h, homeForm, awayForm, oddsMatch);
    }

    // Get odds for the AI's pick
    let oddsInfo = null;
    if(aiResult?.tip && oddsMatch) {
      oddsInfo = getBestOddsForTip(oddsMatch, aiResult.tip, aiResult.market, aiResult.model_prob);
    }

    // Format home/away form
    const fmtFixtures = (fixtures, teamId) => fixtures.map(m => ({
      date:      m.fixture.date?.split('T')[0],
      homeTeam:  m.teams.home.name,
      awayTeam:  m.teams.away.name,
      homeGoals: m.goals.home,
      awayGoals: m.goals.away,
      isHome:    m.teams.home.id === teamId,
      result:    m.goals.home == null ? null :
                 m.teams.home.id===teamId ? (m.goals.home>m.goals.away?'W':m.goals.home<m.goals.away?'L':'D')
                                          : (m.goals.away>m.goals.home?'W':m.goals.away<m.goals.home?'L':'D'),
    }));

    const response = {
      fixture_id:   fixtureId,
      home_team:    fixture.teams.home.name,
      away_team:    fixture.teams.away.name,
      home_logo:    fixture.teams.home.logo,
      away_logo:    fixture.teams.away.logo,
      league:       fixture.league.name,
      league_logo:  fixture.league.logo,
      fixture_date: fixture.fixture.date?.split('T')[0],
      status:       fixture.fixture.status.short,
      venue:        fixture.fixture.venue?.name,
      h2h:          h2hData.slice(0,5).map(m=>({
        date:m.fixture.date?.split('T')[0],
        homeTeam:m.teams.home.name, awayTeam:m.teams.away.name,
        homeGoals:m.goals.home, awayGoals:m.goals.away
      })),
      home_form:    fmtFixtures(homeForm, homeId),
      away_form:    fmtFixtures(awayForm, awayId),
      odds: oddsMatch ? (() => {
        const bm=oddsMatch.bookmakers?.[0];
        const h2hMkt=bm?.markets?.find(m=>m.key==='h2h');
        const totMkt=bm?.markets?.find(m=>m.key==='totals');
        return {
          home:  h2hMkt?.outcomes?.find(o=>o.name===fixture.teams.home.name)?.price,
          draw:  h2hMkt?.outcomes?.find(o=>o.name==='Draw')?.price,
          away:  h2hMkt?.outcomes?.find(o=>o.name===fixture.teams.away.name)?.price,
          over25:totMkt?.outcomes?.find(o=>o.name==='Over'&&o.point===2.5)?.price,
          under25:totMkt?.outcomes?.find(o=>o.name==='Under'&&o.point===2.5)?.price,
        };
      })() : null,
      analysis:     aiResult?.summary || null,
      tip:          aiResult?.tip || null,
      market:       aiResult?.market || null,
      confidence:   aiResult?.confidence || null,
      model_prob:   aiResult?.model_prob || null,
      reasoning:    aiResult?.reasoning || null,
      risk:         aiResult?.risk || null,
      best_odds:    oddsInfo?.odds || null,
      implied_prob: oddsInfo?.implied || null,
      edge_pct:     oddsInfo?.edgePct || null,
      has_value:    (oddsInfo?.edgePct||0) >= 5,
    };

    // Cache result
    db.cacheAnalysis(response);

    res.json(response);
  } catch(e) {
    console.error('[MATCH]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/bet — place a paper bet
app.post('/api/bet', (req, res) => {
  try {
    const bet = db.placeBet(req.body);
    if(!bet) return res.json({ ok:false, reason:'Insufficient bankroll or no edge' });
    res.json({ ok:true, bet });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// POST /api/settle — settle finished bets
app.post('/api/settle', async (req, res) => {
  try {
    const pending = db.getBets({ pending:true });
    let settled=0;
    for(const bet of pending) {
      const data = await afFetch(`/fixtures?id=${bet.fixture_id}`);
      const f = data[0];
      if(!f) continue;
      const status = f.fixture.status.short;
      if(!['FT','AET','PEN'].includes(status)) continue;
      const hG = f.goals.home, aG = f.goals.away;
      if(hG==null||aG==null) continue;
      settled += db.settleBet(bet.fixture_id, hG, aG);
    }
    res.json({ ok:true, settled, checked:pending.length });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// GET /api/portfolio
app.get('/api/portfolio', (req, res) => {
  try { res.json(db.getStats()); }
  catch(e) { res.status(500).json({ error:e.message }); }
});

// GET /api/bets
app.get('/api/bets', (req, res) => {
  try { res.json(db.getBets({ limit: parseInt(req.query.limit)||50 })); }
  catch(e) { res.status(500).json({ error:e.message }); }
});

// POST /api/bankroll/reset
app.post('/api/bankroll/reset', (req, res) => {
  try {
    const amount = req.body.amount || 1000;
    db.resetBankroll(amount);
    res.json({ ok:true, bankroll:amount });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// GET /api/status
app.get('/api/status', (req, res) => {
  const stats = db.getStats();
  res.json({
    status: 'ok', version:'2.0',
    hasAI: !!AI_KEY,
    bankroll: stats.bankroll,
    totalBets: stats.totalBets,
    winRate: stats.winRate,
  });
});

// SPA fallback — all non-api routes serve index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Auto-settle on startup
app.listen(PORT, () => {
  console.log(`PROPRED v2 on port ${PORT} | AI: ${AI_KEY?'✅':'❌ (set ANTHROPIC_KEY)'}`);
  setTimeout(()=>{
    fetch(`http://localhost:${PORT}/api/settle`,{method:'POST'})
      .then(r=>r.json()).then(d=>console.log('[STARTUP] Settled:',d.settled))
      .catch(()=>{});
  }, 2000);
});
