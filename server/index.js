const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');
const db      = require('./db');

const app  = express();
const PORT = process.env.PORT || 3000;

const ODDS_KEY  = process.env.ODDS_API_KEY  || 'f40efeabae93fc096daa59c7e2ab6fc2';
const AF_KEY    = process.env.API_FOOTBALL_KEY || 'dld7aaea599eb42ce6a723c2935ee70e';
const AI_KEY    = process.env.ANTHROPIC_KEY || '';
const AF_BASE   = 'https://v3.football.api-sports.io';
const ODDS_BASE = 'https://api.the-odds-api.com/v4';

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── ESPN (FREE, NO KEY) ────────────────────────────────────────────────────
const ESPN_LEAGUES = [
  { id: 'eng.1',          name: 'Premier League',   oddsKey: 'soccer_epl' },
  { id: 'esp.1',          name: 'La Liga',           oddsKey: 'soccer_spain_la_liga' },
  { id: 'ger.1',          name: 'Bundesliga',        oddsKey: 'soccer_germany_bundesliga' },
  { id: 'ita.1',          name: 'Serie A',           oddsKey: 'soccer_italy_serie_a' },
  { id: 'fra.1',          name: 'Ligue 1',           oddsKey: 'soccer_france_ligue_one' },
  { id: 'uefa.champions', name: 'Champions League',  oddsKey: 'soccer_uefa_champs_league' },
  { id: 'uefa.europa',    name: 'Europa League',     oddsKey: 'soccer_uefa_europa_league' },
  { id: 'eng.2',          name: 'Championship',      oddsKey: 'soccer_efl_champ' },
  { id: 'ned.1',          name: 'Eredivisie',        oddsKey: 'soccer_netherlands_eredivisie' },
  { id: 'por.1',          name: 'Primeira Liga',     oddsKey: 'soccer_portugal_primeira_liga' },
  { id: 'sco.1',          name: 'Scottish Prem',     oddsKey: 'soccer_scotland_premiership' },
  { id: 'tur.1',          name: 'Super Lig',         oddsKey: 'soccer_turkey_super_league' },
];

function espnStatus(code) {
  const m = { STATUS_SCHEDULED:'NS', STATUS_IN_PROGRESS:'1H', STATUS_HALFTIME:'HT',
    STATUS_FINAL:'FT', STATUS_FULL_TIME:'FT', STATUS_POSTPONED:'PST', STATUS_CANCELED:'CANC' };
  return m[code] || 'NS';
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
        const hG = parseInt(home.score), aG = parseInt(away.score);
        all.push({
          id:         ev.id,
          date:       comp.date,
          status:     espnStatus(comp.status?.type?.name),
          homeTeam:   home.team.displayName,
          awayTeam:   away.team.displayName,
          homeLogo:   home.team.logo,
          awayLogo:   away.team.logo,
          homeGoals:  isNaN(hG)?null:hG,
          awayGoals:  isNaN(aG)?null:aG,
          league:     league.name,
          leagueId:   league.id,
          oddsKey:    league.oddsKey,
          venue:      comp.venue?.fullName||null,
          odds:       {home:null,draw:null,away:null,over25:null,under25:null},
          hasOdds:    false,
        });
      });
      console.log(`[ESPN] ${league.name}: ${data.events?.length||0} fixtures`);
    } catch(e) { console.error(`[ESPN] ${league.name}:`, e.message); }
  }));
  return all;
}

// ── ODDS API ───────────────────────────────────────────────────────────────
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

// ── API-FOOTBALL (H2H + FORM only) ────────────────────────────────────────
async function afFetch(endpoint) {
  try {
    const resp = await fetch(`${AF_BASE}${endpoint}`,{headers:{'x-apisports-key':AF_KEY}});
    const data = await resp.json();
    return data.response||[];
  } catch(e) { return []; }
}

