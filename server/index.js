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
// Map league name → Odds API sport key
const ODDS_SPORT_KEYS = {
  'premier league':    'soccer_epl',
  'championship':      'soccer_england_championship',
  'bundesliga':        'soccer_germany_bundesliga',
  'bundesliga 2':      'soccer_germany_bundesliga2',
  'serie a':           'soccer_italy_serie_a',
  'serie b':           'soccer_italy_serie_b',
  'la liga':           'soccer_spain_la_liga',
  'segunda division':  'soccer_spain_segunda_division',
  'ligue 1':           'soccer_france_ligue_one',
  'ligue 2':           'soccer_france_ligue_two',
  'eredivisie':        'soccer_netherlands_eredivisie',
  'primeira liga':     'soccer_portugal_primeira_liga',
  'champions league':  'soccer_uefa_champs_league',
  'europa league':     'soccer_uefa_europa_league',
  'mls':               'soccer_usa_mls',
  'liga mx':           'soccer_mexico_ligamx',
  'super lig':         'soccer_turkey_super_league',
  'scottish prem':     'soccer_scotland_premiership',
  'brasileirao':       'soccer_brazil_campeonato',
  'pro league':        'soccer_belgium_first_div',
};

// In-memory odds cache: sportKey → { events, fetchedAt }
const oddsCache = {};
const ODDS_TTL = 60 * 60 * 1000; // 1 hour

async function fetchOddsForLeague(league) {
  if (!ODDS_API_KEY) return [];
  const leagueKey = (league || '').toLowerCase();
  const sportKey = ODDS_SPORT_KEYS[leagueKey] || 'soccer_epl';

  // Return cached if fresh
  const cached = oddsCache[sportKey];
  if (cached && Date.now() - cached.fetchedAt < ODDS_TTL) return cached.events;

  try {
    const markets = 'h2h,totals';
    const res = await fetch(
      `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?apiKey=${ODDS_API_KEY}&regions=uk,eu&markets=${markets}&oddsFormat=decimal`,
      { timeout: 8000 }
    );
    if (!res.ok) {
      console.error(`[ODDS] ${sportKey} HTTP ${res.status}`);
      return [];
    }
    const events = await res.json();
    if (!Array.isArray(events)) return [];
    oddsCache[sportKey] = { events, fetchedAt: Date.now() };
    console.log(`[ODDS] ${sportKey} — ${events.length} events cached`);
    return events;
  } catch(e) {
    console.error('[ODDS]', e.message);
    return [];
  }
}

function parseOddsFromEvent(event, homeTeam, awayTeam) {
  if (!event) return null;
  const result = {};
  for (const bm of (event.bookmakers || [])) {
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
    }
    break; // first bookmaker only
  }
  return Object.keys(result).length ? result : null;
}

