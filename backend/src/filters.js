// Confirmation filters for phases 02-07. Each returns checks:
//   { group:'ENTRY', phase, mode:'advisory'|'required', id, label, status:'PASS'|'FAIL'|'NA', pass, detail }
// - 'required' filters can veto a BUY on FAIL. 'advisory' filters are shown and counted but never veto.
// - NA = cannot be measured (no volume on an index, no option data, historical backfill). NA never vetoes.
//   Candle-based indicators that are still warming up are FAIL (fail closed).
const fmt = (n, d = 2) => Number(n).toFixed(d);
const on = m => m === 'advisory' || m === 'required';
const mk = (phase, mode, id, label, status, detail) => ({ group: 'ENTRY', phase, mode, id, label, status, pass: status !== 'FAIL', detail });
const st = ok => (ok ? 'PASS' : 'FAIL');

function ema(cfg, candles, series, i) {
  if (!on(cfg.emaMode)) return [];
  const m = cfg.emaMode, s = series[i], p = i > 0 ? series[i - 1] : null, f = cfg.emaFast ?? 9, sl = cfg.emaSlow ?? 21;
  if (s.ema1 == null || s.ema2 == null) return [mk(2, m, 'emaWarm', `EMA ${f}/${sl} ready`, 'FAIL', 'warming up')];
  const out = [
    mk(2, m, 'emaTrend', `EMA${f} above EMA${sl}`, st(s.ema1 > s.ema2), `${fmt(s.ema1)} vs ${fmt(s.ema2)}`),
    mk(2, m, 'emaPrice', `Close above EMA${sl}`, st(candles[i].close > s.ema2), `${fmt(candles[i].close)} vs ${fmt(s.ema2)}`)
  ];
  if (p && p.ema2 != null) out.push(mk(2, m, 'emaSlope', `EMA${sl} rising`, st(s.ema2 > p.ema2), `${fmt(p.ema2)} → ${fmt(s.ema2)}`));
  return out;
}

function volume(cfg, candles, series, i) {
  if (!on(cfg.volumeMode)) return [];
  const m = cfg.volumeMode, s = series[i], c = candles[i], min = cfg.volumeMinRvol ?? 1.2;
  if (s.vwapMode === 'TYPICAL_PRICE') return [mk(3, m, 'rvol', `Relative volume ≥ ${min}x`, 'NA', 'instrument reports no volume (index)')];
  if (s.rvol == null) return [mk(3, m, 'rvol', `Relative volume ≥ ${min}x`, 'FAIL', 'warming up')];
  return [
    mk(3, m, 'rvol', `Relative volume ≥ ${min}x`, st(s.rvol >= min), `${fmt(s.rvol)}x of ${cfg.volumeLookback ?? 20}-candle avg`),
    mk(3, m, 'upCandle', 'Up-candle (close ≥ open)', st(c.close >= c.open), `${fmt(c.open)} → ${fmt(c.close)}`)
  ];
}

function macd(cfg, candles, series, i) {
  if (!on(cfg.macdMode)) return [];
  const m = cfg.macdMode, s = series[i], p = i > 0 ? series[i - 1] : null;
  if (s.macd == null || s.macdSignal == null || s.macdHist == null) return [mk(4, m, 'macdWarm', 'MACD ready', 'FAIL', 'warming up')];
  const out = [mk(4, m, 'macdSig', 'MACD above signal line', st(s.macd > s.macdSignal), `${fmt(s.macd, 3)} vs ${fmt(s.macdSignal, 3)}`)];
  if (p && p.macdHist != null) out.push(mk(4, m, 'macdHist', 'Histogram rising', st(s.macdHist > p.macdHist), `${fmt(p.macdHist, 3)} → ${fmt(s.macdHist, 3)}`));
  if (cfg.macdRequireZero) out.push(mk(4, m, 'macdZero', 'MACD above zero line', st(s.macd > 0), fmt(s.macd, 3)));
  return out;
}

function noChain(phase, mode, id, label, ctx) {
  if (ctx.historical) return mk(phase, mode, id, label, 'NA', 'not available in historical backfill');
  return mk(phase, mode, id, label, 'NA', ctx.chain ? `chain data stale (${ctx.chain.ageSec}s old)` : 'no option-chain data for this symbol');
}
function chainOk(ctx) { return ctx.chain && !ctx.chain.stale && !ctx.historical; }

function option(cfg, candles, series, i, ctx) {
  if (!on(cfg.optionMode)) return [];
  const m = cfg.optionMode, label = `Room below call wall ≥ ${cfg.optionMinRoomPct ?? 0.3}%`;
  if (!chainOk(ctx)) return [noChain(5, m, 'callWall', label, ctx)];
  const ch = ctx.chain, spot = candles[i].close, min = cfg.optionMinRoomPct ?? 0.3, w = ch.callWall;
  if (!w) return [mk(5, m, 'callWall', label, 'NA', 'no call OI above spot in window')];
  if (w.strike <= spot) return [mk(5, m, 'callWall', label, 'PASS', `spot above call wall ${w.strike} (breakout)`)];
  const room = ((w.strike - spot) / spot) * 100;
  return [mk(5, m, 'callWall', label, st(room >= min), `call wall ${w.strike} is ${fmt(room)}% above (${fmt(w.oi / 1e5, 1)}L OI)`)];
}

function oi(cfg, candles, series, i, ctx) {
  if (!on(cfg.oiMode)) return [];
  const m = cfg.oiMode, out = [];
  if (!chainOk(ctx)) return [noChain(6, m, 'pcr', 'PCR not bearish', ctx), noChain(6, m, 'oiFlow', 'OI flow not bearish', ctx)];
  const ch = ctx.chain;
  out.push(mk(6, m, 'pcr', `PCR not bearish (> ${cfg.pcrBearish ?? 0.7})`, st(ch.pcrBias !== 'BEARISH'), `window PCR ${fmt(ch.window.pcr)} → ${ch.pcrBias.toLowerCase()}`));
  if (ch.flow?.state === 'OK') out.push(mk(6, m, 'oiFlow', 'OI flow not bearish', st(ch.flow.bias !== 'BEARISH'), `${ch.flow.bias.toLowerCase()}: CE ${ch.flow.ce.label.toLowerCase()}, PE ${ch.flow.pe.label.toLowerCase()} (${ch.flow.minutes}m)`));
  else out.push(mk(6, m, 'oiFlow', 'OI flow not bearish', 'NA', 'collecting OI baseline'));
  return out;
}

function regimeFilter(cfg, regime) {
  if (!on(cfg.aiMode)) return [];
  const m = cfg.aiMode;
  if (!regime || regime.regime === 'UNKNOWN') return [mk(7, m, 'regime', 'Market regime supports longs', 'NA', 'not enough data')];
  return [mk(7, m, 'regime', 'Market regime supports longs', st(!['TRENDING_DOWN', 'VOLATILE', 'CHOPPY'].includes(regime.regime)), regime.label)];
}

function buildFilters(cfg, candles, series, i, ctx = {}, regime = null) {
  return [...ema(cfg, candles, series, i), ...volume(cfg, candles, series, i), ...macd(cfg, candles, series, i),
    ...option(cfg, candles, series, i, ctx), ...oi(cfg, candles, series, i, ctx), ...regimeFilter(cfg, regime)];
}
module.exports = { buildFilters };
