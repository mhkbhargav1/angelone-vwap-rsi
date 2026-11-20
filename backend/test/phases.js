// Offline checks for phases 02-08: node test/phases.js
const assert = require('assert');
const { computeSeries } = require('../src/indicators');
const { evaluate } = require('../src/strategy');
const { buildFilters } = require('../src/filters');
const { RiskEngine } = require('../src/risk');
const { analyze, pickExpiry, parseExpiry, windowContracts } = require('../src/options');
const { classifyRegime, review } = require('../src/ai');
const { Engine } = require('../src/engine');
const IST = 330 * 60_000, at = (d, h, m) => Date.parse(`${d}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+05:30`);
const base = { timeframe: 5, rsiPeriod: 14, rsiBuyMin: 50, rsiBuyMax: 95, rsiExitLevel: 45, historyCandles: 50, vwapFallback: true, continuation: true, continuationMinCandles: 2, continuationMaxDistPct: 0.5,
  emaMode: 'required', emaFast: 9, emaSlow: 21, volumeMode: 'required', volumeLookback: 20, volumeMinRvol: 1.2, macdMode: 'required', macdFast: 12, macdSlow: 26, macdSignal: 9, macdRequireZero: false,
  optionMode: 'advisory', oiMode: 'advisory', optionMinRoomPct: 0.3, pcrBullish: 1.0, pcrBearish: 0.7, aiMode: 'advisory',
  option: { oiCompareMinutes: 30, oiMinBaselineMinutes: 5, pollSeconds: 60, strikesEachSide: 10 }, ai: { apiKey: 'k', model: 'm', url: 'http://x' },
  risk: { enabled: true, capital: 500000, riskPerTradePct: 1, atrStopMult: 1.5, minStopPct: 0.15, maxStopPct: 2, rewardRisk: 2, trailStartR: 1, trailMult: 1, maxDailyLossPct: 3,
    maxTradesPerDay: 3, maxOpen: 2, cooldownCandles: 2, maxLeverage: 1, optionDelta: 0.5, noEntryBeforeMin: 560, noEntryAfterMin: 885, squareOffMin: 915 } };
let n = 0; const ok = (name, fn) => { const r = fn(); n++; console.log('  ✓', name); return r; };
const day = '2026-11-18';
const mk = (closes, vols, opts = {}) => closes.map((c, i) => ({ time: at(day, 9, 15) + i * 300_000, day, open: opts.open ? opts.open[i] : c - 0.1, high: c + 0.4, low: c - 0.4, close: c, volume: vols ? vols[i] : 1000 }));
let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const walk = (len, start = 100, drift = 0) => { const a = []; let p = start; for (let i = 0; i < len; i++) { p += (rnd() - 0.5) * 1.2 + drift; a.push(+p.toFixed(3)); } return a; };

console.log('Phase 02-04 indicators');
ok('EMA matches reference (SMA seed)', () => {
  const closes = walk(60), cs = mk(closes), s = computeSeries(cs, base), p = 9, k = 2 / (p + 1);
  let e = closes.slice(0, p).reduce((a, b) => a + b, 0) / p; for (let i = p; i < 60; i++) e = e + (closes[i] - e) * k;
  assert(Math.abs(s[59].ema1 - e) < 1e-9); assert.strictEqual(s[p - 2].ema1, null); assert(s[p - 1].ema1 != null);
});
ok('MACD = EMA12-EMA26, signal = EMA9 of MACD, hist = diff', () => {
  const s = computeSeries(mk(walk(80)), base), L = s[79];
  assert(Math.abs(L.macdHist - (L.macd - L.macdSignal)) < 1e-12); assert.strictEqual(s[24].macd, null); assert(s[25].macd != null); assert.strictEqual(s[32].macdSignal, null); assert(s[33].macdSignal != null);
});
ok('ATR (Wilder) and RVOL', () => {
  const cs = mk(walk(40)), s = computeSeries(cs, base);
  let tr = cs.map((c, i) => i ? Math.max(c.high - c.low, Math.abs(c.high - cs[i - 1].close), Math.abs(c.low - cs[i - 1].close)) : c.high - c.low), atr = tr.slice(0, 14).reduce((a, b) => a + b) / 14;
  for (let i = 14; i < 40; i++) atr = (atr * 13 + tr[i]) / 14; assert(Math.abs(s[39].atr - atr) < 1e-9);
  const vols = Array(40).fill(1000); vols[39] = 3000; const r = computeSeries(mk(walk(40), vols), base)[39]; assert(Math.abs(r.rvol - 3) < 1e-9);
});

