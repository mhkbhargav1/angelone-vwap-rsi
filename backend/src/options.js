// Phases 05 + 06 - option-chain intelligence, OI and PCR.
// Data: Angel One scrip master (to find option tokens) + SmartAPI market quote in FULL mode (LTP, OI, volume).
// The quote API has no "previous OI", so OI change is measured against our own earlier snapshots (rolling baseline).
const fs = require('fs'), path = require('path');
const { istDay } = require('./indicators');
const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const parseExpiry = s => { const m = /^(\d{1,2})([A-Z]{3})(\d{4})$/.exec(String(s || '').toUpperCase()); return m && m[2] in MONTHS ? Date.UTC(+m[3], MONTHS[m[2]], +m[1]) : null; };

// Option contracts for `names`. Cache is per day and holds the UNION of every name requested so far, so adding a
// symbol later only re-downloads when it was not already cached.
async function loadContracts(cfg, names, now = Date.now(), { fetchImpl, dir = path.join(__dirname, '../.cache') } = {}) {
  const file = path.join(dir, `options-${istDay(now)}.json`), want = new Set(names);
  let cached = null; try { cached = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (cached && Array.isArray(cached.names) && [...want].every(n => cached.names.includes(n))) return cached.rows.filter(r => want.has(r.name));
  const union = new Set([...(cached?.names || []), ...want]);
  const all = await require('./scripmaster').download(cfg.option.scripMasterUrl, fetchImpl, cfg.option.scripMasterFile);
  const rows = all.filter(r => r.exch_seg === 'NFO' && union.has(r.name) && (r.instrumenttype === 'OPTIDX' || r.instrumenttype === 'OPTSTK') && parseExpiry(r.expiry) != null)
    .map(r => ({ name: r.name, token: String(r.token), tradingSymbol: r.symbol, expiry: String(r.expiry).toUpperCase(), expiryTs: parseExpiry(r.expiry),
      strike: Number(r.strike) / 100, type: String(r.symbol).endsWith('CE') ? 'CE' : 'PE', lotSize: Number(r.lotsize) || null }));
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify({ names: [...union], rows })); } catch {}
  return rows.filter(r => want.has(r.name));
}

function pickExpiry(contracts, wanted, now = Date.now()) {
  const today = Date.parse(istDay(now)), exp = [...new Set(contracts.map(c => c.expiry))].map(e => ({ e, t: parseExpiry(e) })).filter(x => x.t >= today).sort((a, b) => a.t - b.t);
  if (!exp.length) return null;
  if (wanted && wanted !== 'nearest') { const f = exp.find(x => x.e === wanted.toUpperCase()); if (f) return f.e; }
  return exp[0].e;
}

// Choose ATM +/- N strikes -> contract list
function windowContracts(contracts, expiry, spot, n) {
  const list = contracts.filter(c => c.expiry === expiry), strikes = [...new Set(list.map(c => c.strike))].sort((a, b) => a - b);
  if (!strikes.length) return { strikes: [], contracts: [] };
  let atmIdx = 0; strikes.forEach((s, i) => { if (Math.abs(s - spot) < Math.abs(strikes[atmIdx] - spot)) atmIdx = i; });
  const chosen = new Set(strikes.slice(Math.max(0, atmIdx - n), atmIdx + n + 1));
  return { strikes: [...chosen], contracts: list.filter(c => chosen.has(c.strike)) };
}

const sign = (x, eps) => (Math.abs(x) < eps ? 0 : x > 0 ? 1 : -1);
function label(side, dOiPct, dLtpPct) {
  const oiUp = dOiPct >= 1, oiDown = dOiPct <= -1, up = dLtpPct >= 1, down = dLtpPct <= -1;
  if (side === 'CE') return oiUp && up ? 'LONG BUILDUP' : oiUp && down ? 'SHORT BUILDUP' : oiDown && up ? 'SHORT COVERING' : oiDown && down ? 'LONG UNWINDING' : 'FLAT';
  return oiUp && down ? 'PUT WRITING' : oiUp && up ? 'PUT BUYING' : oiDown && up ? 'PUT SHORT COVERING' : oiDown && down ? 'PUT UNWINDING' : 'FLAT';
}

