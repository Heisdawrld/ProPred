'use strict';

const express  = require('express');
const fetch    = require('node-fetch');
const path     = require('path');
const db       = require('./db');

const app  = express();
const PORT = process.env.PORT || 10000;
const AI_KEY       = (process.env.ANTHROPIC_KEY || '').trim();
const GEMINI_KEY   = (process.env.GEMINI_KEY || '').trim();
const GROQ_KEY     = (process.env.GROQ_KEY || '').trim();
const FOOTBALL_KEY = process.env.API_FOOTBALL_KEY || '';
const ODDS_KEY     = process.env.ODDS_API_KEY || '';

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

let fixtureStore = {};
let lastFetchDate = null;

const today = () => new Date().toISOString().split('T')[0];

const LEAGUE_MAP = {
  'eng.1':          'Premier League',
  'eng.2':          'Championship',
  'esp.1':          'La Liga',
  'ger.1':          'Bundesliga',
  'ita.1':          'Serie A',
  'fra.1':          'Ligue 1',
  'ned.1':          'Eredivisie',
  'tur.1':          'Super Lig',
  'sco.1':          'Scottish Prem',
  'por.1':          'Primeira Liga',
  'uefa.champions': 'Champions League',
  'uefa.europa':    'Europa League',
  'mex.1':          'Liga MX',
  'usa.1':          'MLS',
  'bra.1':          'Brasileirao',
  'arg.1':          'Primera Division',
  'eng.league_cup': 'EFL Cup',
  'ger.2':          'Bundesliga 2',
  'esp.2':          'Segunda Division',
  'ita.2':          'Serie B',
  'fra.2':          'Ligue 2',
  'bel.1':          'Pro League',
  'por.2':          'Segunda Liga',
};

const ODDS_MAP = {
  'Premier League':   'soccer_epl',
  'Championship':     'soccer_efl_champ',
  'La Liga':          'soccer_spain_la_liga',
  'Bundesliga':       'soccer_germany_bundesliga',
  'Serie A':          'soccer_italy_serie_a',
  'Ligue 1':          'soccer_france_ligue_one',
  'Eredivisie':       'soccer_netherlands_eredivisie',
  'Champions League': 'soccer_uefa_champs_league',
  'Europa League':    'soccer_uefa_europa_league',
  'Scottish Prem':    'soccer_scotland_premiership',
};

// ── ESPN ───────────────────────────────────────────────────────────────────
async function fetchESPN(date) {
  const fixtures = [];
  for (const [slug, name] of Object.entries(LEAGUE_MAP)) {
    try {
      const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/scoreboard?dates=${date.replace(/-/g,'')}`;
      const res  = await fetch(url);
      const json = await res.json();
      const events = json.events || [];
      console.log(`[ESPN] ${name}: ${events.length}`);
      for (const ev of events) {
        const comp = ev.competitions?.[0];
        if (!comp) continue;
        const home = comp.competitors?.find(c=>c.homeAway==='home');
        const away = comp.competitors?.find(c=>c.homeAway==='away');
        if (!home || !away) continue;
        fixtures.push({
          id:         String(ev.id),
          league:     name,
          leagueSlug: slug,
          leagueLogo: `https://a.espncdn.com/i/leaguelogos/soccer/500/${slug}.png`,
          date:       comp.date,
          homeTeam:   home.team.displayName,
          awayTeam:   away.team.displayName,
          homeEspnId: home.team.id,
          awayEspnId: away.team.id,
          homeLogo:   home.team.logo,
          awayLogo:   away.team.logo,
          homeGoals:  home.score != null ? parseInt(home.score) : null,
          awayGoals:  away.score != null ? parseInt(away.score) : null,
          status:     comp.status?.type?.shortDetail || 'NS',
          venue:      comp.venue?.fullName || '',
          hasOdds:    false,
          odds:       {},
        });
      }
    } catch(e) { console.error(`[ESPN] ${name}:`, e.message); }
  }
  return fixtures;
}

