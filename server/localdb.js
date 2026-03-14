'use strict';

const fs    = require('fs');
const path  = require('path');
const fetch = require('node-fetch');

let Database = null;
try { Database = require('better-sqlite3'); }
catch(e) { console.error('[LOCALDB] better-sqlite3 not available:', e.message); }

if (!Database) {
  module.exports = {
    getLocalForm: () => null, getTeamStats: () => null,
    refresh: async () => {}, init: async () => {}, getFlashscoreFixtures: () => []
  };
} else {

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const dbPath = path.join(DATA_DIR, 'localform.db');
const ldb    = new Database(dbPath);

// ─── DB SCHEMA (CSV History + New Flashscore Fixtures) ─────────────
ldb.exec(`
  CREATE TABLE IF NOT EXISTS matches (
    id TEXT PRIMARY KEY, league TEXT, season TEXT, date TEXT,
    home_team TEXT, away_team TEXT, home_goals INTEGER, away_goals INTEGER,
    home_shots INTEGER, away_shots INTEGER, home_shots_target INTEGER, away_shots_target INTEGER,
    home_corners INTEGER, away_corners INTEGER, home_yellow INTEGER, away_yellow INTEGER,
    b365_home REAL, b365_draw REAL, b365_away REAL, created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_league ON matches(league);
  CREATE INDEX IF NOT EXISTS idx_home ON matches(home_team);
  CREATE INDEX IF NOT EXISTS idx_away ON matches(away_team);
  CREATE INDEX IF NOT EXISTS idx_date ON matches(date);
  
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

  -- NEW FLASHSCORE MASTER TABLE
  CREATE TABLE IF NOT EXISTS fs_fixtures (
    match_id TEXT PRIMARY KEY,
    match_date TEXT,
    date_only TEXT,
    league TEXT,
    category TEXT,
    home_team TEXT,
    home_id TEXT,
    away_team TEXT,
    away_id TEXT,
    match_url TEXT,
    status TEXT DEFAULT 'NS',
    home_goals INTEGER,
    away_goals INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_fs_date_only ON fs_fixtures(date_only);
`);

// ─── APIFY FLASHSCORE INGESTION PIPELINE ────────────────────────────
const insertFS = ldb.prepare(`
  INSERT OR REPLACE INTO fs_fixtures
  (match_id, match_date, date_only, league, category, home_team, home_id, away_team, away_id, match_url)
  VALUES (@match_id, @match_date, @date_only, @tournament_name, @category_name, @home_team_name, @home_team_id, @away_team_name, @away_team_id, @match_url)
`);

const insertManyFS = ldb.transaction(rows => {
  for (const r of rows) insertFS.run(r);
});

async function syncApifyFixtures() {
  const APIFY_TOKEN = process.env.APIFY_TOKEN;
  const ID = process.env.APIFY_ACTOR_ID; 
  
  if (!APIFY_TOKEN || !ID) {
    console.log('[LOCALDB] Apify credentials missing. Skipping Flashscore sync.');
    return;
  }

  console.log(`[LOCALDB] Syncing Apify fixtures using ID: ${ID}...`);
  try {
    let res;
    let url;

    // TRY 1: Assume it's an Actor ID
    url = `https://api.apify.com/v2/acts/${ID}/runs/last/dataset/items?token=${APIFY_TOKEN}`;
    res = await fetch(url);
    
    // TRY 2: Assume it's a Task ID
    if (res.status === 404) {
      console.log('[LOCALDB] ID not found as Actor. Pivoting to Task endpoint...');
      url = `https://api.apify.com/v2/actor-tasks/${ID}/runs/last/dataset/items?token=${APIFY_TOKEN}`;
      res = await fetch(url);
    }

    // TRY 3: Assume it's a direct Dataset ID (Most likely if copied from the data table)
    if (res.status === 404) {
      console.log('[LOCALDB] ID not found as Task. Pivoting to direct Dataset endpoint...');
      url = `https://api.apify.com/v2/datasets/${ID}/items?token=${APIFY_TOKEN}`;
      res = await fetch(url);
    }

    // Explicitly catch Key Issues
    if (res.status === 401 || res.status === 403) {
        throw new Error(`Auth Error (${res.status}). Your APIFY_TOKEN is invalid.`);
    }

    if (!res.ok) throw new Error(`Apify HTTP ${res.status}`);
    
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error('Apify response is not an array');
    if (data.length === 0) throw new Error('Apify returned an empty dataset. Check your run on Apify.');

    const formattedRows = data.map(item => {
      let dOnly = null;
      if (item.match_date) {
        const datePart = item.match_date.split(' ')[0];
        if (datePart.includes('.')) {
          const [d, m, y] = datePart.split('.');
          dOnly = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
        } else {
          dOnly = datePart; 
        }
      }
      return { ...item, date_only: dOnly };
    }).filter(r => r.date_only && r.match_id);

    insertManyFS(formattedRows);
    console.log(`[LOCALDB] SUCCESS! Ingested ${formattedRows.length} Flashscore fixtures.`);
  } catch(e) {
    console.error('[LOCALDB] Apify sync failed:', e.message);
    throw e;
  }
}

function getFlashscoreFixtures(dateStr) {
  try {
    return ldb.prepare("SELECT * FROM fs_fixtures WHERE date_only = ? ORDER BY match_date ASC").all(dateStr);
  } catch(e) {
    console.error('[LOCALDB] getFlashscoreFixtures error:', e.message);
    return [];
  }
}

// ─── CSV HISTORY LOGIC (Unchanged) ──────────────────────────────────
const FDCO_CURRENT = {
  'Premier League': 'https://www.football-data.co.uk/mmz4281/2526/E0.csv',
  'La Liga': 'https://www.football-data.co.uk/mmz4281/2526/SP1.csv',
  'Bundesliga': 'https://www.football-data.co.uk/mmz4281/2526/D1.csv',
  'Serie A': 'https://www.football-data.co.uk/mmz4281/2526/I1.csv',
  'Ligue 1': 'https://www.football-data.co.uk/mmz4281/2526/F1.csv'
};

function parseCSV(text) {
  const lines = text.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
  return lines.slice(1).map(line => {
    const vals = line.split(',').map(v => v.trim().replace(/"/g, ''));
    const row = {};
    headers.forEach((h, i) => { row[h] = vals[i] || ''; });
    return row;
  }).filter(r => r.HomeTeam && r.AwayTeam && r.Date);
}

function parseDate(str) {
  if (!str) return null;
  const parts = str.split('/');
  if (parts.length !== 3) return null;
  const [d, m, y] = parts;
  const year = y.length === 2 ? (parseInt(y) > 50 ? '19' + y : '20' + y) : y;
  return `${year}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

function norm(name) { return (name || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim(); }

const insertMatch = ldb.prepare(`
  INSERT OR REPLACE INTO matches
  (id, league, season, date, home_team, away_team, home_goals, away_goals, home_shots, away_shots, home_shots_target, away_shots_target, home_corners, away_corners, home_yellow, away_yellow, b365_home, b365_draw, b365_away)
  VALUES (@id, @league, @season, @date, @home_team, @away_team, @home_goals, @away_goals, @home_shots, @away_shots, @home_shots_target, @away_shots_target, @home_corners, @away_corners, @home_yellow, @away_yellow, @b365_home, @b365_draw, @b365_away)
`);

const insertMany = ldb.transaction(rows => { for (const r of rows) insertMatch.run(r); });

function csvRowToMatch(row, league, season) {
  const date = parseDate(row.Date);
  if (!date) return null;
  const hg = parseInt(row.FTHG), ag = parseInt(row.FTAG);
  if (isNaN(hg) || isNaN(ag)) return null;
  return {
    id: `${league}|${date}|${norm(row.HomeTeam)}|${norm(row.AwayTeam)}`, league, season, date,
    home_team: row.HomeTeam, away_team: row.AwayTeam, home_goals: hg, away_goals: ag,
    home_shots: parseInt(row.HS)||null, away_shots: parseInt(row.AS)||null,
    home_shots_target: parseInt(row.HST)||null, away_shots_target: parseInt(row.AST)||null,
    home_corners: parseInt(row.HC)||null, away_corners: parseInt(row.AC)||null,
    home_yellow: parseInt(row.HY)||null, away_yellow: parseInt(row.AY)||null,
    b365_home: parseFloat(row.B365H)||null, b365_draw: parseFloat(row.B365D)||null, b365_away: parseFloat(row.B365A)||null,
  };
}

async function ingestLeague(league, url, season) {
  try {
    const res = await fetch(url);
    if (!res.ok) return 0;
    const rows = parseCSV(await res.text()).map(r => csvRowToMatch(r, league, season)).filter(Boolean);
    if (rows.length) insertMany(rows);
    return rows.length;
  } catch(e) { return 0; }
}

async function refresh() {
  for (const [league, url] of Object.entries(FDCO_CURRENT)) {
    await ingestLeague(league, url, '2526');
  }
  ldb.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('last_refresh',?)").run(new Date().toISOString());
  await syncApifyFixtures(); 
}

function fuzzyMatch(q, c) {
  const qn = norm(q), cn = norm(c);
  if (qn === cn) return true;
  const qw = qn.split(' ').filter(w => w.length > 2);
  const cw = cn.split(' ').filter(w => w.length > 2);
  return qw.some(w => cw.some(cword => cword.startsWith(w) || w.startsWith(cword)));
}

function getLocalForm(homeTeamQuery, awayTeamQuery, league) {
  try {
    const teams = ldb.prepare(`SELECT DISTINCT home_team FROM matches WHERE league = ? AND season = '2526'`).all(league).map(r => r.home_team);
    const hT = teams.find(t => norm(t) === norm(homeTeamQuery)) || teams.find(t => fuzzyMatch(homeTeamQuery, t));
    const aT = teams.find(t => norm(t) === norm(awayTeamQuery)) || teams.find(t => fuzzyMatch(awayTeamQuery, t));
    if (!hT || !aT) return null;

    const getForm = teamName => ldb.prepare(`SELECT * FROM matches WHERE (home_team = ? OR away_team = ?) AND league = ? AND home_goals IS NOT NULL ORDER BY date DESC LIMIT 8`).all(teamName, teamName, league).map(r => {
      const isHome = r.home_team === teamName;
      const gf = isHome ? r.home_goals : r.away_goals, ga = isHome ? r.away_goals : r.home_goals;
      return {
        date: r.date, homeTeam: r.home_team, awayTeam: r.away_team, homeGoals: r.home_goals, awayGoals: r.away_goals,
        isHome, result: gf > ga ? 'W' : gf < ga ? 'L' : 'D'
      };
    });

    const h2h = ldb.prepare(`SELECT * FROM matches WHERE ((home_team = ? AND away_team = ?) OR (home_team = ? AND away_team = ?)) AND home_goals IS NOT NULL ORDER BY date DESC LIMIT 8`).all(hT, aT, aT, hT).map(r => ({
      date: r.date, homeTeam: r.home_team, awayTeam: r.away_team, homeGoals: r.home_goals, awayGoals: r.away_goals,
    }));

    return { homeForm: getForm(hT), awayForm: getForm(aT), h2h, source: 'localdb' };
  } catch(e) { return null; }
}

function getTeamStats(teamName, league) {
  try {
    const rows = ldb.prepare(`SELECT * FROM matches WHERE (home_team = ? OR away_team = ?) AND league = ? AND home_goals IS NOT NULL AND season = '2526' ORDER BY date DESC LIMIT 10`).all(teamName, teamName, league);
    if (!rows.length) return null;
    const stats = rows.map(r => ({
      scored: r.home_team === teamName ? r.home_goals : r.away_goals,
      conceded: r.home_team === teamName ? r.away_goals : r.home_goals
    }));
    const avg = arr => (arr.reduce((a, b) => a + (b || 0), 0) / arr.length).toFixed(2);
    return {
      avgScored: avg(stats.map(s => s.scored)), avgConceded: avg(stats.map(s => s.conceded)),
      bttsRate: Math.round(rows.filter(r => r.home_goals > 0 && r.away_goals > 0).length / rows.length * 100),
      over25Rate: Math.round(rows.filter(r => r.home_goals + r.away_goals > 2).length / rows.length * 100), n: rows.length,
    };
  } catch(e) { return null; }
}

async function init() {
  refresh().catch(e => console.error('[LOCALDB] Initial forced refresh failed:', e));
  setInterval(() => refresh().catch(() => {}), 12 * 60 * 60 * 1000);
}

module.exports = { getLocalForm, getTeamStats, getFlashscoreFixtures, syncApifyFixtures, refresh, init };

}
