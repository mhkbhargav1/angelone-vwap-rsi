const $ = id => document.getElementById(id);
let snapshot = null, selected = '', source;
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = n => Number.isFinite(Number(n)) ? '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '--';
const hhmm = ms => new Date(ms).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
const clock = () => $('clock').textContent = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST'; setInterval(clock, 1000); clock();

function setConnection(s) {
  const el = $('connection'), st = s.state || 'CONNECTING';
  el.className = 'status ' + (st === 'CONNECTED' ? 'good' : st === 'ERROR' ? 'bad' : '');
  el.innerHTML = `<i></i> ${esc(st)}`;
  $('marketStatus').textContent = st === 'CONNECTED' ? 'CONNECTED' : st === 'ERROR' ? 'OFFLINE' : st === 'BACKFILLING' ? 'LOADING HISTORY' : 'CONNECTING';
}

function biasOf(s) { return s?.ready ? (s.aboveVWAP ? ['ABOVE VWAP', 'positive'] : ['BELOW VWAP', 'negative']) : ['WARMING UP', 'neutral-text']; }

function render(d) {
  snapshot = d; setConnection(d.stream || {});
  $('watchCount').textContent = (d.watchlist || []).length;
  $('timeframe').innerHTML = `${d.timeframe || 5}<span> min</span>`;
  $('signalCount').textContent = (d.signals || []).filter(x => !x.backfill && x.type !== 'BLOCKED').length;
  const cfg = d.config || {};
  $('entryFilter').textContent = `Above VWAP · RSI ${cfg.rsiBuyMin}–${cfg.rsiBuyMax} rising · Fresh cross${cfg.continuation ? ' or continuation' : ''}`;
  $('logicText').textContent = `BUY (no open position): close above session VWAP, RSI rising inside ${cfg.rsiBuyMin}–${cfg.rsiBuyMax}, and either a fresh cross above VWAP${cfg.continuation ? ` or a continuation (≥ ${cfg.continuationMinCandles} closes above VWAP, within ${cfg.continuationMaxDistPct}% of it)` : ''}. EXIT only after a BUY: close below VWAP or RSI below ${cfg.rsiExitLevel}.`;
  const symbols = d.watchlist || [];
  if (!selected && symbols.length) selected = symbols[0];
  if (selected && !symbols.includes(selected)) selected = symbols[0] || '';
  const select = $('instrumentSelect'), key = symbols.join(',');
  if (select.dataset.list !== key) { select.innerHTML = '<option value="">Choose symbol</option>'; symbols.forEach(s => select.add(new Option(s, s))); select.dataset.list = key; }
  select.value = selected;
  $('watchRows').innerHTML = symbols.map(sym => {
    const p = d.prices?.[sym], s = d.states?.[sym], [bias, cls] = biasOf(s), sig = s?.ready ? s.signal : '';
    return `<tr data-symbol="${esc(sym)}"><td>${esc(sym)}</td><td>${p ? money(p.price) : '--'}</td><td>${s?.vwap ? money(s.vwap) : '--'}</td><td>${s?.rsi != null ? s.rsi.toFixed(1) : '--'}</td><td class="${cls}">${bias}</td><td><span class="pill ${sig.toLowerCase()}">${sig || '--'}</span></td><td><button class="rm" data-rm="${esc(sym)}" title="Remove ${esc(sym)}">×</button></td></tr>`;
  }).join('') || '<tr><td colspan="7" class="empty">No instruments yet. Use the search box above to add one.</td></tr>';
  $('watchRows').querySelectorAll('tr[data-symbol]').forEach(tr => tr.onclick = () => { selected = tr.dataset.symbol; select.value = selected; renderDetail(); });
  $('watchRows').querySelectorAll('button[data-rm]').forEach(b => b.onclick = ev => { ev.stopPropagation(); removeSymbol(b.dataset.rm); });
  if (!selected) { $('selectedTitle').textContent = 'Select an instrument'; ['signalContent', 'checks', 'phaseList', 'riskBox', 'chainBox', 'aiBox'].forEach(id => $(id).innerHTML = ''); }
  renderDetail(); renderLog(d.signals || []);
}