// ── ODDS ───────────────────────────────────────────────────────────────────
async function fetchOddsForFixtures(fixtures) {
  if (!ODDS_KEY) return;
  const leagues = [...new Set(fixtures.map(f=>f.league))];
  for (const league of leagues) {
    const sport = ODDS_MAP[league];
    if (!sport) continue;
    try {
      const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${ODDS_KEY}&regions=uk&markets=h2h,totals&oddsFormat=decimal`;
      const res  = await fetch(url);
      const json = await res.json();
      if (!Array.isArray(json)) continue;
      for (const game of json) {
        const norm = s => (s||'').toLowerCase().replace(/[^a-z0-9]/g,' ').trim();
        const match = fixtures.find(f =>
          f.league === league &&
          (norm(f.homeTeam).split(' ')[0] === norm(game.home_team).split(' ')[0])
        );
        if (!match) continue;
        const bk  = game.bookmakers?.[0];
        if (!bk) continue;
        const h2h = bk.markets?.find(m=>m.key==='h2h');
        const tot = bk.markets?.find(m=>m.key==='totals');
        if (h2h) {
          match.odds.home = h2h.outcomes?.find(o=>o.name===game.home_team)?.price || h2h.outcomes?.[0]?.price;
          match.odds.draw = h2h.outcomes?.find(o=>o.name==='Draw')?.price;
          match.odds.away = h2h.outcomes?.find(o=>o.name===game.away_team)?.price || h2h.outcomes?.[2]?.price;
          match.hasOdds   = true;
        }
        if (tot) {
          match.odds.over25  = tot.outcomes?.find(o=>o.name==='Over'  && o.point===2.5)?.price;
          match.odds.under25 = tot.outcomes?.find(o=>o.name==='Under' && o.point===2.5)?.price;
        }
      }
    } catch(e) { console.error(`[ODDS] ${league}:`, e.message); }
  }
}


// ── FDORG MATCH ID ENRICHMENT ──────────────────────────────────────────────
// Fetches today's matches from football-data.org and matches them to ESPN fixtures
// This gives us fdorgMatchId needed for the proper H2H endpoint
async function enrichWithFDOrgIds(fixtures, date) {
  try {
    const headers = { 'X-Auth-Token': FDORG_KEY };
    // Get all matches for today across subscribed competitions
    const res = await fetch(`https://api.football-data.org/v4/matches?dateFrom=${date}&dateTo=${date}`, { headers });
    if (!res.ok) { console.log('[FDORG-IDS] Failed:', res.status); return; }
    const data = await res.json();
    const fdMatches = data.matches || [];
    console.log(`[FDORG-IDS] Found ${fdMatches.length} matches for ${date}`);

    let matched = 0;
    for (const fx of fixtures) {
      const homeW = fx.homeTeam.toLowerCase().split(' ')[0];
      const awayW = fx.awayTeam.toLowerCase().split(' ')[0];
      const fdMatch = fdMatches.find(m => {
        const fh = (m.homeTeam?.shortName || m.homeTeam?.name || '').toLowerCase();
        const fa = (m.awayTeam?.shortName || m.awayTeam?.name || '').toLowerCase();
        return (fh.includes(homeW) || homeW.includes(fh.split(' ')[0])) &&
               (fa.includes(awayW) || awayW.includes(fa.split(' ')[0]));
      });
      if (fdMatch) {
        fx.fdorgMatchId = fdMatch.id;
        fx.fdorgHomeId = fdMatch.homeTeam?.id;
        fx.fdorgAwayId = fdMatch.awayTeam?.id;
        matched++;
      }
    }
    console.log(`[FDORG-IDS] Matched ${matched}/${fixtures.length} fixtures`);
  } catch(e) { console.error('[FDORG-IDS] Error:', e.message); }
}

async function loadFixtures(date) {
  const fixtures = await fetchESPN(date);
  await fetchOddsForFixtures(fixtures);
  if (FDORG_KEY) await enrichWithFDOrgIds(fixtures, date);
  fixtureStore = {};
  for (const f of fixtures) fixtureStore[f.id] = f;
  lastFetchDate = date;
  console.log(`[STORE] ${fixtures.length} fixtures loaded`);
  return fixtures;
}

// ── AI ANALYSIS ────────────────────────────────────────────────────────────
async function analyseWithAI(homeTeam, awayTeam, league, odds, h2h=[], homeForm=[], awayForm=[]) {
  const hasOdds = odds?.home != null;
  const hasForm = homeForm.length > 0 && awayForm.length > 0;
  const hasH2H  = h2h.length > 0;

  // Format odds string with ALL available lines
  const oddsStr = hasOdds
    ? [
        `Home Win (${homeTeam}): ${odds.home}`,
        `Draw: ${odds.draw}`,
        `Away Win (${awayTeam}): ${odds.away}`,
        odds.over25  ? `Over 2.5 Goals: ${odds.over25}`  : null,
        odds.under25 ? `Under 2.5 Goals: ${odds.under25}` : null,
      ].filter(Boolean).join(' | ')
    : 'No odds available — use your knowledge to estimate';

  // Format form with location, opponent and score
  const fmtForm = (form) => {
    if (!form?.length) return 'No data from API';
    return form.slice(0,6).map(f => {
      const loc = f.isHome ? 'HOME' : 'AWAY';
      const opp = f.isHome ? f.awayTeam : f.homeTeam;
      const score = `${f.homeGoals??'?'}-${f.awayGoals??'?'}`;
      return `${f.result} ${loc} vs ${opp} (${score}) ${f.date||''}`;
    }).join('\n    ');
  };

  // Compute goal stats
  const goalStats = (form) => {
    if (!form?.length) return null;
    const valid = form.filter(f => f.homeGoals != null && f.awayGoals != null);
    if (!valid.length) return null;
    const scored   = valid.map(f => f.isHome ? f.homeGoals : f.awayGoals);
    const conceded = valid.map(f => f.isHome ? f.awayGoals : f.homeGoals);
    const totalGoals = valid.map(f => f.homeGoals + f.awayGoals);
    const avg_scored   = (scored.reduce((a,b)=>a+b,0)/valid.length).toFixed(2);
    const avg_conceded = (conceded.reduce((a,b)=>a+b,0)/valid.length).toFixed(2);
    const avg_total    = (totalGoals.reduce((a,b)=>a+b,0)/valid.length).toFixed(2);
    const btts   = valid.filter(f => f.homeGoals > 0 && f.awayGoals > 0).length;
    const over25 = valid.filter(f => f.homeGoals + f.awayGoals > 2).length;
    const over15 = valid.filter(f => f.homeGoals + f.awayGoals > 1).length;
    const cleanSheets = valid.filter(f => f.isHome ? f.awayGoals === 0 : f.homeGoals === 0).length;
    return { avg_scored, avg_conceded, avg_total, btts, over25, over15, cleanSheets, n: valid.length };
  };

  const hS = goalStats(homeForm);
  const aS = goalStats(awayForm);
  const h2hGoals = h2h.filter(m => m.homeGoals != null).map(m => m.homeGoals + m.awayGoals);
  const h2hAvg = h2hGoals.length ? (h2hGoals.reduce((a,b)=>a+b,0)/h2hGoals.length).toFixed(2) : null;
  const h2hBTTS = h2h.filter(m => m.homeGoals > 0 && m.awayGoals > 0).length;

  const statsBlock = (hS && aS) ? `
COMPUTED STATS (from actual match data):
${homeTeam}: avg scored ${hS.avg_scored} | avg conceded ${hS.avg_conceded} | avg total goals ${hS.avg_total} | BTTS ${hS.btts}/${hS.n} | Over 2.5: ${hS.over25}/${hS.n} | Over 1.5: ${hS.over15}/${hS.n} | Clean sheets: ${hS.cleanSheets}/${hS.n}
${awayTeam}: avg scored ${aS.avg_scored} | avg conceded ${aS.avg_conceded} | avg total goals ${aS.avg_total} | BTTS ${aS.btts}/${aS.n} | Over 2.5: ${aS.over25}/${aS.n} | Over 1.5: ${aS.over15}/${aS.n} | Clean sheets: ${aS.cleanSheets}/${aS.n}
H2H avg goals: ${h2hAvg||'N/A'} | H2H BTTS: ${h2hBTTS}/${h2h.length}` : '';

  const formNote = !hasForm
    ? `NOTE: No recent form data available from API. Use your extensive knowledge of ${homeTeam} and ${awayTeam} — their current season form, playing style, goals scored/conceded, typical match patterns in ${league}. Make a confident pick based on what you know.`
    : '';

  const prompt = `You are a professional football betting analyst who makes money finding value bets. You are sharp, decisive and back your opinion with reasoning.

MATCH: ${homeTeam} vs ${awayTeam}
COMPETITION: ${league}

BOOKMAKER ODDS:
${oddsStr}

${homeTeam} RECENT FORM (newest first):
    ${fmtForm(homeForm)}

${awayTeam} RECENT FORM (newest first):
    ${fmtForm(awayForm)}

HEAD TO HEAD (most recent first):
${h2h.length ? h2h.slice(0,6).map(m=>`  ${m.date||''}: ${m.homeTeam} ${m.homeGoals??'?'}-${m.awayGoals??'?'} ${m.awayTeam}`).join('\n') : '  No H2H data'}
${statsBlock}
${formNote}

YOUR JOB: Pick ONE bet with the highest probability of winning. Think like a sharp bettor who only bets when they have real conviction.

AVAILABLE BETS (choose exactly one):
- "${homeTeam} Win"
- "Draw"  
- "${awayTeam} Win"
- "Over 1.5 Goals"   ← covers ~75% of matches globally
- "Over 2.5 Goals"   ← covers ~55% of matches
- "Under 2.5 Goals"  ← only pick if you genuinely expect a tight low-scoring game
- "Both Teams to Score"      ← pick when both teams regularly score AND concede
- "Both Teams NOT to Score"  ← only if one team has very strong defence
- "${homeTeam} or Draw"
- "${awayTeam} or Draw"

RULES:
1. If BTTS stat shows 4+/5 for both teams → "Both Teams to Score" is your pick
2. If avg total goals > 2.7 → "Over 2.5 Goals" is likely
3. If avg total goals > 1.8 → "Over 1.5 Goals" is very safe
4. If one team is clearly stronger (odds gap > 0.8) → pick their Win or Double Chance
5. "Under 2.5" is ONLY valid if clean sheet rate is high AND avg goals < 2.2
6. NEVER pick "Under 2.5" just because you lack data — use your football knowledge instead
7. DO NOT hedge. Pick ONE market with conviction.

Return ONLY this JSON (no markdown, no explanation outside JSON):
{
  "tip": "exact bet from the list above",
  "market": "h2h|totals|btts|dc",
  "summary": "2-3 sentences: describe both teams current form and why this match sets up the way it does",
  "reasoning": "1 sentence: the specific stat or fact that makes this bet the right pick",
  "confidence": 72,
  "model_prob": 74,
  "risk": "low|medium|high"
}`;

  // Try Groq first (free, no credit card)
  if (GROQ_KEY) {
    console.log('[AI] Calling Groq...');
    try {
      const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: 'You are an expert football betting analyst. You have deep knowledge of Premier League, La Liga, Bundesliga, Serie A and other European leagues. You know each team\'s playing style, typical formations, attacking and defensive tendencies. Always respond with valid JSON only.' },
            { role: 'user', content: prompt }
          ],
          max_tokens: 600, temperature: 0.4,
        }),
      });
      const data = await resp.json();
      console.log('[AI] Groq status:', resp.status, '| Body:', JSON.stringify(data).slice(0, 300));
      if (resp.status !== 200) { console.error('[AI] Groq error:', data); }
      else {
        const text = (data.choices?.[0]?.message?.content || '').trim();
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          console.log('[AI] Groq success:', parsed.tip);
          return parsed;
        }
      }
    } catch(e) { console.error('[AI] Groq exception:', e.message); }
  }

  // Try Gemini
  if (GEMINI_KEY) {
    console.log('[AI] Calling Gemini...');
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_KEY}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 512 } }),
      });
      const data = await resp.json();
      console.log('[AI] Gemini status:', resp.status);
      if (resp.status === 200) {
        const text = (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) { const parsed = JSON.parse(jsonMatch[0]); console.log('[AI] Gemini success:', parsed.tip); return parsed; }
      }
    } catch(e) { console.error('[AI] Gemini exception:', e.message); }
  }

  // Try Claude
  if (AI_KEY) {
    console.log('[AI] Calling Claude...');
    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': AI_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 512, messages: [{ role: 'user', content: prompt }] }),
      });
      const data = await resp.json();
      console.log('[AI] Claude status:', resp.status);
      if (resp.status === 200) {
        const text = (data.content?.[0]?.text || '').trim();
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) { const parsed = JSON.parse(jsonMatch[0]); console.log('[AI] Claude success:', parsed.tip); return parsed; }
      }
    } catch(e) { console.error('[AI] Claude exception:', e.message); }
  }

  console.log('[AI] All providers failed');
  return null;
}


