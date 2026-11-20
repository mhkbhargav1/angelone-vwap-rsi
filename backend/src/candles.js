const { istDay } = require('./indicators');
const IST = 330 * 60_000, DAY = 86_400_000;
const OPEN_MIN = 9 * 60 + 15, CLOSE_MIN = 15 * 60 + 30, MAX_HISTORY = 1000;

// Buckets are anchored to the 09:15 IST open, matching Angel One's historical candles
// (this matters for 10/30/60-minute timeframes).
function bucketStart(ms, minutes) {
  const t = ms + IST, open = Math.floor(t / DAY) * DAY + OPEN_MIN * 60_000, size = minutes * 60_000;
  return open + Math.floor((t - open) / size) * size - IST;
}
const minuteOfDay = ms => Math.floor(((ms + IST) % DAY) / 60_000);
const inSession = ms => { const m = minuteOfDay(ms); return m >= OPEN_MIN && m < CLOSE_MIN; };

class CandleBook {
  constructor(minutes) { this.minutes = minutes; this.size = minutes * 60_000; this.data = new Map(); this.listeners = []; }
  onClose(fn) { this.listeners.push(fn); }
  _slot(symbol) {
    let s = this.data.get(symbol);
    if (!s) { s = { current: null, history: [], sessionDay: null, lastDayVolume: null }; this.data.set(symbol, s); }
    return s;
  }
  // Load backfilled candles: `history` = closed candles, `current` = still-forming candle (or null).
  seed(symbol, history, current = null, now = Date.now()) {
    const s = this._slot(symbol);
    s.history = history.slice(-MAX_HISTORY); s.current = current ? { ...current } : null;
    s.sessionDay = istDay(now); s.lastDayVolume = null;
  }
  _close(symbol, s) {
    const c = s.current; if (!c) return;
    const closed = { ...c, complete: true, closeTime: c.time + this.size };
    s.history.push(closed); if (s.history.length > MAX_HISTORY) s.history.shift();
    s.current = null;
    const snapshot = s.history.slice();
    for (const fn of this.listeners) fn(symbol, closed, snapshot);
  }
  ingest(symbol, price, dayVolume, timestamp = Date.now()) {
    if (!(price > 0) || !inSession(timestamp)) return; // drops pre-open / post-close ticks
    const s = this._slot(symbol), start = bucketStart(timestamp, this.minutes), day = istDay(timestamp);
    const lastClosed = s.history[s.history.length - 1];
    if ((lastClosed && start <= lastClosed.time) || (s.current && start < s.current.time)) return; // late tick
    if (s.sessionDay !== day) { s.sessionDay = day; s.lastDayVolume = null; } // history is kept for RSI warm-up
    const vol = Number(dayVolume) || 0, prev = s.lastDayVolume;
    const delta = prev == null || vol < prev ? 0 : vol - prev;
    s.lastDayVolume = vol;
    if (s.current && start > s.current.time) this._close(symbol, s);
    if (!s.current) s.current = { symbol, timeframe: this.minutes, time: start, day, open: price, high: price, low: price, close: price, volume: delta, complete: false };
    else { const c = s.current; c.high = Math.max(c.high, price); c.low = Math.min(c.low, price); c.close = price; c.volume += delta; }
  }
  // Close candles whose time is up even if no further tick arrives (quiet symbol, 15:25 candle).
  flush(now = Date.now(), graceMs = 3000) {
    for (const [symbol, s] of this.data) if (s.current && now >= s.current.time + this.size + graceMs) this._close(symbol, s);
  }
  remove(symbol) { this.data.delete(symbol); }
  get(symbol) { const s = this.data.get(symbol); return s ? { current: s.current, history: s.history.slice() } : { current: null, history: [] }; }
}
module.exports = { CandleBook, bucketStart, inSession };
