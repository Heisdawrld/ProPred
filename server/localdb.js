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

ldb.exec(`
  CREATE TABLE IF NOT EXISTS matches (
    id TEXT PRIMARY KEY, league TEXT, season TEXT, date TEXT,
    home_team TEXT, away_team TEXT, home_goals INTEGER, away_goals INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  );
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

const insertFS = ldb.prepare(`
  INSERT OR REPLACE INTO fs_fixtures
  (match_id, match_date, date_only, league, category, home_team, home_id, away_team, away_id, match_url)
  VALUES (@match_id, @match_date, @date_only, @tournament_name, @category_name, @home_team_name, @home_team_id, @away_team_name, @away_team_id, @match_url)
`);

const insertManyFS = ldb.transaction(rows => { for (const r of rows) insertFS.run(r); });

async function syncApifyFixtures() {
  const APIFY_TOKEN = process.env.APIFY_TOKEN;
  const ID = process.env.APIFY_ACTOR_ID; 
  if (!APIFY_TOKEN || !ID) return;

  try {
    let res, url = \`https://api.apify.com/v2/acts/\${ID}/runs/last/dataset/items?token=\${APIFY_TOKEN}\`;
    res = await fetch(url);
    if (res.status === 404) {
      url = \`https://api.apify.com/v2/actor-tasks/\${ID}/runs/last/dataset/items?token=\${APIFY_TOKEN}\`;
      res = await fetch(url);
    }
    if (res.status === 404) {
      url = \`https://api.apify.com/v2/datasets/\${ID}/items?token=\${APIFY_TOKEN}\`;
      res = await fetch(url);
    }
    
    const data = await res.json();
    const currentYear = new Date().getFullYear().toString();

    const formattedRows = data.map(item => {
      let dOnly = null;
      if (item.match_date) {
        // Fix: Ensure date is stored as YYYY-MM-DD
        const parts = item.match_date.split(' ')[0].split('.').filter(p => p.trim());
        const d = parts[0], m = parts[1];
        let y = parts[2] || currentYear;
        if (y.length < 4) y = currentYear;
        dOnly = \`\${y}-\${m.padStart(2, '0')}-\${d.padStart(2, '0')}\`;
      }
      return { ...item, date_only: dOnly };
    }).filter(r => r.date_only && r.match_id);

    insertManyFS(formattedRows);
    console.log(\`[LOCALDB] SUCCESS! Ingested \${formattedRows.length} fixtures.\`);
  } catch(e) { console.error('[LOCALDB] Sync failed:', e.message); }
}

function getFlashscoreFixtures(dateStr) {
  return ldb.prepare("SELECT * FROM fs_fixtures WHERE date_only = ? ORDER BY match_date ASC").all(dateStr);
}

async function init() {
  syncApifyFixtures().catch(() => {});
  setInterval(syncApifyFixtures, 12 * 60 * 60 * 1000);
}

module.exports = { getLocalForm: () => null, getTeamStats: () => null, getFlashscoreFixtures, syncApifyFixtures, refresh: async () => {}, init };
}