console.log('Confirmation filters');
// Strong trend with volume: all required filters should pass; flat low-volume tape should fail them
const up = walk(70, 100, 0.25), volsHi = up.map((_, i) => (i === 69 ? 4000 : 1000));
ok('EMA/volume/MACD pass in a strong uptrend, and veto when they fail', () => {
  const cs = mk(up, volsHi), s = computeSeries(cs, base), f = buildFilters(base, cs, s, 69, {});
  const byPhase = p => f.filter(x => x.phase === p); assert(byPhase(2).length === 3 && byPhase(2).every(x => x.status === 'PASS'), 'EMA'); assert(byPhase(3).every(x => x.status === 'PASS'), 'volume');
  const dn = mk(walk(70, 100, -0.25), volsHi), sd = computeSeries(dn, base), fd = buildFilters(base, dn, sd, 69, {}); assert(fd.filter(x => x.phase === 2).some(x => x.status === 'FAIL'));
});
ok('modes: off removes a phase, advisory never vetoes', () => {
  const cs = mk(up, volsHi), s = computeSeries(cs, base);
  assert.strictEqual(buildFilters({ ...base, emaMode: 'off' }, cs, s, 69, {}).filter(x => x.phase === 2).length, 0);
  const lowVol = mk(up, up.map(() => 1000)); const sl = computeSeries(lowVol, base);
  const ev = evaluate(lowVol, sl, 69, null, { ...base, volumeMode: 'advisory', emaMode: 'off', macdMode: 'off' }, {});
  assert(ev.checks.some(c => c.phase === 3 && c.status === 'FAIL'));
});
ok('zero-volume index: volume filter is NA (never vetoes)', () => {
  const cs = mk(up, up.map(() => 0)), s = computeSeries(cs, base), f = buildFilters(base, cs, s, 69, {}).filter(x => x.phase === 3);
  assert(f.length === 1 && f[0].status === 'NA');
});
ok('warming-up candle indicators fail closed', () => {
  const cs = mk(walk(20)), s = computeSeries(cs, base), f = buildFilters(base, cs, s, 19, {}); assert(f.some(x => x.id === 'macdWarm' && x.status === 'FAIL'));
});

