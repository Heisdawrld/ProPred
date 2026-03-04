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
      const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${ODDS_KEY}&regions=uk&markets=h2h,totals,btts,draw_no_bet,asian_handicap&oddsFormat=decimal`;
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
        // Try multiple bookmakers for best coverage
        const bk = game.bookmakers?.find(b => ['bet365','williamhill','betfair','unibet','paddypower'].includes(b.key))
                || game.bookmakers?.[0];
        if (!bk) continue;

        const getMarket = (key) => bk.markets?.find(m => m.key === key);
        const h2h  = getMarket('h2h');
        const tot  = getMarket('totals');
        const btts = getMarket('btts');
        const dnb  = getMarket('draw_no_bet');
        const ah   = getMarket('asian_handicap');

        if (h2h) {
          match.odds.home = h2h.outcomes?.find(o=>o.name===game.home_team)?.price || h2h.outcomes?.[0]?.price;
          match.odds.draw = h2h.outcomes?.find(o=>o.name==='Draw')?.price;
          match.odds.away = h2h.outcomes?.find(o=>o.name===game.away_team)?.price || h2h.outcomes?.[2]?.price;
          match.hasOdds   = true;
        }
        if (tot) {
          match.odds.over15  = tot.outcomes?.find(o=>o.name==='Over'  && o.point===1.5)?.price;
          match.odds.under15 = tot.outcomes?.find(o=>o.name==='Under' && o.point===1.5)?.price;
          match.odds.over25  = tot.outcomes?.find(o=>o.name==='Over'  && o.point===2.5)?.price;
          match.odds.under25 = tot.outcomes?.find(o=>o.name==='Under' && o.point===2.5)?.price;
          match.odds.over35  = tot.outcomes?.find(o=>o.name==='Over'  && o.point===3.5)?.price;
          match.odds.under35 = tot.outcomes?.find(o=>o.name==='Under' && o.point===3.5)?.price;
          match.odds.over45  = tot.outcomes?.find(o=>o.name==='Over'  && o.point===4.5)?.price;
        }
        if (btts) {
          match.odds.bttsYes = btts.outcomes?.find(o=>o.name==='Yes')?.price;
          match.odds.bttsNo  = btts.outcomes?.find(o=>o.name==='No')?.price;
        }
        if (dnb) {
          match.odds.dnbHome = dnb.outcomes?.find(o=>o.name===game.home_team)?.price;
          match.odds.dnbAway = dnb.outcomes?.find(o=>o.name===game.away_team)?.price;
        }
        if (ah) {
          // Asian handicap - grab the -0.5 lines (closest to 1X2 but no draw)
          match.odds.ahHome = ah.outcomes?.find(o=>o.name===game.home_team && o.point===-0.5)?.price;
          match.odds.ahAway = ah.outcomes?.find(o=>o.name===game.away_team && o.point===0.5)?.price;
        }
        // Compute double chance from h2h odds
        if (match.odds.home && match.odds.draw) {
          match.odds.dc1X = parseFloat((1/(1/match.odds.home + 1/match.odds.draw)).toFixed(2));
        }
        if (match.odds.away && match.odds.draw) {
          match.odds.dcX2 = parseFloat((1/(1/match.odds.away + 1/match.odds.draw)).toFixed(2));
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

  // Build full odds block with every available line
  const oddsLines = [];
  if (hasOdds) {
    oddsLines.push(`1X2: Home(${homeTeam}) ${odds.home} | Draw ${odds.draw} | Away(${awayTeam}) ${odds.away}`);
    if (odds.dc1X)    oddsLines.push(`Double Chance: ${homeTeam} or Draw ${odds.dc1X} | ${awayTeam} or Draw ${odds.dcX2||'—'}`);
    if (odds.dnbHome) oddsLines.push(`Draw No Bet: ${homeTeam} ${odds.dnbHome} | ${awayTeam} ${odds.dnbAway||'—'}`);
    if (odds.over15)  oddsLines.push(`Goals Over/Under 1.5: Over ${odds.over15} | Under ${odds.under15||'—'}`);
    if (odds.over25)  oddsLines.push(`Goals Over/Under 2.5: Over ${odds.over25} | Under ${odds.under25||'—'}`);
    if (odds.over35)  oddsLines.push(`Goals Over/Under 3.5: Over ${odds.over35} | Under ${odds.under35||'—'}`);
    if (odds.over45)  oddsLines.push(`Goals Over/Under 4.5: Over ${odds.over45||'—'}`);
    if (odds.bttsYes) oddsLines.push(`Both Teams to Score: Yes ${odds.bttsYes} | No ${odds.bttsNo||'—'}`);
    if (odds.ahHome)  oddsLines.push(`Asian Handicap -0.5: ${homeTeam} ${odds.ahHome} | ${awayTeam} ${odds.ahAway||'—'}`);
  }
  const oddsStr = oddsLines.length ? oddsLines.join('\n') : 'No odds available — use your knowledge to estimate';

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

  const prompt = `You are a professional football betting analyst. You have encyclopedic knowledge of world football — every team, their style of play, their managers, their current season form, who scores, who leaks goals.

