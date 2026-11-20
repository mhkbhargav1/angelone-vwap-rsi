const path = require('path');
const express = require('express');
const cors = require('cors');
const config = require('./config');
const { AngelOne } = require('./angelone');
const { Engine } = require('./engine');
const { OptionChains } = require('./options');
const { istDay } = require('./indicators');
const { Instruments } = require('./instruments');
const { WatchlistStore, WatchlistManager } = require('./watchlist');
const ai = require('./ai');

// The watchlist lives in backend/data/watchlist.json and is edited from the dashboard. WATCHLIST in .env only seeds the first run.
const store = new WatchlistStore(), seed = config.watchlist.slice();
config.watchlist.splice(0, config.watchlist.length, ...store.load(seed));
// ---- Access protection: required once the dashboard has a public URL ---------------------------------
const crypto = require('crypto');
const AUTH_USER = process.env.APP_USERNAME || 'admin', AUTH_PASS = process.env.APP_PASSWORD || '';
const IN_CLOUD = !!(process.env.RENDER || process.env.NODE_ENV === 'production');
if (IN_CLOUD && AUTH_PASS.length < 8) { console.error('Set APP_PASSWORD (at least 8 characters) in the hosting dashboard. Refusing to start a public server without a password.'); process.exit(1); }
const digest = v => crypto.createHash('sha256').update(String(v)).digest();
const sameText = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));
function requireLogin(req, res, next) {
  if (!AUTH_PASS) return next(); // local use without a password still works
  const m = /^Basic (.+)$/i.exec(req.headers.authorization || '');
  if (m) {
    const decoded = Buffer.from(m[1], 'base64').toString('utf8'), i = decoded.indexOf(':');
    const okUser = sameText(decoded.slice(0, Math.max(i, 0)), AUTH_USER), okPass = sameText(decoded.slice(i + 1), AUTH_PASS);
    if (i >= 0 && okUser && okPass) return next();
  }
  setTimeout(() => { res.set('WWW-Authenticate', 'Basic realm="Trading dashboard", charset="UTF-8"').status(401).send('Login required'); }, 1000); // slows down password guessing
}

const app = express();
app.disable('x-powered-by');
app.get('/healthz', (_req, res) => res.json({ ok: true })); // open on purpose: used by the host's health check and the keep-awake ping
app.use(requireLogin);
// The dashboard is served by this same server, so CORS is not needed. Set CORS_ORIGIN only if you host the frontend elsewhere.
if (process.env.CORS_ORIGIN) app.use(cors({ origin: process.env.CORS_ORIGIN.split(',').map(x => x.trim()) }));
app.use(express.json()); app.use(express.static(path.join(__dirname, '../../frontend')));
const byToken = new Map(config.watchlist.map(x => [x.token, x])), instruments = new Instruments(config);
const prices = {}, signals = [], clients = new Set(), aiReviews = {}, aiLast = {}; let stream = { state: 'STARTING' }, broker, chains = null;

function broadcast(event, data) { const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; for (const res of clients) res.write(msg); }
function pushSignal(s) {
  const item = { id: `${s.symbol}-${s.type}-${s.time}`, ...s, createdAt: s.backfill ? s.time : Date.now() };
  if (signals.some(x => x.id === item.id)) return;
  signals.unshift(item); if (signals.length > 100) signals.pop();
  broadcast('signal', item);
  if (item.type === 'BUY' && !item.backfill && config.ai.autoOnBuy) setTimeout(() => runAi(item.symbol, true), 100);
}
const engine = new Engine(config, {
  onState: s => broadcast('state', s), onSignal: pushSignal, onRisk: r => broadcast('risk', r),
  onCandle: (symbol, c) => broadcast('candle', { symbol, ...c }), getChain: symbol => chains?.summary(symbol) || null
});
setInterval(() => engine.flush(), 1000); // close candles on time even without a following tick

// ---- Phase 07: AI review (advisory only) -----------------------------------------------------------
async function runAi(symbol, auto = false) {
  const st = engine.states[symbol]; if (!st?.ready) return { ok: false, error: 'No ready state for ' + symbol };
  if (!config.ai.reviewEnabled || !config.ai.apiKey) return { ok: false, error: 'Claude review disabled: set ANTHROPIC_API_KEY (and AI_REVIEW_ENABLED=true) in backend/.env' };
  if (Date.now() - (aiLast[symbol] || 0) < config.ai.minGapSeconds * 1000 && auto) return aiReviews[symbol] || { ok: false, error: 'rate limited' };
  aiLast[symbol] = Date.now();
  let r; try { r = await ai.review(config, st, chains?.summary(symbol)); } catch (e) { r = { ok: false, error: e.message }; }
  aiReviews[symbol] = { ...r, symbol, at: Date.now() }; broadcast('ai', aiReviews[symbol]); return aiReviews[symbol];
}

