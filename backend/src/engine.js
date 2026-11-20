// Glue: candle book + indicators + strategy (01-07) + risk engine (08) + position tracking. No network/Express -> testable.
const { CandleBook, bucketStart } = require('./candles');
const { computeSeries, istDay } = require('./indicators');
const { evaluate, makePosition, toSignal, activePosition } = require('./strategy');
const { RiskEngine } = require('./risk');

function normalize(raw, minutes) {
  const map = new Map();
  for (const r of raw || []) {
    const [t, o, h, l, c, v] = Array.isArray(r) ? r : [r.time, r.open, r.high, r.low, r.close, r.volume];
    const ms = typeof t === 'number' ? t : Date.parse(t);
    const k = { open: +o, high: +h, low: +l, close: +c, volume: Number(v) || 0 };
    if (!Number.isFinite(ms) || !(k.open > 0 && k.high > 0 && k.low > 0 && k.close > 0)) continue;
    const time = bucketStart(ms, minutes);
    map.set(time, { time, day: istDay(time), timeframe: minutes, ...k });
  }
  return [...map.values()].sort((a, b) => a.time - b.time);
}
const fmt = (n, d = 2) => Number(n).toFixed(d);
const REASON = { STOP_LOSS: 'Stop-loss hit', TRAIL_STOP: 'Trailing stop hit', TARGET: 'Target reached', SQUARE_OFF: 'Square-off time', RULE_VWAP: 'Rule exit', RULE_RSI: 'Rule exit' };

class Engine {
  constructor(cfg, hooks = {}) {
    this.cfg = cfg; this.hooks = hooks; this.book = new CandleBook(cfg.timeframe); this.risk = new RiskEngine(cfg);
    this.positions = new Map(); this.states = {}; this.meta = {}; this.lastBlocked = new Map(); this.day = null; // trading day of the newest data seen (not the wall clock, so a weekend shows Friday)
    this.book.onClose((symbol, candle, history) => this._onClose(symbol, candle, history));
  }
  // Drop everything held for a symbol (watchlist removal). An open model position is discarded, not closed.
  remove(symbol) {
    this.positions.delete(symbol); this.lastBlocked.delete(symbol); this.risk.reset(symbol); this.book.remove(symbol);
    delete this.states[symbol]; delete this.meta[symbol]; this._emitRisk();
  }
  flush(now = Date.now()) { this.book.flush(now); }
  setMeta(symbol, meta) { this.meta[symbol] = { ...(this.meta[symbol] || {}), ...meta }; }
  _ctx(symbol, historical) { return { historical, chain: historical ? null : this.hooks.getChain?.(symbol) || null }; }
  _openCount(except) { let n = 0; for (const [s, p] of this.positions) if (s !== except && p.day === this.day) n++; return n; }
  riskSummary() {
    const open = [...this.positions].filter(([, p]) => p.day === this.day).map(([symbol, p]) => ({ symbol, ...p, markPrice: this.states[symbol]?.price ?? null }));
    return this.risk.summary(this.day || istDay(Date.now()), open);
  }
  _emitRisk() { this.hooks.onRisk?.(this.riskSummary()); }

  // Gate + plan for a candidate BUY. Returns the (possibly BLOCKED) evaluation.
  _applyRisk(symbol, ev, candle, s, time, ctx) {
    if (!this.risk.enabled || ev.signal !== 'BUY') return { ev, plan: null };
    const g = this.risk.gate({ symbol, price: candle.close, atr: s.atr, time, openCount: this._openCount(symbol), lotSize: ctx.chain?.lotSize ?? null });
    const checks = [...ev.checks, ...g.checks];
    if (!g.allowed) return { ev: { ...ev, checks, signal: 'BLOCKED', plan: g.plan, reason: `Rules say BUY but the risk engine blocked it: ${g.reasons.join('; ')}.` }, plan: null };
    return { ev: { ...ev, checks, plan: g.plan, reason: `${ev.reason} Risk plan: stop ${fmt(g.plan.stop)}, target ${fmt(g.plan.target)}, size ${g.plan.qty}.` }, plan: g.plan };
  }

  _exit(symbol, pos, rx, ev, time, candlePrice, backfill) {
    this.positions.delete(symbol);
    const exitPrice = rx.price ?? candlePrice, rule = rx.reason.startsWith('RULE');
    const trade = this.risk.enabled && pos.qty ? this.risk.close(symbol, pos, exitPrice, time, rx.reason) : null;
    const pnlPct = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100, r = pos.riskDist ? (exitPrice - pos.entryPrice) / pos.riskDist : null;
    const why = rule ? ev.reason : `${REASON[rx.reason]}: exit ${fmt(exitPrice)} vs entry ${fmt(pos.entryPrice)}${pos.stop != null ? ` (stop ${fmt(pos.stop)}, target ${fmt(pos.target)})` : ''}; ${pnlPct >= 0 ? '+' : ''}${fmt(pnlPct)}%${r != null ? `, ${r >= 0 ? '+' : ''}${fmt(r)}R` : ''}.`;
    return { symbol, type: 'EXIT', entryType: pos.entryType, exitReason: rx.reason, price: exitPrice, vwap: ev.vwap, rsi: ev.rsi, reason: why, timeframe: this.cfg.timeframe, time,
      pnlPct, rMultiple: r, pnlAmt: trade?.pnlAmt ?? null, qty: pos.qty ?? null, vwapMode: ev.vwapMode, backfill };
  }