// ── CLAUDE AI ──────────────────────────────────────────────────────────────
async function analyseWithAI(homeTeam, awayTeam, league, h2h, homeForm, awayForm, odds) {
  const fmtH2H = h2h.slice(0,5).map(m=>`${m.teams.home.name} ${m.goals.home??'?'}-${m.goals.away??'?'} ${m.teams.away.name}`).join(' | ')||'No data';
  const fmtForm = (fixtures, teamId) => fixtures.slice(0,5).map(m=>{
    const isHome=m.teams.home.id===teamId;
    const gf=isHome?m.goals.home:m.goals.away, ga=isHome?m.goals.away:m.goals.home;
    const r=gf>ga?'W':gf<ga?'L':'D';
    return `${r}(${gf??'?'}-${ga??'?'})`;
  }).join(' ')||'Unknown';

  const oddsStr = odds.home
    ? `1X2: ${odds.home}/${odds.draw}/${odds.away}${odds.over25?` | O2.5:${odds.over25} U2.5:${odds.under25}`:''}`
    : 'No odds';

  const prompt = `You are a sharp football betting analyst. Analyse this match concisely.

MATCH: ${homeTeam} vs ${awayTeam} (${league})
H2H last 5: ${fmtH2H}
${homeTeam} form: ${fmtForm(homeForm, homeForm[0]?.teams?.home?.id)}
${awayTeam} form: ${fmtForm(awayForm, awayForm[0]?.teams?.away?.id)}
Bookmaker odds: ${oddsStr}

Respond ONLY in this exact JSON format:
{"summary":"2 sentence analysis","tip":"e.g. Arsenal Win or Over 2.5 Goals","market":"h2h or totals","confidence":65,"model_prob":68,"reasoning":"why this has value vs the odds","risk":"low|medium|high"}

Rules: confidence 40-85 only. Only pick value you genuinely see. Be sharp, not generic.`;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages',{
      method:'POST',
      headers:{'Content-Type':'application/json','x-api-key':AI_KEY,'anthropic-version':'2023-06-01'},
      body:JSON.stringify({model:'claude-sonnet-4-5',max_tokens:400,messages:[{role:'user',content:prompt}]})
    });
    const data = await resp.json();
    console.log('[AI] Response status:', resp.status, '| data:', JSON.stringify(data).slice(0,300));
    const text = data.content?.[0]?.text||'';
    return JSON.parse(text.replace(/```json|```/g,'').trim());
  } catch(e) { console.error('[AI]',e.message); return null; }
}

function getBestOddsForTip(oddsMatch, tip, market, modelProb) {
  if(!oddsMatch) return null;
  const tipL=(tip||'').toLowerCase();
  let best=null;
  for(const bm of oddsMatch.bookmakers||[]){
    const mkt=bm.markets?.find(m=>m.key===market);
    if(!mkt) continue;
    for(const o of mkt.outcomes||[]){
      const nL=(o.name||'').toLowerCase();
      const isMatch = market==='totals'
        ? (tipL.includes('over 2.5')&&nL==='over'&&o.point===2.5)||(tipL.includes('under 2.5')&&nL==='under'&&o.point===2.5)
          ||(tipL.includes('over 1.5')&&nL==='over'&&o.point===1.5)||(tipL.includes('over 3.5')&&nL==='over'&&o.point===3.5)
        : tipL.split(' ').some(w=>w.length>3&&nL.includes(w));
      if(isMatch&&o.price&&(!best||o.price>best)) best=o.price;
    }
  }
  if(!best) return null;
  const implied=Math.round(1/best*100);
  return {odds:parseFloat(best.toFixed(2)),implied,edgePct:Math.round(modelProb-implied)};
}

// ── ROUTES ─────────────────────────────────────────────────────────────────

app.get('/api/fixtures', async (req, res) => {
  try {
    const date = req.query.date||new Date().toISOString().split('T')[0];
    const fixtures = await fetchESPN(date);

    // Fetch odds for leagues that have them
    const sportKeys=[...new Set(fixtures.map(f=>f.oddsKey).filter(Boolean))];
    const allOdds=(await Promise.all(sportKeys.map(getOdds))).flat();

    // Attach odds
    fixtures.forEach(f=>{
      const om=matchOdds(allOdds,f.homeTeam,f.awayTeam);
      if(om){
        f.odds=extractOdds(om,f.homeTeam,f.awayTeam);
        f.hasOdds=!!(f.odds.home);
      }
    });

    res.json({date,fixtures,count:fixtures.length});
  } catch(e){ console.error('[FIXTURES]',e.message); res.status(500).json({error:e.message}); }
});