// ── FOOTBALL-DATA.ORG FORM + H2H ─────────────────────────────────────────────
// Maps league names to football-data.org competition codes
const FDORG_KEY = (process.env.FDORG_KEY || '').trim();

const LEAGUE_TO_FDORG = {
  'Premier League': 'PL',
  'La Liga': 'PD',
  'Bundesliga': 'BL1',
  'Serie A': 'SA',
  'Ligue 1': 'FL1',
  'Champions League': 'CL',
  'UEFA Champions League': 'CL',
  'Europa League': 'EL',
  'UEFA Europa League': 'EL',
  'Championship': 'ELC',
  'Eredivisie': 'DED',
  'Primeira Liga': 'PPL',
};

async function getFormAndH2H(homeTeam, awayTeam, homeEspnId, awayEspnId, leagueSlug, league, fdorgMatchId) {
  // Try football-data.org first if key is set
  if (FDORG_KEY) {
    try {
      const result = await getFormFDOrg(homeTeam, awayTeam, league, fdorgMatchId);
      if (result.homeForm.length > 0 || result.awayForm.length > 0) {
        console.log(`[FDORG] ${homeTeam}: ${result.homeForm.length} | ${awayTeam}: ${result.awayForm.length} | H2H: ${result.h2h.length}`);
        return result;
      }
    } catch(e) { console.error('[FDORG] Error:', e.message); }
  }

  // Fallback: ESPN team schedule
  if (!homeEspnId || !awayEspnId || !leagueSlug) return { h2h: [], homeForm: [], awayForm: [] };
  try {
    const [hRes, aRes] = await Promise.all([
      fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${leagueSlug}/teams/${homeEspnId}/schedule`),
      fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${leagueSlug}/teams/${awayEspnId}/schedule`),
    ]);
    const hData = await hRes.json();
    const aData = await aRes.json();

    console.log(`[ESPN-FORM] home events: ${hData.events?.length||0} away events: ${aData.events?.length||0}`);

    const parseForm = (data, teamId) => {
      const all = data.events || [];
      const finished = all.filter(ev => {
        const s = ev.competitions?.[0]?.status?.type;
        return s?.completed === true || s?.description === 'Final' || s?.shortDetail === 'FT';
      });
      return finished.slice(-6).reverse().slice(0,5).map(ev => {
        const comp = ev.competitions[0];
        const home = comp.competitors?.find(c => c.homeAway === 'home');
        const away = comp.competitors?.find(c => c.homeAway === 'away');
        const isHome = String(home?.team?.id) === String(teamId);
        const hG = home?.score != null ? parseInt(home.score) : null;
        const aG = away?.score != null ? parseInt(away.score) : null;
        const gf = isHome ? hG : aG;
        const ga = isHome ? aG : hG;
        const result = gf == null ? null : gf > ga ? 'W' : gf < ga ? 'L' : 'D';
        return { date: comp.date?.split('T')[0], homeTeam: home?.team?.displayName, awayTeam: away?.team?.displayName, homeGoals: hG, awayGoals: aG, isHome, result };
      });
    };

    const homeForm = parseForm(hData, homeEspnId);
    const awayForm = parseForm(aData, awayEspnId);
    const allHomeEvents = (hData.events||[]).filter(ev => ev.competitions?.[0]?.status?.type?.completed);
    const h2h = allHomeEvents.filter(ev => ev.competitions[0].competitors.some(c => String(c.team?.id) === String(awayEspnId)))
      .slice(-5).map(ev => {
        const comp = ev.competitions[0];
        const home = comp.competitors.find(c => c.homeAway === 'home');
        const away = comp.competitors.find(c => c.homeAway === 'away');
        return { date: comp.date?.split('T')[0], homeTeam: home?.team?.displayName, awayTeam: away?.team?.displayName, homeGoals: home?.score != null ? parseInt(home.score) : null, awayGoals: away?.score != null ? parseInt(away.score) : null };
      });

    console.log(`[ESPN-FORM] parsed - ${homeTeam}: ${homeForm.length} | ${awayTeam}: ${awayForm.length} | H2H: ${h2h.length}`);
    return { h2h, homeForm, awayForm };
  } catch(e) {
    console.error('[FORM] ESPN fallback error:', e.message);
    return { h2h: [], homeForm: [], awayForm: [] };
  }
}