  // One closed candle: risk exits -> rule evaluation -> risk gate -> open/close position. Used by backfill replay AND live closes.
  _closeCandle(symbol, candles, series, i, backfill) {
    const candle = candles[i], s = series[i], day = s.day, time = candle.time + this.cfg.timeframe * 60_000, out = [];
    if (!this.day || day > this.day) this.day = day;
    let pos = activePosition(this.positions.get(symbol), day);
    if (!pos) this.positions.delete(symbol);
    const ctx = this._ctx(symbol, backfill);
    let ev = evaluate(candles, series, i, pos, this.cfg, ctx);
    if (!ev.ready) return out;
    if (pos) {
      let rx = this.risk.enabled ? this.risk.onCandle(pos, candle) : null;
      if (!rx && this.risk.enabled && this.risk.isSquareOff(time)) rx = { reason: 'SQUARE_OFF', price: candle.close };
      if (!rx && ev.signal === 'EXIT') rx = { reason: ev.exitRule === 'VWAP' ? 'RULE_VWAP' : 'RULE_RSI', price: candle.close };
      if (rx) out.push(this._exit(symbol, pos, rx, ev, time, candle.close, backfill));
      return out;
    }
    const applied = this._applyRisk(symbol, ev, candle, s, time, ctx); ev = applied.ev;
    if (ev.signal === 'BUY') {
      const base = makePosition(ev, candle, day, this.cfg.timeframe);
      this.positions.set(symbol, applied.plan ? this.risk.open(base, applied.plan, symbol) : base);
      this.lastBlocked.delete(symbol);
      out.push({ ...toSignal(symbol, ev, candle, this.cfg, backfill), plan: applied.plan });
    } else if (ev.signal === 'BLOCKED') {
      if (this.lastBlocked.get(symbol) !== ev.reason) { this.lastBlocked.set(symbol, ev.reason); out.push(toSignal(symbol, ev, candle, this.cfg, backfill)); }
    } else this.lastBlocked.delete(symbol);
    return out;
  }

  // Backfill: keep today's whole session (VWAP) + `historyCandles` earlier candles (indicator warm-up), replay the session
  // (rules + risk) to rebuild the model position and today's model P&L, then publish state.
  seed(symbol, rawCandles, now = Date.now()) {
    const tf = this.cfg.timeframe * 60_000, all = normalize(rawCandles, this.cfg.timeframe);
    if (!all.length) throw new Error('No candles returned');
    const sessionDay = all[all.length - 1].day;
    if (!this.day || sessionDay > this.day) this.day = sessionDay;
    const closed = all.filter(c => c.time + tf <= now);
    const forming = all.find(c => c.time <= now && now < c.time + tf) || null;
    const prior = closed.filter(c => c.day < sessionDay).slice(-this.cfg.historyCandles);
    const session = closed.filter(c => c.day === sessionDay);
    const history = [...prior, ...session];
    const series = computeSeries(history, this.cfg);
    this.positions.delete(symbol); this.risk.reset(symbol); this.lastBlocked.delete(symbol);
    const signals = [];
    for (let i = prior.length; i < history.length; i++) signals.push(...this._closeCandle(symbol, history, series, i, true));
    this.book.seed(symbol, history, forming, now);
    for (const s of signals) this.hooks.onSignal?.(s);
    this._publish(symbol); this._emitRisk();
    const lastClosed = history[history.length - 1] || null;
    return { candles: history.length + (forming ? 1 : 0), warmupCandles: prior.length, sessionCandles: session.length + (forming ? 1 : 0),
      sessionDay, replayedSignals: signals.length, lastClose: lastClosed?.close ?? null, lastTime: (forming || lastClosed)?.time ?? null };
  }

  tick(symbol, price, volume, ts = Date.now()) {
    this.book.ingest(symbol, price, volume, ts);
    const pos = activePosition(this.positions.get(symbol), istDay(ts));
    if (pos && this.risk.enabled) {
      const rx = this.risk.onTick(pos, price, ts);
      if (rx) {
        const st = this.states[symbol] || {}, sig = this._exit(symbol, pos, rx, { vwap: st.vwap, rsi: st.rsi, vwapMode: st.vwapMode, reason: '' }, ts, price, false);
        this.hooks.onSignal?.(sig); this._emitRisk();
      }
    }
    this._publish(symbol);
  }

  _onClose(symbol, candle, history) {
    const series = computeSeries(history, this.cfg), i = history.length - 1;
    const sigs = this._closeCandle(symbol, history, series, i, false);
    for (const s of sigs) this.hooks.onSignal?.(s);
    this.hooks.onCandle?.(symbol, candle);
    this._publish(symbol); if (sigs.length) this._emitRisk();
  }

  _publish(symbol) {
    const d = this.book.get(symbol), candles = [...d.history, ...(d.current ? [d.current] : [])];
    if (!candles.length) return;
    const series = computeSeries(candles, this.cfg), i = candles.length - 1, s = series[i], ctx = this._ctx(symbol, false);
    const pos = this.positions.get(symbol);
    let ev = evaluate(candles, series, i, pos, this.cfg, ctx);
    if (ev.ready && ev.signal === 'BUY') ev = this._applyRisk(symbol, ev, candles[i], s, candles[i].time + this.cfg.timeframe * 60_000, ctx).ev;
    const live = activePosition(pos, s.day);
    if (live && live.stop != null) ev = { ...ev, position: { ...live } };
    const sessionCandles = series.filter(x => x.day === s.day).length;
    const state = { symbol, ...ev, provisional: !!d.current, candleCount: candles.length, sessionCandles, backfill: this.meta[symbol] || null };
    this.states[symbol] = state; this.hooks.onState?.(state);
  }
}
module.exports = { Engine, normalize };