// Pure analytics: strikes = [{strike, ce:{ltp,oi,volume}, pe:{...}}]; snapshots = earlier [{t, map: {strike:[ceLtp,ceOi,peLtp,peOi]}}]
function analyze({ symbol, expiry, lotSize }, strikes, spot, snapshots, cfg, now = Date.now()) {
  const o = cfg.option;
  if (!strikes.length) return null;
  let atm = strikes[0]; for (const s of strikes) if (Math.abs(s.strike - spot) < Math.abs(atm.strike - spot)) atm = s;
  const sorted = strikes.map(s => s.strike).sort((a, b) => a - b), step = sorted.length > 1 ? sorted[Math.floor(sorted.length / 2)] - sorted[Math.floor(sorted.length / 2) - 1] : null;
  const callOI = strikes.reduce((a, s) => a + (s.ce?.oi || 0), 0), putOI = strikes.reduce((a, s) => a + (s.pe?.oi || 0), 0);
  const pcr = callOI > 0 ? putOI / callOI : null;
  const pcrBias = pcr == null ? 'NEUTRAL' : pcr >= cfg.pcrBullish ? 'BULLISH' : pcr <= cfg.pcrBearish ? 'BEARISH' : 'NEUTRAL';
  const above = strikes.filter(s => s.strike >= spot && s.ce?.oi > 0), below = strikes.filter(s => s.strike <= spot && s.pe?.oi > 0);
  const cw = above.sort((a, b) => b.ce.oi - a.ce.oi)[0], pw = below.sort((a, b) => b.pe.oi - a.pe.oi)[0];
  const callWall = cw ? { strike: cw.strike, oi: cw.ce.oi } : null, putWall = pw ? { strike: pw.strike, oi: pw.pe.oi } : null;
  const straddle = atm.ce?.ltp > 0 && atm.pe?.ltp > 0 ? atm.ce.ltp + atm.pe.ltp : null;

  // OI flow around ATM (+/- 3 strikes) vs a rolling baseline snapshot
  const near = strikes.filter(s => step ? Math.abs(s.strike - atm.strike) <= 3 * step : s.strike === atm.strike);
  let flow = { state: 'WARMING', minutes: 0, bias: 'NEUTRAL', score: 0 };
  const target = now - o.oiCompareMinutes * 60_000;
  const base = [...snapshots].reverse().find(s => s.t <= target) || snapshots[0];
  if (base && now - base.t >= o.oiMinBaselineMinutes * 60_000) {
    const side = (k, oiIdx, ltpIdx) => { let nowOi = 0, thenOi = 0, nowL = 0, thenL = 0, used = 0;
      for (const s of near) { const b = base.map[s.strike]; if (!b) continue; nowOi += s[k]?.oi || 0; thenOi += b[oiIdx]; nowL += s[k]?.ltp || 0; thenL += b[ltpIdx]; used++; }
      const dOi = nowOi - thenOi, dOiPct = thenOi > 0 ? (dOi / thenOi) * 100 : 0, dLtpPct = thenL > 0 ? ((nowL - thenL) / thenL) * 100 : 0;
      return { used, oiChange: dOi, oiChangePct: dOiPct, ltpChangePct: dLtpPct, label: label(k === 'ce' ? 'CE' : 'PE', dOiPct, dLtpPct) }; };
    const ce = side('ce', 1, 0), pe = side('pe', 3, 2);
    if (ce.used && pe.used) {
      const w = x => (x.oiChangePct >= 1 ? 1 : 0.5);
      // premium direction is a proxy for underlying direction (CE up / PE down = bullish); equal theta decay on both sides cancels out
      const score = (sign(ce.ltpChangePct, 1) * w(ce) + -sign(pe.ltpChangePct, 1) * w(pe)) / 2;
      flow = { state: 'OK', minutes: Math.round((now - base.t) / 60_000), ce, pe, score, bias: score >= 0.3 ? 'BULLISH' : score <= -0.3 ? 'BEARISH' : 'NEUTRAL' };
    }
  }
  const snap = { t: now, map: Object.fromEntries(strikes.map(s => [s.strike, [s.ce?.ltp || 0, s.ce?.oi || 0, s.pe?.ltp || 0, s.pe?.oi || 0]])) };
  const summary = { symbol, expiry, lotSize, spot, atmStrike: atm.strike, step, atm: { ce: atm.ce?.ltp ?? null, pe: atm.pe?.ltp ?? null }, straddle,
    expectedMovePct: straddle ? (straddle / spot) * 100 : null, callWall, putWall,
    roomUpPct: callWall ? ((callWall.strike - spot) / spot) * 100 : null, roomDownPct: putWall ? ((spot - putWall.strike) / spot) * 100 : null,
    window: { callOI, putOI, pcr, strikes: sorted.length }, pcrBias, flow, updatedAt: now,
    strikes: strikes.map(s => ({ strike: s.strike, ceOi: s.ce?.oi || 0, peOi: s.pe?.oi || 0, ceLtp: s.ce?.ltp ?? null, peLtp: s.pe?.ltp ?? null })).sort((a, b) => a.strike - b.strike) };
  return { summary, snap };
}