MATCH: ${homeTeam} vs ${awayTeam}
COMPETITION: ${league}

BOOKMAKER ODDS:
${oddsStr}

${homeTeam} LAST 6 RESULTS:
${fmtForm(homeForm)}

${awayTeam} LAST 6 RESULTS:
${fmtForm(awayForm)}

HEAD TO HEAD (recent first):
${h2h.length ? h2h.slice(0,6).map(m=>`${m.date||''}: ${m.homeTeam} ${m.homeGoals??'?'}-${m.awayGoals??'?'} ${m.awayTeam}`).join('\n') : 'No H2H data — use your knowledge'}
${statsBlock}
${formNote}

YOUR MISSION:
Find the single bet with the HIGHEST chance of winning across ALL available markets.
You are not restricted. Pick whatever you believe is most likely to land.
Think about: goals patterns, team strength gap, defensive solidity, home advantage, cup/league context, recent results, typical match tempo for these teams.

AVAILABLE MARKETS:
MATCH RESULT (1X2):
  "${homeTeam} Win" | "Draw" | "${awayTeam} Win"

DOUBLE CHANCE:
  "${homeTeam} or Draw" | "${awayTeam} or Draw"

DRAW NO BET:
  "${homeTeam} DNB" | "${awayTeam} DNB"

GOALS MARKETS:
  "Over 1.5 Goals" | "Under 1.5 Goals"
  "Over 2.5 Goals" | "Under 2.5 Goals"
  "Over 3.5 Goals" | "Under 3.5 Goals"
  "Over 4.5 Goals"

BOTH TEAMS TO SCORE:
  "Both Teams to Score" | "Both Teams NOT to Score"

ASIAN HANDICAP:
  "${homeTeam} -0.5" | "${awayTeam} -0.5"

DECISION FRAMEWORK:
Step 1 — Check form stats: avg goals per game, BTTS rate, clean sheets
Step 2 — Check H2H: does this fixture tend to be high or low scoring?
Step 3 — Check odds: which market offers the best value vs probability?
Step 4 — Use your knowledge: what do you know about these teams that the stats don't show?
Step 5 — Pick the ONE market you'd bet your own money on

HARD RULES:
• If avg total goals > 2.5 in recent games → lean goals markets
• If BTTS in 4+/5 recent games for BOTH teams → "Both Teams to Score"  
• If one side clearly outclasses the other → Win or Asian Handicap -0.5
• If match is between two strong defences (you know this) → Under or DNB
• NEVER pick something just to play it safe with no reasoning
• Be decisive. No hedging. One pick, full conviction.

