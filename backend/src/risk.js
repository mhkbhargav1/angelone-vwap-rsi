// Phase 08 - Risk management engine (model account; it never places orders).
//  - sizing: risk a fixed % of capital per trade, stop distance = ATR x multiple
//  - entry gates: time window, daily loss limit, trades/day, max open, cooldown after stop-out, stop width, size >= 1
//  - position management: stop, R-multiple target, breakeven + trailing stop, square-off time
const day = ms => new Date(ms + 330 * 60_000).toISOString().slice(0, 10);
const tod = ms => Math.floor(((ms + 330 * 60_000) % 86_400_000) / 60_000);
const fmt = (n, d = 2) => Number(n).toFixed(d);
const hm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const chk = (id, label, ok, detail) => ({ group: 'RISK', phase: 8, mode: 'required', id, label, status: ok ? 'PASS' : 'FAIL', pass: !!ok, detail });

class RiskEngine {
  constructor(cfg) { this.cfg = cfg; this.r = cfg.risk || { enabled: false, capital: 0, riskPerTradePct: 0, maxDailyLossPct: 0, noEntryBeforeMin: 0, noEntryAfterMin: 1440, squareOffMin: null }; this.timeframe = cfg.timeframe; this.trades = []; this.entries = []; this.lastStop = new Map(); }
  get enabled() { return !!this.r.enabled; }
  reset(symbol) { this.trades = this.trades.filter(t => t.symbol !== symbol); this.entries = this.entries.filter(e => e.symbol !== symbol); this.lastStop.delete(symbol); }
  riskAmount() { return (this.r.capital * this.r.riskPerTradePct) / 100; }
  dailyLimit() { return (this.r.capital * this.r.maxDailyLossPct) / 100; }
  realised(d) { return this.trades.filter(t => t.day === d).reduce((a, t) => a + t.pnlAmt, 0); }
  isSquareOff(timeMs) { return this.r.squareOffMin != null && tod(timeMs) >= this.r.squareOffMin; }

  plan(price, atr, lotSize = null) {
    const r = this.r, atrDist = atr != null ? atr * r.atrStopMult : 0;
    const dist = Math.max(atrDist, price * (r.minStopPct / 100));
    const stop = price - dist, target = price + dist * r.rewardRisk, riskAmount = this.riskAmount();
    let qty = Math.floor(riskAmount / dist);
    const cap = Math.floor((r.capital * r.maxLeverage) / price); if (qty > cap) qty = cap;
    const plan = { entry: price, stop, target, riskDist: dist, rr: r.rewardRisk, stopPct: (dist / price) * 100, atr, qty, riskAmount, notional: qty * price };
    if (lotSize) { const lots = Math.floor(riskAmount / (dist * r.optionDelta * lotSize)); plan.optionLots = lots; plan.lotSize = lotSize; plan.optionNote = `≈ ${lots} lot(s) assuming ATM delta ${r.optionDelta}; premium-based stop will differ`; }
    return plan;
  }

  // Entry gate for a candidate BUY. Returns {allowed, checks[], plan, reasons[]}
  gate({ symbol, price, atr, time, openCount = 0, lotSize = null }) {
    const r = this.r, d = day(time), t = tod(time), plan = this.plan(price, atr, lotSize);
    const realised = this.realised(d), limit = this.dailyLimit();
    const sym = this.entries.filter(e => e.symbol === symbol && e.day === d).length;
    const ls = this.lastStop.get(symbol), since = ls == null ? Infinity : Math.round((time - ls) / (this.timeframe * 60_000));
    const checks = [
      chk('window', `Entry window ${hm(r.noEntryBeforeMin)}–${hm(r.noEntryAfterMin)} IST`, t >= r.noEntryBeforeMin && t < r.noEntryAfterMin, `now ${hm(t)}`),
      chk('dailyLoss', `Daily loss under ₹${fmt(limit, 0)}`, realised > -limit, `realised ${realised >= 0 ? '+' : '−'}₹${fmt(Math.abs(realised), 0)}`),
      chk('tradeCount', `Trades today < ${r.maxTradesPerDay}`, sym < r.maxTradesPerDay, `${sym} taken in ${symbol}`),
      chk('openCount', `Open positions < ${r.maxOpen}`, openCount < r.maxOpen, `${openCount} open elsewhere`),
      chk('cooldown', `${r.cooldownCandles}-candle cooldown after stop-out`, since >= r.cooldownCandles, since === Infinity ? 'no recent stop-out' : `${since} candle(s) since stop-out`),
      chk('stopWidth', `Stop within ${r.maxStopPct}% of price`, plan.stopPct <= r.maxStopPct, `${fmt(plan.stopPct)}% (ATR ${atr == null ? 'n/a' : fmt(atr)} × ${r.atrStopMult})`),
      chk('size', 'Position size ≥ 1 unit', plan.qty >= 1, `${plan.qty} unit(s) for ₹${fmt(plan.riskAmount, 0)} risk`)
    ];
    const failed = checks.filter(c => c.status === 'FAIL');
    return { allowed: failed.length === 0, checks, plan, reasons: failed.map(c => `${c.label} (${c.detail})`) };
  }

