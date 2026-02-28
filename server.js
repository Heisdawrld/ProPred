const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.SPORTMONKS_KEY || 'EbRqkfYJgeCOtHzoC1AXpk1OO4semN0DtJ1P84zrYVNRCT1x4dHVsP9FGJAV';
const BASE = 'https://api.sportmonks.com/v3/football';

// Serve static files (index.html)
app.use(express.static(path.join(__dirname, 'public')));

// CORS headers
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Proxy route — frontend calls /api/... instead of Sportmonks directly
app.get('/api/*', async (req, res) => {
  try {
    // Strip /api prefix, forward the rest to Sportmonks
    const endpoint = req.path.replace('/api', '');
    const queryString = new URLSearchParams(req.query).toString();
    const sep = queryString ? '&' : '';
    const url = `${BASE}${endpoint}?api_token=${API_KEY}${sep}${queryString}`;

    console.log(`[PROXY] ${url}`);

    const response = await fetch(url);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('[PROXY ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`PROPRED server running on port ${PORT}`);
});