// Cache team lookups to avoid hammering the API
const fdorgTeamCache = {};

async function getFormFDOrg(homeTeam, awayTeam, league, fdorgMatchId) {
  const code = LEAGUE_TO_FDORG[league];
  if (!code) { console.log(`[FDORG] No code for league: ${league}`); return { h2h: [], homeForm: [], awayForm: [] }; }

  const headers = { 'X-Auth-Token': FDORG_KEY };

  // Get teams list (cached per competition)
  if (!fdorgTeamCache[code]) {
    const teamsRes = await fetch(`https://api.football-data.org/v4/competitions/${code}/teams`, { headers });
    if (!teamsRes.ok) throw new Error(`FDORG teams ${code}: ${teamsRes.status}`);
    fdorgTeamCache[code] = await teamsRes.json();
  }
  const teamsData = fdorgTeamCache[code];

  const findTeam = (name) => {
    const nl = name.toLowerCase().replace(/[^a-z0-9 ]/g, '');
    const words = nl.split(' ').filter(w => w.length > 2);
    return teamsData.teams?.find(t => {
      const tn = (t.name||'').toLowerCase().replace(/[^a-z0-9 ]/g, '');
      const sn = (t.shortName||'').toLowerCase().replace(/[^a-z0-9 ]/g, '');
      const tla = (t.tla||'').toLowerCase();
      // Exact match first
      if (tn === nl || sn === nl) return true;
      // Any significant word match
      return words.some(w => tn.includes(w) || sn.includes(w));
    });
  };

  const homeObj = findTeam(homeTeam);
  const awayObj = findTeam(awayTeam);
  console.log(`[FDORG] ${homeTeam} → ${homeObj?.name||'NO MATCH'} | ${awayTeam} → ${awayObj?.name||'NO MATCH'}`);
  if (!homeObj || !awayObj) return { h2h: [], homeForm: [], awayForm: [] };

  // Fetch form for both teams (last 8 finished matches) + H2H via match endpoint
  const [hRes, aRes] = await Promise.all([
    fetch(`https://api.football-data.org/v4/teams/${homeObj.id}/matches?status=FINISHED&limit=8`, { headers }),
    fetch(`https://api.football-data.org/v4/teams/${awayObj.id}/matches?status=FINISHED&limit=8`, { headers }),
  ]);
  const [hData, aData] = await Promise.all([hRes.json(), aRes.json()]);

  const parseForm = (data, teamId) => {
    const matches = (data.matches || [])
      .filter(m => m.score?.fullTime?.home != null) // only matches with scores
      .sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate)) // newest first
      .slice(0, 5);
    return matches.map(m => {
      const isHome = m.homeTeam?.id === teamId;
      const hG = m.score.fullTime.home;
      const aG = m.score.fullTime.away;
      const gf = isHome ? hG : aG;
      const ga = isHome ? aG : hG;
      const result = gf > ga ? 'W' : gf < ga ? 'L' : 'D';
      return {
        date: m.utcDate?.split('T')[0],
        homeTeam: m.homeTeam?.shortName || m.homeTeam?.name,
        awayTeam: m.awayTeam?.shortName || m.awayTeam?.name,
        homeGoals: hG, awayGoals: aG, isHome, result,
        competition: m.competition?.name,
      };
    });
  };

  // H2H: use /v4/matches/{id}/head2head if we have the fdorg match ID
  // Otherwise fall back to filtering team matches
  let h2h = [];
  if (fdorgMatchId) {
    try {
      const h2hRes = await fetch(`https://api.football-data.org/v4/matches/${fdorgMatchId}/head2head?limit=8`, { headers });
      if (h2hRes.ok) {
        const h2hData = await h2hRes.json();
        h2h = (h2hData.matches || [])
          .filter(m => m.score?.fullTime?.home != null)
          .sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate))
          .slice(0, 6)
          .map(m => ({
            date: m.utcDate?.split('T')[0],
            homeTeam: m.homeTeam?.shortName || m.homeTeam?.name,
            awayTeam: m.awayTeam?.shortName || m.awayTeam?.name,
            homeGoals: m.score.fullTime.home,
            awayGoals: m.score.fullTime.away,
          }));
        console.log(`[FDORG] H2H via match endpoint: ${h2h.length} results`);
      }
    } catch(e) { console.error('[FDORG] H2H error:', e.message); }
  }

  // Fallback H2H: cross-filter team matches
  if (!h2h.length) {
    h2h = (hData.matches || [])
      .filter(m => (m.homeTeam?.id === awayObj.id || m.awayTeam?.id === awayObj.id) && m.score?.fullTime?.home != null)
      .sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate))
      .slice(0, 6)
      .map(m => ({
        date: m.utcDate?.split('T')[0],
        homeTeam: m.homeTeam?.shortName || m.homeTeam?.name,
        awayTeam: m.awayTeam?.shortName || m.awayTeam?.name,
        homeGoals: m.score.fullTime.home,
        awayGoals: m.score.fullTime.away,
      }));
    console.log(`[FDORG] H2H via filter: ${h2h.length} results`);
  }

  return {
    homeForm: parseForm(hData, homeObj.id),
    awayForm: parseForm(aData, awayObj.id),
    h2h,
  };
}