console.log('Phase 05/06 option chain + OI/PCR');
const strikes = [24800, 24900, 25000, 25100, 25200].map(k => ({ strike: k, ce: { ltp: Math.max(5, 25000 - k + 100) / 2, oi: k === 25200 ? 900000 : 300000, volume: 1 }, pe: { ltp: Math.max(5, k - 25000 + 100) / 2, oi: k === 24800 ? 1200000 : 500000, volume: 1 } }));
const t0 = at(day, 10, 0);
const A = ok('analytics: ATM, walls, PCR, straddle', () => {
  const r = analyze({ symbol: 'NIFTY', expiry: '19NOV2026', lotSize: 75 }, strikes, 25030, [], base, t0).summary;
  assert.strictEqual(r.atmStrike, 25000); assert.strictEqual(r.callWall.strike, 25200); assert.strictEqual(r.putWall.strike, 24800);
  const put = 1200000 + 4 * 500000, call = 900000 + 4 * 300000; assert(Math.abs(r.window.pcr - put / call) < 1e-9); assert(r.straddle > 0); assert.strictEqual(r.flow.state, 'WARMING'); return r;
});
ok('OI flow: put writing + call short-covering -> bullish; theta decay alone cancels to neutral', () => {
  const first = analyze({ symbol: 'N', expiry: 'x' }, strikes, 25000, [], base, t0), later = t0 + 20 * 60_000;
  const moved = strikes.map(s => ({ ...s, ce: { ...s.ce, ltp: s.ce.ltp * 1.1, oi: s.ce.oi * 0.97 }, pe: { ...s.pe, ltp: s.pe.ltp * 0.85, oi: s.pe.oi * 1.1 } }));
  const bull = analyze({ symbol: 'N', expiry: 'x' }, moved, 25000, [first.snap], base, later).summary.flow;
  assert.strictEqual(bull.state, 'OK'); assert.strictEqual(bull.pe.label, 'PUT WRITING'); assert.strictEqual(bull.ce.label, 'SHORT COVERING'); assert.strictEqual(bull.bias, 'BULLISH');
  const decay = strikes.map(s => ({ ...s, ce: { ...s.ce, ltp: s.ce.ltp * 0.9 }, pe: { ...s.pe, ltp: s.pe.ltp * 0.9 } }));
  assert.strictEqual(analyze({ symbol: 'N', expiry: 'x' }, decay, 25000, [first.snap], base, later).summary.flow.bias, 'NEUTRAL');
  const young = analyze({ symbol: 'N', expiry: 'x' }, moved, 25000, [first.snap], base, t0 + 2 * 60_000).summary.flow; assert.strictEqual(young.state, 'WARMING');
});
ok('filters: call-wall room, bearish PCR veto, stale/historical -> NA', () => {
  const cs = mk(up, volsHi), s = computeSeries(cs, base), chain = { ...A, stale: false, ageSec: 5 };
  const room = buildFilters(base, cs, s, 69, { chain }).find(x => x.id === 'callWall'); assert(room.status === 'PASS' || room.status === 'FAIL');
  const near = { ...chain, callWall: { strike: cs[69].close * 1.001, oi: 1e6 } }; assert.strictEqual(buildFilters(base, cs, s, 69, { chain: near }).find(x => x.id === 'callWall').status, 'FAIL');
  const bear = { ...chain, pcrBias: 'BEARISH' }; assert.strictEqual(buildFilters(base, cs, s, 69, { chain: bear }).find(x => x.id === 'pcr').status, 'FAIL');
  assert(buildFilters(base, cs, s, 69, { chain: { ...chain, stale: true, ageSec: 400 } }).filter(x => x.phase >= 5).every(x => x.status === 'NA'));
  assert(buildFilters(base, cs, s, 69, { historical: true }).filter(x => x.phase >= 5).every(x => x.status === 'NA'));
});
ok('scrip-master helpers: expiry parsing, nearest expiry, ATM window', () => {
  assert.strictEqual(parseExpiry('19NOV2026'), Date.UTC(2026, 10, 19)); const cs = [{ expiry: '12NOV2026' }, { expiry: '19NOV2026' }, { expiry: '26NOV2026' }];
  assert.strictEqual(pickExpiry(cs, 'nearest', at(day, 10, 0)), '19NOV2026'); assert.strictEqual(pickExpiry(cs, '26NOV2026', at(day, 10, 0)), '26NOV2026');
  const k = []; for (let s = 24000; s <= 26000; s += 100) { k.push({ expiry: 'E', strike: s, type: 'CE', token: 'c' + s }, { expiry: 'E', strike: s, type: 'PE', token: 'p' + s }); }
  const w = windowContracts(k, 'E', 25040, 3); assert.deepStrictEqual(w.strikes, [24700, 24800, 24900, 25000, 25100, 25200, 25300]); assert.strictEqual(w.contracts.length, 14);
});

