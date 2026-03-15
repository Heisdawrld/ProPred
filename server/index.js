 (cd "$(git rev-parse --show-toplevel)" && git apply --3way <<'EOF' 
diff --git a/server/index.js b/server/index.js
index 3cf66dd8f6d8ecb9aa88380616bc50830723c369..e53743449c4c05dacdabb145f5d5e5ae64585593 100644
--- a/server/index.js
+++ b/server/index.js
@@ -245,50 +245,278 @@ function computeValue(ai, odds) {
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
 
+function clamp(n, min, max) {
+  return Math.max(min, Math.min(max, n));
+}
+
+function poisson(lambda, k) {
+  const fact = (n) => {
+    let out = 1;
+    for (let i = 2; i <= n; i++) out *= i;
+    return out;
+  };
+  return (Math.exp(-lambda) * Math.pow(lambda, k)) / fact(k);
+}
+
+function extractOddsForMarket(odds, market, selection) {
+  if (!odds) return null;
+  if (market === '1x2') return odds[selection] || null;
+  if (market === 'btts') return selection === 'yes' ? odds.bttsYes || null : odds.bttsNo || null;
+  if (market === 'totals') return odds[selection] || null;
+  return null;
+}
+
+function toSnapshot(base, market, selection, probability, odds, payload) {
+  const implied = odds && odds > 1 ? (100 / odds) : null;
+  const edge = implied != null ? (probability * 100) - implied : null;
+  return {
+    fixture_id: base.fixture_id,
+    home_team: base.home_team,
+    away_team: base.away_team,
+    league: base.league,
+    fixture_date: base.fixture_date,
+    market,
+    selection,
+    probability: Number((probability * 100).toFixed(1)),
+    confidence: base.confidence,
+    odds,
+    implied_prob: implied != null ? Number(implied.toFixed(1)) : null,
+    edge_pct: edge != null ? Number(edge.toFixed(1)) : null,
+    source: base.source || 'model',
+    payload_json: payload,
+  };
+}
+
+function buildMarketPredictions(matchData) {
+  const probs = matchData.probs || {};
+  const odds = matchData.odds || {};
+
+  const aiHome = (probs.home_win ?? 0) / 100;
+  const aiDraw = (probs.draw ?? 0) / 100;
+  const aiAway = (probs.away_win ?? 0) / 100;
+  const aiTotal = aiHome + aiDraw + aiAway;
+  const nAiHome = aiTotal > 0 ? aiHome / aiTotal : 0.4;
+  const nAiDraw = aiTotal > 0 ? aiDraw / aiTotal : 0.28;
+  const nAiAway = aiTotal > 0 ? aiAway / aiTotal : 0.32;
+
+  const over25Seed = clamp((probs.over25 ?? 55) / 100, 0.1, 0.9);
+  const expectedTotalGoals = clamp(1.6 + over25Seed * 2.2, 1.2, 4.2);
+  const homeBias = clamp((nAiHome - nAiAway) * 0.35, -0.2, 0.2);
+  const homeShare = clamp(0.5 + homeBias, 0.25, 0.75);
+  const lambdaHome = Number((expectedTotalGoals * homeShare).toFixed(3));
+  const lambdaAway = Number((expectedTotalGoals * (1 - homeShare)).toFixed(3));
+
+  const maxGoals = 6;
+  const grid = [];
+  for (let h = 0; h <= maxGoals; h++) {
+    for (let a = 0; a <= maxGoals; a++) {
+      grid.push({ h, a, p: poisson(lambdaHome, h) * poisson(lambdaAway, a) });
+    }
+  }
+
+  const pHome = grid.filter(x => x.h > x.a).reduce((s, x) => s + x.p, 0);
+  const pDraw = grid.filter(x => x.h === x.a).reduce((s, x) => s + x.p, 0);
+  const pAway = grid.filter(x => x.h < x.a).reduce((s, x) => s + x.p, 0);
+
+  const bHome = 0.6 * nAiHome + 0.4 * pHome;
+  const bDraw = 0.6 * nAiDraw + 0.4 * pDraw;
+  const bAway = 0.6 * nAiAway + 0.4 * pAway;
+  const norm = bHome + bDraw + bAway;
+
+  const oneX2 = {
+    home: Number((bHome / norm).toFixed(3)),
+    draw: Number((bDraw / norm).toFixed(3)),
+    away: Number((bAway / norm).toFixed(3)),
+  };
+
+  const pOver = (line) => Number(grid.filter(x => (x.h + x.a) > line).reduce((s, x) => s + x.p, 0).toFixed(3));
+  const pBttsYes = Number(grid.filter(x => x.h > 0 && x.a > 0).reduce((s, x) => s + x.p, 0).toFixed(3));
+  const pHomeOver = (line) => Number(grid.filter(x => x.h > line).reduce((s, x) => s + x.p, 0).toFixed(3));
+  const pAwayOver = (line) => Number(grid.filter(x => x.a > line).reduce((s, x) => s + x.p, 0).toFixed(3));
+
+  const exactScore = grid
+    .sort((a, b) => b.p - a.p)
+    .slice(0, 5)
+    .map(x => ({ score: `${x.h}-${x.a}`, probability: Number(x.p.toFixed(3)) }));
+
+  const markets = {
+    match_result: oneX2,
+    correct_score: exactScore,
+    totals: {
+      over_1_5: pOver(1.5), under_1_5: Number((1 - pOver(1.5)).toFixed(3)),
+      over_2_5: pOver(2.5), under_2_5: Number((1 - pOver(2.5)).toFixed(3)),
+      over_3_5: pOver(3.5), under_3_5: Number((1 - pOver(3.5)).toFixed(3)),
+      over_4_5: pOver(4.5), under_4_5: Number((1 - pOver(4.5)).toFixed(3)),
+    },
+    btts: { yes: pBttsYes, no: Number((1 - pBttsYes).toFixed(3)) },
+    home_team_goals: {
+      over_0_5: pHomeOver(0.5), under_0_5: Number((1 - pHomeOver(0.5)).toFixed(3)),
+      over_1_5: pHomeOver(1.5), under_1_5: Number((1 - pHomeOver(1.5)).toFixed(3)),
+      over_2_5: pHomeOver(2.5), under_2_5: Number((1 - pHomeOver(2.5)).toFixed(3)),
+      over_3_5: pHomeOver(3.5), under_3_5: Number((1 - pHomeOver(3.5)).toFixed(3)),
+    },
+    away_team_goals: {
+      over_0_5: pAwayOver(0.5), under_0_5: Number((1 - pAwayOver(0.5)).toFixed(3)),
+      over_1_5: pAwayOver(1.5), under_1_5: Number((1 - pAwayOver(1.5)).toFixed(3)),
+      over_2_5: pAwayOver(2.5), under_2_5: Number((1 - pAwayOver(2.5)).toFixed(3)),
+      over_3_5: pAwayOver(3.5), under_3_5: Number((1 - pAwayOver(3.5)).toFixed(3)),
+    },
+  };
+
+  return {
+    params: { lambda_home: lambdaHome, lambda_away: lambdaAway, expected_total_goals: Number(expectedTotalGoals.toFixed(2)) },
+    markets,
+  };
+}
+
+function findFixtureInCache(id) {
+  for (const d of Object.keys(fixtureCache)) {
+    const fixture = fixtureCache[d].fixtures.find(f => String(f.id) === String(id));
+    if (fixture) return fixture;
+  }
+  return null;
+}
+
+async function getMatchAnalysisData(id) {
+  const cached = db.getCachedAnalysis(id);
+  if (cached) {
+    let h2h = [], homeForm = [], awayForm = [], probs = {};
+    try { h2h = JSON.parse(cached.h2h || '[]'); } catch (e) {}
+    try { homeForm = JSON.parse(cached.home_form || '[]'); } catch (e) {}
+    try { awayForm = JSON.parse(cached.away_form || '[]'); } catch (e) {}
+    try { probs = JSON.parse(cached.probs || '{}'); } catch (e) {}
+    return {
+      id,
+      home_team: cached.home_team,
+      away_team: cached.away_team,
+      league: cached.league,
+      fixture_date: cached.fixture_date,
+      analysis: cached.analysis,
+      tip: cached.tip,
+      market: cached.market,
+      best_odds: cached.odds,
+      edge_pct: cached.edge_pct,
+      model_prob: cached.model_prob,
+      confidence: cached.confidence,
+      reasoning: cached.reasoning,
+      risk: cached.risk,
+      h2h,
+      home_form: homeForm,
+      away_form: awayForm,
+      probs,
+      odds: {},
+      no_odds_tip: !cached.odds,
+      has_value: !!(cached.odds && cached.edge_pct >= 3),
+      snapshot_source: 'cache',
+    };
+  }
+
+  const fixture = findFixtureInCache(id);
+  if (!fixture) return null;
+
+  const formData = await getFormAndH2H(fixture.homeTeam, fixture.awayTeam, fixture.league);
+  const ai = await analyseWithAI(fixture, formData);
+  const value = computeValue(ai, fixture.odds);
+
+  const responseData = {
+    id,
+    home_team: fixture.homeTeam,
+    away_team: fixture.awayTeam,
+    home_logo: fixture.homeLogo,
+    away_logo: fixture.awayLogo,
+    league: fixture.league,
+    fixture_date: fixture.date?.split(' ')[0],
+    status: fixture.status,
+    home_goals: fixture.homeGoals,
+    away_goals: fixture.awayGoals,
+    venue: fixture.venue,
+    odds: fixture.odds,
+    home_form: formData?.homeForm || [],
+    away_form: formData?.awayForm || [],
+    h2h: formData?.h2h || [],
+    analysis: ai?.analysis || null,
+    reasoning: ai?.reasoning || null,
+    tip: ai?.tip || null,
+    market: ai?.market || 'h2h',
+    confidence: ai?.confidence || null,
+    risk: ai?.risk || null,
+    probs: ai?.probs || {},
+    is_blind: ai?.is_blind || false,
+    ...value,
+    no_odds_tip: !!(ai?.tip && !value.best_odds),
+    snapshot_source: 'live',
+  };
+
+  if (ai?.analysis) {
+    db.cacheAnalysis({
+      fixture_id: id,
+      home_team: fixture.homeTeam,
+      away_team: fixture.awayTeam,
+      league: fixture.league,
+      fixture_date: fixture.date?.split(' ')[0],
+      analysis: ai.analysis,
+      tip: ai.tip,
+      market: ai.market,
+      best_odds: value.best_odds,
+      edge_pct: value.edge_pct,
+      model_prob: value.model_prob,
+      confidence: ai.confidence,
+      reasoning: ai.reasoning,
+      risk: ai.risk,
+      h2h: JSON.stringify(formData?.h2h || []),
+      home_form: JSON.stringify(formData?.homeForm || []),
+      away_form: JSON.stringify(formData?.awayForm || []),
+      probs: JSON.stringify(ai.probs || {}),
+    });
+  }
+
+  return responseData;
+}
+
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
@@ -315,87 +543,104 @@ async function loadFixtures(date) {
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
-    const cached = db.getCachedAnalysis(id);
-    if (cached) {
-      let h2h = [], homeForm = [], awayForm = [], probs = {};
-      try { h2h = JSON.parse(cached.h2h || '[]'); } catch(e) {}
-      try { homeForm = JSON.parse(cached.home_form || '[]'); } catch(e) {}
-      try { awayForm = JSON.parse(cached.away_form || '[]'); } catch(e) {}
-      try { probs = JSON.parse(cached.probs || '{}'); } catch(e) {}
-      return res.json({ id, ...cached, home_team: cached.home_team, away_team: cached.away_team, league: cached.league, fixture_date: cached.fixture_date, analysis: cached.analysis, tip: cached.tip, market: cached.market, best_odds: cached.odds, edge_pct: cached.edge_pct, model_prob: cached.model_prob, confidence: cached.confidence, reasoning: cached.reasoning, risk: cached.risk, h2h, home_form: homeForm, away_form: awayForm, probs, has_value: !!(cached.odds && cached.edge_pct >= 3), no_odds_tip: !cached.odds });
-    }
-
-    let fixture = null;
-    for (const d of Object.keys(fixtureCache)) {
-      fixture = fixtureCache[d].fixtures.find(f => String(f.id) === String(id));
-      if (fixture) break;
-    }
-    if (!fixture) return res.status(404).json({ error: 'Fixture not found. Sync database.' });
-
-    const formData = await getFormAndH2H(fixture.homeTeam, fixture.awayTeam, fixture.league);
-    const ai = await analyseWithAI(fixture, formData);
-    const value = computeValue(ai, fixture.odds);
+    const responseData = await getMatchAnalysisData(id);
+    if (!responseData) return res.status(404).json({ error: 'Fixture not found. Sync database.' });
+    res.json(responseData);
+  } catch(e) { res.status(500).json({ error: e.message }); }
+});
 
