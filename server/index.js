'use strict';

const express  = require('express');
const fetch    = require('node-fetch');
const path     = require('path');
const db       = require('./db');
const bsd      = require('./bsd');   // ← BSD predictions module

const app  = express();
const PORT = process.env.PORT || 10000;
const AI_KEY       = (process.env.ANTHROPIC_KEY  || '').trim();
const GEMINI_KEY   = (process.env.GEMINI_KEY     || '').trim();
const GROQ_KEY     = (process.env.GROQ_KEY       || '').trim();
const ODDS_KEY     = process.env.ODDS_API_KEY    || '';
const FDORG_KEY    = (process.env.FDORG_KEY      || '').trim();

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

let fixtureStore = {};
let lastFetchDate = null;
const today = () => new Date().toISOString().split('T')[0];

const LEAGUE_MAP = {
  'eng.1':'Premier League','eng.2':'Championship','esp.1':'La Liga','ger.1':'Bundesliga',
  'ita.1':'Serie A','fra.1':'Ligue 1','ned.1':'Eredivisie','tur.1':'Super Lig',
  'sco.1':'Scottish Prem','por.1':'Primeira Liga','uefa.champions':'Champions League',
  'uefa.europa':'Europa League','mex.1':'Liga MX','usa.1':'MLS','bra.1':'Brasileirao',
  'arg.1':'Primera Division','eng.league_cup':'EFL Cup','ger.2':'Bundesliga 2',
  'esp.2':'Segunda Division','ita.2':'Serie B','fra.2':'Ligue 2','bel.1':'Pro League','por.2':'Segunda Liga',
};

const ODDS_MAP = {
  'Premier League':'soccer_epl','Championship':'soccer_efl_champ','La Liga':'soccer_spain_la_liga',
  'Bundesliga':'soccer_germany_bundesliga','Serie A':'soccer_italy_serie_a',
  'Ligue 1':'soccer_france_ligue_one','Eredivisie':'soccer_netherlands_eredivisie',
  'Champions League':'soccer_uefa_champs_league','Europa League':'soccer_uefa_europa_league',
  'Scottish Prem':'soccer_scotland_premiership',
};

const LEAGUE_TO_FDORG = {
  'Premier League':'PL','La Liga':'PD','Bundesliga':'BL1','Serie A':'SA','Ligue 1':'FL1',
  'Champions League':'CL','Europa League':'EL','Championship':'ELC','Eredivisie':'DED','Primeira Liga':'PPL',
};

// ── ESPN FIXTURES ─────────────────────────────────────────────────────────
async function fetchESPN(date) {
  const fixtures = [];
  for (const [slug, name] of Object.entries(LEAGUE_MAP)) {
    try {
      const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/scoreboard?dates=${date.replace(/-/g,'')}`;
      const res  = await fetch(url);
      const json = await res.json();
      for (const ev of (json.events || [])) {
        const comp = ev.competitions?.[0];
        if (!comp) continue;
        const home = comp.competitors?.find(c=>c.homeAway==='home');
        const away = comp.competitors?.find(c=>c.homeAway==='away');
        if (!home || !away) continue;
        fixtures.push({
          id: String(ev.id), league: name, leagueSlug: slug, date: comp.date,
          homeTeam: home.team.displayName, awayTeam: away.team.displayName,
          homeEspnId: home.team.id, awayEspnId: away.team.id,
          homeLogo: home.team.logo, awayLogo: away.team.logo,
          homeGoals: home.score != null ? parseInt(home.score) : null,
          awayGoals: away.score != null ? parseInt(away.score) : null,
          status: comp.status?.type?.shortDetail || 'NS',
          venue: comp.venue?.fullName || '', hasOdds: false, odds: {},
        });
      }
    } catch(e) { console.error(`[ESPN] ${name}:`, e.message); }
  }
  console.log(`[ESPN] Total fixtures: ${fixtures.length}`);
  return fixtures;
}

// ── ODDS ──────────────────────────────────────────────────────────────────
async function fetchOddsForFixtures(fixtures) {
  if (!ODDS_KEY) return;
  for (const league of [...new Set(fixtures.map(f=>f.league))]) {
    const sport = ODDS_MAP[league];
    if (!sport) continue;
    try {
      const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${ODDS_KEY}&regions=uk&markets=h2h,totals,btts,draw_no_bet,asian_handicap&oddsFormat=decimal`;
      const json = await fetch(url).then(r=>r.json());
      if (!Array.isArray(json)) continue;
      for (const game of json) {
        const norm = s => (s||'').toLowerCase().replace(/[^a-z0-9]/g,' ').trim();
        const match = fixtures.find(f => f.league===league && norm(f.homeTeam).split(' ')[0]===norm(game.home_team).split(' ')[0]);
        if (!match) continue;
        const bk = game.bookmakers?.find(b=>['bet365','williamhill','betfair','unibet','paddypower'].includes(b.key)) || game.bookmakers?.[0];
        if (!bk) continue;
        const gm = key => bk.markets?.find(m=>m.key===key);
        const h2h=gm('h2h'), tot=gm('totals'), btts=gm('btts'), dnb=gm('draw_no_bet'), ah=gm('asian_handicap');
        if (h2h) {
          match.odds.home = h2h.outcomes?.find(o=>o.name===game.home_team)?.price || h2h.outcomes?.[0]?.price;
          match.odds.draw = h2h.outcomes?.find(o=>o.name==='Draw')?.price;
          match.odds.away = h2h.outcomes?.find(o=>o.name===game.away_team)?.price || h2h.outcomes?.[2]?.price;
          match.hasOdds = true;
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
          match.odds.ahHome = ah.outcomes?.find(o=>o.name===game.home_team && o.point===-0.5)?.price;
          match.odds.ahAway = ah.outcomes?.find(o=>o.name===game.away_team && o.point===0.5)?.price;
        }
        if (match.odds.home && match.odds.draw)
          match.odds.dc1X = parseFloat((1/(1/match.odds.home+1/match.odds.draw)).toFixed(2));
        if (match.odds.away && match.odds.draw)
          match.odds.dcX2 = parseFloat((1/(1/match.odds.away+1/match.odds.draw)).toFixed(2));
      }
    } catch(e) { console.error(`[ODDS] ${league}:`, e.message); }
  }
}

