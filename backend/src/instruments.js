// Symbol search over Angel One's NSE instruments (equities "-EQ" and indices). Token lookup is done here,
// so the user only pastes a symbol. A compact copy is cached per day in backend/.cache/.
const fs = require('fs'), path = require('path');
const { istDay } = require('./indicators');
const { download } = require('./scripmaster');

const clean = s => String(s || '').toUpperCase().replace(/\s+/g, '');
function compact(all) {
  const out = [], seen = new Set();
  for (const r of all) {
    if (r.exch_seg !== 'NSE' || !r.token) continue;
    const isIndex = r.instrumenttype === 'AMXIDX', isEq = String(r.symbol || '').endsWith('-EQ');
    if (!isIndex && !isEq) continue;
    const token = String(r.token); if (seen.has(token)) continue; seen.add(token);
    out.push({ token, symbol: clean(r.name || String(r.symbol).replace(/-EQ$/, '')), tradingSymbol: r.symbol, name: r.name || r.symbol, type: isIndex ? 'INDEX' : 'EQ', lotSize: Number(r.lotsize) || null });
  }
  return out;
}

class Instruments {
  constructor(cfg, { fetchImpl, dir = path.join(__dirname, '../.cache') } = {}) { this.cfg = cfg; this.fetchImpl = fetchImpl; this.dir = dir; this.rows = null; this.loading = null; }
  async load(now = Date.now()) {
    if (this.rows) return this.rows;
    if (!this.loading) this.loading = (async () => {
      const file = path.join(this.dir, `nse-${istDay(now)}.json`);
      try { this.rows = JSON.parse(fs.readFileSync(file, 'utf8')); return this.rows; } catch {}
      this.rows = compact(await download(this.cfg.option.scripMasterUrl, this.fetchImpl, this.cfg.option.scripMasterFile));
      try { fs.mkdirSync(this.dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(this.rows)); } catch {}
      return this.rows;
    })().finally(() => { this.loading = null; });
    return this.loading;
  }
  setRows(rows) { this.rows = rows; } // tests / preloading
  // Ranking: exact symbol/token > symbol prefix > name/tradingSymbol prefix > substring. Indices beat equities on ties.
  search(q, limit = 8) {
    const needle = clean(q).replace(/-EQ$/, ''); if (!needle || !this.rows) return [];
    const scored = [];
    for (const r of this.rows) {
      const sym = r.symbol, ts = clean(r.tradingSymbol).replace(/-EQ$/, ''), nm = clean(r.name);
      let s = 0;
      if (r.token === needle || sym === needle || ts === needle) s = 100;
      else if (sym.startsWith(needle)) s = 80;
      else if (ts.startsWith(needle) || nm.startsWith(needle)) s = 60;
      else if (sym.includes(needle) || nm.includes(needle) || ts.includes(needle)) s = 30;
      if (s) scored.push({ s: s + (r.type === 'INDEX' ? 1 : 0) - sym.length / 1000, r });
    }
    return scored.sort((a, b) => b.s - a.s).slice(0, limit).map(x => x.r);
  }
  byToken(token) { return (this.rows || []).find(r => r.token === String(token)) || null; }
}
module.exports = { Instruments, compact, clean };
