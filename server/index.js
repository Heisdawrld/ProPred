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
const FDORG_KEY        = (process.env.FDORG_KEY        || '').trim();

const VERSION = '3.1.0';

// ─── IN-MEMORY FIXTURE CACHE ──────────────────────────────────────────────
let fixtureCache = {};   // date → { fixtures, fetchedAt }
const FIXTURE_TTL = 30 * 60 * 1000; // 30 min

// ─── UTILS ────────────────────────────────────────────────────────────────
const today = () => new Date().toISOString().split('T')[0];

function norm(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

function fuzzyTeam(a, b) {
  const na = norm(a), nb = norm(b);
  if (na === nb) return true;
  const wa = na.split(' ').filter(w => w.length > 2);
  const wb = nb.split(' ').filter(w => w.length > 2);
  return wa.some(w => wb.some(x => x.startsWith(w) || w.startsWith(x)));
}

// ─── ODDS API ─────────────────────────────────────────────────────────────
async function fetchOdds(homeTeam, awayTeam) {
  if (!ODDS_API_KEY) return null;
  try {
    const markets = 'h2h,totals,btts,asian_handicap,double_chance';
    const res = await fetch(
      `https://api.the-odds-api.com/v4/sports/soccer/odds/?apiKey=${ODDS_API_KEY}&regions=uk&markets=${markets}&oddsFormat=decimal`,
      { timeout: 5000 }
    );
    if (!res.ok) return null;
    const events = await res.json();
    const match = events.find(e =>
      (fuzzyTeam(e.home_team, homeTeam) && fuzzyTeam(e.away_team, awayTeam)) ||
      (fuzzyTeam(e.home_team, awayTeam) && fuzzyTeam(e.away_team, homeTeam))
    );
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
      break; // first bookmaker only
    }
    return Object.keys(result).length ? result : null;
  } catch(e) {
    console.error('[ODDS]', e.message);
    return null;
  }
}

// ─── FDORG COMPETITION MAP ────────────────────────────────────────────────
const FDORG_COMPS = {
  'PL':  { name: 'Premier League',   country: 'England' },
  'BL1': { name: 'Bundesliga',       country: 'Germany' },
  'SA':  { name: 'Serie A',          country: 'Italy'   },
  'PD':  { name: 'La Liga',          country: 'Spain'   },
  'FL1': { name: 'Ligue 1',          country: 'France'  },
  'DED': { name: 'Eredivisie',       country: 'Netherlands' },
  'PPL': { name: 'Primeira Liga',    country: 'Portugal' },
  'CL':  { name: 'Champions League', country: 'Europe'  },
  'EL':  { name: 'Europa League',    country: 'Europe'  },
  'EC':  { name: 'European Championship', country: 'Europe' },
  'WC':  { name: 'World Cup',        country: 'World'   },
  'BSA': { name: 'Brasileirao',      country: 'Brazil'  },
  'ELC': { name: 'Championship',     country: 'England' },
};

// ─── FETCH FIXTURES: FDORG (primary) ──────────────────────────────────────
async function fetchFixturesFDOrg(date) {
  if (!FDORG_KEY) return [];
  try {
    const results = [];
    // Fetch all competitions in parallel
    const fetches = Object.entries(FDORG_COMPS).map(async ([code, meta]) => {
      try {
        const res = await fetch(
          `https://api.football-data.org/v4/competitions/${code}/matches?dateFrom=${date}&dateTo=${date}`,
          { headers: { 'X-Auth-Token': FDORG_KEY }, timeout: 8000 }
        );
        if (!res.ok) return [];
        const data = await res.json();
        return (data.matches || []).map(m => ({
          id:          `fdorg-${m.id}`,
          fdorgId:     m.id,
          league:      meta.name,
          leagueCode:  code,
          homeTeam:    m.homeTeam.name,
          awayTeam:    m.awayTeam.name,
          homeLogo:    m.homeTeam.crest || null,
          awayLogo:    m.awayTeam.crest || null,
          homeId:      m.homeTeam.id,
          awayId:      m.awayTeam.id,
          date:        m.utcDate,
          status:      normFDOrgStatus(m.status),
          homeGoals:   m.score?.fullTime?.home ?? null,
          awayGoals:   m.score?.fullTime?.away ?? null,
          venue:       m.venue || null,
          slug:        meta.name.toLowerCase().replace(/\s+/g, '-'),
          fdorgMatchId: m.id,
        }));
      } catch(e) {
        console.error(`[FIXTURES/FDORG] ${code}:`, e.message);
        return [];
      }
    });
    const all = await Promise.all(fetches);
    return all.flat();
  } catch(e) {
    console.error('[FIXTURES/FDORG]', e.message);
    return [];
  }
}

