// Rules (signals are evaluated on candle CLOSE; the forming candle is shown as provisional):
//   Phase 01 core   BUY: close > VWAP, RSI inside zone and rising, AND a fresh VWAP cross (A) or an optional continuation (B)
//   Phases 02-07    confirmations (EMA, volume, MACD, option chain, OI/PCR, regime). 'required' ones veto the BUY on FAIL.
//   Phase 08        risk gate + stops/targets live in risk.js / engine.js
//   HOLD / EXIT     with an open position only: EXIT on close below VWAP or RSI below exit level (risk exits are added by the engine)
//   WAIT            everything else. The reason lists what failed. `setup:true` = core setup valid but confirmations failed.
const { buildFilters } = require('./filters');
const { classifyRegime } = require('./ai');
const fmt = (n, d = 2) => Number(n).toFixed(d);
const activePosition = (pos, day) => (pos && pos.day === day ? pos : null); // positions don't carry overnight
const tag = arr => arr.map(c => ({ phase: 1, mode: 'required', status: c.pass ? 'PASS' : 'FAIL', ...c }));

function evaluate(candles, series, i, position, cfg, ctx = {}) {
  const c = candles[i], s = series[i], pos = activePosition(position, s.day);
  const regime = classifyRegime(candles, series, i);
  const base = { candleTime: c.time, price: c.close, vwap: s.vwap, rsi: s.rsi, atr: s.atr, vwapMode: s.vwapMode, position: pos, regime, updatedAt: Date.now() };
  if (s.rsi == null || s.vwap == null) {
    const reason = s.vwap == null ? 'VWAP unavailable (no volume data and fallback disabled).' : `RSI needs ${cfg.rsiPeriod + 1} candles, have ${i + 1}.`;
    return { ...base, ready: false, signal: 'WAIT', entryType: null, checks: [], reason };
  }
  const p = i > 0 ? series[i - 1] : null, pc = i > 0 ? candles[i - 1] : null;
  const sameDay = !!p && p.day === s.day && p.vwap != null;
  const above = c.close > s.vwap, dist = ((c.close - s.vwap) / s.vwap) * 100;
  const prevRsi = p && p.rsi != null ? p.rsi : null, rising = prevRsi != null && s.rsi > prevRsi;
  const inZone = s.rsi >= cfg.rsiBuyMin && s.rsi <= cfg.rsiBuyMax;
  const fresh = above && sameDay && pc.close <= p.vwap;
  let held = 0;
  for (let k = i; k >= 0 && series[k].day === s.day && series[k].vwap != null && candles[k].close > series[k].vwap; k--) held++;
  const heldOk = held >= cfg.continuationMinCandles, notExtended = dist <= cfg.continuationMaxDistPct;
  const signed = n => (n >= 0 ? '+' : '') + fmt(n) + '%';
  const result = (signal, extra) => ({ ...base, ready: true, signal, entryType: null, aboveVWAP: above, rsiRising: rising, distPct: dist, ...extra });

  // ---- Open position: only EXIT / HOLD ---------------------------------------------------------
  if (pos) {
    const pnlPct = ((c.close - pos.entryPrice) / pos.entryPrice) * 100;
    const checks = tag([
      { group: 'EXIT', id: 'exitVwap', label: 'Close above VWAP', pass: above, detail: `${fmt(c.close)} vs VWAP ${fmt(s.vwap)} (${signed(dist)})` },
      { group: 'EXIT', id: 'exitRsi', label: `RSI at or above ${cfg.rsiExitLevel}`, pass: s.rsi >= cfg.rsiExitLevel, detail: `RSI ${fmt(s.rsi, 1)}` }
    ]);
    const risk = pos.stop != null ? ` Stop ${fmt(pos.stop)}${pos.trailing ? ' (trailing)' : ''}, target ${fmt(pos.target)}.` : '';
    if (!above) return result('EXIT', { checks, pnlPct, exitRule: 'VWAP', entryType: pos.entryType, reason: `Close ${fmt(c.close)} is below VWAP ${fmt(s.vwap)} while in a ${pos.entryType} long from ${fmt(pos.entryPrice)} (${signed(pnlPct)}).` });
    if (s.rsi < cfg.rsiExitLevel) return result('EXIT', { checks, pnlPct, exitRule: 'RSI', entryType: pos.entryType, reason: `RSI ${fmt(s.rsi, 1)} fell below ${cfg.rsiExitLevel} while in a ${pos.entryType} long from ${fmt(pos.entryPrice)} (${signed(pnlPct)}).` });
    return result('HOLD', { checks, pnlPct, entryType: pos.entryType, reason: `In ${pos.entryType} long from ${fmt(pos.entryPrice)} (${signed(pnlPct)}). Above VWAP, RSI ${fmt(s.rsi, 1)} ≥ ${cfg.rsiExitLevel}.${risk}` });
  }

  // ---- No position: Phase 01 core ----------------------------------------------------------------
  const core1 = tag([
    { group: 'ENTRY', id: 'aboveVwap', label: 'Close above VWAP', pass: above, detail: `${fmt(c.close)} vs VWAP ${fmt(s.vwap)} (${signed(dist)})` },
    { group: 'ENTRY', id: 'rsiZone', label: `RSI inside ${cfg.rsiBuyMin}–${cfg.rsiBuyMax}`, pass: inZone, detail: `RSI ${fmt(s.rsi, 1)}` },
    { group: 'ENTRY', id: 'rsiRising', label: 'RSI rising', pass: rising, detail: prevRsi == null ? 'no previous RSI' : `${fmt(prevRsi, 1)} → ${fmt(s.rsi, 1)}` },
    { group: 'ENTRY', path: 'CROSSOVER', id: 'freshCross', label: 'Fresh cross above VWAP', pass: fresh,
      detail: !sameDay ? 'no earlier candle this session' : `prev close ${fmt(pc.close)} ${pc.close <= p.vwap ? '≤' : '>'} prev VWAP ${fmt(p.vwap)}` }
  ]);
  if (cfg.continuation) core1.push(...tag([
    { group: 'ENTRY', path: 'CONTINUATION', id: 'held', label: `Held above VWAP ≥ ${cfg.continuationMinCandles} closes`, pass: heldOk, detail: `${held} close(s) above` },
    { group: 'ENTRY', path: 'CONTINUATION', id: 'notExtended', label: `Not extended (≤ ${cfg.continuationMaxDistPct}% above VWAP)`, pass: notExtended, detail: signed(dist) }
  ]));
  const filters = buildFilters(cfg, candles, series, i, ctx, regime);
  const checks = [...core1, ...filters];
  const confirm = { passed: filters.filter(f => f.status === 'PASS').length, failed: filters.filter(f => f.status === 'FAIL').length, na: filters.filter(f => f.status === 'NA').length, total: filters.length };

  const core = above && inZone && rising;
  const entryType = core && fresh ? 'CROSSOVER' : core && cfg.continuation && heldOk && notExtended ? 'CONTINUATION' : null;
  if (entryType) {
    const blockers = filters.filter(f => f.mode === 'required' && f.status === 'FAIL');
    const why = entryType === 'CROSSOVER'
      ? `Fresh cross: close ${fmt(c.close)} > VWAP ${fmt(s.vwap)} after prev close ${fmt(pc.close)} ≤ VWAP; RSI ${fmt(prevRsi, 1)} → ${fmt(s.rsi, 1)} inside ${cfg.rsiBuyMin}–${cfg.rsiBuyMax}.`
      : `Continuation: ${held} closes above VWAP, ${signed(dist)} from it (not extended); RSI ${fmt(prevRsi, 1)} → ${fmt(s.rsi, 1)} inside ${cfg.rsiBuyMin}–${cfg.rsiBuyMax}.`;
    if (!blockers.length) return result('BUY', { checks, confirm, entryType, reason: why + (filters.length ? ` Confirmations: ${confirm.passed} pass, ${confirm.na} n/a, ${confirm.failed} advisory-fail.` : '') });
    return result('WAIT', { checks, confirm, entryType, setup: true, reason: `Core ${entryType.toLowerCase()} setup is valid but required confirmations failed: ${blockers.map(b => `${b.label} (${b.detail})`).join('; ')}.` });
  }

  const fails = [];
  if (!above) fails.push(`close ${fmt(c.close)} is below VWAP ${fmt(s.vwap)}`);
  if (!inZone) fails.push(s.rsi > cfg.rsiBuyMax ? `RSI ${fmt(s.rsi, 1)} is above ${cfg.rsiBuyMax} (extended)` : `RSI ${fmt(s.rsi, 1)} is below ${cfg.rsiBuyMin}`);
  if (!rising) fails.push(`RSI is not rising (${prevRsi == null ? 'n/a' : fmt(prevRsi, 1)} → ${fmt(s.rsi, 1)})`);
  if (core) {
    fails.push('not a fresh cross');
    if (!cfg.continuation) fails.push('continuation entries are off');
    else if (!heldOk) fails.push(`only ${held}/${cfg.continuationMinCandles} closes above VWAP for continuation`);
    else if (!notExtended) fails.push(`price is ${signed(dist)} above VWAP, too extended to chase`);
  }
  return result('WAIT', { checks, confirm, reason: 'No entry: ' + fails.join('; ') + '.' });
}

