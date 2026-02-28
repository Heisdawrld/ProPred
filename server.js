const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');
const db      = require('./db');

const app     = express();
const PORT    = process.env.PORT || 3000;
const API_KEY = process.env.SPORTMONKS_KEY || 'EbRqkfYJgeCOtHzoC1AXpk1OO4semN0DtJ1P84zrYVNRCT1x4dHVsP9FGJAV';
const BASE    = 'https://api.sportmonks.com/v3/football';

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT');
  next();
});

// SPORTMONKS PROXY
app.get('/api/*', async (req, res) => {
  try {
    const endpoint    = req.path.replace('/api', '');
    const queryString = new URLSearchParams(req.query).toString();
    const sep         = queryString ? '&' : '';
    const url         = `${BASE}${endpoint}?api_token=${API_KEY}${sep}${queryString}`;
    console.log(`[PROXY] ${endpoint}`);
    const response = await fetch(url);
    const data     = await response.json();
    res.json(data);
  } catch (err) {
    console.error('[PROXY ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// TEAM MEMORY
app.post('/memory/team', (req, res) => {
  try {
    const { teamId, stats } = req.body;
    if (!teamId || !stats) return res.status(400).json({ error: 'teamId and stats required' });
    db.saveTeam(teamId, stats);
    res.json({ ok: true, teamId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/memory/team/:teamId', (req, res) => {
  const team = db.getTeam(req.params.teamId);
  if (!team) return res.json({ found: false });
  res.json({ found: true, team });
});

app.get('/memory/teams', (req, res) => res.json(db.getAllTeams()));

// PREDICTION TRACKING
app.post('/predictions/save', (req, res) => {
  try {
    const pred = req.body;
    if (!pred.fixtureId) return res.status(400).json({ error: 'fixtureId required' });
    const saved = db.savePrediction(pred);
    res.json({ ok: true, saved });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/predictions/resolve', (req, res) => {
  try {
    const { fixtureId, homeGoals, awayGoals } = req.body;
    if (fixtureId == null || homeGoals == null || awayGoals == null)
      return res.status(400).json({ error: 'fixtureId, homeGoals, awayGoals required' });
    const resolved = db.resolvePrediction(fixtureId, homeGoals, awayGoals);
    if (!resolved) return res.status(404).json({ error: 'Prediction not found' });
    res.json({ ok: true, resolved });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/predictions/auto-resolve', async (req, res) => {
  try {
    const preds   = db.getPredictions(200);
    const pending = preds.filter(p => !p.result && p.fixtureId);
    let resolved  = 0;
    for (const pred of pending) {
      try {
        const url  = `${BASE}/fixtures/${pred.fixtureId}?include=scores;state&api_token=${API_KEY}`;
        const resp = await fetch(url);
        const data = await resp.json();
        const fix  = data.data;
        if (!fix) continue;
        const state = (fix.state?.short_name || '').toUpperCase();
        if (!['FT','AET','AP'].includes(state)) continue;
        const hG = fix.scores?.find(s => s.description==='CURRENT' && s.score?.participant==='home')?.score?.goals;
        const aG = fix.scores?.find(s => s.description==='CURRENT' && s.score?.participant==='away')?.score?.goals;
        if (hG == null || aG == null) continue;
        db.resolvePrediction(pred.fixtureId, hG, aG);
        resolved++;
        console.log(`[RESOLVE] ${pred.homeTeam} vs ${pred.awayTeam}: ${hG}-${aG}`);
      } catch(e) { console.error(`[RESOLVE FAIL] ${pred.fixtureId}`, e.message); }
    }
    res.json({ ok: true, checked: pending.length, resolved });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/predictions/recent', (req, res) => {
  res.json(db.getPredictions(parseInt(req.query.limit)||50));
});

app.get('/predictions/results', (req, res) => {
  res.json(db.getRecentResults(parseInt(req.query.limit)||20));
});

// CALIBRATION
app.get('/calibration', (req, res) => {
  const calib = db.getCalibration();
  res.json(calib || { message: 'No calibration data yet.' });
});

// HEALTH
app.get('/health', (req, res) => {
  const preds = db.getPredictions(999);
  const teams = Object.keys(db.getAllTeams()).length;
  const calib = db.getCalibration();
  res.json({
    status: 'ok', teams, predictions: preds.length,
    resolved: preds.filter(p=>p.result).length,
    overallRate: calib?.overall?.rate ?? null,
    uptime: process.uptime(),
  });
});

app.listen(PORT, () => {
  console.log(`PROPRED v3 running on port ${PORT}`);
  setTimeout(() => {
    fetch(`http://localhost:${PORT}/predictions/auto-resolve`, { method:'POST' })
      .then(r=>r.json()).then(d=>console.log('[STARTUP AUTO-RESOLVE]', d))
      .catch(()=>{});
  }, 2000);
});