-    const responseData = {
-      id, home_team: fixture.homeTeam, away_team: fixture.awayTeam, home_logo: fixture.homeLogo, away_logo: fixture.awayLogo,
-      league: fixture.league, fixture_date: fixture.date?.split(' ')[0], status: fixture.status, home_goals: fixture.homeGoals, away_goals: fixture.awayGoals, venue: fixture.venue, odds: fixture.odds,
-      home_form: formData?.homeForm || [], away_form: formData?.awayForm || [], h2h: formData?.h2h || [],
-      analysis: ai?.analysis || null, reasoning: ai?.reasoning || null, tip: ai?.tip || null, market: ai?.market || 'h2h', confidence: ai?.confidence || null, risk: ai?.risk || null, probs: ai?.probs || {}, is_blind: ai?.is_blind || false, ...value, no_odds_tip: !!(ai?.tip && !value.best_odds),
+app.get('/api/predict/:id/markets', async (req, res) => {
+  try {
+    const id = req.params.id;
+    const matchData = await getMatchAnalysisData(id);
+    if (!matchData) return res.status(404).json({ error: 'Fixture not found. Sync database.' });
+
+    const bundle = buildMarketPredictions(matchData);
+    const snapshotBase = {
+      fixture_id: id,
+      home_team: matchData.home_team,
+      away_team: matchData.away_team,
+      league: matchData.league,
+      fixture_date: matchData.fixture_date,
+      confidence: matchData.confidence,
+      source: matchData.snapshot_source || 'model',
     };
 
-    if (ai?.analysis) {
-      db.cacheAnalysis({
-        fixture_id: id, home_team: fixture.homeTeam, away_team: fixture.awayTeam, league: fixture.league, fixture_date: fixture.date?.split(' ')[0],
-        analysis: ai.analysis, tip: ai.tip, market: ai.market, best_odds: value.best_odds, edge_pct: value.edge_pct, model_prob: value.model_prob, confidence: ai.confidence, reasoning: ai.reasoning, risk: ai.risk, h2h: JSON.stringify(formData?.h2h || []), home_form: JSON.stringify(formData?.homeForm || []), away_form: JSON.stringify(formData?.awayForm || []), probs: JSON.stringify(ai.probs || {}),
-      });
-    }
+    db.savePredictionSnapshot(toSnapshot(snapshotBase, '1x2', 'home', bundle.markets.match_result.home, extractOddsForMarket(matchData.odds, '1x2', 'home'), bundle.params));
+    db.savePredictionSnapshot(toSnapshot(snapshotBase, '1x2', 'draw', bundle.markets.match_result.draw, extractOddsForMarket(matchData.odds, '1x2', 'draw'), bundle.params));
+    db.savePredictionSnapshot(toSnapshot(snapshotBase, '1x2', 'away', bundle.markets.match_result.away, extractOddsForMarket(matchData.odds, '1x2', 'away'), bundle.params));
+    db.savePredictionSnapshot(toSnapshot(snapshotBase, 'btts', 'yes', bundle.markets.btts.yes, extractOddsForMarket(matchData.odds, 'btts', 'yes'), bundle.params));
+    db.savePredictionSnapshot(toSnapshot(snapshotBase, 'btts', 'no', bundle.markets.btts.no, extractOddsForMarket(matchData.odds, 'btts', 'no'), bundle.params));
+    db.savePredictionSnapshot(toSnapshot(snapshotBase, 'totals', 'over25', bundle.markets.totals.over_2_5, extractOddsForMarket(matchData.odds, 'totals', 'over25'), bundle.params));
+    db.savePredictionSnapshot(toSnapshot(snapshotBase, 'totals', 'under25', bundle.markets.totals.under_2_5, extractOddsForMarket(matchData.odds, 'totals', 'under25'), bundle.params));
+
+    res.json({
+      fixture_id: id,
+      fixture: `${matchData.home_team} vs ${matchData.away_team}`,
+      league: matchData.league,
+      fixture_date: matchData.fixture_date,
+      model: 'hybrid-poisson-v1',
+      ...bundle,
+    });
+  } catch (e) {
+    res.status(500).json({ error: e.message });
+  }
+});
 
-    res.json(responseData);
-  } catch(e) { res.status(500).json({ error: e.message }); }
+app.get('/api/predictions/snapshots', (req, res) => {
+  try {
+    const rows = db.getPredictionSnapshots({
+      fixture_id: req.query.fixture_id,
+      limit: req.query.limit,
+    });
+    res.json({ count: rows.length, snapshots: rows });
+  } catch (e) {
+    res.status(500).json({ error: e.message });
+  }
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
 
EOF
)