console.log('Phase 07 regime + AI');
ok('regime: uptrend / choppy / volatile', () => {
  const cs = mk(walk(70, 100, 0.3)), s = computeSeries(cs, base); assert.strictEqual(classifyRegime(cs, s, 69).regime, 'TRENDING_UP');
  const chop = []; for (let i = 0; i < 70; i++) chop.push(100 + (i % 2 ? 0.3 : -0.3)); const c2 = mk(chop), s2 = computeSeries(c2, base); assert.strictEqual(classifyRegime(c2, s2, 69).regime, 'CHOPPY');
  const vol = walk(70, 100, 0).map((p, i) => (i > 62 ? p + (i % 2 ? 6 : -6) : p)), c3 = mk(vol), s3 = computeSeries(c3, base); assert(['VOLATILE', 'CHOPPY'].includes(classifyRegime(c3, s3, 69).regime));
});
(async () => {
  const st = { symbol: 'T', signal: 'BUY', ready: true, checks: [], price: 1, vwap: 1, rsi: 55 };
  const real = global.fetch, seen = {};
  global.fetch = async (url, init) => { seen.url = url; seen.init = init; return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: '```json\n{"stance":"CAUTION","confidence":140,"summary":"Mixed.","concerns":["a"],"watch":["b"]}\n```' }] }) }; };
  const r = await review(base, st, null);
  assert(r.ok && r.stance === 'CAUTION' && r.confidence === 100); assert.strictEqual(JSON.parse(seen.init.body).model, 'm'); assert.strictEqual(seen.init.headers['x-api-key'], 'k'); n++; console.log('  ✓ Claude review: request shape, fenced-JSON parse, confidence clamp');
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'not json' }] }) });
  assert.strictEqual((await review(base, st, null)).ok, false); assert.strictEqual((await review({ ...base, ai: { ...base.ai, apiKey: null } }, st, null)).ok, false); global.fetch = real; n++; console.log('  ✓ Claude review: bad reply / missing key handled, never throws into the engine');

  // ---- Phase 08 ----
  console.log('Phase 08 risk engine');
  const R = new RiskEngine(base), t = at(day, 10, 0);
  ok('sizing: 1% of capital / (1.5 x ATR), capped by notional', () => {
    const p = R.plan(25000, 40); assert.strictEqual(p.stop, 25000 - 60); assert.strictEqual(p.target, 25000 + 120); assert.strictEqual(p.qty, Math.floor(5000 / 60) > Math.floor(500000 / 25000) ? 20 : Math.floor(5000 / 60)); assert.strictEqual(p.qty, 20);
    const stock = R.plan(500, 4); assert.strictEqual(stock.qty, Math.floor(5000 / 6)); const withLots = R.plan(25000, 40, 75); assert(withLots.optionLots >= 0 && withLots.lotSize === 75);
  });
  ok('gates: window, daily loss, trades/day, open count, cooldown, stop width', () => {
    const g = o => R.gate({ symbol: 'A', price: 100, atr: 0.5, time: t, openCount: 0, ...o });
    assert(g().allowed); assert(!g({ time: at(day, 9, 16) }).allowed); assert(!g({ time: at(day, 14, 50) }).allowed); assert(!g({ openCount: 2 }).allowed); assert(!g({ atr: 5 }).allowed, 'stop too wide');
    for (let k = 0; k < 3; k++) { R.entries.push({ symbol: 'A', day, time: t }); } assert(!g().allowed); R.reset('A'); assert(g().allowed);
    R.trades.push({ symbol: 'B', day, pnlAmt: -16000 }); assert(!g().allowed && /Daily loss/.test(g().reasons[0])); R.reset('B'); assert(g().allowed);
    R.lastStop.set('A', t - 300_000); assert(!g().allowed); R.lastStop.set('A', t - 900_000); assert(g().allowed);
  });
  ok('management: stop, target, same-candle tie = stop, gap fills, breakeven + trail, square-off', () => {
    const mkPos = () => R.open({ entryPrice: 100, entryTime: t, entryType: 'CROSSOVER', day }, { qty: 10, riskAmount: 500, riskDist: 2, stop: 98, target: 104 }, 'Z');
    let p = mkPos(); assert.strictEqual(R.onCandle(p, { open: 100, high: 101, low: 99, close: 100.5 }), null);
    assert.deepStrictEqual(R.onCandle(mkPos(), { open: 100, high: 105, low: 97, close: 100 }), { reason: 'STOP_LOSS', price: 98 }); // both touched -> stop first
    assert.deepStrictEqual(R.onCandle(mkPos(), { open: 100, high: 104.5, low: 99, close: 104 }), { reason: 'TARGET', price: 104 });
    assert.strictEqual(R.onCandle(mkPos(), { open: 96, high: 97, low: 95, close: 96 }).price, 96, 'gap below stop fills at open');
    p = mkPos(); assert.strictEqual(R.onCandle(p, { open: 100, high: 102.5, low: 100, close: 102 }), null); assert.strictEqual(p.stop, 100.5, 'trail = highest - 1R, never below breakeven'); assert(p.trailing);
    assert.deepStrictEqual(R.onCandle(p, { open: 102, high: 102.6, low: 100.4, close: 101 }), { reason: 'TRAIL_STOP', price: 100.5 });
    p = mkPos(); assert.strictEqual(R.onTick(p, 103, t), null); assert.strictEqual(p.stop, 101); assert.strictEqual(R.onTick(p, 100.9, t).reason, 'TRAIL_STOP');
    assert.strictEqual(R.onTick(mkPos(), 100.5, at(day, 15, 16)).reason, 'SQUARE_OFF');
    const tr = R.close('Z', mkPos(), 98, t, 'STOP_LOSS'); assert.strictEqual(tr.pnlAmt, -20); assert.strictEqual(tr.rMultiple, -1); assert(R.lastStop.has('Z'));
  });

  // ---- Full engine: backfill replay with filters + risk ----
  console.log('Engine integration');
  const prev = '2026-11-17', raw = [];
  const push = (d, count, startPrice, drift, volFn) => { let p = startPrice; for (let i = 0; i < count; i++) { const o = p; p = o + (rnd() - 0.45) * 1.5 + drift; const ts = at(d, 9, 15) + i * 300_000; raw.push([new Date(ts + IST).toISOString().replace('Z', '+05:30'), o, Math.max(o, p) + 0.3, Math.min(o, p) - 0.3, p, volFn(i)]); } };
  push(prev, 75, 100, 0.02, () => 1000 + Math.round(rnd() * 600)); push(day, 40, 101, 0.05, i => 1000 + Math.round(rnd() * 1500) + (i % 7 === 0 ? 2500 : 0));
  const sigs = [], hooks = { onSignal: s => sigs.push(s), onState: () => {}, onRisk: () => {} };
  const eng = new Engine({ ...base, emaMode: 'advisory', volumeMode: 'advisory', macdMode: 'advisory' }, hooks), now = at(day, 12, 40);
  // Crafted session: warm-up day, then a dip below VWAP, a recovery (fresh cross + RSI rising), a rally and a collapse.
  const dipPath = [100, 100.2, 100.1, 100.3, 100.2, 100.1, 100, 99.9, 99.8, 99.7, 99.6, 99.5, 99.4, 99.3, 99.2, 99.1, 99, 98.9, 98.8, 98.9, 99.2, 99.6, 100.1, 100.6, 101, 101.3, 101.5, 101.6, 101.7, 100.5, 98.5, 97];
  const crafted = [], cpush = (d, closes, vol) => closes.forEach((c, i) => { const ts = at(d, 9, 15) + i * 300_000, o = i ? closes[i - 1] : c; crafted.push([new Date(ts + IST).toISOString().replace('Z', '+05:30'), o, Math.max(o, c) + 0.5, Math.min(o, c) - 0.5, c, vol(i)]); });
  cpush(prev, Array.from({ length: 75 }, (_, i) => 100 + Math.sin(i / 5) * 0.8), () => 1000); cpush(day, dipPath, i => (i >= 22 && i <= 28 ? 3000 : 1000));
  const cNow = at(day, 9, 15) + dipPath.length * 300_000 + 60_000, off = { emaMode: 'off', volumeMode: 'off', macdMode: 'off', aiMode: 'off', optionMode: 'off', oiMode: 'off' };
  ok('engine: BUY has stop/target/size, EXIT comes only after BUY, P&L lands in the daily ledger', () => {
    const out = [], e = new Engine({ ...base, ...off, risk: { ...base.risk, noEntryBeforeMin: 0 } }, { onSignal: s => out.push(s) }); const info = e.seed('T', crafted, cNow);
    assert(info.warmupCandles === 50); const buys = out.filter(s => s.type === 'BUY'), exits = out.filter(s => s.type === 'EXIT'); assert(buys.length >= 1 && exits.length >= 1, 'expected a BUY and an EXIT: ' + out.map(s => s.type));
    const b = buys[0]; assert(b.backfill && b.plan.stop < b.price && b.plan.target > b.price && b.plan.qty >= 1 && b.entryType === 'CROSSOVER');
    let open = false; for (const s of out.filter(x => x.type !== 'BLOCKED')) { if (s.type === 'BUY') { assert(!open); open = true; } else { assert(open, 'EXIT without BUY'); open = false; assert(s.exitReason && s.qty >= 1); } }
    const rs = e.riskSummary(); assert.strictEqual(rs.tradesToday, exits.length); assert(Math.abs(rs.realised - exits.reduce((a, s) => a + s.pnlAmt, 0)) < 1e-6);
    console.log(`      replay: ${out.map(s => s.type + (s.exitReason ? ':' + s.exitReason : '')).join(' → ')} | realised ₹${rs.realised.toFixed(0)}`);
  });
  ok('engine: a required filter that fails vetoes that same BUY (and says why)', () => {
    const probe = []; new Engine({ ...base, ...off, risk: { ...base.risk, noEntryBeforeMin: 0 } }, { onSignal: s => probe.push(s) }).seed('T', crafted, cNow);
    const t1 = probe.find(s => s.type === 'BUY').time, cut = 75 + (t1 - at(day, 9, 15)) / 300_000; // candles up to and including the BUY candle
    const e = new Engine({ ...base, ...off, volumeMode: 'required', volumeMinRvol: 1000, risk: { ...base.risk, noEntryBeforeMin: 0 } }, { onSignal: () => {} });
    const out = []; e.hooks.onSignal = s => out.push(s); e.seed('T', crafted.slice(0, cut), t1 + 1000);
    assert(!out.some(s => s.type === 'BUY')); const st = e.states.T; assert(st.setup === true && /Relative volume/.test(st.reason), st.reason);
  });
  ok('risk off-switch / daily-loss halt turns BUY into BLOCKED and opens no position', () => {
    const a = []; const e = new Engine({ ...base, ...off, risk: { ...base.risk, maxDailyLossPct: 0.0001, noEntryBeforeMin: 0 } }, { onSignal: s => a.push(s) });
    e.risk.trades.push({ symbol: 'X', day, pnlAmt: -1000 }); e.seed('T', crafted, cNow); // seed resets only symbol T
    assert(!a.some(s => s.type === 'BUY'), 'no BUY while halted'); assert(a.some(s => s.type === 'BLOCKED') && /Daily loss/.test(a.find(s => s.type === 'BLOCKED').reason));
  });
  ok('live: tick-level stop exits immediately; candle close then sees no position', () => {
    const live = [], e = new Engine({ ...base, emaMode: 'off', volumeMode: 'off', macdMode: 'off', risk: { ...base.risk, noEntryBeforeMin: 0 } }, { onSignal: s => live.push(s) });
    e.seed('T', raw.slice(0, 75 + 30), at(day, 11, 45) + 10_000); // candle 11:45 forming
    const pos = { entryPrice: 100, entryTime: at(day, 11, 40), entryType: 'CROSSOVER', day }; e.positions.set('T', e.risk.open(pos, { qty: 10, riskAmount: 500, riskDist: 2, stop: 98, target: 104 }, 'T'));
    e.tick('T', 99, 5000, at(day, 11, 46)); assert(!live.some(s => s.exitReason)); e.tick('T', 97.9, 5000, at(day, 11, 47));
    const x = live.find(s => s.exitReason); assert(x && x.exitReason === 'STOP_LOSS' && x.price === 97.9 && x.pnlAmt < 0); assert(!e.positions.has('T'));
  });
  console.log(`\n${n} phase checks passed`);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
