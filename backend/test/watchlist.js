// Offline checks for the editable watchlist: node test/watchlist.js
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const { Instruments, compact } = require('../src/instruments');
const { WatchlistStore, WatchlistManager } = require('../src/watchlist');
const { loadContracts } = require('../src/options');
const { Engine } = require('../src/engine');
let n = 0; const ok = async (name, fn) => { await fn(); n++; console.log('  ✓', name); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-'));
const MASTER = [
  { token: '2885', symbol: 'RELIANCE-EQ', name: 'RELIANCE', exch_seg: 'NSE', instrumenttype: '', lotsize: '1' },
  { token: '500', symbol: 'RELIANCE-BE', name: 'RELIANCE', exch_seg: 'NSE', instrumenttype: '' },
  { token: '1234', symbol: 'RELINFRA-EQ', name: 'RELINFRA', exch_seg: 'NSE', instrumenttype: '' },
  { token: '11536', symbol: 'TCS-EQ', name: 'TCS', exch_seg: 'NSE', instrumenttype: '' },
  { token: '3045', symbol: 'SBIN-EQ', name: 'SBIN', exch_seg: 'NSE', instrumenttype: '' },
  { token: '99926000', symbol: 'Nifty 50', name: 'NIFTY', exch_seg: 'NSE', instrumenttype: 'AMXIDX' },
  { token: '99926009', symbol: 'Nifty Bank', name: 'BANKNIFTY', exch_seg: 'NSE', instrumenttype: 'AMXIDX' },
  { token: '777', symbol: 'RELIANCE29DEC262500CE', name: 'RELIANCE', exch_seg: 'NFO', instrumenttype: 'OPTSTK', expiry: '29DEC2026', strike: '250000.000000', lotsize: '500' },
  { token: '778', symbol: 'NIFTY19NOV2625000CE', name: 'NIFTY', exch_seg: 'NFO', instrumenttype: 'OPTIDX', expiry: '19NOV2026', strike: '2500000.000000', lotsize: '75' }
];
const cfg = { option: { scripMasterUrl: 'http://x/master.json' } };
let fetches = 0; const fakeFetch = async () => { fetches++; return { ok: true, status: 200, json: async () => MASTER }; };

(async () => {
  console.log('Instrument search');
  const inst = new Instruments(cfg, { fetchImpl: fakeFetch, dir: path.join(tmp, 'c1') });
  await ok('compact keeps only NSE equities (-EQ) and indices, drops BE series and NFO', () => {
    const rows = compact(MASTER); assert.deepStrictEqual(rows.map(r => r.symbol).sort(), ['BANKNIFTY', 'NIFTY', 'RELIANCE', 'RELINFRA', 'SBIN', 'TCS']); assert.strictEqual(rows.find(r => r.symbol === 'NIFTY').type, 'INDEX');
  });
  await ok('load downloads once, caches per day, second instance reads the cache', async () => {
    await inst.load(); await new Instruments(cfg, { fetchImpl: fakeFetch, dir: path.join(tmp, 'c1') }).load(); assert.strictEqual(fetches, 1);
  });
  await ok('search ranking: exact > prefix > substring; token, trading symbol and spaces work', () => {
    assert.strictEqual(inst.search('reliance')[0].symbol, 'RELIANCE'); assert.strictEqual(inst.search('reliance-eq')[0].token, '2885'); assert.strictEqual(inst.search('2885')[0].symbol, 'RELIANCE');
    assert.deepStrictEqual(inst.search('reli').map(r => r.symbol), ['RELIANCE', 'RELINFRA']); assert.strictEqual(inst.search('nifty 50')[0].symbol, 'NIFTY'); assert.strictEqual(inst.search('NIFTY')[0].symbol, 'NIFTY');
    assert(inst.search('bank').some(r => r.symbol === 'BANKNIFTY')); assert.deepStrictEqual(inst.search('zzzz'), []); assert.deepStrictEqual(inst.search(''), []);
  });

  console.log('Persistence');
  const file = path.join(tmp, 'data', 'watchlist.json'), store = new WatchlistStore(file);
  await ok('store: seed on first run, then the saved file wins; atomic write', () => {
    const seed = [{ symbol: 'NIFTY', token: '99926000' }]; assert.deepStrictEqual(store.load(seed), seed);
    store.save([{ symbol: 'TCS', token: '11536', junk: 1 }]); assert.deepStrictEqual(store.load(seed), [{ symbol: 'TCS', token: '11536' }]); assert(!fs.existsSync(file + '.tmp'));
    fs.writeFileSync(file, '{broken'); assert.deepStrictEqual(store.load(seed), seed, 'corrupt file falls back to seed');
  });

  console.log('Add / remove orchestration');
  const mkMgr = (over = {}) => {
    const calls = [], list = [], byToken = new Map(), st = new WatchlistStore(path.join(tmp, 'm' + Math.random(), 'w.json'));
    const mgr = new WatchlistManager({ list, byToken, store: st, instruments: inst, max: over.max ?? 3, isReady: () => over.ready ?? true,
      hooks: { subscribe: i => calls.push('sub:' + i.symbol), unsubscribe: i => calls.push('unsub:' + i.symbol), backfill: async i => { calls.push('bf:' + i.symbol); }, addOptions: s => calls.push('opt+:' + s),
        removeOptions: s => calls.push('opt-:' + s), purge: s => calls.push('purge:' + s), changed: () => calls.push('changed') } });
    return { mgr, calls, list, byToken, st };
  };
  await ok('add by pasted symbol: resolves token, subscribes, backfills, wires options, persists, notifies (in order)', async () => {
    const { mgr, calls, list, byToken, st } = mkMgr(); const r = await mgr.add({ symbol: 'reliance' });
    assert.deepStrictEqual(r.instrument, { symbol: 'RELIANCE', token: '2885', type: 'EQ', name: 'RELIANCE' }); assert.deepStrictEqual(calls, ['sub:RELIANCE', 'bf:RELIANCE', 'opt+:RELIANCE', 'changed']);
    assert.strictEqual(byToken.get('2885').symbol, 'RELIANCE'); assert.deepStrictEqual(st.load([]), [{ symbol: 'RELIANCE', token: '2885' }]); assert.strictEqual(list.length, 1);
  });
  await ok('add by token and by trading symbol; index works', async () => {
    const { mgr } = mkMgr(); assert.strictEqual((await mgr.add({ token: '99926000' })).instrument.symbol, 'NIFTY'); assert.strictEqual((await mgr.add({ symbol: 'TCS-EQ' })).instrument.symbol, 'TCS'); assert.strictEqual((await mgr.add({ symbol: 'Nifty Bank' })).instrument.symbol, 'BANKNIFTY');
  });
  await ok('rejects: not ready (503), duplicate (409), full (400), unknown (404), ambiguous partial (404 + hint), empty (400)', async () => {
    const err = async (p, s) => { try { await p; assert.fail('should throw'); } catch (e) { assert.strictEqual(e.status, s, e.message); return e; } };
    await err(mkMgr({ ready: false }).mgr.add({ symbol: 'TCS' }), 503);
    const a = mkMgr({ max: 2 }); await a.mgr.add({ symbol: 'TCS' }); await err(a.mgr.add({ symbol: 'tcs' }), 409); await a.mgr.add({ symbol: 'SBIN' }); await err(a.mgr.add({ symbol: 'NIFTY' }), 400);
    await err(a.mgr.add({ symbol: 'ZZZZ' }), 404); const hint = await err(mkMgr().mgr.add({ symbol: 'RELI' }), 404); assert(/Did you mean RELIANCE/.test(hint.message)); await err(mkMgr().mgr.add({}), 400);
    assert.strictEqual(a.list.length, 2, 'failed adds leave the list untouched');
  });
  await ok('remove: unsubscribes, purges engine state, drops options, persists; unknown is 404', async () => {
    const { mgr, calls, list, byToken, st } = mkMgr(); await mgr.add({ symbol: 'TCS' }); calls.length = 0;
    assert.deepStrictEqual(await mgr.remove('tcs'), { ok: true, removed: 'TCS' }); assert.deepStrictEqual(calls, ['unsub:TCS', 'purge:TCS', 'opt-:TCS', 'changed']); assert(!list.length && !byToken.size); assert.deepStrictEqual(st.load(['x']), []);
    try { await mgr.remove('TCS'); assert.fail(); } catch (e) { assert.strictEqual(e.status, 404); }
  });

  console.log('Runtime cleanup + option contracts');
  await ok('engine.remove clears candles, state, model position and the symbol\'s trades', () => {
    const e = new Engine({ timeframe: 5, rsiPeriod: 14, emaMode: 'off', volumeMode: 'off', macdMode: 'off', risk: { enabled: true, capital: 1, riskPerTradePct: 1, maxDailyLossPct: 1, noEntryBeforeMin: 0, noEntryAfterMin: 1440, squareOffMin: null } }, {});
    e.positions.set('T', { day: e.day, entryPrice: 1 }); e.states.T = { price: 1 }; e.meta.T = { state: 'OK' }; e.risk.trades.push({ symbol: 'T', day: e.day, pnlAmt: -5 }); e.book._slot('T');
    e.remove('T'); assert(!e.positions.has('T') && !e.states.T && !e.meta.T && !e.book.data.has('T') && e.risk.trades.length === 0);
  });
  await ok('option contracts: cache holds the union; adding a symbol later works and old names still resolve', async () => {
    const dir = path.join(tmp, 'opt'), before = fetches;
    const a = await loadContracts(cfg, ['NIFTY'], Date.now(), { fetchImpl: fakeFetch, dir }); assert.deepStrictEqual([...new Set(a.map(r => r.name))], ['NIFTY']); assert.strictEqual(a[0].strike, 25000); assert.strictEqual(a[0].lotSize, 75);
    const b = await loadContracts(cfg, ['NIFTY'], Date.now(), { fetchImpl: fakeFetch, dir }); assert.strictEqual(b.length, 1);
    const c = await loadContracts(cfg, ['NIFTY', 'RELIANCE'], Date.now(), { fetchImpl: fakeFetch, dir }); assert.deepStrictEqual([...new Set(c.map(r => r.name))].sort(), ['NIFTY', 'RELIANCE']);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8')).names.sort(), ['NIFTY', 'RELIANCE']); assert(fetches - before <= 1, 'master downloads are shared');
  });
  console.log('Scrip master sources');
  const sm = require('../src/scripmaster').download;
  await ok('falls back to the next URL on 404; error lists every URL tried; local file wins', async () => {
    sm.reset(); const seen = [], f404 = async u => { seen.push(u); return u.includes('good') ? { ok: true, status: 200, json: async () => MASTER } : { ok: false, status: 404, json: async () => ({}) }; };
    assert.strictEqual((await sm(['http://old/x.json', 'http://good/x.json'], f404)).length, MASTER.length); assert.deepStrictEqual(seen, ['http://old/x.json', 'http://good/x.json']);
    sm.reset(); try { await sm(['http://a/x', 'http://b/x'], f404); assert.fail('should throw'); } catch (e) { assert(/http:\/\/a\/x \(HTTP 404\)/.test(e.message) && /http:\/\/b\/x \(HTTP 404\)/.test(e.message) && /SCRIP_MASTER_FILE/.test(e.message)); }
    sm.reset(); const lf = path.join(tmp, 'master.json'); fs.writeFileSync(lf, JSON.stringify(MASTER)); let called = false; assert.strictEqual((await sm(['http://a/x'], async () => { called = true; }, lf)).length, MASTER.length); assert(!called, 'local file avoids the network');
    sm.reset(); try { await sm(['http://a/x'], f404, path.join(tmp, 'missing.json')); assert.fail(); } catch (e) { assert(/SCRIP_MASTER_FILE could not be read/.test(e.message)); }
    sm.reset();
  });
  console.log(`\n${n} watchlist checks passed`);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