// ── FDORG ENRICHMENT ──────────────────────────────────────────────────────
async function enrichWithFDOrgIds(fixtures, date) {
  try {
    const headers = { 'X-Auth-Token': FDORG_KEY };
    const d = new Date(date);
    const d1 = new Date(d); d1.setDate(d1.getDate()-1);
    const d2 = new Date(d); d2.setDate(d2.getDate()+1);
    const fmt = x => x.toISOString().split('T')[0];
    const res = await fetch(`https://api.football-data.org/v4/matches?dateFrom=${fmt(d1)}&dateTo=${fmt(d2)}`, { headers });
    if (!res.ok) { console.log('[FDORG-IDS] Failed:', res.status); return; }
    const fdMatches = (await res.json()).matches || [];
    console.log(`[FDORG-IDS] ${fdMatches.length} matches`);
    let matched = 0;
    for (const fx of fixtures) {
      const hw = fx.homeTeam.toLowerCase().split(' ')[0];
      const aw = fx.awayTeam.toLowerCase().split(' ')[0];
      const fdm = fdMatches.find(m => {
        const fh=(m.homeTeam?.shortName||m.homeTeam?.name||'').toLowerCase();
        const fa=(m.awayTeam?.shortName||m.awayTeam?.name||'').toLowerCase();
        return (fh.includes(hw)||hw.includes(fh.split(' ')[0]))&&(fa.includes(aw)||aw.includes(fa.split(' ')[0]));
      });
      if (fdm) { fx.fdorgMatchId=fdm.id; fx.fdorgHomeId=fdm.homeTeam?.id; fx.fdorgAwayId=fdm.awayTeam?.id; matched++; }
    }
    console.log(`[FDORG-IDS] Matched ${matched}/${fixtures.length}`);
  } catch(e) { console.error('[FDORG-IDS]', e.message); }
}

async function loadFixtures(date) {
  const fixtures = await fetchESPN(date);
  await fetchOddsForFixtures(fixtures);
  if (FDORG_KEY) await enrichWithFDOrgIds(fixtures, date);
  fixtureStore = {};
  for (const f of fixtures) fixtureStore[f.id] = f;
  lastFetchDate = date;
  console.log(`[STORE] ${fixtures.length} fixtures stored`);
  return fixtures;
}

// ── FORM: FDORG ───────────────────────────────────────────────────────────
const fdorgTeamCache = {};

