// Persistent, editable watchlist (backend/data/watchlist.json). WATCHLIST in .env is only the first-run seed.
const fs = require('fs'), path = require('path');
const { clean } = require('./instruments');

class WatchlistStore {
  constructor(file = path.join(__dirname, '../data/watchlist.json')) { this.file = file; }
  load(seed = []) {
    try { const j = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (Array.isArray(j.watchlist)) return j.watchlist.filter(x => x.symbol && x.token); } catch {}
    return seed;
  }
  save(list) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify({ watchlist: list.map(({ symbol, token }) => ({ symbol, token })) }, null, 2));
    fs.renameSync(this.file + '.tmp', this.file);
  }
}

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

// Orchestrates add/remove across the live system. All side effects are injected so it can be tested without Angel One.
//   deps: { list (mutable array shared with config), byToken (Map), store, instruments, max, isReady(),
//           hooks: { subscribe(inst), unsubscribe(inst), backfill(inst), addOptions(symbol), removeOptions(symbol), purge(symbol), changed() } }
class WatchlistManager {
  constructor(d) { this.d = d; }
  async add(query) {
    const { list, byToken, store, instruments, hooks } = this.d;
    if (!this.d.isReady()) throw new HttpError(503, 'Still connecting to Angel One. Try again in a few seconds.');
    await instruments.load();
    const q = String(query?.token || query?.symbol || '').trim();
    if (!q) throw new HttpError(400, 'Provide a symbol or token');
    const hit = instruments.search(q, 1)[0];
    const norm = s => clean(s).replace(/-EQ$/, '');
    const exact = hit && [hit.token, hit.symbol, norm(hit.tradingSymbol), norm(hit.name)].includes(norm(q));
    if (!hit || (!exact && !query.token)) throw new HttpError(404, hit ? `No exact match for "${q}". Did you mean ${hit.symbol}?` : `No NSE equity or index found for "${q}"`);
    const inst = { symbol: hit.symbol, token: hit.token };
    if (byToken.has(inst.token)) throw new HttpError(409, `${inst.symbol} is already in the watchlist`);
    if (list.some(x => x.symbol === inst.symbol)) throw new HttpError(409, `Another instrument is already using the name ${inst.symbol}`);
    if (list.length >= this.d.max) throw new HttpError(400, `Watchlist is full (${this.d.max}). Remove one first.`);
    list.push(inst); byToken.set(inst.token, inst); store.save(list);
    try { hooks.subscribe(inst); } catch (e) { console.error('[Watchlist] subscribe failed:', e.message); }
    await hooks.backfill(inst);           // never throws: failure is recorded as live-only
    hooks.addOptions(inst.symbol);        // background; phases 05/06 show NO DATA until it resolves
    hooks.changed();
    return { ok: true, instrument: { ...inst, type: hit.type, name: hit.name } };
  }
  async remove(symbol) {
    const { list, byToken, store, hooks } = this.d, sym = String(symbol || '').toUpperCase(), i = list.findIndex(x => x.symbol === sym);
    if (i < 0) throw new HttpError(404, `${sym} is not in the watchlist`);
    const [inst] = list.splice(i, 1); byToken.delete(inst.token); store.save(list);
    try { hooks.unsubscribe(inst); } catch (e) { console.error('[Watchlist] unsubscribe failed:', e.message); }
    hooks.purge(inst.symbol); hooks.removeOptions(inst.symbol); hooks.changed();
    return { ok: true, removed: inst.symbol };
  }
}
module.exports = { WatchlistStore, WatchlistManager, HttpError };