const PHASE_NAME = { 1: 'P1 · VWAP + RSI', 2: 'P2 · EMA', 3: 'P3 · Volume', 4: 'P4 · MACD', 5: 'P5 · Option chain', 6: 'P6 · OI + PCR', 7: 'P7 · Regime', 8: 'P8 · Risk gate' };
const ICON = { PASS: '✓', FAIL: '✗', NA: '–' };
function renderChecks(s) {
  if (!s?.checks?.length) { $('checks').innerHTML = ''; return; }
  const row = c => `<li class="${(c.status || (c.pass ? 'PASS' : 'FAIL')).toLowerCase()}"><i>${ICON[c.status] || (c.pass ? '✓' : '✗')}</i><span>${esc(c.label)}${c.path ? `<em>${c.path === 'CROSSOVER' ? 'path A' : 'path B'}</em>` : ''}${c.mode === 'advisory' ? '<em>advisory</em>' : ''}</span><small>${esc(c.detail)}</small></li>`;
  const groups = {}; s.checks.forEach(c => (groups[c.phase || 1] = groups[c.phase || 1] || []).push(c));
  const title = s.position ? 'EXIT conditions (position open)' : 'ENTRY conditions by phase';
  const body = Object.keys(groups).sort().map(ph => {
    const g = groups[ph], core = g.filter(c => !c.path), paths = g.filter(c => c.path);
    const hint = paths.length ? `<li class="hint">Need path A <b>or</b> path B${snapshot?.config?.continuation ? '' : ' (B is off)'}</li>` : '';
    return `<div class="phase-title">${PHASE_NAME[ph] || 'P' + ph}</div><ul>${core.map(row).join('')}${hint}${paths.map(row).join('')}</ul>`;
  }).join('');
  $('checks').innerHTML = `<div class="checks-title">${title}</div>${body}`;
}

function renderPhases() {
  const cfgp = snapshot?.config?.phases || [], s = snapshot?.states?.[selected]; $('phaseSym').textContent = selected || '--';
  $('phaseList').innerHTML = cfgp.map(p => {
    const cs = (s?.checks || []).filter(c => (c.phase || 1) === p.n), pass = cs.filter(c => c.status === 'PASS').length, fail = cs.filter(c => c.status === 'FAIL').length, na = cs.filter(c => c.status === 'NA').length;
    const res = cs.length ? `<span class="${fail ? 'negative' : 'positive'}">${pass}✓ ${fail}✗${na ? ` ${na}–` : ''}</span>` : '<span class="muted">—</span>';
    return `<div class="phase-row"><b>0${p.n}</b><div><span>${esc(p.name)}</span><small>${esc(p.note || '')}</small></div><em class="st ${p.status.toLowerCase().replace(/\s/g, '')}">${esc(p.status)}</em>${res}</div>`;
  }).join('');
}

const inr = n => (n < 0 ? '−' : n > 0 ? '+' : '') + '₹' + Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 });
function renderRisk() {
  const r = snapshot?.risk, s = snapshot?.states?.[selected]; if (!r) return;
  if (!r.enabled) { $('riskBox').innerHTML = '<div class="empty">Risk engine is off (RISK_ENABLED=false).</div>'; $('riskChip').textContent = 'OFF'; return; }
  $('riskChip').textContent = r.halted ? 'HALTED' : 'ACTIVE'; $('riskChip').className = 'chip ' + (r.halted ? 'bad' : '');
  const plan = s?.plan, pos = s?.position;
  const planHtml = plan ? `<div class="kv"><span>${s.signal === 'BLOCKED' ? 'Blocked plan' : 'Entry plan'}</span><b>${money(plan.entry)} → stop ${money(plan.stop)} · target ${money(plan.target)} · ${plan.rr}R</b></div><div class="kv"><span>Size</span><b>${plan.qty} unit(s) · risk ${inr(-plan.riskAmount)} · stop ${plan.stopPct.toFixed(2)}%</b></div>${plan.optionNote ? `<div class="kv"><span>Options</span><b>${esc(plan.optionNote)}</b></div>` : ''}` : '';
  const posHtml = pos?.stop != null ? `<div class="kv"><span>Open position</span><b>${pos.qty} @ ${money(pos.entryPrice)} · stop ${money(pos.stop)}${pos.trailing ? ' (trailing)' : ''} · target ${money(pos.target)}</b></div>` : '';
  const trades = (r.trades || []).slice(0, 5).map(t => `<div class="kv"><span>${esc(t.symbol)} ${hhmm(t.exitTime)}</span><b class="${t.pnlAmt >= 0 ? 'positive' : 'negative'}">${inr(t.pnlAmt)} · ${t.rMultiple != null ? (t.rMultiple >= 0 ? '+' : '') + t.rMultiple.toFixed(2) + 'R' : ''} · ${esc(t.reason)}</b></div>`).join('');
  $('riskBox').innerHTML = `<div class="kv"><span>Model P&L today</span><b class="${r.realised >= 0 ? 'positive' : 'negative'}">${inr(r.realised)} realised${r.unrealised ? ` · ${inr(r.unrealised)} open` : ''}</b></div>
  <div class="kv"><span>Budget</span><b>${inr(-r.riskAmount)}/trade (${r.riskPerTradePct}% of ₹${r.capital.toLocaleString('en-IN')}) · daily stop ${inr(-r.dailyLossLimit)}</b></div>
  <div class="kv"><span>Trades today</span><b>${r.tradesToday} (${r.wins}W/${r.losses}L) · max ${r.maxTradesPerDay}/symbol, ${r.maxOpen} open</b></div>
  <div class="kv"><span>Window</span><b>${r.noEntryBefore}–${r.noEntryAfter} entries · square-off ${r.squareOff || 'off'}</b></div>${planHtml}${posHtml}${trades ? '<div class="sub">Recent model trades</div>' + trades : ''}
  <div class="datanote">Model account only: sizes and stops are suggestions, orders stay manual. Index "units" are a sizing reference, not a tradable quantity.</div>`;
}

