// Phase 07 - AI market intelligence.
//  (a) classifyRegime(): local, deterministic market-regime read (always available, no API key).
//  (b) narrative():      plain-English summary of the current state (always available).
//  (c) review():         optional second opinion from Claude. ADVISORY ONLY: it never changes a signal or a position.
const fmt = (n, d = 2) => Number(n).toFixed(d);

function classifyRegime(candles, series, i, lookback = 12) {
  const s = series[i];
  if (i < 6 || s.atr == null || s.ema1 == null || s.ema2 == null || s.vwap == null)
    return { regime: 'UNKNOWN', label: 'Not enough data', trendStrength: null, chop: null, atrPct: null, atrRatio: null };
  const trendStrength = (s.ema1 - s.ema2) / s.atr;                  // EMA separation in ATRs
  const slope = (s.ema2 - series[i - 5].ema2) / s.atr;              // slow-EMA slope over 5 candles, in ATRs
  const atrPct = (s.atr / candles[i].close) * 100;
  let sum = 0, cnt = 0; for (let k = Math.max(0, i - 49); k <= i; k++) if (series[k].atr != null) { sum += series[k].atr / candles[k].close * 100; cnt++; }
  const atrRatio = cnt ? atrPct / (sum / cnt) : 1;
  let crosses = 0, sameDay = 0;                                     // VWAP whipsaw count within the session
  for (let k = Math.max(1, i - lookback + 1); k <= i; k++) {
    if (series[k].day !== s.day || series[k - 1].day !== s.day || series[k].vwap == null || series[k - 1].vwap == null) continue;
    sameDay++; if ((candles[k].close > series[k].vwap) !== (candles[k - 1].close > series[k - 1].vwap)) crosses++;
  }
  let regime = 'RANGING', label = 'Range-bound / no clear trend';
  if (atrRatio >= 1.6) { regime = 'VOLATILE'; label = `Volatility spike (ATR ${fmt(atrRatio, 1)}x normal)`; }
  else if (crosses >= 4) { regime = 'CHOPPY'; label = `Choppy: ${crosses} VWAP crosses in last ${sameDay} candles`; }
  else if (trendStrength > 0.3 && slope > 0.15) { regime = 'TRENDING_UP'; label = 'Uptrend: fast EMA above rising slow EMA'; }
  else if (trendStrength < -0.3 && slope < -0.15) { regime = 'TRENDING_DOWN'; label = 'Downtrend: fast EMA below falling slow EMA'; }
  return { regime, label, trendStrength, slope, chop: crosses, atrPct, atrRatio };
}

function narrative(st, chain) {
  if (!st || !st.ready) return st?.reason || 'Waiting for data.';
  const out = [];
  const fails = (st.checks || []).filter(c => c.status === 'FAIL' && c.mode === 'required').map(c => c.label);
  if (st.position) out.push(`Model position is open (${st.position.entryType}); ${st.signal === 'EXIT' ? 'exit conditions are met' : 'exit conditions are not met'}.`);
  else if (st.signal === 'BUY') out.push(`${st.entryType} entry confirmed by all required filters${st.plan ? `; risk plan: stop ${fmt(st.plan.stop)}, target ${fmt(st.plan.target)}, size ${st.plan.qty}` : ''}.`);
  else if (st.signal === 'BLOCKED') out.push(`The rules want a BUY but the risk engine blocked it: ${st.reason}`);
  else if (st.setup) out.push(`VWAP + RSI setup is valid but not confirmed. Failing: ${fails.join(', ') || 'n/a'}.`);
  else out.push(st.reason);
  if (st.regime && st.regime.regime !== 'UNKNOWN') out.push(`Regime: ${st.regime.label}.`);
  if (chain && !chain.stale) {
    const bits = [`PCR ${fmt(chain.window.pcr)} (${chain.pcrBias.toLowerCase()})`];
    if (chain.callWall) bits.push(`call wall ${chain.callWall.strike}`); if (chain.putWall) bits.push(`put wall ${chain.putWall.strike}`);
    if (chain.flow?.state === 'OK') bits.push(`OI flow ${chain.flow.bias.toLowerCase()}`);
    out.push('Options: ' + bits.join(', ') + '.');
  }
  return out.join(' ');
}

const SYSTEM = `You are a cautious intraday-market analyst reviewing the output of a RULE-BASED VWAP/RSI signal engine for an Indian equity/index instrument. You do not place orders and you do not give personalised financial advice. Judge whether the evidence supports the rule engine's current state, point out contradictions, and say what would change your view. Use ONLY the JSON provided; do not invent prices, news or data. Reply with ONLY a JSON object: {"stance":"SUPPORTS"|"CAUTION"|"CONTRADICTS","confidence":0-100,"summary":"<=60 words","concerns":["..."],"watch":["..."]}`;

function compact(st, chain) {
  return { symbol: st.symbol, signal: st.signal, entryType: st.entryType, setupValidButUnconfirmed: !!st.setup, candleForming: !!st.provisional,
    price: st.price, vwap: st.vwap, vwapMode: st.vwapMode, rsi: st.rsi, regime: st.regime,
    checks: (st.checks || []).map(c => ({ phase: c.phase, mode: c.mode, label: c.label, status: c.status, detail: c.detail })),
    position: st.position || null, plan: st.plan || null, reason: st.reason,
    options: chain && !chain.stale ? { expiry: chain.expiry, atm: chain.atmStrike, pcr: chain.window.pcr, pcrBias: chain.pcrBias, callWall: chain.callWall, putWall: chain.putWall,
      roomUpPct: chain.roomUpPct, expectedMovePct: chain.expectedMovePct, flow: chain.flow && { state: chain.flow.state, bias: chain.flow.bias, ce: chain.flow.ce, pe: chain.flow.pe } } : null };
}

async function review(cfg, st, chain) {
  const key = cfg.ai.apiKey;
  if (!key) return { ok: false, error: 'Set ANTHROPIC_API_KEY in backend/.env to enable the Claude review.' };
  const res = await fetch(cfg.ai.url, { method: 'POST', signal: AbortSignal.timeout(25_000),
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: cfg.ai.model, max_tokens: 700, system: SYSTEM, messages: [{ role: 'user', content: JSON.stringify(compact(st, chain)) }] }) });
  const body = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: body?.error?.message || `Anthropic API HTTP ${res.status}` };
  const text = (body?.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  let parsed = null; try { parsed = JSON.parse(text.replace(/^```(?:json)?|```$/gim, '').trim()); } catch { const m = text.match(/\{[\s\S]*\}/); if (m) try { parsed = JSON.parse(m[0]); } catch {} }
  if (!parsed || !parsed.stance) return { ok: false, error: 'Claude returned an unparseable reply', raw: text.slice(0, 300) };
  const stance = ['SUPPORTS', 'CAUTION', 'CONTRADICTS'].includes(parsed.stance) ? parsed.stance : 'CAUTION';
  return { ok: true, stance, confidence: Math.max(0, Math.min(100, Number(parsed.confidence) || 0)), summary: String(parsed.summary || '').slice(0, 600),
    concerns: (parsed.concerns || []).slice(0, 5).map(String), watch: (parsed.watch || []).slice(0, 5).map(String), model: cfg.ai.model, forSignal: st.signal, at: Date.now() };
}
module.exports = { classifyRegime, narrative, review, compact };