// ── ROUTES ─────────────────────────────────────────────────────────────────

app.get('/api/fixtures', async (req, res) => {
  const date = req.query.date || today();
  try {
    if (lastFetchDate !== date || Object.keys(fixtureStore).length === 0) {
      await loadFixtures(date);
    }
    res.json({ fixtures: Object.values(fixtureStore), date, count: Object.keys(fixtureStore).length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/match/:id', async (req, res) => {
  const id = String(req.params.id);
  console.log('[MATCH] Request for:', id, '| Store size:', Object.keys(fixtureStore).length);

  // Ensure store is populated
  if (Object.keys(fixtureStore).length === 0) {
    await loadFixtures(today());
  }

  const fixture = fixtureStore[id];
  if (!fixture) {
    console.error('[MATCH] Not found. Store keys:', Object.keys(fixtureStore).slice(0,5));
    return res.status(404).json({ error: 'Fixture not found — please go to Fixtures page first' });
  }

  // Check cache — only use if analysis is not empty
  const cached = db.getCachedAnalysis(id);
  if (cached && cached.analysis && cached.analysis.trim().length > 10) {
    console.log('[MATCH] Returning cached analysis for:', id);
    const odds = fixture.odds || {};
    const impliedProb = odds.home ? Math.round(100 / odds.home) : null;
    const edgePct = impliedProb ? (cached.model_prob || 50) - impliedProb : null;
    return res.json({
      id, home_team: fixture.homeTeam, away_team: fixture.awayTeam,
      league: fixture.league, fixture_date: (fixture.date||'').split('T')[0],
      home_logo: fixture.homeLogo, away_logo: fixture.awayLogo,
      status: fixture.status, home_goals: fixture.homeGoals, away_goals: fixture.awayGoals,
      venue: fixture.venue, odds,
      analysis: cached.analysis, tip: cached.tip, market: cached.market,
      confidence: cached.confidence, model_prob: cached.model_prob,
      reasoning: cached.reasoning, risk: cached.risk,
      best_odds: odds.home || null, implied_prob: impliedProb,
      edge_pct: edgePct, has_value: edgePct != null && edgePct >= 3,
      h2h: [], home_form: [], away_form: [],
    });
  }

  // Fetch form + H2H
  const { h2h, homeForm, awayForm } = await getFormAndH2H(fixture.homeTeam, fixture.awayTeam, fixture.homeEspnId, fixture.awayEspnId, fixture.leagueSlug, fixture.league, fixture.fdorgMatchId);
  console.log('[MATCH] Running fresh AI for:', fixture.homeTeam, 'vs', fixture.awayTeam, '| H2H:', h2h.length, 'homeForm:', homeForm.length);
  const ai = await analyseWithAI(fixture.homeTeam, fixture.awayTeam, fixture.league, fixture.odds, h2h, homeForm, awayForm);

  const odds = fixture.odds || {};
  const modelProb = ai?.model_prob || 50;

  // Pick best odds based on the AI's chosen tip
  const getBestOdds = (tip, odds, homeTeam, awayTeam) => {
    const t = (tip || '').toLowerCase();
    const h = homeTeam.toLowerCase();
    const a = awayTeam.toLowerCase();
    if (t.includes('over 2.5')) return { odds: odds.over25, label: 'Over 2.5' };
    if (t.includes('under 2.5')) return { odds: odds.under25, label: 'Under 2.5' };
    if (t.includes('over 1.5')) return { odds: odds.over25 ? parseFloat((odds.over25 * 0.62).toFixed(2)) : null, label: 'Over 1.5' };
    if (t.includes('both teams to score') && !t.includes('not')) {
      return { odds: odds.over25 ? parseFloat((odds.over25 * 0.88).toFixed(2)) : null, label: 'BTTS Yes' };
    }
    if (t.includes('both teams not')) {
      return { odds: odds.under25 ? parseFloat((odds.under25 * 0.88).toFixed(2)) : null, label: 'BTTS No' };
    }
    if (t.includes(' or draw')) {
      if (t.includes(h.split(' ')[0]) || t.startsWith(h.split(' ')[0])) {
        const dc = (odds.home && odds.draw) ? parseFloat((1/(1/odds.home + 1/odds.draw)).toFixed(2)) : null;
        return { odds: dc, label: homeTeam + ' or Draw' };
      }
      if (t.includes(a.split(' ')[0]) || t.includes(a.split(' ').pop())) {
        const dc = (odds.away && odds.draw) ? parseFloat((1/(1/odds.away + 1/odds.draw)).toFixed(2)) : null;
        return { odds: dc, label: awayTeam + ' or Draw' };
      }
    }
    if (t.includes('draw')) return { odds: odds.draw, label: 'Draw' };
    // Check home team name words
    const homeWords = h.split(' ');
    if (homeWords.some(w => w.length > 2 && t.includes(w))) return { odds: odds.home, label: homeTeam + ' Win' };
    // Check away team name words
    const awayWords = a.split(' ');
    if (awayWords.some(w => w.length > 2 && t.includes(w))) return { odds: odds.away, label: awayTeam + ' Win' };
    return { odds: odds.home, label: homeTeam + ' Win' };
  };

  const { odds: bestOdds, label: betLabel } = getBestOdds(ai?.tip, odds, fixture.homeTeam, fixture.awayTeam);
  const impliedProb = bestOdds ? Math.round(100 / bestOdds) : null;
  const edgePct = impliedProb != null ? modelProb - impliedProb : null;

  if (ai?.summary) {
    db.cacheAnalysis({
      fixture_id: id, home_team: fixture.homeTeam, away_team: fixture.awayTeam,
      league: fixture.league, fixture_date: (fixture.date||'').split('T')[0],
      analysis: ai.summary, tip: ai.tip || '', market: ai.market || 'h2h',
      best_odds: bestOdds || null, edge_pct: edgePct, model_prob: modelProb,
      confidence: ai.confidence, reasoning: ai.reasoning, risk: ai.risk,
    });
  }

  res.json({
    id, home_team: fixture.homeTeam, away_team: fixture.awayTeam,
    league: fixture.league, fixture_date: (fixture.date||'').split('T')[0],
    home_logo: fixture.homeLogo, away_logo: fixture.awayLogo,
    status: fixture.status, home_goals: fixture.homeGoals, away_goals: fixture.awayGoals,
    venue: fixture.venue, odds,
    analysis: ai?.summary    || null,
    tip:      ai?.tip        || null,
    market:   ai?.market     || null,
    confidence: ai?.confidence || null,
    model_prob: modelProb,
    reasoning:  ai?.reasoning  || null,
    risk:       ai?.risk       || null,
    best_odds:  bestOdds       || null,
    bet_label:  betLabel       || null,
    implied_prob: impliedProb,
    edge_pct:   edgePct,
    has_value:  edgePct != null && edgePct >= 2,
    h2h, home_form: homeForm, away_form: awayForm,
  });
});

app.post('/api/bet', (req, res) => {
  try {
    const bet = db.placeBet(req.body);
    if (!bet) return res.json({ ok: false, reason: 'Insufficient bankroll or zero Kelly stake' });
    res.json({ ok: true, bet });
  } catch(e) { res.status(500).json({ ok: false, reason: e.message }); }
});

app.get('/api/bets', (req, res) => {
  res.json(db.getBets({ limit: parseInt(req.query.limit) || 50 }));
});

app.get('/api/portfolio', (req, res) => { res.json(db.getStats()); });

app.post('/api/settle', async (req, res) => {
  try {
    await loadFixtures(today());
    let settled = 0;
    const pending = db.getBets({ pending: true });
    for (const bet of pending) {
      const f = fixtureStore[String(bet.fixture_id)];
      if (!f || f.homeGoals == null) continue;
      const status = (f.status||'').toLowerCase();
      if (!status.includes('ft') && !status.includes('final') && !status.includes('full')) continue;
      settled += db.settleBet(bet.fixture_id, f.homeGoals, f.awayGoals);
    }
    res.json({ ok: true, settled });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/status', (req, res) => {
  const stats = db.getStats();
  res.json({ status: 'ok', version: '2.0', hasAI: !!AI_KEY, bankroll: stats.bankroll, totalBets: stats.totalBets, winRate: stats.winRate });
});

app.post('/api/bankroll/reset', (req, res) => {
  const amount = parseFloat(req.body.amount) || 1000;
  db.resetBankroll(amount);
  res.json({ ok: true, amount });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

app.listen(PORT, async () => {
  console.log(`PROPRED v2 on :${PORT} | AI: ${AI_KEY ? '✅ key length='+AI_KEY.length : '❌ NO KEY'}`);
  await loadFixtures(today());
});