const cr = n => n >= 1e7 ? (n / 1e7).toFixed(2) + 'Cr' : n >= 1e5 ? (n / 1e5).toFixed(1) + 'L' : String(Math.round(n));
function renderChain() {
  const c = snapshot?.chains?.[selected], el = $('chainBox'), chip = $('chainChip');
  if (!c) { chip.textContent = 'NO DATA'; el.innerHTML = `<div class="empty">${snapshot?.config?.phases?.[4]?.status === 'NO DATA' ? 'No option chain for this symbol (needs NFO options on Angel One).' : 'Fetching option chain…'}</div>`; return; }
  chip.textContent = `${c.expiry}${c.stale ? ' · STALE' : ''}`; chip.className = 'chip ' + (c.stale ? 'bad' : '');
  const max = Math.max(1, ...c.strikes.flatMap(x => [x.ceOi, x.peOi])), f = c.flow || {};
  const rows = c.strikes.map(x => `<tr class="${x.strike === c.atmStrike ? 'atm' : ''}"><td class="bar left"><i style="width:${(x.peOi / max) * 100}%"></i><span>${cr(x.peOi)}</span></td><td class="k">${x.strike}</td><td class="bar"><i style="width:${(x.ceOi / max) * 100}%"></i><span>${cr(x.ceOi)}</span></td></tr>`).join('');
  const bias = b => `<b class="${b === 'BULLISH' ? 'positive' : b === 'BEARISH' ? 'negative' : ''}">${b}</b>`;
  el.innerHTML = `<div class="chain-stats"><div><span>PCR (window)</span>${bias(c.pcrBias)} ${c.window.pcr != null ? c.window.pcr.toFixed(2) : '--'}</div><div><span>Call wall</span><b>${c.callWall ? c.callWall.strike + ' (' + (c.roomUpPct >= 0 ? '+' : '') + c.roomUpPct.toFixed(2) + '%)' : '--'}</b></div><div><span>Put wall</span><b>${c.putWall ? c.putWall.strike + ' (−' + c.roomDownPct.toFixed(2) + '%)' : '--'}</b></div><div><span>ATM straddle</span><b>${c.straddle ? money(c.straddle) + ' · ±' + c.expectedMovePct.toFixed(2) + '%' : '--'}</b></div></div>
  <div class="flow">${f.state === 'OK' ? `OI flow (${f.minutes}m, ATM±3): ${bias(f.bias)} · CE ${esc(f.ce.label)} (OI ${f.ce.oiChangePct >= 0 ? '+' : ''}${f.ce.oiChangePct.toFixed(1)}%, LTP ${f.ce.ltpChangePct >= 0 ? '+' : ''}${f.ce.ltpChangePct.toFixed(1)}%) · PE ${esc(f.pe.label)} (OI ${f.pe.oiChangePct >= 0 ? '+' : ''}${f.pe.oiChangePct.toFixed(1)}%, LTP ${f.pe.ltpChangePct >= 0 ? '+' : ''}${f.pe.ltpChangePct.toFixed(1)}%)` : 'OI flow: collecting baseline (needs a few minutes of snapshots).'}</div>
  <table class="oitable"><thead><tr><th>PUT OI</th><th>STRIKE</th><th>CALL OI</th></tr></thead><tbody>${rows}</tbody></table>
  <div class="datanote" style="color:#9fb1c9!important">Spot ${money(c.spot)} · updated ${c.ageSec}s ago${c.error ? ' · last error: ' + esc(c.error) : ''}. Walls and PCR cover ATM±${Math.floor((c.window.strikes - 1) / 2)} strikes. Flow is a heuristic.</div>`;
}