async function getFormFDOrg(homeTeam, awayTeam, league, fdorgMatchId) {
  const code = LEAGUE_TO_FDORG[league];
  if (!code) return null;
  const headers = { 'X-Auth-Token': FDORG_KEY };
  if (!fdorgTeamCache[code]) {
    const r = await fetch(`https://api.football-data.org/v4/competitions/${code}/teams`, { headers });
    if (!r.ok) throw new Error(`FDORG teams ${code}: ${r.status}`);
    fdorgTeamCache[code] = await r.json();
  }
  const teams = fdorgTeamCache[code].teams || [];
  const findT = name => {
    const nl = name.toLowerCase().replace(/[^a-z0-9 ]/g,'');
    const words = nl.split(' ').filter(w=>w.length>2);
    return teams.find(t => {
      const tn=(t.name||'').toLowerCase().replace(/[^a-z0-9 ]/g,'');
      const sn=(t.shortName||'').toLowerCase().replace(/[^a-z0-9 ]/g,'');
      if (tn===nl||sn===nl) return true;
      return words.some(w=>tn.includes(w)||sn.includes(w));
    });
  };
  const hObj=findT(homeTeam), aObj=findT(awayTeam);
  console.log(`[FDORG] ${homeTeam}→${hObj?.name||'NO'} | ${awayTeam}→${aObj?.name||'NO'}`);
  if (!hObj||!aObj) return null;
  const [hRes,aRes] = await Promise.all([
    fetch(`https://api.football-data.org/v4/teams/${hObj.id}/matches?status=FINISHED&limit=8`,{headers}),
    fetch(`https://api.football-data.org/v4/teams/${aObj.id}/matches?status=FINISHED&limit=8`,{headers}),
  ]);
  const [hData,aData] = await Promise.all([hRes.json(),aRes.json()]);
  const parseForm = (data, teamId) => (data.matches||[])
    .filter(m=>m.score?.fullTime?.home!=null)
    .sort((a,b)=>new Date(b.utcDate)-new Date(a.utcDate))
    .slice(0,6)
    .map(m => {
      const isHome=m.homeTeam?.id===teamId,hG=m.score.fullTime.home,aG=m.score.fullTime.away;
      const gf=isHome?hG:aG,ga=isHome?aG:hG;
      return { date:m.utcDate?.split('T')[0], homeTeam:m.homeTeam?.shortName||m.homeTeam?.name,
        awayTeam:m.awayTeam?.shortName||m.awayTeam?.name, homeGoals:hG, awayGoals:aG, isHome,
        result:gf>ga?'W':gf<ga?'L':'D' };
    });
  let h2h=[];
  if (fdorgMatchId) {
    try {
      const hr=await fetch(`https://api.football-data.org/v4/matches/${fdorgMatchId}/head2head?limit=8`,{headers});
      if (hr.ok) {
        h2h=(await hr.json()).matches?.filter(m=>m.score?.fullTime?.home!=null)
          .sort((a,b)=>new Date(b.utcDate)-new Date(a.utcDate)).slice(0,6)
          .map(m=>({date:m.utcDate?.split('T')[0],homeTeam:m.homeTeam?.shortName||m.homeTeam?.name,
            awayTeam:m.awayTeam?.shortName||m.awayTeam?.name,homeGoals:m.score.fullTime.home,awayGoals:m.score.fullTime.away})) || [];
      }
    } catch(e){}
  }
  if (!h2h.length) {
    h2h=(hData.matches||[]).filter(m=>(m.homeTeam?.id===aObj.id||m.awayTeam?.id===aObj.id)&&m.score?.fullTime?.home!=null)
      .sort((a,b)=>new Date(b.utcDate)-new Date(a.utcDate)).slice(0,6)
      .map(m=>({date:m.utcDate?.split('T')[0],homeTeam:m.homeTeam?.shortName||m.homeTeam?.name,
        awayTeam:m.awayTeam?.shortName||m.awayTeam?.name,homeGoals:m.score.fullTime.home,awayGoals:m.score.fullTime.away}));
  }
  return { homeForm:parseForm(hData,hObj.id), awayForm:parseForm(aData,aObj.id), h2h };
}

