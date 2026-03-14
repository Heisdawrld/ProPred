 // ─────────────────────────────────────────────────────────────
// INDEX.JS CHANGES — apply these to your existing index.js
// ─────────────────────────────────────────────────────────────

// 1. At the very top, after `const bsd = require('./bsd');` add:
const localdb = require(’./localdb’);

// 2. Replace getFormAndH2H with this version (adds Tier 0 — localdb):
async function getFormAndH2H(homeTeam, awayTeam, homeId, awayId, slug, league, fdorgMatchId) {
console.log(`[FORM] ${homeTeam} vs ${awayTeam} | ${league}`);

// Tier 0: Local SQLite (football-data.co.uk CSVs — instant, no API call)
try {
const r = localdb.getLocalForm(homeTeam, awayTeam, league);
if (r && (r.homeForm.length > 0 || r.awayForm.length > 0)) {
console.log(`[FORM] localdb hit: home=${r.homeForm.length} away=${r.awayForm.length} h2h=${r.h2h.length}`);
return r;
}
} catch(e) { console.error(’[FORM] localdb err:’, e.message); }

// Tier 1: FDORG (most reliable for top leagues)
if (process.env.FDORG_KEY) {
try {
const r = await getFormFDOrg(homeTeam, awayTeam, league, fdorgMatchId);
if (r && (r.homeForm.length > 0 || r.awayForm.length > 0)) {
console.log(`[FORM] FDORG ok: home=${r.homeForm.length} away=${r.awayForm.length}`);
return r;
}
} catch(e) { console.error(’[FORM] FDORG err:’, e.message); }
}

// Tier 2: API-Football (covers 100+ leagues)
try {
const r = await Promise.race([
getFormAPIFootball(homeTeam, awayTeam, league),
new Promise(res => setTimeout(() => res(null), 8000))
]);
if (r && (r.homeForm.length > 0 || r.awayForm.length > 0)) {
console.log(`[FORM] API-Football ok: home=${r.homeForm.length} away=${r.awayForm.length}`);
return r;
}
} catch(e) { console.error(’[FORM] API-Football err:’, e.message); }

// Tier 3: ESPN scoreboard
console.log(`[FORM] ESPN fallback for ${league}`);
return getFormESPN(homeTeam, awayTeam, homeId, awayId, slug);
}

// 3. In the analyseWithAI function, enrich statsBlk with localdb team stats.
//    After the existing statsBlk line, add:
//    (inside analyseWithAI, after statsBlk is computed)

const localStatsHome = localdb.getTeamStats(homeTeam, league);
const localStatsAway = localdb.getTeamStats(awayTeam, league);
const localStatsBlk = (localStatsHome && localStatsAway) ? ` SEASON STATS (${localStatsHome.n} matches): ${homeTeam}: ${localStatsHome.avgScored} goals/g scored | ${localStatsHome.avgConceded} conceded | ${localStatsHome.avgShots} shots/g | ${localStatsHome.avgShotsT} on target | BTTS ${localStatsHome.bttsRate}% | O2.5 ${localStatsHome.over25Rate}% ${awayTeam}: ${localStatsAway.avgScored} goals/g scored | ${localStatsAway.avgConceded} conceded | ${localStatsAway.avgShots} shots/g | ${localStatsAway.avgShotsT} on target | BTTS ${localStatsAway.bttsRate}% | O2.5 ${localStatsAway.over25Rate}%` : ‘’;

//    Then add ${localStatsBlk} into the prompt string, after ${statsBlk}${teamGoalStats}

// 4. In the startup block (app.listen callback), after `await loadFixtures(today());` add:
//    localdb.init(); // non-blocking — downloads CSVs in background
