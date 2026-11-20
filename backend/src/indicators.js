// Indicator series: VWAP, Wilder RSI (phase 1), EMA (2), relative volume (3), MACD (4), ATR (used by risk, 7, 8).
// Computed as per-candle series so history and live candles share one code path.
const IST_MS = 330 * 60_000;
const istDay = ms => new Date(ms + IST_MS).toISOString().slice(0, 10); // 'YYYY-MM-DD' in IST

function toRsi(avgGain, avgLoss) {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}
// Streaming EMA seeded with the SMA of the first `period` values (null until then).
class Ema {
  constructor(period) { this.p = period; this.k = 2 / (period + 1); this.n = 0; this.sum = 0; this.v = null; }
  push(x) {
    this.n++;
    if (this.n <= this.p) { this.sum += x; if (this.n === this.p) this.v = this.sum / this.p; }
    else this.v = this.v + (x - this.v) * this.k;
    return this.v;
  }
}

/**
 * Returns [{ vwap, vwapMode, rsi, day, ema1, ema2, macd, macdSignal, macdHist, atr, rvol, avgVol }] aligned with `candles`.
 * - VWAP is cumulative and resets at the first candle of each IST trading day.
 * - RSI / EMA / MACD / ATR run continuously across days, so yesterday's candles are warm-up.
 * - No volume at all in a session (NSE indices) -> VWAP falls back to average typical price (vwapMode says so), rvol is null.
 */
function computeSeries(candles, o = {}) {
  const rsiPeriod = o.rsiPeriod ?? 14, vwapFallback = o.vwapFallback ?? true;
  const atrPeriod = o.atrPeriod ?? 14, volLookback = o.volumeLookback ?? 20;
  const e1 = new Ema(o.emaFast ?? 9), e2 = new Ema(o.emaSlow ?? 21);
  const mf = new Ema(o.macdFast ?? 12), ms = new Ema(o.macdSlow ?? 26), msig = new Ema(o.macdSignal ?? 9);
  const out = new Array(candles.length);
  let day = null, pv = 0, vol = 0, tpSum = 0, n = 0;
  let gainSeed = 0, lossSeed = 0, avgGain = 0, avgLoss = 0, atr = null, trSum = 0, prevHist = null;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i], d = c.day || istDay(c.time);
    if (d !== day) { day = d; pv = 0; vol = 0; tpSum = 0; n = 0; }
    const tp = (c.high + c.low + c.close) / 3, v = Math.max(0, Number(c.volume) || 0);
    pv += tp * v; vol += v; tpSum += tp; n++;
    let vwap = null, vwapMode = null;
    if (vol > 0) { vwap = pv / vol; vwapMode = 'VOLUME'; }
    else if (vwapFallback) { vwap = tpSum / n; vwapMode = 'TYPICAL_PRICE'; }

    let rsi = null;
    if (i > 0) {
      const diff = c.close - candles[i - 1].close, g = Math.max(diff, 0), l = Math.max(-diff, 0);
      if (i <= rsiPeriod) {
        gainSeed += g; lossSeed += l;
        if (i === rsiPeriod) { avgGain = gainSeed / rsiPeriod; avgLoss = lossSeed / rsiPeriod; rsi = toRsi(avgGain, avgLoss); }
      } else {
        avgGain = (avgGain * (rsiPeriod - 1) + g) / rsiPeriod;
        avgLoss = (avgLoss * (rsiPeriod - 1) + l) / rsiPeriod;
        rsi = toRsi(avgGain, avgLoss);
      }
    }
    // ATR (Wilder). Gaps between days count as true range, like most charting platforms.
    const pc = i > 0 ? candles[i - 1].close : null;
    const tr = pc == null ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
    if (i < atrPeriod) { trSum += tr; if (i === atrPeriod - 1) atr = trSum / atrPeriod; } else atr = (atr * (atrPeriod - 1) + tr) / atrPeriod;

    const ema1 = e1.push(c.close), ema2 = e2.push(c.close);
    const f = mf.push(c.close), s = ms.push(c.close);
    const macd = f != null && s != null ? f - s : null;
    const macdSignal = macd != null ? msig.push(macd) : null;
    const macdHist = macd != null && macdSignal != null ? macd - macdSignal : null;

    let avgVol = null, rvol = null;
    if (i >= volLookback) {
      let t = 0; for (let k = i - volLookback; k < i; k++) t += Math.max(0, Number(candles[k].volume) || 0);
      avgVol = t / volLookback; rvol = avgVol > 0 ? v / avgVol : null;
    }
    out[i] = { vwap, vwapMode, rsi, day: d, ema1, ema2, macd, macdSignal, macdHist, atr, rvol, avgVol };
  }
  return out;
}

const last = a => a[a.length - 1];
const calculateVWAP = (candles, opts) => candles.length ? last(computeSeries(candles, opts)).vwap : null;
const calculateRSI = (candles, period = 14) => candles.length ? last(computeSeries(candles, { rsiPeriod: period })).rsi : null;

module.exports = { computeSeries, calculateVWAP, calculateRSI, istDay, Ema };