const STANCE = { SUPPORTS: 'positive', CONTRADICTS: 'negative', CAUTION: '' };
function renderAI() {
  const s = snapshot?.states?.[selected], r = snapshot?.ai?.[selected], reg = s?.regime, cfg = snapshot?.config || {};
  $('aiBtn').disabled = !cfg.aiConfigured; $('aiBtn').title = cfg.aiConfigured ? 'Ask Claude to review the current state' : 'Set ANTHROPIC_API_KEY in backend/.env';
  const regime = reg && reg.regime !== 'UNKNOWN' ? `<div class="kv"><span>Regime</span><b class="${reg.regime === 'TRENDING_UP' ? 'positive' : ['TRENDING_DOWN', 'VOLATILE', 'CHOPPY'].includes(reg.regime) ? 'negative' : ''}">${esc(reg.regime.replace('_', ' '))}</b></div><div class="kv"><span></span><b>${esc(reg.label)}</b></div>` : '';
  const local = `<div class="sub">Summary (rule-based)</div><p class="ai-text">${esc(s ? localNarrative(s) : 'Loading…')}</p>`;
  let ai = '';
  if (r?.ok) ai = `<div class="sub">Claude review · ${esc(r.model)} · for ${esc(r.forSignal)} · ${hhmm(r.at)}</div><div class="kv"><span>Stance</span><b class="${STANCE[r.stance] || ''}">${esc(r.stance)} · ${r.confidence}%</b></div><p class="ai-text">${esc(r.summary)}</p>${(r.concerns || []).length ? '<div class="sub">Concerns</div><ul class="ai-list">' + r.concerns.map(x => `<li>${esc(x)}</li>`).join('') + '</ul>' : ''}${(r.watch || []).length ? '<div class="sub">Watch</div><ul class="ai-list">' + r.watch.map(x => `<li>${esc(x)}</li>`).join('') + '</ul>' : ''}`;
  else if (r?.error) ai = `<div class="datanote">Claude review unavailable: ${esc(r.error)}</div>`;
  else if (!cfg.aiConfigured) ai = '<div class="datanote" style="color:#9fb1c9!important">Claude review is off. Add ANTHROPIC_API_KEY to backend/.env to enable it. Market data for the symbol is sent to the Anthropic API when you use it.</div>';
  $('aiBox').innerHTML = regime + local + ai + '<div class="datanote" style="color:#9fb1c9!important">Advisory only: the review never changes a signal or a position.</div>';
}
function localNarrative(s) {
  if (!s.ready) return s.reason || 'Waiting for data.';
  const fails = (s.checks || []).filter(c => c.status === 'FAIL' && c.mode === 'required').map(c => c.label);
  if (s.position) return `Model position open (${s.position.entryType}). ${s.reason}`;
  if (s.signal === 'BUY') return s.reason;
  if (s.signal === 'BLOCKED') return s.reason;
  if (s.setup) return `VWAP + RSI setup is valid but not confirmed. Failing: ${fails.join(', ') || 'n/a'}.`;
  return s.reason;
}