RESPOND WITH ONLY THIS JSON:
{
  "tip": "exact market string from the list above",
  "market": "h2h|dc|dnb|totals|btts|ah",
  "summary": "3 sentences — current form of both teams, what makes this matchup interesting, what the data says",
  "reasoning": "1 decisive sentence — the exact reason this bet wins, referencing a stat or your knowledge",
  "confidence": 74,
  "model_prob": 76,
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
        const rawText = (data.choices?.[0]?.message?.content || '').trim();
        // Strip markdown code blocks if model wraps response
        const text = rawText.replace(/^```(?:json)?\n?/,'').replace(/\n?```$/,'').trim();
        console.log('[AI] Groq raw response:', text.slice(0,200));
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[0]);
            console.log('[AI] Groq success:', parsed.tip);
            return parsed;
          } catch(parseErr) {
            console.error('[AI] JSON parse failed:', parseErr.message, '| text:', text.slice(0,200));
          }
        } else {
          console.error('[AI] No JSON found in response:', text.slice(0,200));
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
    const t = (tip || '').toLowerCase().trim();
    const h = homeTeam.toLowerCase();
    const a = awayTeam.toLowerCase();

    // Goals markets - check most specific first
    if (t.includes('over 4.5'))  return { odds: odds.over45,  label: 'Over 4.5 Goals' };
    if (t.includes('under 3.5')) return { odds: odds.under35, label: 'Under 3.5 Goals' };
    if (t.includes('over 3.5'))  return { odds: odds.over35,  label: 'Over 3.5 Goals' };
    if (t.includes('under 2.5')) return { odds: odds.under25, label: 'Under 2.5 Goals' };
    if (t.includes('over 2.5'))  return { odds: odds.over25,  label: 'Over 2.5 Goals' };
    if (t.includes('under 1.5')) return { odds: odds.under15, label: 'Under 1.5 Goals' };
    if (t.includes('over 1.5'))  return { odds: odds.over15 || (odds.over25 ? parseFloat((odds.over25*0.62).toFixed(2)) : null), label: 'Over 1.5 Goals' };

    // BTTS
    if (t.includes('both teams to score') || t === 'btts yes') return { odds: odds.bttsYes || (odds.over25 ? parseFloat((odds.over25*0.9).toFixed(2)) : null), label: 'BTTS - Yes' };
    if (t.includes('both teams not') || t === 'btts no')       return { odds: odds.bttsNo  || (odds.under25 ? parseFloat((odds.under25*0.9).toFixed(2)) : null), label: 'BTTS - No' };

    // Draw No Bet
    if (t.includes('dnb') || t.includes('draw no bet')) {
      const isHome = h.split(' ').some(w => w.length > 2 && t.includes(w));
      return isHome
        ? { odds: odds.dnbHome || (odds.home ? parseFloat((odds.home*0.75).toFixed(2)) : null), label: homeTeam + ' DNB' }
        : { odds: odds.dnbAway || (odds.away ? parseFloat((odds.away*0.75).toFixed(2)) : null), label: awayTeam + ' DNB' };
    }

    // Asian Handicap
    if (t.includes('-0.5') || t.includes('asian handicap') || t.includes(' ah')) {
      const isHome = h.split(' ').some(w => w.length > 2 && t.includes(w));
      return isHome
        ? { odds: odds.ahHome || (odds.home ? parseFloat((odds.home*0.85).toFixed(2)) : null), label: homeTeam + ' -0.5' }
        : { odds: odds.ahAway || (odds.away ? parseFloat((odds.away*0.85).toFixed(2)) : null), label: awayTeam + ' -0.5' };
    }

    // Double Chance
    if (t.includes(' or draw')) {
      const isHome = h.split(' ').some(w => w.length > 2 && t.includes(w));
      return isHome
        ? { odds: odds.dc1X || (odds.home && odds.draw ? parseFloat((1/(1/odds.home+1/odds.draw)).toFixed(2)) : null), label: homeTeam + ' or Draw' }
        : { odds: odds.dcX2 || (odds.away && odds.draw ? parseFloat((1/(1/odds.away+1/odds.draw)).toFixed(2)) : null), label: awayTeam + ' or Draw' };
    }

    // 1X2
    if (t === 'draw' || t.endsWith('draw')) return { odds: odds.draw, label: 'Draw' };
    const homeWords = h.split(' ').filter(w => w.length > 2);
    if (homeWords.some(w => t.includes(w))) return { odds: odds.home, label: homeTeam + ' Win' };
    const awayWords = a.split(' ').filter(w => w.length > 2);
    if (awayWords.some(w => t.includes(w))) return { odds: odds.away, label: awayTeam + ' Win' };

    // Fallback
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
  res.json({ status: 'ok', version: '2.0', hasAI: !!(GROQ_KEY||AI_KEY||GEMINI_KEY), bankroll: stats.bankroll, totalBets: stats.totalBets, winRate: stats.winRate });
});

app.post('/api/bankroll/reset', (req, res) => {
  const amount = parseFloat(req.body.amount) || 1000;
  db.resetBankroll(amount);
  res.json({ ok: true, amount });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));


// ── DEBUG: test AI directly ────────────────────────────────────────────────
app.get('/api/test-ai', async (req, res) => {
  try {
    const result = await analyseWithAI(
      'Arsenal', 'Chelsea', 'Premier League',
      { home: 2.1, draw: 3.4, away: 3.6, over25: 1.75, under25: 2.1, bttsYes: 1.8, bttsNo: 2.0, dc1X: 1.28, dcX2: 1.72 },
      [{ date:'2026-02-22', homeTeam:'Arsenal', awayTeam:'Man City', homeGoals:2, awayGoals:1, isHome:true, result:'W' }],
      [{ date:'2026-02-22', homeTeam:'Arsenal', awayTeam:'Man City', homeGoals:2, awayGoals:1, isHome:true, result:'W' },
       { date:'2026-02-15', homeTeam:'Arsenal', awayTeam:'Brighton', homeGoals:3, awayGoals:1, isHome:true, result:'W' },
       { date:'2026-02-08', homeTeam:'Wolves', awayTeam:'Arsenal', homeGoals:0, awayGoals:2, isHome:false, result:'W' }],
      [{ date:'2026-02-22', homeTeam:'Chelsea', awayTeam:'Spurs', homeGoals:2, awayGoals:2, isHome:true, result:'D' },
       { date:'2026-02-15', homeTeam:'Brentford', awayTeam:'Chelsea', homeGoals:1, awayGoals:2, isHome:false, result:'W' },
       { date:'2026-02-08', homeTeam:'Chelsea', awayTeam:'Everton', homeGoals:3, awayGoals:0, isHome:true, result:'W' }]
    );
    res.json({ ok: true, result, groqKey: GROQ_KEY ? 'set ('+GROQ_KEY.slice(0,8)+'...)' : 'MISSING' });
  } catch(e) {
    res.json({ ok: false, error: e.message, groqKey: GROQ_KEY ? 'set' : 'MISSING' });
  }
});

app.listen(PORT, async () => {
  console.log(`PROPRED v2 on :${PORT} | AI: ${AI_KEY ? '✅ key length='+AI_KEY.length : '❌ NO KEY'}`);
  await loadFixtures(today());
});
