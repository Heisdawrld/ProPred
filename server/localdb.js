'use strict';

const fs    = require('fs');
const path  = require('path');
const fetch = require('node-fetch');

// ── Try loading better-sqlite3 ────────────────────────────────────────────
let Database = null;
try { Database = require('better-sqlite3'); }
catch(e) { console.error('[LOCALDB] better-sqlite3 not available:', e.message); }

// If SQLite not available, export no-ops and stop
if (!Database) {
  module.exports = {
    getLocalForm:  () => null,
    getTeamStats:  () => null,
    refresh:       async () => {},
    init:          async () => {},
  };
} else {

// ── Everything below only runs when better-sqlite3 is available ───────────

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const dbPath = path.join(DATA_DIR, 'localform.db');
const ldb    = new Database(dbPath);

ldb.exec(`
  CREATE TABLE IF NOT EXISTS matches (
    id                    TEXT PRIMARY KEY,
    league                TEXT,
    season                TEXT,
    date                  TEXT,
    home_team             TEXT,
    away_team             TEXT,
    home_goals            INTEGER,
    away_goals            INTEGER,
    home_shots            INTEGER,
    away_shots            INTEGER,
    home_shots_target     INTEGER,
    away_shots_target     INTEGER,
    home_corners          INTEGER,
    away_corners          INTEGER,
    home_yellow           INTEGER,
    away_yellow           INTEGER,
    b365_home             REAL,
    b365_draw             REAL,
    b365_away             REAL,
    created_at            TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_league ON matches(league);
  CREATE INDEX IF NOT EXISTS idx_home   ON matches(home_team);
  CREATE INDEX IF NOT EXISTS idx_away   ON matches(away_team);
  CREATE INDEX IF NOT EXISTS idx_date   ON matches(date);
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

// ── League CSV map — current season 25/26 ────────────────────────────────
const FDCO_CURRENT = {
  'Premier League':   'https://www.football-data.co.uk/mmz4281/2526/E0.csv',
  'Championship':     'https://www.football-data.co.uk/mmz4281/2526/E1.csv',
  'Serie A':          'https://www.football-data.co.uk/mmz4281/2526/I1.csv',
  'Serie B':          'https://www.football-data.co.uk/mmz4281/2526/I2.csv',
  'La Liga':          'https://www.football-data.co.uk/mmz4281/2526/SP1.csv',
  'Segunda Division': 'https://www.football-data.co.uk/mmz4281/2526/SP2.csv',
  'Bundesliga':       'https://www.football-data.co.uk/mmz4281/2526/D1.csv',
  'Bundesliga 2':     'https://www.football-data.co.uk/mmz4281/2526/D2.csv',
  'Ligue 1':          'https://www.football-data.co.uk/mmz4281/2526/F1.csv',
  'Ligue 2':          'https://www.football-data.co.uk/mmz4281/2526/F2.csv',
  'Eredivisie':       'https://www.football-data.co.uk/mmz4281/2526/N1.csv',
  'Pro League':       'https://www.football-data.co.uk/mmz4281/2526/B1.csv',
  'Scottish Prem':    'https://www.football-data.co.uk/mmz4281/2526/SC0.csv',
  'Primeira Liga':    'https://www.football-data.co.uk/mmz4281/2526/P1.csv',
  'Super Lig':        'https://www.football-data.co.uk/mmz4281/2526/T1.csv',
  'MLS':              'https://www.football-data.co.uk/new/MLS.csv',
};

// Previous season for H2H depth
const FDCO_PREV = {
  'Premier League':   'https://www.football-data.co.uk/mmz4281/2425/E0.csv',
  'Championship':     'https://www.football-data.co.uk/mmz4281/2425/E1.csv',
  'Serie A':          'https://www.football-data.co.uk/mmz4281/2425/I1.csv',
  'Serie B':          'https://www.football-data.co.uk/mmz4281/2425/I2.csv',
  'La Liga':          'https://www.football-data.co.uk/mmz4281/2425/SP1.csv',
  'Bundesliga':       'https://www.football-data.co.uk/mmz4281/2425/D1.csv',
  'Bundesliga 2':     'https://www.football-data.co.uk/mmz4281/2425/D2.csv',
  'Ligue 1':          'https://www.football-data.co.uk/mmz4281/2425/F1.csv',
  'Ligue 2':          'https://www.football-data.co.uk/mmz4281/2425/F2.csv',
  'Eredivisie':       'https://www.football-data.co.uk/mmz4281/2425/N1.csv',
  'Pro League':       'https://www.football-data.co.uk/mmz4281/2425/B1.csv',
  'Primeira Liga':    'https://www.football-data.co.uk/mmz4281/2425/P1.csv',
  'Super Lig':        'https://www.football-data.co.uk/mmz4281/2425/T1.csv',
};

// ── CSV parser ─────────────────────────────────────────────────────────────
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

function norm(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

// ── DB insert ──────────────────────────────────────────────────────────────
const insertMatch = ldb.prepare(`
  INSERT OR REPLACE INTO matches
    (id, league, season, date, home_team, away_team,
     home_goals, away_goals, home_shots, away_shots,
     home_shots_target, away_shots_target,
     home_corners, away_corners, home_yellow, away_yellow,
     b365_home, b365_draw, b365_away)
  VALUES
    (@id, @league, @season, @date, @home_team, @away_team,
     @home_goals, @away_goals, @home_shots, @away_shots,
     @home_shots_target, @away_shots_target,
     @home_corners, @away_corners, @home_yellow, @away_yellow,
     @b365_home, @b365_draw, @b365_away)
`);

const insertMany = ldb.transaction(rows => {
  for (const r of rows) insertMatch.run(r);
});

function csvRowToMatch(row, league, season) {
  const date = parseDate(row.Date);
  if (!date) return null;
  const hg = parseInt(row.FTHG), ag = parseInt(row.FTAG);
  if (isNaN(hg) || isNaN(ag)) return null;
  return {
    id:                 `${league}|${date}|${norm(row.HomeTeam)}|${norm(row.AwayTeam)}`,
    league,
    season,
    date,
    home_team:          row.HomeTeam,
    away_team:          row.AwayTeam,
    home_goals:         hg,
    away_goals:         ag,
    home_shots:         parseInt(row.HS)   || null,
    away_shots:         parseInt(row.AS)   || null,
    home_shots_target:  parseInt(row.HST)  || null,
    away_shots_target:  parseInt(row.AST)  || null,
    home_corners:       parseInt(row.HC)   || null,
    away_corners:       parseInt(row.AC)   || null,
    home_yellow:        parseInt(row.HY)   || null,
    away_yellow:        parseInt(row.AY)   || null,
    b365_home:          parseFloat(row.B365H) || null,
    b365_draw:          parseFloat(row.B365D) || null,
    b365_away:          parseFloat(row.B365A) || null,
  };
}

// ── Download + ingest one CSV ──────────────────────────────────────────────
async function ingestLeague(league, url, season) {
  try {
    const res = await fetch(url);
    if (!res.ok) { console.log(`[LOCALDB] ${league} HTTP ${res.status}`); return 0; }
    const text = await res.text();
    const rows = parseCSV(text).map(r => csvRowToMatch(r, league, season)).filter(Boolean);
    if (!rows.length) { console.log(`[LOCALDB] ${league} — 0 valid rows`); return 0; }
    insertMany(rows);
    console.log(`[LOCALDB] ${league} (${season}) — ${rows.length} matches`);
    return rows.length;
  } catch(e) {
    console.error(`[LOCALDB] ${league} error:`, e.message);
    return 0;
  }
}

// ── Full refresh ───────────────────────────────────────────────────────────
async function refresh() {
  console.log('[LOCALDB] Starting refresh…');
  let total = 0;
  for (const [league, url] of Object.entries(FDCO_CURRENT)) {
    total += await ingestLeague(league, url, '2526');
    await new Promise(r => setTimeout(r, 400));
  }
  for (const [league, url] of Object.entries(FDCO_PREV)) {
    total += await ingestLeague(league, url, '2425');
    await new Promise(r => setTimeout(r, 400));
  }
  ldb.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('last_refresh',?)").run(new Date().toISOString());
  console.log(`[LOCALDB] Done — ${total} total matches stored`);
}

// ── Fuzzy team name match ──────────────────────────────────────────────────
function fuzzyMatch(query, candidate) {
  const na = norm(query), nb = norm(candidate);
  if (na === nb) return true;
  if ((na.includes(nb) && nb.length > 3) || (nb.includes(na) && na.length > 3)) return true;

  const generic = ['united', 'city', 'fc', 'afc', 'rovers', 'athletic', 'real', 'cf', 'cd', 'sporting', 'club', 'de'];
  const strip = s => s.split(' ').filter(w => w.length > 2 && !generic.includes(w)).join(' ');

  const ca = strip(na);
  const cb = strip(nb);

  if (!ca || !cb) return false;
  if (ca === cb) return true;
  if (ca.includes(cb) || cb.includes(ca)) return true;

  const w1 = ca.split(' ')[0];
  const w2 = cb.split(' ')[0];
  if (w1 === w2) return true;

  const aliases = [
    ['manchester', 'man'], ['nottingham', 'nottm'], 
    ['wolverhampton', 'wolves'], ['sheffield', 'sheff'], ['tottenham', 'spurs']
  ];
  for (const [full, abbr] of aliases) {
    if ((w1 === full && w2 === abbr) || (w2 === full && w1 === abbr)) return true;
  }

  if (w1.length >= 5 && w2.length >= 5 && (w1.startsWith(w2) || w2.startsWith(w1))) return true;
  return false;
}

function getLeagueTeams(league) {
  return ldb.prepare(
    `SELECT DISTINCT home_team FROM matches WHERE league = ? AND season = '2526'`
  ).all(league).map(r => r.home_team);
}

function findTeam(query, teams) {
  return teams.find(t => norm(t) === norm(query))
      || teams.find(t => fuzzyMatch(query, t))
      || null;
}

// ── Main query ─────────────────────────────────────────────────────────────
function getLocalForm(homeTeamQuery, awayTeamQuery, league) {
  try {
    const teams = getLeagueTeams(league);
    if (!teams.length) return null;

    const homeTeam = findTeam(homeTeamQuery, teams);
    const awayTeam = findTeam(awayTeamQuery, teams);

    console.log(`[LOCALDB] ${homeTeamQuery}→${homeTeam || 'NO'} | ${awayTeamQuery}→${awayTeam || 'NO'} | ${league}`);
    if (!homeTeam || !awayTeam) return null;

    const getForm = teamName => ldb.prepare(`
      SELECT * FROM matches
      WHERE (home_team = ? OR away_team = ?) AND league = ? AND home_goals IS NOT NULL
      ORDER BY date DESC LIMIT 8
    `).all(teamName, teamName, league).map(r => {
      const isHome = r.home_team === teamName;
      const gf = isHome ? r.home_goals : r.away_goals;
      const ga = isHome ? r.away_goals : r.home_goals;
      return {
        date: r.date, homeTeam: r.home_team, awayTeam: r.away_team,
        homeGoals: r.home_goals, awayGoals: r.away_goals, isHome,
        result: gf > ga ? 'W' : gf < ga ? 'L' : 'D',
        shots:       isHome ? r.home_shots        : r.away_shots,
        shotsTarget: isHome ? r.home_shots_target : r.away_shots_target,
        corners:     isHome ? r.home_corners      : r.away_corners,
      };
    });

    const h2h = ldb.prepare(`
      SELECT * FROM matches
      WHERE ((home_team = ? AND away_team = ?) OR (home_team = ? AND away_team = ?))
        AND home_goals IS NOT NULL
      ORDER BY date DESC LIMIT 8
    `).all(homeTeam, awayTeam, awayTeam, homeTeam).map(r => ({
      date: r.date, homeTeam: r.home_team, awayTeam: r.away_team,
      homeGoals: r.home_goals, awayGoals: r.away_goals,
    }));

    const homeForm = getForm(homeTeam);
    const awayForm = getForm(awayTeam);

    if (!homeForm.length && !awayForm.length) return null;

    console.log(`[LOCALDB] ✅ home:${homeForm.length} away:${awayForm.length} h2h:${h2h.length}`);
    return { homeForm, awayForm, h2h, source: 'localdb' };
  } catch(e) {
    console.error('[LOCALDB] query error:', e.message);
    return null;
  }
}

// ── Team stats for AI prompt ───────────────────────────────────────────────
function getTeamStats(teamName, league) {
  try {
    const rows = ldb.prepare(`
      SELECT * FROM matches
      WHERE (home_team = ? OR away_team = ?) AND league = ?
        AND home_goals IS NOT NULL AND season = '2526'
      ORDER BY date DESC LIMIT 10
    `).all(teamName, teamName, league);
    if (!rows.length) return null;

    const stats = rows.map(r => {
      const isHome = r.home_team === teamName;
      return {
        scored:   isHome ? r.home_goals : r.away_goals,
        conceded: isHome ? r.away_goals : r.home_goals,
        shots:    isHome ? r.home_shots : r.away_shots,
        shotsT:   isHome ? r.home_shots_target : r.away_shots_target,
      };
    });
    const avg = arr => (arr.reduce((a, b) => a + (b || 0), 0) / arr.length).toFixed(2);
    return {
      avgScored:   avg(stats.map(s => s.scored)),
      avgConceded: avg(stats.map(s => s.conceded)),
      avgShots:    avg(stats.map(s => s.shots)),
      avgShotsT:   avg(stats.map(s => s.shotsT)),
      bttsRate:    Math.round(rows.filter(r => r.home_goals > 0 && r.away_goals > 0).length / rows.length * 100),
      over25Rate:  Math.round(rows.filter(r => r.home_goals + r.away_goals > 2).length / rows.length * 100),
      n:           rows.length,
    };
  } catch(e) { return null; }
}

// ── Init: check staleness, schedule 48hr refresh ───────────────────────────
async function init() {
  const lastRefresh = ldb.prepare("SELECT value FROM meta WHERE key='last_refresh'").get();
  const count = ldb.prepare("SELECT COUNT(*) as n FROM matches").get().n;

  if (!lastRefresh || count < 100) {
    console.log('[LOCALDB] No data — starting initial download (background)…');
    refresh().catch(e => console.error('[LOCALDB] initial refresh error:', e.message));
  } else {
    const ageHrs = (Date.now() - new Date(lastRefresh.value).getTime()) / 3600000;
    console.log(`[LOCALDB] ${count} matches cached | ${ageHrs.toFixed(1)}hrs since last refresh`);
    if (ageHrs > 48) {
      console.log('[LOCALDB] Stale — refreshing in background');
      refresh().catch(e => console.error('[LOCALDB] refresh error:', e.message));
    }
  }

  // 48hr auto-refresh
  setInterval(() => {
    refresh().catch(e => console.error('[LOCALDB] interval error:', e.message));
  }, 48 * 60 * 60 * 1000);
}

module.exports = { getLocalForm, getTeamStats, refresh, init };

} // end else (Database available)