class OptionChains {
  constructor(cfg, deps) { this.cfg = cfg; this.d = deps; this.meta = new Map(); this.out = new Map(); this.snaps = new Map(); this.timer = null; this.busy = false; this.errors = {}; }
  _register(rows, sym) {
    const contracts = rows.filter(r => r.name === sym), expiry = pickExpiry(contracts, this.cfg.option.expiry);
    if (contracts.length && expiry) this.meta.set(sym, { contracts, expiry, lotSize: contracts.find(c => c.expiry === expiry)?.lotSize ?? null });
  }
  async init(symbols) {
    this.names = new Set(symbols);
    if (!symbols.length) return [];
    const rows = await loadContracts(this.cfg, symbols);
    for (const sym of symbols) this._register(rows, sym);
    return [...this.meta.keys()];
  }
  // Add one symbol at runtime. Returns true if it has options.
  async addSymbol(symbol) {
    (this.names ||= new Set()).add(symbol);
    this._register(await loadContracts(this.cfg, [...this.names]), symbol);
    return this.meta.has(symbol);
  }
  removeSymbol(symbol) { this.names?.delete(symbol); this.meta.delete(symbol); this.out.delete(symbol); this.snaps.delete(symbol); delete this.errors[symbol]; }
  supported() { return [...this.meta.keys()]; }
  async refresh(symbol, now = Date.now()) {
    const m = this.meta.get(symbol), spot = this.d.getSpot(symbol);
    if (!m || !(spot > 0)) return null;
    try {
      const w = windowContracts(m.contracts, m.expiry, spot, this.cfg.option.strikesEachSide), byToken = new Map(w.contracts.map(c => [c.token, c]));
      const tokens = [...byToken.keys()], rows = [];
      for (let i = 0; i < tokens.length; i += 50) { if (i) await sleep(1100); rows.push(...await this.d.quote(tokens.slice(i, i + 50))); } // quote API: <=50 tokens, ~1 req/s
      const strikeMap = new Map();
      for (const r of rows) {
        const c = byToken.get(String(r.symbolToken)); if (!c) continue;
        const e = strikeMap.get(c.strike) || { strike: c.strike }; e[c.type === 'CE' ? 'ce' : 'pe'] = { ltp: Number(r.ltp), oi: Number(r.opnInterest ?? r.openInterest ?? r.oi ?? 0), volume: Number(r.tradeVolume ?? 0) }; strikeMap.set(c.strike, e);
      }
      const strikes = [...strikeMap.values()].filter(s => s.ce || s.pe);
      if (!strikes.length) throw new Error('quote returned no option data');
      const history = this.snaps.get(symbol) || [];
      const res = analyze({ symbol, expiry: m.expiry, lotSize: m.lotSize }, strikes, spot, history, this.cfg, now);
      history.push(res.snap); while (history.length > 400) history.shift(); this.snaps.set(symbol, history);
      this.out.set(symbol, res.summary); delete this.errors[symbol];
      return res.summary;
    } catch (e) { this.errors[symbol] = e.message; throw e; }
  }
  summary(symbol, now = Date.now()) {
    const s = this.out.get(symbol); if (!s) return null;
    const ageSec = Math.round((now - s.updatedAt) / 1000);
    return { ...s, ageSec, stale: ageSec > this.cfg.option.pollSeconds * 3 + 30, error: this.errors[symbol] || null };
  }
  all() { const o = {}; for (const k of this.out.keys()) o[k] = this.summary(k); return o; }
  start(onUpdate) {
    if (this.timer) return; this.onUpdate = onUpdate;
    const live = () => { const t = new Date(Date.now() + 330 * 60_000), dow = t.getUTCDay(), min = t.getUTCHours() * 60 + t.getUTCMinutes(); return dow >= 1 && dow <= 5 && min >= 555 && min < 931; };
    const tick = async (force) => {
      if (this.busy || (!force && !live())) return; this.busy = true;
      try { for (const sym of this.supported()) { try { const s = await this.refresh(sym); if (s) this.onUpdate?.(sym, this.summary(sym)); } catch (e) { console.error(`[Options] ${sym}: ${e.message}`); } await sleep(1100); } } finally { this.busy = false; }
    };
    this.timer = setInterval(() => tick(false), this.cfg.option.pollSeconds * 1000); tick(true); // one fetch at startup even after hours
  }
  stop() { clearInterval(this.timer); this.timer = null; }
}
module.exports = { OptionChains, analyze, windowContracts, pickExpiry, parseExpiry, loadContracts };