function renderDetail() {
  if (!snapshot || !selected) return;
  const s = snapshot.states?.[selected], p = snapshot.prices?.[selected], bf = s?.backfill;
  $('selectedTitle').textContent = selected;
  $('vwapValue').textContent = s?.vwap ? money(s.vwap) : '--';
  $('rsiValue').textContent = s?.rsi != null ? s.rsi.toFixed(1) : '--';
  $('lastValue').textContent = p ? money(p.price) : '--';
  $('vwapState').textContent = s?.aboveVWAP ? 'Price above VWAP' : s?.ready ? 'Price below VWAP' : 'Calculating';
  $('vwapState').className = s?.aboveVWAP ? 'positive' : s?.ready ? 'negative' : '';
  $('rsiState').textContent = s?.rsiRising ? 'RSI rising' : s?.ready ? 'RSI not rising' : 'Awaiting data';
  $('rsiBar').style.width = (s?.rsi ?? 0) + '%';
  $('priceState').textContent = !p ? 'Waiting for data' : p.source === 'HISTORY' ? 'Last close (history)' : 'Live tick received';

  const signal = s?.signal || 'WAIT', cls = signal.toLowerCase();
  const tag = s?.provisional && s?.ready ? '<span class="tag">candle forming · confirms at close</span>' : '';
  const setup = s?.setup ? '<span class="tag">SETUP · UNCONFIRMED</span>' : '';
  const entry = signal === 'BUY' && s.entryType ? `<span class="tag">${esc(s.entryType)}</span>` : '';
  $('signalContent').innerHTML = `<div class="signal-icon ${cls}">${signal === 'BUY' ? '↗' : signal === 'EXIT' ? '↘' : signal === 'HOLD' ? '◉' : signal === 'BLOCKED' ? '⊘' : '⌁'}</div><div class="signal-word ${signal === 'BUY' || signal === 'HOLD' ? 'positive' : signal === 'EXIT' || signal === 'BLOCKED' ? 'negative' : ''}">${signal}</div>${entry}${setup}${tag}<p>${esc(s?.reason || 'Loading history…')}</p>`;
  renderChecks(s); renderPhases(); renderRisk(); renderChain(); renderAI();

  const pos = s?.position;
  $('positionLine').innerHTML = pos ? `Model position: <b class="positive">LONG</b> from ${money(pos.entryPrice)} at ${hhmm(pos.entryTime)} (${esc(pos.entryType)})${s.pnlPct != null ? ` · <b class="${s.pnlPct >= 0 ? 'positive' : 'negative'}">${s.pnlPct >= 0 ? '+' : ''}${s.pnlPct.toFixed(2)}%</b>` : ''}` : 'Model position: <b>none</b> — EXIT can only follow a BUY';
  const notes = [];
  if (bf?.state === 'OK') notes.push(`History: ${bf.warmupCandles} warm-up + ${bf.sessionCandles} session candles (${bf.sessionDay}) loaded; live candles continue the series.`);
  else if (bf?.state === 'FAILED') notes.push(`History backfill failed (${bf.message}). Running live-only — RSI needs ${(snapshot.config?.rsiPeriod || 14) + 1} live candles.`);
  else notes.push('History backfill not run for this symbol.');
  if (s?.vwapMode === 'TYPICAL_PRICE') notes.push('No volume reported for this instrument, so "VWAP" is the session average of typical price (not volume-weighted).');
  $('dataNote').innerHTML = notes.map(esc).join('<br>');
}

function renderLog(items) {
  $('signalLog').innerHTML = items.length ? items.slice(0, 14).map(x => `<div class="log-item"><span class="log-type ${x.type === 'BUY' ? 'positive' : 'negative'}">${x.type}</span><div><b>${esc(x.symbol)}</b> ${x.entryType ? `<span class="tag">${esc(x.entryType)}</span>` : ''}${x.exitReason ? `<span class="tag">${esc(x.exitReason)}</span>` : ''}${x.backfill ? '<span class="tag">BACKFILL</span>' : ''}<small>${esc(x.reason)}</small></div><time>${hhmm(x.time || x.createdAt)}</time></div>`).join('') : '<div class="empty">No signals yet. The system is monitoring.</div>';
}

$('instrumentSelect').addEventListener('change', e => { selected = e.target.value; renderDetail(); });
async function load() { try { const r = await fetch('/api/snapshot'); if (!r.ok) throw Error('API unavailable'); render(await r.json()); } catch (e) { setConnection({ state: 'ERROR' }); } }
function connectEvents() {
  if (source) source.close(); source = new EventSource('/api/events');
  source.addEventListener('snapshot', e => render(JSON.parse(e.data)));
  source.addEventListener('status', e => setConnection(JSON.parse(e.data)));
  source.addEventListener('state', e => { const s = JSON.parse(e.data); if (snapshot) { snapshot.states[s.symbol] = s; renderDetail(); } });
  source.addEventListener('price', e => { const p = JSON.parse(e.data); if (snapshot) { snapshot.prices[p.symbol] = p; render(snapshot); } });
  source.addEventListener('signal', e => { const s = JSON.parse(e.data); if (snapshot) { snapshot.signals = [s, ...snapshot.signals.filter(x => x.id !== s.id)]; renderLog(snapshot.signals); $('signalCount').textContent = snapshot.signals.filter(x => !x.backfill && x.type !== 'BLOCKED').length; } });
  source.addEventListener('risk', e => { if (snapshot) { snapshot.risk = JSON.parse(e.data); renderRisk(); } });
  source.addEventListener('chain', e => { const c = JSON.parse(e.data); if (snapshot) { snapshot.chains[c.symbol] = c; renderChain(); } });
  source.addEventListener('ai', e => { const r = JSON.parse(e.data); if (snapshot) { snapshot.ai[r.symbol] = r; renderAI(); } });
  source.onerror = () => setConnection({ state: 'RECONNECTING' });
}
load(); connectEvents(); setInterval(load, 15000);