const modeLabel = m => (m === 'required' ? 'REQUIRED' : m === 'advisory' ? 'ADVISORY' : 'OFF');
function phases() {
  const c = config, optOn = c.option.enabled && chains && chains.supported().length > 0;
  return [
    { n: 1, name: 'VWAP + RSI', status: 'CORE', note: 'always on' },
    { n: 2, name: 'EMA confirmation', status: modeLabel(c.emaMode), note: `EMA ${c.emaFast}/${c.emaSlow}` },
    { n: 3, name: 'Volume analysis', status: modeLabel(c.volumeMode), note: `RVOL ≥ ${c.volumeMinRvol}x` },
    { n: 4, name: 'MACD confirmation', status: modeLabel(c.macdMode), note: `${c.macdFast}/${c.macdSlow}/${c.macdSignal}` },
    { n: 5, name: 'Option-chain intelligence', status: optOn ? modeLabel(c.optionMode) : 'NO DATA', note: optOn ? `${chains.supported().join(', ')}` : 'needs NFO options + quote access' },
    { n: 6, name: 'OI + PCR analysis', status: optOn ? modeLabel(c.oiMode) : 'NO DATA', note: `PCR ${c.pcrBearish}–${c.pcrBullish}` },
    { n: 7, name: 'AI market intelligence', status: modeLabel(c.aiMode), note: c.ai.apiKey && c.ai.reviewEnabled ? `regime + Claude review (${c.ai.model})` : 'regime only (no API key)' },
    { n: 8, name: 'Risk management engine', status: c.risk.enabled ? 'ENFORCED' : 'OFF', note: `${c.risk.riskPerTradePct}% risk · ${c.risk.rewardRisk}R target` }
  ];
}
const settings = () => ({ rsiPeriod: config.rsiPeriod, rsiBuyMin: config.rsiBuyMin, rsiBuyMax: config.rsiBuyMax, rsiExitLevel: config.rsiExitLevel,
  historyCandles: config.historyCandles, continuation: config.continuation, continuationMinCandles: config.continuationMinCandles, continuationMaxDistPct: config.continuationMaxDistPct,
  aiConfigured: !!(config.ai.apiKey && config.ai.reviewEnabled), phases: phases() });
const snapshot = () => ({ stream, timeframe: config.timeframe, watchlist: config.watchlist.map(x => x.symbol), prices, states: engine.states, signals: signals.slice(0, 50),
  chains: chains?.all() || {}, risk: engine.riskSummary(), ai: aiReviews, config: settings() });

// ---- Historical backfill ---------------------------------------------------------------------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const istStamp = ms => new Date(ms + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' ');
async function backfillOne(inst) {
  const now = Date.now(), from = `${istDay(now - config.backfillLookbackDays * 86_400_000)} 09:15`, to = istStamp(now);
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const raw = await broker.candles({ token: inst.token, interval: config.interval, from, to });
      const info = engine.seed(inst.symbol, raw, now);
      const last = engine.states[inst.symbol];
      if (last?.price != null) prices[inst.symbol] = { symbol: inst.symbol, price: last.price, timestamp: info.lastTime ?? now, volume: 0, source: 'HISTORY' };
      engine.setMeta(inst.symbol, { state: 'OK', ...info, from, to, at: Date.now() }); engine._publish(inst.symbol);
      console.log(`[Backfill] ${inst.symbol}: ${info.candles} candles (${info.warmupCandles} warm-up + ${info.sessionCandles} session), ${info.replayedSignals} replayed signal(s)`);
      return;
    } catch (e) { lastErr = e; await sleep(1200 * attempt); }
  }
  engine.setMeta(inst.symbol, { state: 'FAILED', message: lastErr?.message || String(lastErr), at: Date.now() });
  console.error(`[Backfill] ${inst.symbol} failed: ${lastErr?.message || lastErr} -> running live-only`);
}
async function backfillAll() {
  stream = { ...stream, state: 'BACKFILLING', updatedAt: Date.now() }; broadcast('status', stream);
  for (const inst of [...config.watchlist]) { await backfillOne(inst); await sleep(450); } // SmartAPI historical rate limit is ~3 req/s
  broadcast('snapshot', snapshot());
}

function onTick(tick) {
  const instrument = byToken.get(tick.token); if (!instrument) return;
  prices[instrument.symbol] = { symbol: instrument.symbol, price: tick.price, timestamp: tick.timestamp, volume: tick.volume, source: 'LIVE' };
  engine.tick(instrument.symbol, tick.price, tick.volume, tick.timestamp);
  broadcast('price', prices[instrument.symbol]);
}

