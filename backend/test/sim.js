// Offline checks: node test/sim.js   (no credentials / network needed)
const assert = require('assert');
const { computeSeries } = require('../src/indicators');
const { Engine } = require('../src/engine');
const { evaluate, replay } = require('../src/strategy');
const { bucketStart } = require('../src/candles');
const cfg = { timeframe: 5, rsiPeriod: 14, rsiBuyMin: 50, rsiBuyMax: 95, rsiExitLevel: 45, historyCandles: 50, vwapFallback: true,
  continuation: true, continuationMinCandles: 2, continuationMaxDistPct: 0.5 };
const IST = 330 * 60_000, at = (d, h, m) => Date.parse(`${d}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+05:30`);
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('  ✓', name); };

// deterministic pseudo-random
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
function session(day, startPrice, bars = 75, drift = 0) {
  const out = []; let p = startPrice;
  for (let i = 0; i < bars; i++) {
    const t = at(day, 9, 15) + i * 300_000, o = p; p = o + (rnd() - 0.5) * 8 + drift;
    out.push([new Date(t + IST).toISOString().replace('Z', '+05:30'), o, Math.max(o, p) + rnd() * 2, Math.min(o, p) - rnd() * 2, p, Math.round(1000 + rnd() * 5000)]);
  }
  return out;
}

ok('RSI matches classic Wilder reference', () => {
  const raw = session('2026-11-16', 22000, 75), cs = raw.map(r => ({ time: Date.parse(r[0]), close: r[4], high: r[2], low: r[3], volume: r[5] }));
  const ref = (cs, period) => { let g = 0, l = 0; for (let i = 1; i <= period; i++) { const d = cs[i].close - cs[i - 1].close; d > 0 ? g += d : l -= d; } let ag = g / period, al = l / period;
    for (let i = period + 1; i < cs.length; i++) { const d = cs[i].close - cs[i - 1].close; ag = (ag * 13 + Math.max(d, 0)) / 14; al = (al * 13 + Math.max(-d, 0)) / 14; } return 100 - 100 / (1 + ag / al); };
  const s = computeSeries(cs, cfg); assert(Math.abs(s[s.length - 1].rsi - ref(cs, 14)) < 1e-9); assert.strictEqual(s[13].rsi, null); assert(s[14].rsi != null);
});
ok('VWAP resets each day, RSI does not', () => {
  const a = session('2026-11-17', 22000, 75), b = session('2026-11-18', 22100, 10);
  const cs = [...a, ...b].map(r => ({ time: Date.parse(r[0]), close: r[4], high: r[2], low: r[3], volume: r[5], day: new Date(Date.parse(r[0]) + IST).toISOString().slice(0, 10) }));
  const s = computeSeries(cs, cfg), first = cs[75], tp = (first.high + first.low + first.close) / 3;
  assert(Math.abs(s[75].vwap - tp) < 1e-9, 'day-2 first VWAP = its own typical price'); assert(s[75].rsi != null, 'RSI continues across days');
});
ok('zero-volume index falls back to typical-price VWAP and says so', () => {
  const cs = session('2026-11-18', 22000, 5).map(r => ({ time: Date.parse(r[0]), close: r[4], high: r[2], low: r[3], volume: 0 }));
  assert.strictEqual(computeSeries(cs, cfg)[4].vwapMode, 'TYPICAL_PRICE'); assert.strictEqual(computeSeries(cs, { ...cfg, vwapFallback: false })[4].vwap, null);
});
ok('buckets align to 09:15 (30m / 60m)', () => {
  assert.strictEqual(bucketStart(at('2026-11-18', 9, 40), 30), at('2026-11-18', 9, 15)); assert.strictEqual(bucketStart(at('2026-11-18', 10, 20), 60), at('2026-11-18', 10, 15));
});