function normFDOrgStatus(s) {
  if (!s) return 'NS';
  if (s === 'FINISHED') return 'FT';
  if (s === 'IN_PLAY' || s === 'PAUSED') return '1H';
  if (s === 'HALFTIME') return 'HT';
  if (s === 'TIMED' || s === 'SCHEDULED') return 'NS';
  if (s === 'POSTPONED') return 'PST';
  if (s === 'CANCELLED') return 'CANC';
  return 'NS';
}

// ─── FETCH FIXTURES: ESPN (fallback for non-FDORG leagues) ────────────────
const ESPN_LEAGUES = [
  { slug: 'mex.1',  name: 'Liga MX'       },
  { slug: 'usa.1',  name: 'MLS'           },
  { slug: 'ger.2',  name: 'Bundesliga 2'  },
  { slug: 'fra.2',  name: 'Ligue 2'       },
  { slug: 'esp.2',  name: 'Segunda Division' },
  { slug: 'eng.2',  name: 'Championship'  },
  { slug: 'tur.1',  name: 'Super Lig'     },
  { slug: 'sco.1',  name: 'Scottish Prem' },
  { slug: 'arg.1',  name: 'Primera Division' },
  { slug: 'por.1',  name: 'Primeira Liga' },
];

async function fetchFixturesESPN(date) {
  const espnDate = date.replace(/-/g, '');
  const results = [];
  await Promise.all(ESPN_LEAGUES.map(async ({ slug, name }) => {
    try {
      const res = await fetch(
        `https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/scoreboard?dates=${espnDate}`,
        { timeout: 6000 }
      );
      if (!res.ok) return;
      const data = await res.json();
      for (const ev of (data.events || [])) {
        const comp = ev.competitions?.[0];
        if (!comp) continue;
        const [c1, c2] = comp.competitors || [];
        if (!c1 || !c2) continue;
        const home = c1.homeAway === 'home' ? c1 : c2;
        const away = c1.homeAway === 'away' ? c1 : c2;
        const statusState = ev.status?.type?.state || 'pre';
        const statusName  = ev.status?.type?.shortDetail || 'NS';
        let status = 'NS';
        if (statusState === 'post') status = 'FT';
        else if (statusState === 'in') status = '1H';
        const hg = statusState === 'post' || statusState === 'in' ? parseInt(home.score) : null;
        const ag = statusState === 'post' || statusState === 'in' ? parseInt(away.score) : null;
        results.push({
          id:          `espn-${ev.id}`,
          league:      name,
          homeTeam:    home.team?.displayName || home.team?.name,
          awayTeam:    away.team?.displayName || away.team?.name,
          homeLogo:    home.team?.logo || null,
          awayLogo:    away.team?.logo || null,
          homeId:      home.team?.id || null,
          awayId:      away.team?.id || null,
          date:        ev.date,
          status,
          homeGoals:   isNaN(hg) ? null : hg,
          awayGoals:   isNaN(ag) ? null : ag,
          venue:       comp.venue?.fullName || null,
          slug,
          fdorgMatchId: null,
        });
      }
    } catch(e) {
      console.error(`[FIXTURES/ESPN] ${slug}:`, e.message);
    }
  }));
  return results;
}

// ─── COMBINED FIXTURE LOADER ───────────────────────────────────────────────
async function fetchAllFixtures(date) {
  const [fdorg, espn] = await Promise.all([
    fetchFixturesFDOrg(date),
    fetchFixturesESPN(date),
  ]);
  // Deduplicate ESPN fixtures already covered by FDORG
  const fdorgLeagues = new Set(fdorg.map(f => f.league.toLowerCase()));
  const espnFiltered = espn.filter(f => !fdorgLeagues.has(f.league.toLowerCase()));
  return [...fdorg, ...espnFiltered];
}