app.get('/api/health', (_req, res) => res.json({ ok: true, stream, timeframe: config.timeframe }));
app.get('/api/snapshot', (_req, res) => res.json(snapshot()));
app.get('/api/risk', (_req, res) => res.json(engine.riskSummary()));
app.get('/api/chain/:symbol', (req, res) => { const s = chains?.summary(String(req.params.symbol).toUpperCase()); s ? res.json(s) : res.status(404).json({ ok: false, message: 'No option-chain data for this symbol' }); });
app.get('/api/ai/:symbol', (req, res) => res.json(aiReviews[String(req.params.symbol).toUpperCase()] || { ok: false, error: 'No review yet' }));
app.post('/api/ai/review', async (req, res) => { const sym = String(req.body?.symbol || '').toUpperCase(); if (!engine.states[sym]) return res.status(404).json({ ok: false, error: 'Unknown symbol' }); res.json(await runAi(sym, false)); });
app.post('/api/backfill', async (_req, res) => { // re-fetch history (e.g. after a feed drop)
  if (!broker?.session) return res.status(503).json({ ok: false, message: 'Not logged in yet' });
  const prev = stream.state; await backfillAll(); stream = { ...stream, state: prev === 'BACKFILLING' ? 'CONNECTED' : prev }; broadcast('status', stream); res.json({ ok: true, backfill: engine.meta });
});
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }); res.flushHeaders(); clients.add(res);
  res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
  const timer = setInterval(() => res.write(': keepalive\n\n'), 20000);
  req.on('close', () => { clearInterval(timer); clients.delete(res); });
});

const optionsWanted = () => config.option.enabled && !(config.optionMode === 'off' && config.oiMode === 'off');
const onChain = (sym, s) => { broadcast('chain', s); engine._publish(sym); };
function makeChains() { return new OptionChains(config, { quote: tokens => broker.quote(tokens), getSpot: sym => prices[sym]?.price ?? engine.states[sym]?.price ?? null }); }
async function startOptions() {
  if (!optionsWanted()) return;
  chains = makeChains();
  try {
    const ok = await chains.init(config.watchlist.map(x => x.symbol));
    console.log(ok.length ? `[Options] chain enabled for: ${ok.join(', ')}` : '[Options] no watchlist symbol has NFO options in the scrip master -> phases 05/06 report NO DATA');
    if (ok.length) chains.start(onChain);
  } catch (e) { console.error('[Options] disabled:', e.message); chains = null; }
}
async function addOptions(symbol) { // background, after a symbol is added from the UI
  if (!optionsWanted()) return;
  try { chains ||= makeChains(); if (await chains.addSymbol(symbol)) { chains.start(onChain); console.log(`[Options] chain enabled for ${symbol}`); } broadcast('snapshot', snapshot()); }
  catch (e) { console.error(`[Options] ${symbol}: ${e.message}`); }
}

// ---- Editable watchlist ------------------------------------------------------------------------
const manager = new WatchlistManager({ list: config.watchlist, byToken, store, instruments, max: config.watchlistMax, isReady: () => stream.state === 'CONNECTED',
  hooks: {
    subscribe: inst => broker.subscribe([inst]), unsubscribe: inst => broker.unsubscribe([inst]), backfill: inst => (config.backfill ? backfillOne(inst) : Promise.resolve()),
    addOptions, removeOptions: sym => chains?.removeSymbol(sym),
    purge: sym => { engine.remove(sym); delete prices[sym]; delete aiReviews[sym]; delete aiLast[sym]; },
    changed: () => broadcast('snapshot', snapshot())
  } });
const fail = (res, e) => res.status(e.status || 500).json({ ok: false, message: e.message });
app.get('/api/search', async (req, res) => {
  try { await instruments.load(); const have = new Set(config.watchlist.map(x => x.token));
    res.json({ ok: true, results: instruments.search(String(req.query.q || ''), 8).map(r => ({ symbol: r.symbol, token: r.token, name: r.name, tradingSymbol: r.tradingSymbol, type: r.type, added: have.has(r.token) })) });
  } catch (e) { res.status(503).json({ ok: false, message: `Instrument list unavailable: ${e.message}` }); }
});
app.post('/api/watchlist', async (req, res) => { try { res.json(await manager.add(req.body || {})); } catch (e) { fail(res, e); } });
app.delete('/api/watchlist/:symbol', async (req, res) => { try { res.json(await manager.remove(req.params.symbol)); } catch (e) { fail(res, e); } });

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '../../frontend/index.html')));
const server = app.listen(config.port, config.host, () => console.log(`Dashboard: http://${config.host}:${config.port}`));

async function start() {
  broker = new AngelOne(config, onTick, s => { stream = { ...s, updatedAt: Date.now() }; broadcast('status', stream); console.log('[Angel One]', s); });
  try {
    await broker.login();
    if (config.backfill) await backfillAll();
    await broker.startStream(config.watchlist);
    startOptions(); // non-blocking: option data is a confirmation layer, the core engine must not wait for it
  } catch (e) { stream = { state: 'ERROR', message: e.message }; broadcast('status', stream); console.error('[Angel One]', e.message); }
}
process.on('SIGINT', async () => { chains?.stop(); await broker?.close(); server.close(() => process.exit(0)); });
process.on('SIGTERM', async () => { chains?.stop(); await broker?.close(); server.close(() => process.exit(0)); });
start();

// Free hosts put idle services to sleep (Render: after 15 min without inbound requests). Ping our own public URL so the live feed keeps running.
if (process.env.RENDER_EXTERNAL_URL && process.env.KEEP_AWAKE !== 'false') {
  const pingUrl = process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '') + '/healthz';
  setInterval(() => { fetch(pingUrl, { signal: AbortSignal.timeout(10_000) }).catch(() => {}); }, 10 * 60_000);
}