// ── FORM: ESPN SCOREBOARD FALLBACK ────────────────────────────────────────
async function getFormESPN(homeTeam, awayTeam, homeId, awayId, slug) {
  if (!homeId||!awayId||!slug) return {h2h:[],homeForm:[],awayForm:[]};
  try {
    const dates=[];
    for (let i=3;i<=90;i+=7) { const d=new Date(); d.setDate(d.getDate()-i); dates.push(d.toISOString().split('T')[0].replace(/-/g,'')); }
    const allEvents=[];
    for (let i=0;i<dates.length;i+=5) {
      const batch=dates.slice(i,i+5);
      const results=await Promise.allSettled(batch.map(d=>fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/scoreboard?dates=${d}`).then(r=>r.json())));
      for (const r of results) if (r.status==='fulfilled') allEvents.push(...(r.value.events||[]));
      const done=allEvents.filter(ev=>{const s=ev.competitions?.[0]?.status?.type; return s?.completed===true;});
      if (done.length>=40) break;
    }
    const finished=allEvents.filter(ev=>{
      const comp=ev.competitions?.[0],s=comp?.status?.type;
      const h=comp?.competitors?.find(c=>c.homeAway==='home'),a=comp?.competitors?.find(c=>c.homeAway==='away');
      return (s?.completed===true||s?.shortDetail==='FT'||(s?.description||'').includes('Final'))
        &&h?.score!=null&&a?.score!=null&&!isNaN(parseInt(h.score))&&!isNaN(parseInt(a.score));
    });
    const extract=(ev,tid)=>{
      const comp=ev.competitions[0],h=comp.competitors.find(c=>c.homeAway==='home'),a=comp.competitors.find(c=>c.homeAway==='away');
      const isHome=String(h?.team?.id)===String(tid),hG=parseInt(h.score),aG=parseInt(a.score),gf=isHome?hG:aG,ga=isHome?aG:hG;
      return {date:comp.date?.split('T')[0],homeTeam:h?.team?.displayName,awayTeam:a?.team?.displayName,
        homeGoals:hG,awayGoals:aG,isHome,result:gf>ga?'W':gf<ga?'L':'D',hid:h?.team?.id,aid:a?.team?.id};
    };
    const homeForm=finished.filter(ev=>ev.competitions[0].competitors.some(c=>String(c.team?.id)===String(homeId)))
      .sort((a,b)=>new Date(b.competitions[0].date)-new Date(a.competitions[0].date)).slice(0,6).map(ev=>extract(ev,homeId));
    const awayForm=finished.filter(ev=>ev.competitions[0].competitors.some(c=>String(c.team?.id)===String(awayId)))
      .sort((a,b)=>new Date(b.competitions[0].date)-new Date(a.competitions[0].date)).slice(0,6).map(ev=>extract(ev,awayId));
    const h2h=finished.filter(ev=>{const ids=ev.competitions[0].competitors.map(c=>String(c.team?.id));return ids.includes(String(homeId))&&ids.includes(String(awayId));})
      .sort((a,b)=>new Date(b.competitions[0].date)-new Date(a.competitions[0].date)).slice(0,6)
      .map(ev=>{const comp=ev.competitions[0],h=comp.competitors.find(c=>c.homeAway==='home'),a=comp.competitors.find(c=>c.homeAway==='away');
        return {date:comp.date?.split('T')[0],homeTeam:h?.team?.displayName,awayTeam:a?.team?.displayName,homeGoals:parseInt(h.score),awayGoals:parseInt(a.score)};});
    console.log(`[ESPN-FORM] ${homeTeam}:${homeForm.length} ${awayTeam}:${awayForm.length} H2H:${h2h.length}`);
    return {homeForm,awayForm,h2h};
  } catch(e) { console.error('[ESPN-FORM]',e.message); return {h2h:[],homeForm:[],awayForm:[]}; }
}

async function getFormAndH2H(homeTeam, awayTeam, homeId, awayId, slug, league, fdorgMatchId) {
  console.log(`[FORM] ${homeTeam} vs ${awayTeam} | ${league}`);
  if (FDORG_KEY) {
    try {
      const r=await getFormFDOrg(homeTeam,awayTeam,league,fdorgMatchId);
      if (r&&(r.homeForm.length>0||r.awayForm.length>0)) {
        console.log(`[FORM] FDORG ok: home=${r.homeForm.length} away=${r.awayForm.length}`);
        return r;
      }
    } catch(e) { console.error('[FORM] FDORG err:',e.message); }
  }
  console.log(`[FORM] ESPN fallback for ${league}`);
  return getFormESPN(homeTeam,awayTeam,homeId,awayId,slug);
}

// ── AI ANALYSIS ───────────────────────────────────────────────────────────
async function analyseWithAI(homeTeam, awayTeam, league, odds, h2h=[], homeForm=[], awayForm=[]) {
  const oddsLines=[];
  const o=odds||{};
  if (o.home) {
    oddsLines.push(`1X2: Home(${homeTeam}) ${o.home} | Draw ${o.draw} | Away(${awayTeam}) ${o.away}`);
    if (o.dc1X) oddsLines.push(`Double Chance: ${homeTeam}/Draw ${o.dc1X} | ${awayTeam}/Draw ${o.dcX2||'?'}`);
    if (o.dnbHome) oddsLines.push(`Draw No Bet: ${homeTeam} ${o.dnbHome} | ${awayTeam} ${o.dnbAway||'?'}`);
    if (o.over15) oddsLines.push(`Goals O/U 1.5: Over ${o.over15} | Under ${o.under15||'?'}`);
    if (o.over25) oddsLines.push(`Goals O/U 2.5: Over ${o.over25} | Under ${o.under25||'?'}`);
    if (o.over35) oddsLines.push(`Goals O/U 3.5: Over ${o.over35} | Under ${o.under35||'?'}`);
    if (o.over45) oddsLines.push(`Goals O/U 4.5: Over ${o.over45||'?'}`);
    if (o.bttsYes) oddsLines.push(`BTTS: Yes ${o.bttsYes} | No ${o.bttsNo||'?'}`);
    if (o.ahHome) oddsLines.push(`Asian HCP -0.5: ${homeTeam} ${o.ahHome} | ${awayTeam} ${o.ahAway||'?'}`);
  }
  const fmtF=form=>!form?.length?'No data available':form.slice(0,6).map(f=>`${f.result} ${f.isHome?'H':'A'} vs ${f.isHome?f.awayTeam:f.homeTeam} (${f.homeGoals??'?'}-${f.awayGoals??'?'}) ${f.date||''}`).join(' | ');
  const gs=form=>{
    if (!form?.length) return null;
    const v=form.filter(f=>f.homeGoals!=null&&f.awayGoals!=null);
    if (!v.length) return null;
    const sc=v.map(f=>f.isHome?f.homeGoals:f.awayGoals),co=v.map(f=>f.isHome?f.awayGoals:f.homeGoals),tot=v.map(f=>f.homeGoals+f.awayGoals);
    return {avgSc:(sc.reduce((a,b)=>a+b,0)/v.length).toFixed(1),avgCo:(co.reduce((a,b)=>a+b,0)/v.length).toFixed(1),avgTot:(tot.reduce((a,b)=>a+b,0)/v.length).toFixed(1),
      btts:v.filter(f=>f.homeGoals>0&&f.awayGoals>0).length,o25:v.filter(f=>f.homeGoals+f.awayGoals>2).length,cs:v.filter(f=>f.isHome?f.awayGoals===0:f.homeGoals===0).length,n:v.length};
  };
  const hS=gs(homeForm),aS=gs(awayForm);
  const h2hG=h2h.filter(m=>m.homeGoals!=null).map(m=>m.homeGoals+m.awayGoals);
  const statsBlk=(hS&&aS)?`\nSTATS: ${homeTeam}: scored ${hS.avgSc}/g conceded ${hS.avgCo}/g total ${hS.avgTot}/g BTTS ${hS.btts}/${hS.n} O2.5 ${hS.o25}/${hS.n} CS ${hS.cs}/${hS.n}\n${awayTeam}: scored ${aS.avgSc}/g conceded ${aS.avgCo}/g total ${aS.avgTot}/g BTTS ${aS.btts}/${aS.n} O2.5 ${aS.o25}/${aS.n} CS ${aS.cs}/${aS.n}\nH2H avg goals: ${h2hG.length?(h2hG.reduce((a,b)=>a+b,0)/h2hG.length).toFixed(1):'N/A'} BTTS: ${h2h.filter(m=>m.homeGoals>0&&m.awayGoals>0).length}/${h2h.length}`:'';

  const hasOdds = oddsLines.length > 0;
  const hasFormData = homeForm.length > 0 || awayForm.length > 0;

  const prompt=`You are an elite football betting analyst with encyclopedic knowledge of every league worldwide.

MATCH: ${homeTeam} vs ${awayTeam} | ${league}
ODDS: ${hasOdds ? oddsLines.join(' | ') : 'Not available — base tip purely on probabilities'}
${homeTeam} FORM: ${fmtF(homeForm)}
${awayTeam} FORM: ${fmtF(awayForm)}
H2H: ${h2h.length ? h2h.slice(0,5).map(m=>`${m.homeTeam} ${m.homeGoals??'?'}-${m.awayGoals??'?'} ${m.awayTeam}`).join(' | ') : 'No API data — use your knowledge'}
${statsBlk}
${!hasFormData ? `IMPORTANT: No live form data available. You MUST use your deep internal knowledge of ${homeTeam} and ${awayTeam}'s ${new Date().getFullYear()} season — their current form, injuries, playing style, home/away record, and typical scoring patterns. Do NOT refuse to pick a tip.` : ''}

RULES:
1. You MUST always pick a best_tip — never leave it blank or say "insufficient data"
2. If no odds are available, pick the tip based on probability alone (highest confidence outcome)
3. If form data is missing, use your training knowledge of these teams this season
4. Prefer goals markets (Over/Under) when match result is too close to call
5. Confidence should reflect true certainty, not just echo odds

Provide true probability estimates. Pick the single best tip with highest edge or highest confidence.

RESPOND WITH ONLY VALID JSON (no markdown, no explanation):
{"summary":"2-3 sentences on both teams current form and this specific matchup","reasoning":"1 sentence why this tip wins","best_tip":"e.g. Over 2.5 Goals","best_market":"totals","confidence":72,"risk":"medium","probs":{"home_win":45,"draw":27,"away_win":28,"dc_home_draw":72,"dc_away_draw":55,"dnb_home":61,"dnb_away":39,"over15":82,"under15":18,"over25":54,"under25":46,"over35":30,"under35":70,"over45":14,"btts_yes":52,"btts_no":48,"ah_home":57,"ah_away":43}}`;

  const parse=text=>{
    const s=text.replace(/^```(?:json)?\n?/,'').replace(/\n?```$/,'').trim();
    const jm=s.match(/\{[\s\S]*\}/);
    if (!jm) return null;
    try { return JSON.parse(jm[0].replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,'').replace(/\n/g,' ').replace(/\r/g,'')); }
    catch(e) {
      try {
        const tip=s.match(/"best_tip"\s*:\s*"([^"]+)"/)?.[1];
        const market=s.match(/"best_market"\s*:\s*"([^"]+)"/)?.[1];
        const summary=s.match(/"summary"\s*:\s*"([^"]{10,500})"/)?.[1];
        const reasoning=s.match(/"reasoning"\s*:\s*"([^"]{5,300})"/)?.[1];
        const confidence=parseInt(s.match(/"confidence"\s*:\s*(\d+)/)?.[1]||'65');
        const risk=s.match(/"risk"\s*:\s*"([^"]+)"/)?.[1]||'medium';
        const probsMatch=s.match(/"probs"\s*:\s*(\{[^}]+\})/);
        let probs={};
        if (probsMatch){const pairs=[...probsMatch[1].matchAll(/"(\w+)"\s*:\s*(\d+)/g)];for(const[,k,v]of pairs)probs[k]=parseInt(v);}
        if (tip) return {summary,reasoning,best_tip:tip,best_market:market,confidence,risk,probs};
      } catch(e2){}
      return null;
    }
  };

  const groqCall=async model=>{
    const resp=await fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${GROQ_KEY}`},
      body:JSON.stringify({model,messages:[{role:'system',content:'Expert football betting analyst. Respond with valid JSON only. No markdown.'},{role:'user',content:prompt}],max_tokens:1000,temperature:0.25})});
    const data=await resp.json();
    console.log(`[AI] ${model} status:${resp.status}`);
    if (resp.status!==200) return null;
    const text=(data.choices?.[0]?.message?.content||'').trim();
    return parse(text);
  };

  if (GROQ_KEY) {
    try { const r=await groqCall('llama-3.3-70b-versatile'); if(r){console.log('[AI] 70B ok:',r.best_tip);return r;} } catch(e){}
    try { const r=await groqCall('llama-3.1-8b-instant'); if(r){console.log('[AI] 8B ok:',r.best_tip);return r;} } catch(e){}
  }
  if (GEMINI_KEY) {
    try {
      const resp=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_KEY}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{temperature:0.25,maxOutputTokens:1000}})});
      const data=await resp.json();
      if (resp.status===200){const r=parse((data.candidates?.[0]?.content?.parts?.[0]?.text||'').trim());if(r){console.log('[AI] Gemini ok:',r.best_tip);return r;}}
    } catch(e){}
  }
  if (AI_KEY) {
    try {
      const resp=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':AI_KEY,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:'claude-haiku-4-5-20251001',max_tokens:1000,messages:[{role:'user',content:prompt}]})});
      const data=await resp.json();
      if (resp.status===200){const r=parse((data.content?.[0]?.text||'').trim());if(r){console.log('[AI] Claude ok:',r.best_tip);return r;}}
    } catch(e){}
  }
  console.log('[AI] All providers failed');
  return null;
}

