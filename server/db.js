 (cd "$(git rev-parse --show-toplevel)" && git apply --3way <<'EOF' 
diff --git a/server/db.js b/server/db.js
index 1710cb32566d426c17519a4272fe82ef38b797c3..44a4e2142b7756230fa26d1d03b1f7283cc2a013 100644
--- a/server/db.js
+++ b/server/db.js
@@ -41,50 +41,69 @@ db.exec(`
     start_amount REAL NOT NULL DEFAULT 1000,
     updated_at   TEXT DEFAULT (datetime('now'))
   );
 
   CREATE TABLE IF NOT EXISTS analysis_cache (
     fixture_id   TEXT PRIMARY KEY,
     home_team    TEXT,
     away_team    TEXT,
     league       TEXT,
     fixture_date TEXT,
     analysis     TEXT NOT NULL,
     tip          TEXT,
     market       TEXT,
     odds         REAL,
     edge_pct     INTEGER,
     model_prob   INTEGER,
     confidence   INTEGER,
     reasoning    TEXT,
     risk         TEXT,
     h2h          TEXT DEFAULT '[]',
     home_form    TEXT DEFAULT '[]',
     away_form    TEXT DEFAULT '[]',
     created_at   TEXT DEFAULT (datetime('now'))
   );
 
+  CREATE TABLE IF NOT EXISTS prediction_snapshots (
+    id            INTEGER PRIMARY KEY AUTOINCREMENT,
+    fixture_id    TEXT NOT NULL,
+    home_team     TEXT,
+    away_team     TEXT,
+    league        TEXT,
+    fixture_date  TEXT,
+    market        TEXT NOT NULL,
+    selection     TEXT NOT NULL,
+    probability   REAL,
+    confidence    INTEGER,
+    odds          REAL,
+    implied_prob  REAL,
+    edge_pct      REAL,
+    source        TEXT,
+    payload_json  TEXT,
+    created_at    TEXT DEFAULT (datetime('now'))
+  );
+
   INSERT OR IGNORE INTO bankroll (id, amount, start_amount) VALUES (1, 1000, 1000);
 `);
 
 // ── BANKROLL ───────────────────────────────────────────────────────────────
 const getBankroll   = () => db.prepare('SELECT * FROM bankroll WHERE id=1').get();
 const updateBankroll = amt => db.prepare('UPDATE bankroll SET amount=?,updated_at=datetime("now") WHERE id=1').run(amt);
 const resetBankroll  = (amt=1000) => db.prepare('UPDATE bankroll SET amount=?,start_amount=?,updated_at=datetime("now") WHERE id=1').run(amt,amt);
 
 // ── KELLY STAKING ──────────────────────────────────────────────────────────
 function kellyStake(bankroll, modelProb, odds, fraction=0.25) {
   const b=odds-1, p=modelProb/100, q=1-p;
   const kelly=(b*p-q)/b;
   if(kelly<=0) return 0;
   return Math.max(1, Math.min(parseFloat((bankroll*kelly*fraction).toFixed(2)), bankroll*0.1));
 }
 
 // ── BETS ───────────────────────────────────────────────────────────────────
 function placeBet(bet) {
   const br = getBankroll();
   const stake = bet.stake || kellyStake(br.amount, bet.model_prob||50, bet.odds);
   if(stake<=0 || br.amount<stake) return null;
   const potReturn = parseFloat((stake*bet.odds).toFixed(2));
   const newBr = parseFloat((br.amount-stake).toFixed(2));
   const r = db.prepare(`INSERT INTO bets
     (fixture_id,date,home_team,away_team,league,tip,market,odds,stake,model_prob,implied_prob,edge_pct,ai_confidence,potential_return,bankroll_before)
@@ -214,30 +233,68 @@ function cacheAnalysis(data) {
       (fixture_id,home_team,away_team,league,fixture_date,analysis,tip,market,odds,edge_pct,model_prob,confidence,reasoning,risk,h2h,home_form,away_form,probs,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
     `).run(
       String(data.fixture_id||''),
       data.home_team||'',
       data.away_team||'',
       data.league||'',
       data.fixture_date||'',
       data.analysis||'',
       data.tip||'',
       data.market||'',
       data.best_odds||null,
       data.edge_pct||null,
       data.model_prob||null,
       data.confidence||null,
       data.reasoning||null,
       data.risk||null,
       data.h2h||'[]',
       data.home_form||'[]',
       data.away_form||'[]',
       data.probs||'{}'
     );
   } catch(e) { console.error('[CACHE]', e.message); }
 }
 
+function savePredictionSnapshot(snapshot) {
+  try {
+    db.prepare(`INSERT INTO prediction_snapshots
+      (fixture_id, home_team, away_team, league, fixture_date, market, selection, probability, confidence, odds, implied_prob, edge_pct, source, payload_json)
+      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
+    `).run(
+      String(snapshot.fixture_id || ''),
+      snapshot.home_team || null,
+      snapshot.away_team || null,
+      snapshot.league || null,
+      snapshot.fixture_date || null,
+      snapshot.market || 'unknown',
+      snapshot.selection || 'unknown',
+      snapshot.probability ?? null,
+      snapshot.confidence ?? null,
+      snapshot.odds ?? null,
+      snapshot.implied_prob ?? null,
+      snapshot.edge_pct ?? null,
+      snapshot.source || 'model',
+      snapshot.payload_json ? JSON.stringify(snapshot.payload_json) : null,
+    );
+  } catch (e) {
+    console.error('[SNAPSHOT]', e.message);
+  }
+}
+
+function getPredictionSnapshots(opts = {}) {
+  const limit = Math.max(1, Math.min(parseInt(opts.limit, 10) || 50, 500));
+  const fixtureId = opts.fixture_id ? String(opts.fixture_id) : null;
+
+  if (fixtureId) {
+    return db.prepare(`SELECT * FROM prediction_snapshots WHERE fixture_id = ? ORDER BY id DESC LIMIT ?`).all(fixtureId, limit);
+  }
+
+  return db.prepare(`SELECT * FROM prediction_snapshots ORDER BY id DESC LIMIT ?`).all(limit);
+}
+
 module.exports = {
   getBankroll, updateBankroll, resetBankroll, kellyStake,
   placeBet, settleBet, getBets, getStats, evaluateBet,
   getCachedAnalysis, cacheAnalysis,
+  savePredictionSnapshot, getPredictionSnapshots,
 };
 
EOF
)
