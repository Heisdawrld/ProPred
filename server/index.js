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

You must respond with ONLY a raw JSON object. No markdown, no backticks, no explanation. Begin your response with { and end with }.

{"summary":"2 sentence analysis","tip":"e.g. Liverpool Win or Over 2.5 Goals","market":"h2h or totals","confidence":65,"model_prob":68,"reasoning":"one sentence on value","risk":"low|medium|high"}

Rules: confidence between 40-85. Be sharp and specific.`;

  try {
    console.log('[AI] Calling Claude for:', homeTeam, 'vs', awayTeam);
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': AI_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await resp.json();
    console.log('[AI] HTTP status:', resp.status);

    if (resp.status !== 200) {
      console.error('[AI] API error:', JSON.stringify(data));
      return null;
    }

    const text = (data.content?.[0]?.text || '').trim();
    console.log('[AI] Raw response:', text.slice(0, 300));

    if (!text) { console.error('[AI] Empty response from Claude'); return null; }

    // Strip markdown code fences if present
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) { console.error('[AI] No JSON found in response:', text.slice(0, 200)); return null; }

    const parsed = JSON.parse(jsonMatch[0]);
    console.log('[AI] Parsed successfully:', JSON.stringify(parsed));
    return parsed;
  } catch(e) {
    console.error('[AI] Error:', e.message);
    return null;
  }
}