// ── GET BEST ODDS FOR TIP ─────────────────────────────────────────────────
function getBestOdds(tip, odds, ht, at) {
  if (!tip||!odds) return {odds:null,label:tip||''};
  const t=tip.toLowerCase().trim(),h=(ht||'').toLowerCase(),a=(at||'').toLowerCase();
  if (t.includes('over 4.5')) return {odds:odds.over45,label:'Over 4.5 Goals'};
  if (t.includes('under 3.5')) return {odds:odds.under35,label:'Under 3.5 Goals'};
  if (t.includes('over 3.5')) return {odds:odds.over35,label:'Over 3.5 Goals'};
  if (t.includes('under 2.5')) return {odds:odds.under25,label:'Under 2.5 Goals'};
  if (t.includes('over 2.5')) return {odds:odds.over25,label:'Over 2.5 Goals'};
  if (t.includes('under 1.5')) return {odds:odds.under15,label:'Under 1.5 Goals'};
  if (t.includes('over 1.5')) return {odds:odds.over15,label:'Over 1.5 Goals'};
  if (t.includes('both teams to score')||t==='btts yes') return {odds:odds.bttsYes,label:'BTTS - Yes'};
  if (t.includes('both teams not')||t==='btts no') return {odds:odds.bttsNo,label:'BTTS - No'};
  if (t.includes('dnb')||t.includes('draw no bet')) {
    const isH=h.split(' ').some(w=>w.length>2&&t.includes(w));
    return isH?{odds:odds.dnbHome,label:ht+' DNB'}:{odds:odds.dnbAway,label:at+' DNB'};
  }
  if (t.includes('-0.5')||t.includes('asian')) {
    const isH=h.split(' ').some(w=>w.length>2&&t.includes(w));
    return isH?{odds:odds.ahHome,label:ht+' -0.5'}:{odds:odds.ahAway,label:at+' -0.5'};
  }
  if (t.includes(' or draw')) {
    const isH=h.split(' ').some(w=>w.length>2&&t.includes(w));
    return isH?{odds:odds.dc1X,label:ht+' or Draw'}:{odds:odds.dcX2,label:at+' or Draw'};
  }
  if (t==='draw'||t.endsWith(' draw')) return {odds:odds.draw,label:'Draw'};
  if (h.split(' ').filter(w=>w.length>2).some(w=>t.includes(w))) return {odds:odds.home,label:ht+' Win'};
  if (a.split(' ').filter(w=>w.length>2).some(w=>t.includes(w))) return {odds:odds.away,label:at+' Win'};
  return {odds:odds.home,label:ht+' Win'};
}