app.get('/api/match/:id', async (req, res) => {
  try {
    const fixtureId = req.params.id;
    const cached = db.getCachedAnalysis(fixtureId);
    if(cached) return res.json({...cached,fromCache:true});

    // Find fixture from ESPN first
    const date = req.query.date||new Date().toISOString().split('T')[0];
    const fixtures = await fetchESPN(date);
    let fixture = fixtures.find(f=>String(f.id)===String(fixtureId));

    // If not found in today, try fetching directly from ESPN event endpoint
    if(!fixture){
      try {
        // Try each league until we find it
        for(const league of ESPN_LEAGUES){
          const resp=await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${league.id}/summary?event=${fixtureId}`);
          const data=await resp.json();
          if(data.header?.competitions?.[0]){
            const comp=data.header.competitions[0];
            const home=comp.competitors?.find(c=>c.homeAway==='home');
            const away=comp.competitors?.find(c=>c.homeAway==='away');
            if(home&&away){
              fixture={
                id:fixtureId,homeTeam:home.team.displayName,awayTeam:away.team.displayName,
                homeLogo:home.team.logo,awayLogo:away.team.logo,
                homeGoals:parseInt(home.score)||null,awayGoals:parseInt(away.score)||null,
                league:league.name,leagueId:league.id,oddsKey:league.oddsKey,
                status:espnStatus(comp.status?.type?.name),
                venue:data.gameInfo?.venue?.fullName||null,
              };
              break;
            }
          }
        }
      } catch(e){}
    }

    if(!fixture) return res.status(404).json({error:'Fixture not found'});

    // Get H2H and form from API-Football by searching team names
    let h2h=[], homeForm=[], awayForm=[];
    try {
      // Search for team IDs by name
      const [homeSearch, awaySearch] = await Promise.all([
        afFetch(`/teams?name=${encodeURIComponent(fixture.homeTeam)}`),
        afFetch(`/teams?name=${encodeURIComponent(fixture.awayTeam)}`),
      ]);
      const homeId = homeSearch[0]?.team?.id;
      const awayId = awaySearch[0]?.team?.id;
      if(homeId&&awayId){
        [h2h,homeForm,awayForm] = await Promise.all([
          afFetch(`/fixtures/headtohead?h2h=${homeId}-${awayId}&last=10`),
          afFetch(`/fixtures?team=${homeId}&last=8`),
          afFetch(`/fixtures?team=${awayId}&last=8`),
        ]);
      }
    } catch(e){ console.error('[AF H2H]',e.message); }

    // Get odds
    const oddsData = fixture.oddsKey ? await getOdds(fixture.oddsKey) : [];
    const oddsMatch = matchOdds(oddsData,fixture.homeTeam,fixture.awayTeam);
    const odds = extractOdds(oddsMatch,fixture.homeTeam,fixture.awayTeam);

    // AI analysis
    let ai=null;
    if(AI_KEY) ai=await analyseWithAI(fixture.homeTeam,fixture.awayTeam,fixture.league,h2h,homeForm,awayForm,odds);

    // Edge calculation
    let oddsInfo=null;
    if(ai?.tip&&oddsMatch) oddsInfo=getBestOddsForTip(oddsMatch,ai.tip,ai.market,ai.model_prob);

    const fmtForm=(fixtures,teamId)=>fixtures.map(m=>({
      date:m.fixture?.date?.split('T')[0],
      homeTeam:m.teams?.home?.name,awayTeam:m.teams?.away?.name,
      homeGoals:m.goals?.home,awayGoals:m.goals?.away,
      isHome:m.teams?.home?.id===teamId,
      result:m.goals?.home==null?null:
        m.teams?.home?.id===teamId?(m.goals.home>m.goals.away?'W':m.goals.home<m.goals.away?'L':'D')
                                  :(m.goals.away>m.goals.home?'W':m.goals.away<m.goals.home?'L':'D'),
    }));

    const response={
      fixture_id:fixtureId,
      home_team:fixture.homeTeam,away_team:fixture.awayTeam,
      home_logo:fixture.homeLogo,away_logo:fixture.awayLogo,
      league:fixture.league,fixture_date:fixture.date?.split('T')[0],
      status:fixture.status,venue:fixture.venue,
      h2h:h2h.slice(0,5).map(m=>({date:m.fixture?.date?.split('T')[0],homeTeam:m.teams?.home?.name,awayTeam:m.teams?.away?.name,homeGoals:m.goals?.home,awayGoals:m.goals?.away})),
      home_form:fmtForm(homeForm,homeForm[0]?.teams?.home?.id),
      away_form:fmtForm(awayForm,awayForm[0]?.teams?.away?.id),
      odds,
      analysis:ai?.summary||null,tip:ai?.tip||null,market:ai?.market||null,
      confidence:ai?.confidence||null,model_prob:ai?.model_prob||null,
      reasoning:ai?.reasoning||null,risk:ai?.risk||null,
      best_odds:oddsInfo?.odds||null,implied_prob:oddsInfo?.implied||null,
      edge_pct:oddsInfo?.edgePct||null,has_value:(oddsInfo?.edgePct||0)>=5,
    };

    db.cacheAnalysis(response);
    res.json(response);
  } catch(e){ console.error('[MATCH]',e.message); res.status(500).json({error:e.message}); }
});

app.post('/api/bet',(req,res)=>{
  try{
    const bet=db.placeBet(req.body);
    if(!bet) return res.json({ok:false,reason:'Insufficient bankroll or no edge'});
    res.json({ok:true,bet});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/settle', async(req,res)=>{
  try{
    const pending=db.getBets({pending:true});
    let settled=0;
    for(const bet of pending){
      // Use ESPN to get result
      for(const league of ESPN_LEAGUES){
        try{
          const resp=await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${league.id}/summary?event=${bet.fixture_id}`);
          const data=await resp.json();
          const comp=data.header?.competitions?.[0];
          if(!comp) continue;
          const status=espnStatus(comp.status?.type?.name);
          if(!['FT','AET'].includes(status)) break;
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
  setTimeout(()=>{
    fetch(`http://localhost:${PORT}/api/settle`,{method:'POST'})
      .then(r=>r.json()).then(d=>console.log('[STARTUP] Settled:',d.settled)).catch(()=>{});
  },2000);
});