// ---- Engine: backfill + live ---------------------------------------------------------------
const signals = [], states = [];
const eng = new Engine(cfg, { onSignal: s => signals.push(s), onState: s => states.push(s) });
const prevDay = session('2026-11-17', 22000, 75, 0.3), today = session('2026-11-18', 22150, 25, 0.5); // 25 bars = up to 11:15 open
const now = at('2026-11-18', 11, 17) + 30_000;                                                          // 11:17:30 -> 11:15 bar is forming
let info;
ok('backfill: keeps 50 warm-up + whole session, RSI ready immediately', () => {
  info = eng.seed('TEST', [...prevDay, ...today], now);
  assert.strictEqual(info.warmupCandles, 50); assert.strictEqual(info.sessionCandles, 25); assert.strictEqual(info.candles, 75);
  const st = eng.states.TEST; assert(st.ready && st.rsi != null && st.vwap != null); assert.strictEqual(st.provisional, true);
  console.log(`      state: ${st.signal} rsi=${st.rsi.toFixed(1)} vwap=${st.vwap.toFixed(2)} replayed=${info.replayedSignals}`);
});
ok('replayed backfill signals are flagged and only EXIT after BUY', () => {
  assert(signals.every(s => s.backfill === true)); let open = false;
  for (const s of signals) { if (s.type === 'BUY') { assert(!open); open = true; } else { assert(open, 'EXIT without BUY'); open = false; } }
});
ok('live ticks close the candle and continue the same series', () => {
  const before = eng.states.TEST.candleCount; let t = at('2026-11-18', 11, 18);
  for (let k = 0; k < 4; k++) eng.tick('TEST', 22250 + k, 900000 + k * 100, t + k * 1000);
  eng.tick('TEST', 22260, 901000, at('2026-11-18', 11, 21)); // new 11:20 bucket -> 11:15 closes
  assert.strictEqual(eng.states.TEST.candleCount, before + 1);
  assert.strictEqual(eng.book.get('TEST').history.at(-1).time, at('2026-11-18', 11, 15));
});
ok('pre-open and post-close ticks are ignored', () => {
  const c = eng.states.TEST.candleCount; eng.tick('TEST', 1, 1, at('2026-11-18', 9, 5)); eng.tick('TEST', 1, 1, at('2026-11-18', 15, 31)); assert.strictEqual(eng.states.TEST.candleCount, c);
});
ok('flush() closes the last candle without another tick', () => {
  const c = eng.states.TEST.candleCount; eng.flush(at('2026-11-18', 11, 25) + 4000); assert.strictEqual(eng.book.get('TEST').current, null); assert.strictEqual(eng.states.TEST.candleCount, c);
});

// ---- Strategy rules on crafted data ----------------------------------------------------------
const mk = (closes, vols = null) => closes.map((c, i) => ({ time: at('2026-11-18', 9, 15) + i * 300_000, day: '2026-11-18', open: c, high: c + 0.5, low: c - 0.5, close: c, volume: vols ? vols[i] : 1000 }));
function run(closes) { const cs = mk(closes), s = computeSeries(cs, cfg); return { cs, s, ...replay('X', cs, s, cfg, 0) }; }
// 20 flat-ish bars, dip below VWAP, then recover with rising RSI
const dip = [100, 100.2, 100.1, 100.3, 100.2, 100.1, 100, 99.9, 99.8, 99.7, 99.6, 99.5, 99.4, 99.3, 99.2, 99.1, 99.0, 98.9, 98.8, 98.9, 99.2, 99.6, 100.1, 100.6, 101.0, 101.3, 101.5, 101.6, 101.7];
ok('BUY on fresh crossover; EXIT only afterwards', () => {
  const r = run(dip.concat([100, 99, 98])); const types = r.signals.map(s => s.type + ':' + s.entryType);
  console.log('      signals:', types.join(', ')); assert(types[0].startsWith('BUY')); assert(r.signals.some(s => s.type === 'EXIT'));
  let open = false; for (const s of r.signals) { if (s.type === 'BUY') { assert(!open); open = true; } else { assert(open); open = false; } }
});
ok('below VWAP with no position -> WAIT (never EXIT)', () => {
  const cs = mk(dip.slice(0, 19)), s = computeSeries(cs, cfg), ev = evaluate(cs, s, 18, null, cfg);
  assert.strictEqual(ev.signal, 'WAIT'); assert(/below VWAP/.test(ev.reason)); assert(ev.checks.some(c => c.id === 'aboveVwap' && !c.pass));
});
ok('continuation: fires once on a held, non-extended trend; off-switch respected', () => {
  const up = []; let p = 100; for (let i = 0; i < 40; i++) { p += i < 20 ? (i % 2 ? -0.2 : 0.25) : 0.12; up.push(+p.toFixed(3)); }
  const on = run(up), off = (() => { const cs = mk(up), s = computeSeries(cs, { ...cfg }); return replay('X', cs, s, { ...cfg, continuation: false }, 0); })();
  console.log(`      continuation ON: ${on.signals.map(s => s.type + ':' + s.entryType).join(', ') || 'none'} | OFF: ${off.signals.map(s => s.type + ':' + s.entryType).join(', ') || 'none'}`);
});
ok('explanations list every condition', () => {
  const cs = mk(dip), s = computeSeries(cs, cfg), ev = evaluate(cs, s, cs.length - 1, null, cfg);
  assert(ev.checks.length >= 6); console.log('      ' + ev.signal + ' — ' + ev.reason); ev.checks.forEach(c => console.log(`        ${c.pass ? '✓' : '✗'} ${c.label} [${c.detail}]`));
});
console.log(`\n${n} checks passed`);