$('aiBtn').addEventListener('click', async () => {
  if (!selected) return; const b = $('aiBtn'); b.disabled = true; b.textContent = 'Asking…';
  try { const r = await (await fetch('/api/ai/review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol: selected }) })).json(); if (snapshot) { snapshot.ai[selected] = r; renderAI(); } } catch (e) {}
  b.textContent = 'Ask Claude'; b.disabled = !snapshot?.config?.aiConfigured;
});

// ---- Watchlist search / add / remove ------------------------------------------------------------
function toast(msg, bad) { const t = $('toast'); t.textContent = msg; t.style.borderColor = bad ? '#6c3540' : ''; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 4200); }
let results = [], active = -1, searchTimer, searchSeq = 0, busy = false;
const box = $('searchResults'), input = $('symSearch');
function drawResults() {
  if (!results.length) { box.hidden = !input.value.trim(); box.innerHTML = input.value.trim() ? '<div class="res none">No NSE equity or index matches.</div>' : ''; return; }
  box.hidden = false;
  box.innerHTML = results.map((r, i) => `<div class="res ${i === active ? 'on' : ''} ${r.added ? 'added' : ''}" data-i="${i}"><b>${esc(r.symbol)}</b><span>${esc(r.tradingSymbol)}</span><em>${r.type}</em><small>${r.added ? 'ADDED' : 'ADD +'}</small></div>`).join('');
  box.querySelectorAll('.res[data-i]').forEach(el => el.onmousedown = ev => { ev.preventDefault(); const r = results[+el.dataset.i]; if (!r.added) addSymbol({ token: r.token }); });
}
async function runSearch() {
  const q = input.value.trim(), seq = ++searchSeq; if (!q) { results = []; active = -1; drawResults(); return; }
  try { const d = await (await fetch('/api/search?q=' + encodeURIComponent(q))).json(); if (seq !== searchSeq) return; if (!d.ok) { box.hidden = false; box.innerHTML = `<div class="res none">${esc(d.message)}</div>`; return; } results = d.results; active = results.findIndex(r => !r.added); drawResults(); }
  catch { box.hidden = false; box.innerHTML = '<div class="res none">Search failed. Is the backend running?</div>'; }
}
async function addSymbol(body) {
  if (busy) return; busy = true; input.disabled = true; toast('Adding ' + (body.symbol || 'instrument') + '… fetching history');
  try {
    const r = await fetch('/api/watchlist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), d = await r.json();
    if (!d.ok) throw new Error(d.message || 'Could not add');
    toast(`Added ${d.instrument.symbol} (${d.instrument.type === 'INDEX' ? 'index' : 'equity'})`); selected = d.instrument.symbol; input.value = ''; results = []; drawResults(); await load();
  } catch (e) { toast(e.message, true); }
  busy = false; input.disabled = false; input.focus();
}
async function removeSymbol(sym) {
  try { const d = await (await fetch('/api/watchlist/' + encodeURIComponent(sym), { method: 'DELETE' })).json(); if (!d.ok) throw new Error(d.message); toast('Removed ' + sym); if (selected === sym) selected = ''; await load(); }
  catch (e) { toast(e.message, true); }
}
input.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 180); });
input.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' && results.length) { e.preventDefault(); active = (active + 1) % results.length; drawResults(); }
  else if (e.key === 'ArrowUp' && results.length) { e.preventDefault(); active = (active - 1 + results.length) % results.length; drawResults(); }
  else if (e.key === 'Escape') { box.hidden = true; }
  else if (e.key === 'Enter') { e.preventDefault(); const q = input.value.trim(); if (!q) return; const exact = results.find(r => !r.added && [r.symbol, r.token, r.tradingSymbol.replace(/-EQ$/, '')].includes(q.toUpperCase())); if (exact) addSymbol({ token: exact.token }); else if (active >= 0 && results[active]) addSymbol({ token: results[active].token }); else addSymbol({ symbol: q }); }
});
input.addEventListener('blur', () => setTimeout(() => { box.hidden = true; }, 120));
input.addEventListener('focus', () => { if (input.value.trim()) runSearch(); });