// ─── FORM: FDORG ──────────────────────────────────────────────────────────
async function getFormFDOrg(homeTeam, awayTeam, league, fdorgMatchId) {
  if (!FDORG_KEY) return null;
  try {
    // Try to get competition ID from league name
    const compRes = await fetch(
      `https://api.football-data.org/v4/competitions/?plan=TIER_ONE`,
      { headers: { 'X-Auth-Token': FDORG_KEY }, timeout: 5000 }
    );
    if (!compRes.ok) return null;
    const compData = await compRes.json();
    const leagueLower = league.toLowerCase();
    const comp = (compData.competitions || []).find(c =>
      c.name.toLowerCase().includes(leagueLower) ||
      leagueLower.includes(c.name.toLowerCase().split(' ')[0])
    );
    if (!comp) return null;

    const [homeRes, awayRes] = await Promise.all([
      fetch(`https://api.football-data.org/v4/teams?search=${encodeURIComponent(homeTeam)}`, { headers: { 'X-Auth-Token': FDORG_KEY }, timeout: 5000 }),
      fetch(`https://api.football-data.org/v4/teams?search=${encodeURIComponent(awayTeam)}`, { headers: { 'X-Auth-Token': FDORG_KEY }, timeout: 5000 }),
    ]);
    const homeData = await homeRes.json();
    const awayData = await awayRes.json();
    const homeId = homeData.teams?.[0]?.id;
    const awayId = awayData.teams?.[0]?.id;
    if (!homeId || !awayId) return null;

    const [homeMatches, awayMatches, h2hRes] = await Promise.all([
      fetch(`https://api.football-data.org/v4/teams/${homeId}/matches?status=FINISHED&limit=6`, { headers: { 'X-Auth-Token': FDORG_KEY }, timeout: 5000 }),
      fetch(`https://api.football-data.org/v4/teams/${awayId}/matches?status=FINISHED&limit=6`, { headers: { 'X-Auth-Token': FDORG_KEY }, timeout: 5000 }),
      fetch(`https://api.football-data.org/v4/teams/${homeId}/matches?status=FINISHED&limit=10`, { headers: { 'X-Auth-Token': FDORG_KEY }, timeout: 5000 }),
    ]);

    const parseMatches = async (res, teamId) => {
      const data = await res.json();
      return (data.matches || []).map(m => {
        const isHome = m.homeTeam.id === teamId;
        const hg = m.score.fullTime.home, ag = m.score.fullTime.away;
        const gf = isHome ? hg : ag, ga = isHome ? ag : hg;
        return {
          date: m.utcDate?.split('T')[0],
          homeTeam: m.homeTeam.name, awayTeam: m.awayTeam.name,
          homeGoals: hg, awayGoals: ag, isHome,
          result: gf > ga ? 'W' : gf < ga ? 'L' : 'D',
        };
      });
    };

    const homeForm = await parseMatches(homeMatches, homeId);
    const awayForm = await parseMatches(awayMatches, awayId);

    const h2hData = await h2hRes.json();
    const h2h = (h2hData.matches || [])
      .filter(m => {
        const ids = [m.homeTeam.id, m.awayTeam.id];
        return ids.includes(homeId) && ids.includes(awayId);
      })
      .slice(0, 6)
      .map(m => ({
        date: m.utcDate?.split('T')[0],
        homeTeam: m.homeTeam.name, awayTeam: m.awayTeam.name,
        homeGoals: m.score.fullTime.home, awayGoals: m.score.fullTime.away,
      }));

    if (!homeForm.length && !awayForm.length) return null;
    return { homeForm, awayForm, h2h, source: 'fdorg' };
  } catch(e) {
    console.error('[FORM/FDORG]', e.message);
    return null;
  }
}

// ─── FORM: API-FOOTBALL ───────────────────────────────────────────────────
async function getFormAPIFootball(homeTeam, awayTeam, league) {
  if (!API_FOOTBALL_KEY) return null;
  try {
    const search = async name => {
      const r = await fetch(
        `https://v3.football.api-sports.io/teams?search=${encodeURIComponent(name)}`,
        { headers: { 'x-apisports-key': API_FOOTBALL_KEY }, timeout: 4000 }
      );
      return (await r.json())?.response?.[0]?.team?.id || null;
    };
    const [homeId, awayId] = await Promise.all([search(homeTeam), search(awayTeam)]);
    if (!homeId || !awayId) return null;

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
          date: f.fixture.date?.split('T')[0],
          homeTeam: f.teams.home.name, awayTeam: f.teams.away.name,
          homeGoals: hg, awayGoals: ag, isHome,
          result: gf > ga ? 'W' : gf < ga ? 'L' : 'D',
        };
      });
    };

    const homeForm = await parseForm(homeRes, homeId);
    const awayForm = await parseForm(awayRes, awayId);
    const h2hData  = await h2hRes.json();
    const h2h = (h2hData.response || []).map(f => ({
      date: f.fixture.date?.split('T')[0],
      homeTeam: f.teams.home.name, awayTeam: f.teams.away.name,
      homeGoals: f.goals.home, awayGoals: f.goals.away,
    }));

    if (!homeForm.length && !awayForm.length) return null;
    return { homeForm, awayForm, h2h, source: 'api-football' };
  } catch(e) {
    console.error('[FORM/API-FOOTBALL]', e.message);
    return null;
  }
}