async function fetchOdds(homeTeam, awayTeam, league) {
  try {
    const events = await fetchOddsForLeague(league);
    const match = events.find(e =>
      (fuzzyTeam(e.home_team, homeTeam) && fuzzyTeam(e.away_team, awayTeam)) ||
      (fuzzyTeam(e.home_team, awayTeam) && fuzzyTeam(e.away_team, homeTeam))
    );
    return parseOddsFromEvent(match, homeTeam, awayTeam);
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

  // ── Split home/away form properly ─────────────────────────────────────
  const homeOnlyForm  = homeForm.filter(f => f.isHome);   // home team's HOME games
  const homeAwayForm  = homeForm.filter(f => !f.isHome);  // home team's AWAY games
  const awayHomeForm  = awayForm.filter(f => f.isHome);   // away team's HOME games
  const awayOnlyForm  = awayForm.filter(f => !f.isHome);  // away team's AWAY games

  // ── Stats helpers ──────────────────────────────────────────────────────
  const wins    = arr => arr.filter(f => f.result === 'W').length;
  const draws   = arr => arr.filter(f => f.result === 'D').length;
  const losses  = arr => arr.filter(f => f.result === 'L').length;
  const scored  = (arr, isH) => arr.length ? (arr.reduce((s,f) => s + (isH ? f.homeGoals : f.awayGoals), 0) / arr.length).toFixed(2) : '?';
  const conceded= (arr, isH) => arr.length ? (arr.reduce((s,f) => s + (isH ? f.awayGoals : f.homeGoals), 0) / arr.length).toFixed(2) : '?';
  const bttsArr = arr => arr.length ? Math.round(arr.filter(f => f.homeGoals > 0 && f.awayGoals > 0).length / arr.length * 100) : 0;
  const o25Arr  = arr => arr.length ? Math.round(arr.filter(f => f.homeGoals + f.awayGoals > 2).length / arr.length * 100) : 0;
  const o15Arr  = arr => arr.length ? Math.round(arr.filter(f => f.homeGoals + f.awayGoals > 1).length / arr.length * 100) : 0;
  const fmtResults = arr => arr.slice(0,6).map(f => `${f.result}(${f.homeGoals}-${f.awayGoals} vs ${f.isHome ? f.awayTeam : f.homeTeam})`).join(', ') || 'No data';

  // ── Build rich stats block ─────────────────────────────────────────────
  const localStatsHome = localdb.getTeamStats(homeTeam, league);
  const localStatsAway = localdb.getTeamStats(awayTeam, league);

  const homeStatsBlk = `
${homeTeam} HOME form (${homeOnlyForm.length} games): ${fmtResults(homeOnlyForm)}
  W${wins(homeOnlyForm)} D${draws(homeOnlyForm)} L${losses(homeOnlyForm)} | Scored: ${scored(homeOnlyForm, true)}/g | Conceded: ${conceded(homeOnlyForm, true)}/g | BTTS: ${bttsArr(homeOnlyForm)}% | O2.5: ${o25Arr(homeOnlyForm)}%
${homeTeam} AWAY form (${homeAwayForm.length} games): ${fmtResults(homeAwayForm)}
  W${wins(homeAwayForm)} D${draws(homeAwayForm)} L${losses(homeAwayForm)} | Scored: ${scored(homeAwayForm, false)}/g | Conceded: ${conceded(homeAwayForm, false)}/g | BTTS: ${bttsArr(homeAwayForm)}% | O2.5: ${o25Arr(homeAwayForm)}%`;

  const awayStatsBlk = `
${awayTeam} HOME form (${awayHomeForm.length} games): ${fmtResults(awayHomeForm)}
  W${wins(awayHomeForm)} D${draws(awayHomeForm)} L${losses(awayHomeForm)} | Scored: ${scored(awayHomeForm, true)}/g | Conceded: ${conceded(awayHomeForm, true)}/g | BTTS: ${bttsArr(awayHomeForm)}% | O2.5: ${o25Arr(awayHomeForm)}%
${awayTeam} AWAY form (${awayOnlyForm.length} games): ${fmtResults(awayOnlyForm)}
  W${wins(awayOnlyForm)} D${draws(awayOnlyForm)} L${losses(awayOnlyForm)} | Scored: ${scored(awayOnlyForm, false)}/g | Conceded: ${conceded(awayOnlyForm, false)}/g | BTTS: ${bttsArr(awayOnlyForm)}% | O2.5: ${o25Arr(awayOnlyForm)}%`;

  const seasonStatsBlk = (localStatsHome && localStatsAway) ? `
SEASON AVERAGES (all games):
${homeTeam}: scored ${localStatsHome.avgScored}/g | conceded ${localStatsHome.avgConceded}/g | shots ${localStatsHome.avgShots}/g | on target ${localStatsHome.avgShotsT}/g | BTTS ${localStatsHome.bttsRate}% | O2.5 ${localStatsHome.over25Rate}%
${awayTeam}: scored ${localStatsAway.avgScored}/g | conceded ${localStatsAway.avgConceded}/g | shots ${localStatsAway.avgShots}/g | on target ${localStatsAway.avgShotsT}/g | BTTS ${localStatsAway.bttsRate}% | O2.5 ${localStatsAway.over25Rate}%` : '';

  const h2hBlk = h2h.length
    ? `H2H last ${Math.min(h2h.length,5)}: ` + h2h.slice(0,5).map(g => `${g.homeTeam} ${g.homeGoals}-${g.awayGoals} ${g.awayTeam}`).join(' | ')
    : 'H2H: No data';

  // ── Odds block with implied probabilities ──────────────────────────────
  const imp = v => v && v > 1 ? Math.round(100/v) + '%' : '—';
  const oddsBlk = odds ? `
AVAILABLE ODDS & IMPLIED PROBABILITIES:
Home Win: ${odds.home?.toFixed(2)||'—'} (${imp(odds.home)}) | Draw: ${odds.draw?.toFixed(2)||'—'} (${imp(odds.draw)}) | Away Win: ${odds.away?.toFixed(2)||'—'} (${imp(odds.away)})
Over 1.5: ${odds.over15?.toFixed(2)||'—'} (${imp(odds.over15)}) | Under 1.5: ${odds.under15?.toFixed(2)||'—'} (${imp(odds.under15)})
Over 2.5: ${odds.over25?.toFixed(2)||'—'} (${imp(odds.over25)}) | Under 2.5: ${odds.under25?.toFixed(2)||'—'} (${imp(odds.under25)})
Over 3.5: ${odds.over35?.toFixed(2)||'—'} (${imp(odds.over35)}) | Under 3.5: ${odds.under35?.toFixed(2)||'—'} (${imp(odds.under35)})
BTTS Yes: ${odds.bttsYes?.toFixed(2)||'—'} (${imp(odds.bttsYes)}) | BTTS No: ${odds.bttsNo?.toFixed(2)||'—'} (${imp(odds.bttsNo)})
DC Home/Draw: ${odds.dc1X?.toFixed(2)||'—'} (${imp(odds.dc1X)}) | DC Away/Draw: ${odds.dcX2?.toFixed(2)||'—'} (${imp(odds.dcX2)})
DNB Home: ${odds.dnbHome?.toFixed(2)||'—'} (${imp(odds.dnbHome)}) | DNB Away: ${odds.dnbAway?.toFixed(2)||'—'} (${imp(odds.dnbAway)})` 
    : 'ODDS: Not available — give AI pick only';

  const prompt = `You are a sharp football betting analyst. Analyse this match like a professional punter who understands value, momentum, and market inefficiencies.

MATCH: ${homeTeam} vs ${awayTeam} (${homeTeam} is HOME)
LEAGUE: ${league}
${oddsBlk}
${homeStatsBlk}
${awayStatsBlk}
${seasonStatsBlk}
${h2hBlk}
${isBlind ? 'WARNING: No form data available. Use general knowledge but mark as speculative.' : ''}

INSTRUCTIONS:
1. Analyse home form vs away form separately — they are different signals
2. Consider ALL these markets and pick the single best one:
   - HOME WIN / AWAY WIN / DRAW
   - OVER 1.5 / OVER 2.5 / OVER 3.5 / OVER 4.5 goals
   - UNDER 1.5 / UNDER 2.5 / UNDER 3.5 goals
   - BTTS YES / BTTS NO
   - DOUBLE CHANCE (Home or Draw / Away or Draw)
   - DRAW NO BET (Home / Away)
3. Pick the line that data BEST supports — if Over 2.5 rate is 65% pick Over 2.5, if it's only 45% pick Over 1.5
4. If a team is clearly dominant at home with strong defence, a straight Home Win may beat Double Chance value
5. If both teams score consistently (BTTS 65%+), BTTS Yes may be the pick regardless of result
6. Low-scoring teams with under 1.5 goals in most matches → Under 2.5 or Under 1.5 could be the pick
7. A team winning 70%+ of away games → Away Win straight up is valid
8. Be intentional — follow what the stats show, not what feels safe
9. If odds unavailable, still give best pick based on data alone

Respond ONLY in this exact JSON format:
{
  "analysis": "3 sentences: (1) home team strength/weakness at home, (2) away team strength/weakness on the road, (3) key matchup factor that drives your pick",
  "reasoning": "1 sentence explaining why your pick has value — reference specific stats or odds",
  "tip": "exact pick e.g. 'Over 2.5 Goals' or 'Chelsea Win' or 'BTTS Yes' or 'Draw No Bet - Arsenal' or 'Double Chance - Newcastle or Draw'",
  "market": "h2h|totals|btts|dnb|double_chance",
  "confidence": 62,
  "risk": "low|medium|high",
  "probs": {
    "home_win": 45, "draw": 28, "away_win": 27,
    "over15": 82, "under15": 18,
    "over25": 58, "under25": 42,
    "over35": 32, "under35": 68,
    "over45": 14,
    "btts_yes": 55, "btts_no": 45,
    "dc_home_draw": 73, "dc_away_draw": 55,
    "dnb_home": 62, "dnb_away": 40,
    "ah_home": 52, "ah_away": 48
  }
}`;

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [
          { role: 'system', content: 'You are a sharp football betting analyst. You think like a professional punter — you look for value across all markets, not just match results. You understand home/away performance differences, goals trends, and when to back unders vs overs. Respond ONLY with valid JSON, no markdown, no preamble.' },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 1000,
        temperature: 0.2,
      }),
      timeout: 20000,
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
  if (!ai) return { has_value: false, best_odds: null, implied_prob: null, edge_pct: null, model_prob: null };

  const tipL = (ai.tip || '').toLowerCase();
  const p = ai.probs || {};
  const o = odds || {};

  let best_odds = null;
  let model_prob = ai.confidence || 55;

  // Match tip to correct odds and model probability
  if (tipL.includes('over 4.5'))                          { best_odds = o.over45;   model_prob = p.over45   || model_prob; }
  else if (tipL.includes('under 4.5'))                    { best_odds = o.under45;  model_prob = 100 - (p.over45||0) || model_prob; }
  else if (tipL.includes('over 3.5'))                     { best_odds = o.over35;   model_prob = p.over35   || model_prob; }
  else if (tipL.includes('under 3.5'))                    { best_odds = o.under35;  model_prob = p.under35  || model_prob; }
  else if (tipL.includes('over 2.5'))                     { best_odds = o.over25;   model_prob = p.over25   || model_prob; }
  else if (tipL.includes('under 2.5'))                    { best_odds = o.under25;  model_prob = p.under25  || model_prob; }
  else if (tipL.includes('over 1.5'))                     { best_odds = o.over15;   model_prob = p.over15   || model_prob; }
  else if (tipL.includes('under 1.5'))                    { best_odds = o.under15;  model_prob = p.under15  || model_prob; }
  else if (tipL.includes('btts') && tipL.includes('no'))  { best_odds = o.bttsNo;   model_prob = p.btts_no  || model_prob; }
  else if (tipL.includes('btts'))                         { best_odds = o.bttsYes;  model_prob = p.btts_yes || model_prob; }
  else if (tipL.includes('draw no bet') || tipL.includes('dnb')) {
    if (tipL.includes('away')) { best_odds = o.dnbAway; model_prob = p.dnb_away || model_prob; }
    else                       { best_odds = o.dnbHome; model_prob = p.dnb_home || model_prob; }
  }
  else if (tipL.includes('double chance') || tipL.includes('or draw')) {
    if (tipL.includes('away')) { best_odds = o.dcX2; model_prob = p.dc_away_draw || model_prob; }
    else                       { best_odds = o.dc1X; model_prob = p.dc_home_draw || model_prob; }
  }
  else if (tipL === 'draw' || tipL.endsWith(' draw')) {
    best_odds = o.draw; model_prob = p.draw || model_prob;
  }
  else {
    // Result market — figure out home vs away from tip text
    const awayName = (ai.away_team || '').toLowerCase();
    const homeName = (ai.home_team || '').toLowerCase();
    const awayWords = awayName.split(' ').filter(w => w.length > 3);
    const homeWords = homeName.split(' ').filter(w => w.length > 3);
    const isAwayTip = awayWords.some(w => tipL.includes(w));
    const isHomeTip = homeWords.some(w => tipL.includes(w)) || tipL.includes('home');
    if (isAwayTip && !isHomeTip) { best_odds = o.away; model_prob = p.away_win || model_prob; }
    else                          { best_odds = o.home; model_prob = p.home_win || model_prob; }
  }

  if (!best_odds || best_odds <= 1) {
    // No odds available but we still have a tip — mark as no_odds_tip
    return { has_value: false, best_odds: null, implied_prob: null, edge_pct: null, model_prob };
  }

  const implied_prob = Math.round(100 / best_odds);
  const edge_pct = Math.round(model_prob - implied_prob);
  const has_value = edge_pct >= 4;

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
      const odds = await fetchOdds(f.homeTeam, f.awayTeam, f.league);
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
            const odds = await fetchOdds(m.homeTeam.name, m.awayTeam.name, m.competition?.name);
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


// GET /api/debug/team?name=Arsenal&league=Premier+League
app.get('/api/debug/team', async (req, res) => {
  try {
    const { name, league } = req.query;
    if (!name || !league) return res.status(400).json({ error: 'name and league required' });
    const form = localdb.getLocalForm(name, name, league);
    const stats = localdb.getTeamStats(name, league);
    res.json({ form, stats });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/debug/db
app.get('/api/debug/db', (req, res) => {
  try {
    const Database = require('better-sqlite3');
    const path = require('path');
    const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
    const ldb = new Database(path.join(DATA_DIR, 'localform.db'));
    const count = ldb.prepare("SELECT COUNT(*) as n FROM matches").get();
    const leagues = ldb.prepare("SELECT league, season, COUNT(*) as n FROM matches GROUP BY league, season ORDER BY league, season").all();
    const lastRefresh = ldb.prepare("SELECT value FROM meta WHERE key='last_refresh'").get();
    ldb.close();
    res.json({ totalMatches: count.n, lastRefresh: lastRefresh?.value, leagues });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// POST /api/debug/clear-cache
app.post('/api/debug/clear-cache', (req, res) => {
  try {
    const Database = require('better-sqlite3');
    const path = require('path');
    const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
    const mdb = new Database(path.join(DATA_DIR, 'propred.db'));
    const result = mdb.prepare('DELETE FROM analysis_cache').run();
    mdb.close();
    fixtureCache = {}; // clear in-memory fixture cache too
    res.json({ ok: true, deleted: result.changes });
  } catch(e) { res.status(500).json({ error: e.message }); }
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