  open(base, plan, symbol) {
    this.entries.push({ symbol, day: base.day, time: base.entryTime });
    return { ...base, qty: plan.qty, riskAmount: plan.riskAmount, riskDist: plan.riskDist, stop: plan.stop, initialStop: plan.stop, target: plan.target, highest: base.entryPrice, trailing: false };
  }
  _trail(pos) {
    const r = this.r;
    if (pos.highest >= pos.entryPrice + r.trailStartR * pos.riskDist) {
      const ns = Math.max(pos.entryPrice, pos.highest - pos.riskDist * r.trailMult);
      if (ns > pos.stop) { pos.stop = ns; pos.trailing = true; }
    }
  }
  // Candle check (replay + candle close). If stop and target are both inside one candle the stop is assumed first.
  onCandle(pos, c) {
    if (!pos || pos.stop == null) return null;
    if (c.low <= pos.stop) return { reason: pos.trailing ? 'TRAIL_STOP' : 'STOP_LOSS', price: Math.min(pos.stop, c.open) };
    if (c.high >= pos.target) return { reason: 'TARGET', price: Math.max(pos.target, c.open) };
    pos.highest = Math.max(pos.highest, c.high); this._trail(pos); return null;
  }
  // Live tick check
  onTick(pos, price, ts) {
    if (!pos || pos.stop == null) return null;
    if (price <= pos.stop) return { reason: pos.trailing ? 'TRAIL_STOP' : 'STOP_LOSS', price };
    if (price >= pos.target) return { reason: 'TARGET', price };
    if (this.isSquareOff(ts)) return { reason: 'SQUARE_OFF', price };
    if (price > pos.highest) { pos.highest = price; this._trail(pos); }
    return null;
  }
  close(symbol, pos, exitPrice, exitTime, reason) {
    const qty = pos.qty || 0, pnlUnit = exitPrice - pos.entryPrice;
    const trade = { symbol, day: pos.day, entryTime: pos.entryTime, exitTime, entryPrice: pos.entryPrice, exitPrice, qty, pnlAmt: pnlUnit * qty,
      pnlPct: (pnlUnit / pos.entryPrice) * 100, rMultiple: pos.riskDist ? pnlUnit / pos.riskDist : null, reason };
    this.trades.push(trade); if (this.trades.length > 500) this.trades.shift();
    if (pnlUnit < 0) this.lastStop.set(symbol, exitTime);
    return trade;
  }
  summary(d, openPositions = []) {
    const realised = this.realised(d), limit = this.dailyLimit(), today = this.trades.filter(t => t.day === d);
    const unrealised = openPositions.reduce((a, p) => a + (p.markPrice != null ? (p.markPrice - p.entryPrice) * (p.qty || 0) : 0), 0);
    return { enabled: this.enabled, day: d, capital: this.r.capital, riskPerTradePct: this.r.riskPerTradePct, riskAmount: this.riskAmount(), dailyLossLimit: limit,
      realised, unrealised, halted: realised <= -limit, tradesToday: today.length, wins: today.filter(t => t.pnlAmt > 0).length, losses: today.filter(t => t.pnlAmt < 0).length,
      maxOpen: this.r.maxOpen, maxTradesPerDay: this.r.maxTradesPerDay, rewardRisk: this.r.rewardRisk, atrStopMult: this.r.atrStopMult,
      squareOff: this.r.squareOffMin != null ? hm(this.r.squareOffMin) : null, noEntryAfter: hm(this.r.noEntryAfterMin), noEntryBefore: hm(this.r.noEntryBeforeMin),
      open: openPositions, trades: today.slice(-12).reverse() };
  }
}
module.exports = { RiskEngine };
