const { SmartAPI, WebSocketV2 } = require('smartapi-javascript');
const { authenticator } = require('otplib');
class AngelOne {
  constructor(config, onTick, onStatus) { this.c = config; this.onTick = onTick; this.onStatus = onStatus; this.api = null; this.ws = null; this.session = null; }
  async login() {
    this.onStatus({ state: 'AUTHENTICATING' });
    this.api = new SmartAPI({ api_key: this.c.apiKey() });
    const session = await this.api.generateSession(this.c.clientCode(), this.c.pin(), authenticator.generate(this.c.totpSecret()));
    if (!session || session.status === false || !session.data?.jwtToken || !session.data?.feedToken) throw new Error(session?.message || 'Angel One authentication failed');
    this.session = session;
  }
  // Historical candles via SmartAPI getCandleData. Returns [[iso, o, h, l, c, v], ...]
  async candles({ exchange = 'NSE', token, interval, from, to }) {
    const res = await this.api.getCandleData({ exchange, symboltoken: String(token), interval, fromdate: from, todate: to });
    if (!res || res.status === false || !Array.isArray(res.data)) throw new Error(res?.message || 'getCandleData returned no data');
    return res.data;
  }
  // Market quote (FULL mode gives LTP + open interest) for NFO option tokens. Direct REST call with SmartAPI headers.
  async quote(exchangeTokens, mode = 'FULL', exchange = 'NFO') {
    const res = await fetch(this.c.option.quoteUrl, { method: 'POST', signal: AbortSignal.timeout(15_000), headers: {
      Authorization: `Bearer ${this.session.data.jwtToken}`, 'Content-Type': 'application/json', Accept: 'application/json', 'X-UserType': 'USER', 'X-SourceID': 'WEB',
      'X-ClientLocalIP': '127.0.0.1', 'X-ClientPublicIP': '127.0.0.1', 'X-MACAddress': '00:00:00:00:00:00', 'X-PrivateKey': this.c.apiKey() },
      body: JSON.stringify({ mode, exchangeTokens: { [exchange]: exchangeTokens.map(String) } }) });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || body.status === false) throw new Error(body?.message || `quote HTTP ${res.status}`);
    return body.data?.fetched || [];
  }
  async startStream(instruments) {
    this.onStatus({ state: 'CONNECTING' });
    const s = this.session;
    this.ws = new WebSocketV2({ jwttoken: s.data.jwtToken, apikey: this.c.apiKey(), clientcode: this.c.clientCode(), feedtype: s.data.feedToken });
    this.ws.on('tick', raw => { const t = normalize(raw); if (t) this.onTick(t); });
    await this.ws.connect();
    this.subscribe(instruments);
    this.onStatus({ state: 'CONNECTED', subscribed: instruments.length });
  }
  // Live feed subscriptions (NSE cash segment, same as the initial subscription). Safe to call while connected.
  subscribe(instruments) { const tokens = instruments.map(x => String(x.token)); if (tokens.length && this.ws) this.ws.fetchData({ correlationID: 'vwap-rsi-live', action: 1, mode: 2, exchangeType: 1, tokens }); }
  unsubscribe(instruments) { const tokens = instruments.map(x => String(x.token)); if (tokens.length && this.ws) this.ws.fetchData({ correlationID: 'vwap-rsi-live', action: 0, mode: 2, exchangeType: 1, tokens }); }
  async close() { try { await this.ws?.close(); } catch {} }
}
function normalize(raw) {
  let t = raw; if (typeof t === 'string') { try { t = JSON.parse(t); } catch { return null; } }
  if (!t || typeof t !== 'object') return null;
  const token = String(t.token ?? t.symbolToken ?? t.tk ?? '').trim().replace(/^"|"$/g, '');
  const rawPrice = Number(t.last_traded_price ?? t.lastTradedPrice ?? t.ltp ?? t.lp);
  if (!token || !(rawPrice > 0)) return null;
  const timestampRaw = Number(t.exchange_timestamp ?? t.exchangeTimestamp ?? t.ltt ?? 0);
  return { token, price: rawPrice / 100, volume: Number(t.vol_traded ?? t.volume_trade_for_the_day ?? t.volumeTradeForTheDay ?? t.v ?? 0), timestamp: timestampRaw ? (timestampRaw < 1e12 ? timestampRaw * 1000 : timestampRaw) : Date.now() };
}
module.exports = { AngelOne };