// ── ROUTES ────────────────────────────────────────────────────────────────
app.get('/api/fixtures', async (req, res) => {
  const date = req.query.date || today();
  try {
    if (lastFetchDate !== date || Object.keys(fixtureStore).length === 0) await loadFixtures(date);
    res.json({ fixtures: Object.values(fixtureStore), date, count: Object.keys(fixtureStore).length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/match/:id', async (req, res) => {
  const id = String(req.params.id);
  if (Object.keys(fixtureStore).length === 0) await loadFixtures(today());
  const fixture = fixtureStore[id];
  if (!fixture) return res.status(404).json({ error: 'Fixture not found' });

  const cached = db.getCachedAnalysis(id);
  const cacheDate = cached?.created_at ? cached.created_at.replace('T',' ').split(' ')[0] : null;
  if (cached && cached.analysis && cached.analysis.trim().length > 10 && cacheDate === today()) {
    console.log('[MATCH] Cache hit:', id);
    return res.json({
      id, home_team:fixture.homeTeam, away_team:fixture.awayTeam, league:fixture.league,
      fixture_date:(fixture.date||'').split('T')[0], home_logo:fixture.homeLogo, away_logo:fixture.awayLogo,
      status:fixture.status, home_goals:fixture.homeGoals, away_goals:fixture.awayGoals,
      venue:fixture.venue, odds:fixture.odds||{},
      analysis:cached.analysis, tip:cached.tip, market:cached.market,
      confidence:cached.confidence, model_prob:cached.model_prob,
      reasoning:cached.reasoning, risk:cached.risk, best_odds:cached.odds||null,
      probs:(()=>{try{return JSON.parse(cached.probs||'{}')}catch(e){return{}}})(),
      h2h:(()=>{try{return JSON.parse(cached.h2h||'[]')}catch(e){return[]}})(),
      home_form:(()=>{try{return JSON.parse(cached.home_form||'[]')}catch(e){return[]}})(),
      away_form:(()=>{try{return JSON.parse(cached.away_form||'[]')}catch(e){return[]}})(),
    });
  }

  let h2h=[],homeForm=[],awayForm=[];
  try {
    const r=await Promise.race([
      getFormAndH2H(fixture.homeTeam,fixture.awayTeam,fixture.homeEspnId,fixture.awayEspnId,fixture.leagueSlug,fixture.league,fixture.fdorgMatchId),
      new Promise(res=>setTimeout(()=>res({h2h:[],homeForm:[],awayForm:[]}),10000))
    ]);
    h2h=r.h2h; homeForm=r.homeForm; awayForm=r.awayForm;
  } catch(e) { console.error('[MATCH] Form error:',e.message); }

  console.log(`[MATCH] AI: ${fixture.homeTeam} vs ${fixture.awayTeam} | home:${homeForm.length} away:${awayForm.length} h2h:${h2h.length}`);
  const ai = await analyseWithAI(fixture.homeTeam, fixture.awayTeam, fixture.league, fixture.odds, h2h, homeForm, awayForm);
  const odds = fixture.odds || {};
  const {odds:bestOdds, label:betLabel} = getBestOdds(ai?.best_tip, odds, fixture.homeTeam, fixture.awayTeam);
  const modelProb = ai?.confidence || 55;
  const impliedProb = bestOdds ? Math.round(100/bestOdds) : null;
  const edgePct = impliedProb != null ? modelProb - impliedProb : null;

  // has_value: true if edge exists AND odds available.
  // no_odds_tip: true when AI gave a tip but no odds are available — still show the pick, just no bet button.
  const hasValue = edgePct != null && edgePct >= 2;
  const noOddsTip = !!(ai?.best_tip && !bestOdds);

  if (ai?.summary) {
    db.cacheAnalysis({
      fixture_id:id, home_team:fixture.homeTeam, away_team:fixture.awayTeam,
      league:fixture.league, fixture_date:(fixture.date||'').split('T')[0],
      analysis:ai.summary, tip:ai.best_tip||'', market:ai.best_market||'h2h',
      best_odds:bestOdds||null, edge_pct:edgePct, model_prob:modelProb,
      confidence:ai.confidence, reasoning:ai.reasoning, risk:ai.risk,
      probs:JSON.stringify(ai.probs||{}),
      h2h:JSON.stringify(h2h), home_form:JSON.stringify(homeForm), away_form:JSON.stringify(awayForm),
    });
  }

  res.json({
    id, home_team:fixture.homeTeam, away_team:fixture.awayTeam, league:fixture.league,
    fixture_date:(fixture.date||'').split('T')[0], home_logo:fixture.homeLogo, away_logo:fixture.awayLogo,
    status:fixture.status, home_goals:fixture.homeGoals, away_goals:fixture.awayGoals,
    venue:fixture.venue, odds,
    analysis:ai?.summary||null, tip:ai?.best_tip||null, market:ai?.best_market||null,
    confidence:ai?.confidence||null, model_prob:modelProb,
    reasoning:ai?.reasoning||null, risk:ai?.risk||null,
    best_odds:bestOdds||null, bet_label:betLabel||null,
    implied_prob:impliedProb, edge_pct:edgePct, has_value:hasValue, no_odds_tip:noOddsTip,
    probs:ai?.probs||{}, h2h, home_form:homeForm, away_form:awayForm,
  });
});

// ── BSD PREDICTIONS ROUTES ────────────────────────────────────────────────

/**
 * GET /api/bsd-predictions
 * Returns enriched BSD predictions (cached, refreshes every 15 min).
 * 200 immediately if cache is warm; triggers background update if stale.
 */
app.get('/api/bsd-predictions', async (req, res) => {
  try {
    const preds = await bsd.getPredictions();
    res.json({ ok: true, count: preds.length, predictions: preds });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /api/bsd-predictions/refresh
 * Force-triggers a cache refresh (fire-and-forget).
 * Useful for Render keep-alive pings and manual refreshes.
 */
app.post('/api/bsd-predictions/refresh', (req, res) => {
  bsd.updateCache(); // non-blocking
  res.json({ ok: true, message: 'Cache refresh triggered' });
});

// ── EXISTING ROUTES (unchanged) ───────────────────────────────────────────
app.post('/api/bet', (req, res) => {
  try { const bet=db.placeBet(req.body); if(!bet)return res.json({ok:false,reason:'Insufficient bankroll'}); res.json({ok:true,bet}); }
  catch(e) { res.status(500).json({ok:false,reason:e.message}); }
});
app.get('/api/bets', (req, res) => { res.json(db.getBets({limit:parseInt(req.query.limit)||50})); });
app.get('/api/portfolio', (req, res) => { res.json(db.getStats()); });
app.post('/api/settle', async (req, res) => {
  try {
    await loadFixtures(today());
    let settled=0;
    for (const bet of db.getBets({pending:true})) {
      const f=fixtureStore[String(bet.fixture_id)];
      if (!f||f.homeGoals==null) continue;
      const s=(f.status||'').toLowerCase();
      if (!s.includes('ft')&&!s.includes('final')&&!s.includes('full')) continue;
      settled+=db.settleBet(bet.fixture_id,f.homeGoals,f.awayGoals);
    }
    res.json({ok:true,settled});
  } catch(e) { res.status(500).json({error:e.message}); }
});
app.get('/api/status', (req, res) => {
  const s=db.getStats();
  res.json({
    status:'ok', version:'3.1',
    hasAI:!!(GROQ_KEY||AI_KEY||GEMINI_KEY),
    hasBSD:!!process.env.BSD_API_KEY,
    bankroll:s.bankroll, totalBets:s.totalBets, winRate:s.winRate,
  });
});
app.post('/api/bankroll/reset', (req, res) => { const a=parseFloat(req.body.amount)||1000; db.resetBankroll(a); res.json({ok:true,amount:a}); });
app.get('/api/test-ai', async (req, res) => {
  try {
    const r=await analyseWithAI('Arsenal','Chelsea','Premier League',{home:2.1,draw:3.4,away:3.6,over25:1.75,under25:2.1,bttsYes:1.8},[],[{date:'2026-02-22',homeTeam:'Arsenal',awayTeam:'Man City',homeGoals:2,awayGoals:1,isHome:true,result:'W'}],[{date:'2026-02-22',homeTeam:'Chelsea',awayTeam:'Spurs',homeGoals:2,awayGoals:2,isHome:true,result:'D'}]);
    res.json({ok:true,result:r,groqKey:GROQ_KEY?'set':'MISSING'});
  } catch(e) { res.json({ok:false,error:e.message}); }
});
app.get('*', (req, res) => res.sendFile(path.join(__dirname,'../public/index.html')));

// ── STARTUP ───────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`PROPRED v3.1 :${PORT} | Groq:${GROQ_KEY?'✅':'❌'} | BSD:${process.env.BSD_API_KEY?'✅':'❌'} | FDORG:${FDORG_KEY?'✅':'❌'} | Odds:${ODDS_KEY?'✅':'❌'}`);

  // DB migrations
  try { db.prepare("ALTER TABLE analysis_cache ADD COLUMN probs TEXT DEFAULT '{}'").run(); } catch(e) {}
  try { db.prepare("DELETE FROM analysis_cache WHERE date(created_at) < date('now')").run(); } catch(e) {}

  // Warm both caches on startup (non-blocking for BSD so fixtures load first)
  await loadFixtures(today());
  bsd.scheduleRefresh(); // starts BSD fetch + sets 15-min interval
});
