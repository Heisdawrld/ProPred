const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');
const db      = require('./db');

const app  = express();
const PORT = process.env.PORT || 3000;

const ODDS_KEY  = process.env.ODDS_API_KEY  || 'f40efeabae93fc096daa59c7e2ab6fc2';
const AF_KEY    = process.env.API_FOOTBALL_KEY || 'dld7aaea599eb42ce6a723c2935ee70e';
const AI_KEY    = process.env.ANTHROPIC_KEY || '';
const ODDS_BASE = 'https://api.the-odds-api.com/v4';
const AF_BASE   = 'https://v3.football.api-sports.io';

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── ESPN ───────────────────────────────────────────────────────────────────
const ESPN_LEAGUES = [
  { id: 'eng.1',          name: 'Premier League',  oddsKey: 'soccer_epl' },
  { id: 'esp.1',          name: 'La Liga',          oddsKey: 'soccer_spain_la_liga' },
  { id: 'ger.1',          name: 'Bundesliga',       oddsKey: 'soccer_germany_bundesliga' },
  { id: 'ita.1',          name: 'Serie A',          oddsKey: 'soccer_italy_serie_a' },
  { id: 'fra.1',          name: 'Ligue 1',          oddsKey: 'soccer_france_ligue_one' },
  { id: 'uefa.champions', name: 'Champions League', oddsKey: 'soccer_uefa_champs_league' },
  { id: 'uefa.europa',    name: 'Europa League',    oddsKey: 'soccer_uefa_europa_league' },
  { id: 'eng.2',          name: 'Championship',     oddsKey: 'soccer_efl_champ' },
  { id: 'ned.1',          name: 'Eredivisie',       oddsKey: 'soccer_netherlands_eredivisie' },
  { id: 'por.1',          name: 'Primeira Liga',    oddsKey: 'soccer_portugal_primeira_liga' },
  { id: 'sco.1',          name: 'Scottish Prem',    oddsKey: 'soccer_scotland_premiership' },
  { id: 'tur.1',          name: 'Super Lig',        oddsKey: 'soccer_turkey_super_league' },
];

// In-memory fixture store so match page can find fixtures by ID
const fixtureStore = {};

function espnStatus(code) {
  const m = { STATUS_SCHEDULED:'NS',STATUS_IN_PROGRESS:'1H',STATUS_HALFTIME:'HT',
    STATUS_FINAL:'FT',STATUS_FULL_TIME:'FT',STATUS_POSTPONED:'PST',STATUS_CANCELED:'CANC' };
  return m[code]||'NS';
}

