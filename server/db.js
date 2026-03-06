const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'propred.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS bets (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    fixture_id      TEXT NOT NULL,
    date            TEXT NOT NULL,
    home_team       TEXT NOT NULL,
    away_team       TEXT NOT NULL,
    league          TEXT,
    tip             TEXT NOT NULL,
    market          TEXT NOT NULL,
    odds            REAL NOT NULL,
    stake           REAL NOT NULL,
    model_prob      INTEGER,
    implied_prob    INTEGER,
    edge_pct        INTEGER,
    ai_confidence   INTEGER,
    potential_return REAL,
    result          TEXT,
    home_goals      INTEGER,
    away_goals      INTEGER,
    profit          REAL,
    bankroll_before REAL,
    bankroll_after  REAL,
    placed_at       TEXT DEFAULT (datetime('now')),
    settled_at      TEXT
  );

  CREATE TABLE IF NOT EXISTS bankroll (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    amount       REAL NOT NULL DEFAULT 1000,
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
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(bet.fixture_id,bet.date,bet.home_team,bet.away_team,bet.league||'',
    bet.tip,bet.market,bet.odds,stake,bet.model_prob,bet.implied_prob,
    bet.edge_pct,bet.ai_confidence,potReturn,br.amount);
  updateBankroll(newBr);
  return { id:r.lastInsertRowid, stake, potential_return:potReturn, bankroll_before:br.amount };
}

function settleBet(fixtureId, homeGoals, awayGoals) {
  const pending = db.prepare('SELECT * FROM bets WHERE fixture_id=? AND result IS NULL').all(String(fixtureId));
  let settled=0;
  for(const bet of pending){
    const won = evaluateBet(bet.tip, bet.market, homeGoals, awayGoals, bet.home_team, bet.away_team);
    const result = won?'win':'loss';
    const profit = won ? parseFloat((bet.potential_return-bet.stake).toFixed(2)) : -bet.stake;
    const br = getBankroll();
    const brAfter = won ? parseFloat((br.amount+bet.potential_return).toFixed(2)) : br.amount;
    db.prepare(`UPDATE bets SET result=?,home_goals=?,away_goals=?,profit=?,bankroll_after=?,settled_at=datetime('now') WHERE id=?`)
      .run(result,homeGoals,awayGoals,profit,brAfter,bet.id);
    if(won) updateBankroll(brAfter);
    settled++;
  }
  return settled;
}

function evaluateBet(tip, market, hG, aG, homeTeam, awayTeam) {
  const total=hG+aG, tipL=(tip||'').toLowerCase();
  if(market==='h2h'){
    if(tipL.includes('draw')) return hG===aG;
    const htWords=(homeTeam||'').toLowerCase().split(' ').filter(w=>w.length>3);
    const atWords=(awayTeam||'').toLowerCase().split(' ').filter(w=>w.length>3);
    if(htWords.some(w=>tipL.includes(w))) return hG>aG;
    if(atWords.some(w=>tipL.includes(w))) return aG>hG;
  }
  if(market==='totals'){
    const m=tipL.match(/(over|under)\s*([\d.]+)/);
    if(m) return m[1]==='over' ? total>parseFloat(m[2]) : total<parseFloat(m[2]);
  }
  return false;
}

function getBets(opts={}) {
  const { limit=50, pending=false, date=null } = opts;
  let q='SELECT * FROM bets', conds=[], params=[];
  if(pending) conds.push('result IS NULL');
  if(date){ conds.push('date=?'); params.push(date); }
  if(conds.length) q+=' WHERE '+conds.join(' AND ');
  q+=' ORDER BY placed_at DESC LIMIT ?'; params.push(limit);
  return db.prepare(q).all(...params);
}

function getStats() {
  const br = getBankroll();
  const all = db.prepare('SELECT * FROM bets ORDER BY placed_at ASC').all();
  const settled = all.filter(b=>b.result);
  const wins = settled.filter(b=>b.result==='win');
  const totalStaked = settled.reduce((s,b)=>s+b.stake,0);
  const totalReturns = wins.reduce((s,b)=>s+b.potential_return,0);
  const profit = br.amount - br.start_amount;

  // Bankroll history for chart
  const history = [];
  let running = br.start_amount;
  settled.forEach(b=>{
    running += (b.profit||0);
    history.push({ date:b.date, bankroll:parseFloat(running.toFixed(2)), result:b.result, tip:b.tip, odds:b.odds });
  });

  // By league
  const byLeague={};
  settled.forEach(b=>{
    if(!byLeague[b.league]) byLeague[b.league]={wins:0,total:0,profit:0};
    byLeague[b.league].total++;
    byLeague[b.league].profit+=b.profit||0;
    if(b.result==='win') byLeague[b.league].wins++;
  });

  // By market
  const byMarket={};
  settled.forEach(b=>{
    if(!byMarket[b.market]) byMarket[b.market]={wins:0,total:0,profit:0};
    byMarket[b.market].total++;
    byMarket[b.market].profit+=b.profit||0;
    if(b.result==='win') byMarket[b.market].wins++;
  });

  return {
    bankroll:     br.amount,
    startBankroll:br.start_amount,
    profit:       parseFloat(profit.toFixed(2)),
    profitPct:    parseFloat((profit/br.start_amount*100).toFixed(1)),
    roi:          totalStaked>0 ? parseFloat(((totalReturns-totalStaked)/totalStaked*100).toFixed(1)) : 0,
    winRate:      settled.length>0 ? Math.round(wins.length/settled.length*100) : 0,
    totalBets:    all.length,
    settledBets:  settled.length,
    pendingBets:  all.filter(b=>!b.result).length,
    wins:         wins.length,
    losses:       settled.length-wins.length,
    avgOdds:      settled.length>0 ? parseFloat((settled.reduce((s,b)=>s+b.odds,0)/settled.length).toFixed(2)) : 0,
    avgEdge:      settled.length>0 ? parseFloat((settled.reduce((s,b)=>s+(b.edge_pct||0),0)/settled.length).toFixed(1)) : 0,
    history, byLeague, byMarket,
    recentBets:   all.slice(-20).reverse(),
  };
}

// ── ANALYSIS CACHE ─────────────────────────────────────────────────────────
function getCachedAnalysis(fixtureId) {
  const row = db.prepare('SELECT * FROM analysis_cache WHERE fixture_id=?').get(String(fixtureId));
  if(!row) return null;
  // Cache is valid for the whole day it was created — never re-run AI for same fixture same day
  const createdDay = (row.created_at||'').replace('T',' ').split(' ')[0];
  const todayStr = new Date().toISOString().split('T')[0];
  if(createdDay !== todayStr) return null;
  return row;
}

function cacheAnalysis(data) {
  try {
    // Ensure new columns exist (for existing DBs that predate schema update)
    ['confidence INTEGER','reasoning TEXT','risk TEXT','h2h TEXT','home_form TEXT','away_form TEXT',"probs TEXT DEFAULT '{}'"].forEach(col => {
      try { db.prepare('ALTER TABLE analysis_cache ADD COLUMN '+col).run(); } catch(e) {}
    });
    db.prepare(`INSERT OR REPLACE INTO analysis_cache
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

module.exports = {
  getBankroll, updateBankroll, resetBankroll, kellyStake,
  placeBet, settleBet, getBets, getStats, evaluateBet,
  getCachedAnalysis, cacheAnalysis,
};