// ─── FORM: ESPN ───────────────────────────────────────────────────────────
async function getFormESPN(homeTeam, awayTeam, homeId, awayId, slug) {
  try {
    const leagueSlugMap = {
      'premier-league': 'eng.1', 'la-liga': 'esp.1', 'serie-a': 'ita.1',
      'bundesliga': 'ger.1', 'ligue-1': 'fra.1', 'eredivisie': 'ned.1',
      'primeira-liga': 'por.1', 'championship': 'eng.2', 'mls': 'usa.1',
      'liga-mx': 'mex.1', 'bundesliga-2': 'ger.2', 'ligue-2': 'fra.2',
    };
    const espnLeague = leagueSlugMap[slug] || leagueSlugMap[Object.keys(leagueSlugMap).find(k => (slug || '').includes(k.split('-')[0]))] || null;
    if (!espnLeague) return { homeForm: [], awayForm: [], h2h: [] };

    const res = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/soccer/${espnLeague}/scoreboard?limit=40`,
      { timeout: 5000 }
    );
    if (!res.ok) return { homeForm: [], awayForm: [], h2h: [] };
    const data = await res.json();
    const events = data.events || [];

    const homeForm = [], awayForm = [], h2h = [];
    for (const ev of events) {
      const comp = ev.competitions?.[0];
      if (!comp) continue;
      const [c1, c2] = comp.competitors || [];
      if (!c1 || !c2) continue;
      const ht = c1.homeAway === 'home' ? c1 : c2;
      const at = c1.homeAway === 'away' ? c1 : c2;
      const htName = ht.team?.displayName || ht.team?.name || '';
      const atName = at.team?.displayName || at.team?.name || '';
      const hg = parseInt(ht.score), ag = parseInt(at.score);
      if (isNaN(hg) || isNaN(ag)) continue;
      const d = ev.date?.split('T')[0];

      const entry = { date: d, homeTeam: htName, awayTeam: atName, homeGoals: hg, awayGoals: ag };

      if (fuzzyTeam(htName, homeTeam)) {
        homeForm.push({ ...entry, isHome: true, result: hg > ag ? 'W' : hg < ag ? 'L' : 'D' });
      } else if (fuzzyTeam(atName, homeTeam)) {
        homeForm.push({ ...entry, isHome: false, result: ag > hg ? 'W' : ag < hg ? 'L' : 'D' });
      }
      if (fuzzyTeam(htName, awayTeam)) {
        awayForm.push({ ...entry, isHome: true, result: hg > ag ? 'W' : hg < ag ? 'L' : 'D' });
      } else if (fuzzyTeam(atName, awayTeam)) {
        awayForm.push({ ...entry, isHome: false, result: ag > hg ? 'W' : ag < hg ? 'L' : 'D' });
      }
      if (fuzzyTeam(htName, homeTeam) && fuzzyTeam(atName, awayTeam)) h2h.push(entry);
      if (fuzzyTeam(htName, awayTeam) && fuzzyTeam(atName, homeTeam)) h2h.push(entry);
    }

    return { homeForm: homeForm.slice(0, 6), awayForm: awayForm.slice(0, 6), h2h: h2h.slice(0, 6), source: 'espn' };
  } catch(e) {
    console.error('[FORM/ESPN]', e.message);
    return { homeForm: [], awayForm: [], h2h: [] };
  }
}

// ─── FORM ORCHESTRATOR (Tier 0 → 1 → 2 → 3) ──────────────────────────────
async function getFormAndH2H(homeTeam, awayTeam, homeId, awayId, slug, league, fdorgMatchId) {
  console.log(`[FORM] ${homeTeam} vs ${awayTeam} | ${league}`);

  // Tier 0: localdb (football-data.co.uk CSVs — instant, no API call)
  try {
    const r = localdb.getLocalForm(homeTeam, awayTeam, league);
    if (r && (r.homeForm.length > 0 || r.awayForm.length > 0)) {
      console.log(`[FORM] localdb hit: home=${r.homeForm.length} away=${r.awayForm.length} h2h=${r.h2h.length}`);
      return r;
    }
  } catch(e) { console.error('[FORM] localdb err:', e.message); }

  // Tier 1: FDORG
  if (FDORG_KEY) {
    try {
      const r = await getFormFDOrg(homeTeam, awayTeam, league, fdorgMatchId);
      if (r && (r.homeForm.length > 0 || r.awayForm.length > 0)) {
        console.log(`[FORM] FDORG ok: home=${r.homeForm.length} away=${r.awayForm.length}`);
        return r;
      }
    } catch(e) { console.error('[FORM] FDORG err:', e.message); }
  }

  // Tier 2: API-Football
  try {
    const r = await Promise.race([
      getFormAPIFootball(homeTeam, awayTeam, league),
      new Promise(res => setTimeout(() => res(null), 8000)),
    ]);
    if (r && (r.homeForm.length > 0 || r.awayForm.length > 0)) {
      console.log(`[FORM] API-Football ok: home=${r.homeForm.length} away=${r.awayForm.length}`);
      return r;
    }
  } catch(e) { console.error('[FORM] API-Football err:', e.message); }

  // Tier 3: ESPN
  console.log(`[FORM] ESPN fallback for ${league}`);
  return getFormESPN(homeTeam, awayTeam, homeId, awayId, slug);
}

// ─── AI ANALYSIS (GROQ) ───────────────────────────────────────────────────
async function analyseWithAI(fixture, formData) {
  if (!GROQ_KEY) return null;

  const { homeTeam, awayTeam, league, odds } = fixture;
  const { homeForm = [], awayForm = [], h2h = [] } = formData || {};

  const isBlind = !homeForm.length && !awayForm.length;

  const fmtForm = form => form.slice(0, 5).map(f =>
    `${f.result} (${f.isHome ? 'vs' : '@'} ${f.isHome ? f.awayTeam : f.homeTeam} ${f.homeGoals}-${f.awayGoals})`
  ).join(', ') || 'No data';

  const fmtH2H = h2h.slice(0, 5).map(g =>
    `${g.homeTeam} ${g.homeGoals}-${g.awayGoals} ${g.awayTeam}`
  ).join(' | ') || 'No data';

  const oddsBlk = odds
    ? `Odds: Home=${odds.home?.toFixed(2)||'—'} Draw=${odds.draw?.toFixed(2)||'—'} Away=${odds.away?.toFixed(2)||'—'} O2.5=${odds.over25?.toFixed(2)||'—'} BTTS=${odds.bttsYes?.toFixed(2)||'—'}`
    : 'No odds available';

  const statsBlk = homeForm.length
    ? (() => {
        const avgGoals = arr => arr.length ? (arr.reduce((s, f) => s + (f.homeGoals + f.awayGoals), 0) / arr.length).toFixed(1) : '?';
        const winRate  = (arr, team) => arr.length ? Math.round(arr.filter(f => f.result === 'W').length / arr.length * 100) + '%' : '?';
        return `${homeTeam} last ${homeForm.length}: ${winRate(homeForm)} wins, avg ${avgGoals(homeForm)} goals/g | ${awayTeam} last ${awayForm.length}: ${winRate(awayForm)} wins, avg ${avgGoals(awayForm)} goals/g`;
      })()
    : '';

  // Team goal stats from localdb
  const localStatsHome = localdb.getTeamStats(homeTeam, league);
  const localStatsAway = localdb.getTeamStats(awayTeam, league);
  const localStatsBlk = (localStatsHome && localStatsAway)
    ? ` SEASON STATS (${localStatsHome.n} matches): ${homeTeam}: ${localStatsHome.avgScored} goals/g scored | ${localStatsHome.avgConceded} conceded | ${localStatsHome.avgShots} shots/g | ${localStatsHome.avgShotsT} on target | BTTS ${localStatsHome.bttsRate}% | O2.5 ${localStatsHome.over25Rate}% ${awayTeam}: ${localStatsAway.avgScored} goals/g scored | ${localStatsAway.avgConceded} conceded | ${localStatsAway.avgShots} shots/g | ${localStatsAway.avgShotsT} on target | BTTS ${localStatsAway.bttsRate}% | O2.5 ${localStatsAway.over25Rate}%`
    : '';

  const prompt = `Match: ${homeTeam} vs ${awayTeam} | League: ${league}
${oddsBlk}
${homeTeam} form: ${fmtForm(homeForm)}
${awayTeam} form: ${fmtForm(awayForm)}
H2H: ${fmtH2H}
${statsBlk}${localStatsBlk}
${isBlind ? 'NOTE: No live form data found. Use your training knowledge to estimate.' : ''}

Analyse this match and respond in this exact JSON format:
{
  "analysis": "2-3 sentence professional match analysis covering key factors",
  "reasoning": "1 sentence on why your pick has value vs the market",
  "tip": "Your recommended bet (e.g. 'Manchester City Win', 'Over 2.5 Goals', 'BTTS Yes', 'Draw No Bet Home')",
  "market": "h2h|totals|btts|dnb|asian_handicap|double_chance",
  "confidence": 55,
  "risk": "low|medium|high",
  "probs": {
    "home_win": 55, "draw": 25, "away_win": 20,
    "over15": 80, "under15": 20,
    "over25": 55, "under25": 45,
    "over35": 30, "under35": 70,
    "over45": 12,
    "btts_yes": 48, "btts_no": 52,
    "dc_home_draw": 70, "dc_away_draw": 45,
    "dnb_home": 68, "dnb_away": 40,
    "ah_home": 58, "ah_away": 42
  }
}`;

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: 'You are a professional football betting analyst. You study form, odds, and market value. Respond ONLY with valid JSON, no markdown, no preamble.' },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 800,
        temperature: 0.3,
      }),
      timeout: 15000,
    });
    if (!res.ok) { console.error('[AI] Groq error:', res.status); return null; }
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '{}';
    return { ...JSON.parse(text), is_blind: isBlind };
  } catch(e) {
    console.error('[AI]', e.message);
    return null;
  }
}

// ─── COMPUTE VALUE ────────────────────────────────────────────────────────
function computeValue(ai, odds) {
  if (!ai || !odds) return { has_value: false, best_odds: null, implied_prob: null, edge_pct: null, model_prob: null };

  const tipL = (ai.tip || '').toLowerCase();
  let best_odds = null, market_key = null;

  if (tipL.includes('draw')) { best_odds = odds.draw; market_key = 'draw'; }
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
  else if (tipL.includes('dnb') || tipL.includes('draw no bet')) {
    best_odds = tipL.includes('away') ? odds.dnbAway : odds.dnbHome;
  }
  else if (tipL.includes('asian')) {
    best_odds = tipL.includes('away') ? odds.ahAway : odds.ahHome;
  }
  else {
    // Result tip — home or away
    const words = tipL.split(' ').filter(w => w.length > 3);
    // If no draw/away keywords matched, assume home if win is mentioned
    best_odds = odds.home; // default
    if (tipL.includes('away') || (!tipL.includes('home') && !tipL.includes('win'))) {
      // Check if tip text looks more like away
    }
    // Better: check if tip contains away team fragment
    market_key = 'h2h';
  }

  if (!best_odds || best_odds <= 1) return { has_value: false, best_odds: null, implied_prob: null, edge_pct: null, model_prob: null };

  const implied_prob = Math.round(100 / best_odds);
  // Determine model prob from probs object
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
  const has_value = edge_pct >= 3;

  return { has_value, best_odds, implied_prob, edge_pct, model_prob };
}

// ─── LOAD FIXTURES FOR DATE ───────────────────────────────────────────────
async function loadFixtures(date) {
  const cached = fixtureCache[date];
  if (cached && Date.now() - cached.fetchedAt < FIXTURE_TTL) return cached.fixtures;

  console.log(`[FIXTURES] Fetching ${date}…`);
  const fixtures = await fetchAllFixtures(date);
  console.log(`[FIXTURES] Got ${fixtures.length} fixtures (FDORG + ESPN)`);

  // Enrich with odds sequentially to avoid rate limits
  const enriched = [];
  for (const f of fixtures) {
    try {
      const odds = await fetchOdds(f.homeTeam, f.awayTeam);
      enriched.push({ ...f, odds: odds || {}, hasOdds: !!odds });
    } catch(e) {
      enriched.push({ ...f, odds: {}, hasOdds: false });
    }
  }

  fixtureCache[date] = { fixtures: enriched, fetchedAt: Date.now() };
  return enriched;
}

// ─── ROUTES ───────────────────────────────────────────────────────────────

// GET /api/fixtures?date=YYYY-MM-DD
app.get('/api/fixtures', async (req, res) => {
  try {
    const date = req.query.date || today();
    const fixtures = await loadFixtures(date);
    res.json({ fixtures, date });
  } catch(e) {
    console.error('[GET /api/fixtures]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/match/:id
app.get('/api/match/:id', async (req, res) => {
  try {
    const id = req.params.id;

    // Check analysis cache first
    const cached = db.getCachedAnalysis(id);
    if (cached) {
      let h2h = [], homeForm = [], awayForm = [], probs = {};
      try { h2h = JSON.parse(cached.h2h || '[]'); } catch(e) {}
      try { homeForm = JSON.parse(cached.home_form || '[]'); } catch(e) {}
      try { awayForm = JSON.parse(cached.away_form || '[]'); } catch(e) {}
      try { probs = JSON.parse(cached.probs || '{}'); } catch(e) {}
      return res.json({
        id, ...cached,
        home_team: cached.home_team, away_team: cached.away_team,
        league: cached.league, fixture_date: cached.fixture_date,
        analysis: cached.analysis, tip: cached.tip,
        market: cached.market, best_odds: cached.odds,
        edge_pct: cached.edge_pct, model_prob: cached.model_prob,
        confidence: cached.confidence, reasoning: cached.reasoning,
        risk: cached.risk, h2h, home_form: homeForm, away_form: awayForm,
        probs, has_value: !!(cached.odds && cached.edge_pct >= 3),
        no_odds_tip: !cached.odds,
      });
    }

    // Find fixture in cache
    let fixture = null;
    for (const d of Object.keys(fixtureCache)) {
      fixture = fixtureCache[d].fixtures.find(f => String(f.id) === String(id));
      if (fixture) break;
    }

    // If not in cache, try fetching from FDORG directly by match id
    if (!fixture) {
      if (FDORG_KEY && id.startsWith && !id.toString().startsWith('espn-')) {
        try {
          const fdorgId = id.toString().replace('fdorg-', '');
          const r = await fetch(`https://api.football-data.org/v4/matches/${fdorgId}`, {
            headers: { 'X-Auth-Token': FDORG_KEY }, timeout: 6000,
          });
          if (r.ok) {
            const m = await r.json();
            const odds = await fetchOdds(m.homeTeam.name, m.awayTeam.name);
            fixture = {
              id, fdorgId: m.id,
              league: m.competition?.name || 'Unknown',
              homeTeam: m.homeTeam.name, awayTeam: m.awayTeam.name,
              homeLogo: m.homeTeam.crest || null, awayLogo: m.awayTeam.crest || null,
              homeId: m.homeTeam.id, awayId: m.awayTeam.id,
              date: m.utcDate, status: normFDOrgStatus(m.status),
              homeGoals: m.score?.fullTime?.home ?? null,
              awayGoals: m.score?.fullTime?.away ?? null,
              venue: m.venue || null,
              slug: (m.competition?.name || '').toLowerCase().replace(/\s+/g, '-'),
              fdorgMatchId: m.id,
              odds: odds || {}, hasOdds: !!odds,
            };
          }
        } catch(e) { console.error('[MATCH lookup/FDORG]', e.message); }
      }
      if (!fixture) return res.status(404).json({ error: 'Fixture not found' });
    }

    // Fetch form data
    const formData = await getFormAndH2H(
      fixture.homeTeam, fixture.awayTeam,
      fixture.homeId, fixture.awayId,
      fixture.slug, fixture.league, fixture.fdorgMatchId
    );

    // Run AI analysis
    const ai = await analyseWithAI(fixture, formData);
    const value = computeValue(ai, fixture.odds);

    const responseData = {
      id,
      home_team: fixture.homeTeam, away_team: fixture.awayTeam,
      home_logo: fixture.homeLogo, away_logo: fixture.awayLogo,
      league: fixture.league, fixture_date: fixture.date?.split('T')[0],
      status: fixture.status,
      home_goals: fixture.homeGoals, away_goals: fixture.awayGoals,
      venue: fixture.venue,
      odds: fixture.odds,
      home_form: formData?.homeForm || [],
      away_form: formData?.awayForm || [],
      h2h: formData?.h2h || [],
      analysis:   ai?.analysis   || null,
      reasoning:  ai?.reasoning  || null,
      tip:        ai?.tip        || null,
      market:     ai?.market     || 'h2h',
      confidence: ai?.confidence || null,
      risk:       ai?.risk       || null,
      probs:      ai?.probs      || {},
      is_blind:   ai?.is_blind   || false,
      ...value,
      no_odds_tip: !!(ai?.tip && !value.best_odds),
    };

    // Cache the analysis
    if (ai?.analysis) {
      db.cacheAnalysis({
        fixture_id:   id,
        home_team:    fixture.homeTeam,
        away_team:    fixture.awayTeam,
        league:       fixture.league,
        fixture_date: fixture.date?.split('T')[0],
        analysis:     ai.analysis,
        tip:          ai.tip,
        market:       ai.market,
        best_odds:    value.best_odds,
        edge_pct:     value.edge_pct,
        model_prob:   value.model_prob,
        confidence:   ai.confidence,
        reasoning:    ai.reasoning,
        risk:         ai.risk,
        h2h:          JSON.stringify(formData?.h2h || []),
        home_form:    JSON.stringify(formData?.homeForm || []),
        away_form:    JSON.stringify(formData?.awayForm || []),
        probs:        JSON.stringify(ai.probs || {}),
      });
    }

    res.json(responseData);
  } catch(e) {
    console.error('[GET /api/match/:id]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/bet
app.post('/api/bet', async (req, res) => {
  try {
    const bet = req.body;
    if (!bet.fixture_id || !bet.tip || !bet.odds) return res.status(400).json({ ok: false, reason: 'Missing required fields' });
    const result = db.placeBet(bet);
    if (!result) return res.json({ ok: false, reason: 'Insufficient bankroll or zero Kelly stake' });
    res.json({ ok: true, bet: result });
  } catch(e) {
    console.error('[POST /api/bet]', e.message);
    res.status(500).json({ ok: false, reason: e.message });
  }
});

// GET /api/bets
app.get('/api/bets', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const bets = db.getBets({ limit });
    res.json(bets);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/portfolio
app.get('/api/portfolio', (req, res) => {
  try {
    res.json(db.getStats());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/settle
app.post('/api/settle', async (req, res) => {
  try {
    const pending = db.getBets({ pending: true });
    let settled = 0;
    for (const bet of pending) {
      try {
        if (!FDORG_KEY) continue;
        const fdorgId = bet.fixture_id.toString().replace('fdorg-', '');
        const r = await fetch(`https://api.football-data.org/v4/matches/${fdorgId}`, {
          headers: { 'X-Auth-Token': FDORG_KEY }, timeout: 5000,
        });
        if (!r.ok) continue;
        const m = await r.json();
        if (m.status !== 'FINISHED') continue;
        const hg = m.score?.fullTime?.home, ag = m.score?.fullTime?.away;
        if (hg == null || ag == null) continue;
        const n = db.settleBet(bet.fixture_id, hg, ag);
        settled += n;
      } catch(e) { console.error('[SETTLE]', e.message); }
    }
    res.json({ settled });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/bankroll/reset
app.post('/api/bankroll/reset', (req, res) => {
  try {
    const amount = parseFloat(req.body.amount) || 1000;
    db.resetBankroll(amount);
    res.json({ ok: true, amount });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/status
app.get('/api/status', (req, res) => {
  try {
    const stats = db.getStats();
    res.json({
      hasAI:     !!GROQ_KEY,
      hasBSD:    !!process.env.BSD_API_KEY,
      bankroll:  stats.bankroll,
      totalBets: stats.totalBets,
      version:   VERSION,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/bsd-predictions
app.get('/api/bsd-predictions', async (req, res) => {
  try {
    if (!process.env.BSD_API_KEY) return res.json({ ok: false, error: 'BSD_API_KEY not set', predictions: [] });
    const predictions = await bsd.getPredictions();
    res.json({ ok: true, predictions });
  } catch(e) {
    console.error('[BSD-PREDICTIONS]', e.message);
    res.status(500).json({ ok: false, error: e.message, predictions: [] });
  }
});

// POST /api/bsd-predictions/refresh
app.post('/api/bsd-predictions/refresh', async (req, res) => {
  try {
    bsd.updateCache(); // fire and forget
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Catch-all: serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ─── STARTUP ──────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`[PROPRED] v${VERSION} running on port ${PORT}`);
  try {
    await loadFixtures(today());
    console.log('[PROPRED] Today\'s fixtures loaded');
  } catch(e) { console.error('[PROPRED] fixture preload failed:', e.message); }

  localdb.init(); // non-blocking — downloads CSVs in background

  if (process.env.BSD_API_KEY) {
    bsd.scheduleRefresh();
    console.log('[PROPRED] BSD predictions scheduled');
  }
});