async function fetchESPN(date) {
  const d = date.replace(/-/g,'');
  const all = [];
  await Promise.all(ESPN_LEAGUES.map(async league => {
    try {
      const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/${league.id}/scoreboard?dates=${d}`;
      const resp = await fetch(url);
      const data = await resp.json();
      (data.events||[]).forEach(ev => {
        const comp = ev.competitions?.[0];
        const home = comp?.competitors?.find(c=>c.homeAway==='home');
        const away = comp?.competitors?.find(c=>c.homeAway==='away');
        if(!home||!away) return;
        const hG=parseInt(home.score), aG=parseInt(away.score);
        const fixture = {
          id: ev.id, date: comp.date,
          status: espnStatus(comp.status?.type?.name),
          homeTeam: home.team.displayName, awayTeam: away.team.displayName,
          homeLogo: home.team.logo, awayLogo: away.team.logo,
          homeGoals: isNaN(hG)?null:hG, awayGoals: isNaN(aG)?null:aG,
          league: league.name, leagueId: league.id, oddsKey: league.oddsKey,
          venue: comp.venue?.fullName||null,
          odds: {home:null,draw:null,away:null,over25:null,under25:null},
          hasOdds: false,
        };
        all.push(fixture);
        fixtureStore[ev.id] = fixture; // store for match lookup
      });
      console.log(`[ESPN] ${league.name}: ${data.events?.length||0}`);
    } catch(e) { console.error(`[ESPN] ${league.name}:`, e.message); }
  }));
  return all;
}

// ── ODDS ───────────────────────────────────────────────────────────────────
const oddsCache = {};
async function getOdds(sportKey) {
  const now = Date.now();
  if(oddsCache[sportKey]&&now-oddsCache[sportKey].ts<30*60*1000) return oddsCache[sportKey].data;
  try {
    const resp = await fetch(`${ODDS_BASE}/sports/${sportKey}/odds?apiKey=${ODDS_KEY}&regions=uk&markets=h2h,totals&oddsFormat=decimal`);
    console.log(`[ODDS] ${sportKey} remaining: ${resp.headers.get('x-requests-remaining')}`);
    const data = await resp.json();
    oddsCache[sportKey]={ts:now,data};
    return data;
  } catch(e) { return []; }
}

function matchOdds(oddsData, homeTeam, awayTeam) {
  if(!oddsData?.length) return null;
  const norm = s=>(s||'').toLowerCase().replace(/[^a-z0-9]/g,' ').replace(/\s+/g,' ').trim();
  const hn=norm(homeTeam), an=norm(awayTeam);
  for(const m of oddsData){
    const mhn=norm(m.home_team), man=norm(m.away_team);
    const hOk=mhn===hn||mhn.includes(hn.split(' ')[0])||hn.includes(mhn.split(' ')[0]);
    const aOk=man===an||man.includes(an.split(' ')[0])||an.includes(man.split(' ')[0]);
    if(hOk&&aOk) return m;
  }
  return null;
}

function extractOdds(oddsMatch, homeTeam, awayTeam) {
  if(!oddsMatch) return {home:null,draw:null,away:null,over25:null,under25:null};
  const bm=oddsMatch.bookmakers?.[0];
  const h2hMkt=bm?.markets?.find(m=>m.key==='h2h');
  const totMkt=bm?.markets?.find(m=>m.key==='totals');
  return {
    home:   h2hMkt?.outcomes?.find(o=>o.name===homeTeam)?.price || h2hMkt?.outcomes?.[0]?.price,
    draw:   h2hMkt?.outcomes?.find(o=>o.name==='Draw')?.price,
    away:   h2hMkt?.outcomes?.find(o=>o.name===awayTeam)?.price || h2hMkt?.outcomes?.[2]?.price,
    over25: totMkt?.outcomes?.find(o=>o.name==='Over'&&o.point===2.5)?.price,
    under25:totMkt?.outcomes?.find(o=>o.name==='Under'&&o.point===2.5)?.price,
  };
}

// ── API-FOOTBALL ───────────────────────────────────────────────────────────
async function afFetch(endpoint) {
  try {
    const resp = await fetch(`${AF_BASE}${endpoint}`,{headers:{'x-apisports-key':AF_KEY}});
    const data = await resp.json();
    return data.response||[];
  } catch(e) { return []; }
}

// ── CLAUDE AI ──────────────────────────────────────────────────────────────
async function analyseWithAI(homeTeam, awayTeam, league, h2h, homeForm, awayForm, odds) {
  const fmtH2H = h2h.slice(0,5).map(m=>`${m.teams?.home?.name} ${m.goals?.home??'?'}-${m.goals?.away??'?'} ${m.teams?.away?.name}`).join(' | ')||'No H2H data';
  
  const fmtForm = (fixtures, teamName) => {
    const finished = fixtures.filter(m=>m.goals?.home!=null&&m.goals?.away!=null).slice(0,5);
    return finished.map(m=>{
      const isHome=m.teams?.home?.name?.toLowerCase().includes(teamName.split(' ')[0].toLowerCase());
      const gf=isHome?m.goals.home:m.goals.away, ga=isHome?m.goals.away:m.goals.home;
      return `${gf>ga?'W':gf<ga?'L':'D'}(${gf}-${ga})`;
    }).join(' ')||'No form data';
  };

  const oddsStr = odds?.home
    ? `Home:${odds.home} Draw:${odds.draw} Away:${odds.away}${odds.over25?` O2.5:${odds.over25} U2.5:${odds.under25}`:''}`
    : 'No odds available';

  const prompt = `You are a sharp football betting analyst. Analyse this match and find value.

MATCH: ${homeTeam} vs ${awayTeam} (${league})
H2H: ${fmtH2H}
${homeTeam} recent form: ${fmtForm(homeForm, homeTeam)}
${awayTeam} recent form: ${fmtForm(awayForm, awayTeam)}
Bookmaker odds: ${oddsStr}

Respond ONLY with valid JSON, no other text:
{"summary":"2 sentence analysis","tip":"e.g. Liverpool Win or Over 2.5 Goals","market":"h2h or totals","confidence":65,"model_prob":68,"reasoning":"one sentence on value","risk":"low|medium|high"}

Rules: confidence between 40-85. Be sharp and specific.`;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages',{
      method:'POST',
      headers:{'Content-Type':'application/json','x-api-key':AI_KEY,'anthropic-version':'2023-06-01'},
      body:JSON.stringify({model:'claude-haiku-4-5-20251001',max_tokens:1024,messages:[{role:'user',content:prompt}]})
    });
    const data = await resp.json();
    console.log('[AI] HTTP:', resp.status, '| raw:', JSON.stringify(data).slice(0,300));
    const text = data.content?.[0]?.text||'';
    if(!text){ console.error('[AI] No text in response'); return null; }
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if(!jsonMatch){ console.error('[AI] No JSON found:', text.slice(0,200)); return null; }
    return JSON.parse(jsonMatch[0]);
  } catch(e) { console.error('[AI] Error:',e.message); return null; }
}

function getBestOddsForTip(oddsMatch, tip, market, modelProb) {
  if(!oddsMatch||!tip) return null;
  const tipL=(tip||'').toLowerCase();
  let best=null;
  for(const bm of oddsMatch.bookmakers||[]){
    const mkt=bm.markets?.find(m=>m.key===market);
    if(!mkt) continue;
    for(const o of mkt.outcomes||[]){
      const nL=(o.name||'').toLowerCase();
      const isMatch = market==='totals'
        ? (tipL.includes('over 2.5')&&nL==='over'&&o.point===2.5)||(tipL.includes('under 2.5')&&nL==='under'&&o.point===2.5)
        : tipL.split(' ').filter(w=>w.length>3).some(w=>nL.includes(w));
      if(isMatch&&o.price&&(!best||o.price>best)) best=o.price;
    }
  }
  if(!best) return null;
  const implied=Math.round(1/best*100);
  return {odds:parseFloat(best.toFixed(2)),implied,edgePct:Math.round((modelProb||50)-implied)};
}

// ── ROUTES ─────────────────────────────────────────────────────────────────

app.get('/api/fixtures', async (req, res) => {
  try {
    const date = req.query.date||new Date().toISOString().split('T')[0];
    const fixtures = await fetchESPN(date);
    const sportKeys=[...new Set(fixtures.map(f=>f.oddsKey).filter(Boolean))];
    const allOdds=(await Promise.all(sportKeys.map(getOdds))).flat();
    fixtures.forEach(f=>{
      const om=matchOdds(allOdds,f.homeTeam,f.awayTeam);
      if(om){ f.odds=extractOdds(om,f.homeTeam,f.awayTeam); f.hasOdds=!!(f.odds.home); }
    });
    res.json({date,fixtures,count:fixtures.length});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/match/:id', async (req, res) => {
  try {
    const fixtureId = req.params.id;
    console.log('[MATCH] Loading:', fixtureId);

    // Get fixture from store (populated when /api/fixtures was called)
    let fixture = fixtureStore[fixtureId];
    
    // If not in store, fetch today AND yesterday fixtures to populate store
    if(!fixture) {
      const today = new Date().toISOString().split('T')[0];
      const yesterday = new Date(Date.now()-86400000).toISOString().split('T')[0];
      const tomorrow = new Date(Date.now()+86400000).toISOString().split('T')[0];
      await Promise.all([fetchESPN(today), fetchESPN(yesterday), fetchESPN(tomorrow)]);
      fixture = fixtureStore[fixtureId];
    }

    if(!fixture) {
      console.log('[MATCH] Not found. Store has:', Object.keys(fixtureStore).length, 'fixtures. Keys:', Object.keys(fixtureStore).slice(0,10));
      // Last resort: return a basic response so AI still runs
      return res.status(404).json({error:`Fixture ${fixtureId} not found. Please go to Fixtures page first, then click a match.`});
    }

    console.log('[MATCH] Found:', fixture.homeTeam, 'vs', fixture.awayTeam);

    // Get odds
    const oddsData = fixture.oddsKey ? await getOdds(fixture.oddsKey) : [];
    const oddsMatch = matchOdds(oddsData, fixture.homeTeam, fixture.awayTeam);
    const odds = extractOdds(oddsMatch, fixture.homeTeam, fixture.awayTeam);

    // Get H2H and form from API-Football
    let h2h=[], homeForm=[], awayForm=[];
    try {
      const [homeSearch, awaySearch] = await Promise.all([
        afFetch(`/teams?name=${encodeURIComponent(fixture.homeTeam)}`),
        afFetch(`/teams?name=${encodeURIComponent(fixture.awayTeam)}`),
      ]);
      const homeId=homeSearch[0]?.team?.id;
      const awayId=awaySearch[0]?.team?.id;
      console.log('[AF] homeId:', homeId, 'awayId:', awayId);
      if(homeId&&awayId){
        [h2h,homeForm,awayForm]=await Promise.all([
          afFetch(`/fixtures/headtohead?h2h=${homeId}-${awayId}&last=10`),
          afFetch(`/fixtures?team=${homeId}&last=8&status=FT`),
          afFetch(`/fixtures?team=${awayId}&last=8&status=FT`),
        ]);
        console.log('[AF] h2h:', h2h.length, 'homeForm:', homeForm.length, 'awayForm:', awayForm.length);
      }
    } catch(e){ console.error('[AF]', e.message); }

    // AI analysis
    let ai=null;
    if(AI_KEY){
      console.log('[AI] Calling Claude...');
      ai=await analyseWithAI(fixture.homeTeam,fixture.awayTeam,fixture.league,h2h,homeForm,awayForm,odds);
      console.log('[AI] Result:', JSON.stringify(ai));
    } else {
      console.log('[AI] No key set');
    }

    let oddsInfo=null;
    if(ai?.tip&&oddsMatch) oddsInfo=getBestOddsForTip(oddsMatch,ai.tip,ai.market,ai.model_prob);

    const fmtForm=(fixtures,teamName)=>fixtures.map(m=>({
      date:m.fixture?.date?.split('T')[0],
      homeTeam:m.teams?.home?.name, awayTeam:m.teams?.away?.name,
      homeGoals:m.goals?.home, awayGoals:m.goals?.away,
      isHome:m.teams?.home?.name?.toLowerCase().includes((teamName||'').split(' ')[0].toLowerCase()),
      result:m.goals?.home==null?null:
        m.teams?.home?.name?.toLowerCase().includes((teamName||'').split(' ')[0].toLowerCase())
          ?(m.goals.home>m.goals.away?'W':m.goals.home<m.goals.away?'L':'D')
          :(m.goals.away>m.goals.home?'W':m.goals.away<m.goals.home?'L':'D'),
    }));

    const response={
      fixture_id:fixtureId,
      home_team:fixture.homeTeam, away_team:fixture.awayTeam,
      home_logo:fixture.homeLogo, away_logo:fixture.awayLogo,
      league:fixture.league, fixture_date:fixture.date?.split('T')[0],
      status:fixture.status, venue:fixture.venue,
      h2h:h2h.slice(0,5).map(m=>({date:m.fixture?.date?.split('T')[0],homeTeam:m.teams?.home?.name,awayTeam:m.teams?.away?.name,homeGoals:m.goals?.home,awayGoals:m.goals?.away})),
      home_form:fmtForm(homeForm,fixture.homeTeam),
      away_form:fmtForm(awayForm,fixture.awayTeam),
      odds,
      analysis:ai?.summary||null, tip:ai?.tip||null, market:ai?.market||null,
      confidence:ai?.confidence||null, model_prob:ai?.model_prob||null,
      reasoning:ai?.reasoning||null, risk:ai?.risk||null,
      best_odds:oddsInfo?.odds||null, implied_prob:oddsInfo?.implied||null,
      edge_pct:oddsInfo?.edgePct||null, has_value:(oddsInfo?.edgePct||0)>=5,
    };

    db.cacheAnalysis(response);
    res.json(response);
  } catch(e){ console.error('[MATCH ERROR]',e.message,e.stack); res.status(500).json({error:e.message}); }
});

app.post('/api/bet',(req,res)=>{
  try{
    const bet=db.placeBet(req.body);
    if(!bet) return res.json({ok:false,reason:'Insufficient bankroll or no edge'});
    res.json({ok:true,bet});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/settle',async(req,res)=>{
  try{
    const pending=db.getBets({pending:true});
    let settled=0;
    for(const bet of pending){
      for(const league of ESPN_LEAGUES){
        try{
          const resp=await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${league.id}/summary?event=${bet.fixture_id}`);
          const data=await resp.json();
          const comp=data.header?.competitions?.[0];
          if(!comp) continue;
          if(!['FT','AET'].includes(espnStatus(comp.status?.type?.name))) break;
          const home=comp.competitors?.find(c=>c.homeAway==='home');
          const away=comp.competitors?.find(c=>c.homeAway==='away');
          const hG=parseInt(home?.score), aG=parseInt(away?.score);
          if(isNaN(hG)||isNaN(aG)) break;
          settled+=db.settleBet(bet.fixture_id,hG,aG);
          break;
        }catch(e){}
      }
    }
    res.json({ok:true,settled,checked:pending.length});
  }catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/portfolio',(req,res)=>{
  try{res.json(db.getStats());}catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/bets',(req,res)=>{
  try{res.json(db.getBets({limit:parseInt(req.query.limit)||50}));}catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/bankroll/reset',(req,res)=>{
  try{const a=req.body.amount||1000;db.resetBankroll(a);res.json({ok:true,bankroll:a});}
  catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/status',(req,res)=>{
  const s=db.getStats();
  res.json({status:'ok',version:'2.0',hasAI:!!AI_KEY,bankroll:s.bankroll,totalBets:s.totalBets,winRate:s.winRate});
});

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'../public/index.html')));

app.listen(PORT,()=>{
  console.log(`PROPRED v2 on :${PORT} | AI:${AI_KEY?'✅':'❌'}`);
  // Pre-populate fixture store on startup
  const today = new Date().toISOString().split('T')[0];
  fetchESPN(today).then(f=>console.log(`[STARTUP] Loaded ${f.length} fixtures into store`)).catch(()=>{});
  setTimeout(()=>{
    fetch(`http://localhost:${PORT}/api/settle`,{method:'POST'})
      .then(r=>r.json()).then(d=>console.log('[STARTUP] Settled:',d.settled)).catch(()=>{});
  },2000);
});