const makePosition = (ev, candle, day, timeframe) => ({ entryPrice: candle.close, entryTime: candle.time + timeframe * 60_000, entryType: ev.entryType, day });

function toSignal(symbol, ev, candle, cfg, backfill = false) {
  return { symbol, type: ev.signal, entryType: ev.entryType, price: candle.close, vwap: ev.vwap, rsi: ev.rsi, reason: ev.reason,
    timeframe: cfg.timeframe, time: candle.time + cfg.timeframe * 60_000, pnlPct: ev.pnlPct ?? null, vwapMode: ev.vwapMode, backfill };
}

// Pure rule replay (phases 01-07 only, no risk engine). The full replay with risk lives in engine.js; this is kept for tests.
function replay(symbol, candles, series, cfg, startIdx = 0) {
  const signals = []; let position = null;
  for (let i = Math.max(0, startIdx); i < candles.length; i++) {
    const ev = evaluate(candles, series, i, position, cfg, { historical: true });
    if (!ev.ready) continue;
    if (ev.signal === 'BUY') { position = makePosition(ev, candles[i], series[i].day, cfg.timeframe); signals.push(toSignal(symbol, ev, candles[i], cfg, true)); }
    else if (ev.signal === 'EXIT') { signals.push(toSignal(symbol, ev, candles[i], cfg, true)); position = null; }
  }
  return { signals, position };
}
module.exports = { evaluate, replay, makePosition, toSignal, activePosition };
