require('dotenv').config();
function required(key) { const v = process.env[key]; if (!v || v.startsWith('your_') || v.includes('YOUR_')) throw new Error(`Configure ${key} in backend/.env`); return v.trim(); }
const raw = k => { const v = process.env[k]; return v == null || v.trim() === '' ? null : v.trim(); };
const num = (k, d) => { const v = raw(k); const n = v == null ? d : Number(v); if (!Number.isFinite(n)) throw new Error(`${k} must be a number`); return n; };
const bool = (k, d) => { const v = raw(k); return v == null ? d : /^(1|true|yes|on)$/i.test(v); };
const mode = (k, d) => { const v = (raw(k) || d).toLowerCase(); if (!['off', 'advisory', 'required'].includes(v)) throw new Error(`${k} must be off, advisory or required`); return v; };
const hhmm = (k, d) => { const v = raw(k) ?? d; if (v === 'off' || v === 'none') return null; const m = /^(\d{1,2}):(\d{2})$/.exec(v); if (!m) throw new Error(`${k} must be HH:MM (IST)`); return +m[1] * 60 + +m[2]; };
const watchlist = (process.env.WATCHLIST || '').split(',').map(x => x.trim()).filter(Boolean).map(item => {
  const [symbol, token] = item.split(':').map(x => x.trim());
  if (!symbol || !token) throw new Error(`Invalid WATCHLIST item: ${item}. Use SYMBOL:TOKEN`);
  return { symbol: symbol.toUpperCase(), token };
});
const INTERVALS = { 1: 'ONE_MINUTE', 3: 'THREE_MINUTE', 5: 'FIVE_MINUTE', 10: 'TEN_MINUTE', 15: 'FIFTEEN_MINUTE', 30: 'THIRTY_MINUTE', 60: 'ONE_HOUR' };
const timeframe = num('TIMEFRAME', 5);
if (!INTERVALS[timeframe]) throw new Error(`TIMEFRAME must be one of ${Object.keys(INTERVALS).join(', ')} (minutes)`);

const cfg = {
  port: num('PORT', 8787), host: process.env.HOST || (process.env.RENDER ? '0.0.0.0' : '127.0.0.1'),
  apiKey: () => required('ANGEL_API_KEY'), clientCode: () => required('ANGEL_CLIENT_CODE'), pin: () => required('ANGEL_PIN'), totpSecret: () => required('ANGEL_TOTP_SECRET'),
  watchlist, watchlistMax: num('WATCHLIST_MAX', 20), timeframe, interval: INTERVALS[timeframe],
  // Phase 01 - VWAP + RSI
  rsiPeriod: num('RSI_PERIOD', 14), rsiBuyMin: num('RSI_BUY_MIN', 50), rsiBuyMax: num('RSI_BUY_MAX', 95), rsiExitLevel: num('RSI_EXIT_LEVEL', 45),
  backfill: bool('BACKFILL_ENABLED', true), historyCandles: num('HISTORY_CANDLES', 50), backfillLookbackDays: num('BACKFILL_LOOKBACK_DAYS', 7), vwapFallback: bool('VWAP_FALLBACK', true),
  continuation: bool('ENABLE_CONTINUATION', true), continuationMinCandles: num('CONTINUATION_MIN_CANDLES', 2), continuationMaxDistPct: num('CONTINUATION_MAX_DIST_PCT', 0.5),
  // Phase 02 - EMA
  emaMode: mode('EMA_MODE', 'required'), emaFast: num('EMA_FAST', 9), emaSlow: num('EMA_SLOW', 21),
  // Phase 03 - Volume
  volumeMode: mode('VOLUME_MODE', 'required'), volumeLookback: num('VOLUME_LOOKBACK', 20), volumeMinRvol: num('VOLUME_MIN_RVOL', 1.2),
  // Phase 04 - MACD
  macdMode: mode('MACD_MODE', 'required'), macdFast: num('MACD_FAST', 12), macdSlow: num('MACD_SLOW', 26), macdSignal: num('MACD_SIGNAL', 9), macdRequireZero: bool('MACD_REQUIRE_ZERO', false),
  atrPeriod: num('ATR_PERIOD', 14),
  // Phase 05 - Option chain, Phase 06 - OI + PCR
  optionMode: mode('OPTION_MODE', 'advisory'), oiMode: mode('OI_MODE', 'advisory'), optionMinRoomPct: num('OPTION_MIN_ROOM_PCT', 0.3),
  pcrBullish: num('PCR_BULLISH', 1.0), pcrBearish: num('PCR_BEARISH', 0.7),
  option: {
    enabled: bool('OPTION_CHAIN_ENABLED', true), strikesEachSide: Math.min(25, num('OPTION_STRIKES_EACH_SIDE', 10)), pollSeconds: Math.max(15, num('OPTION_POLL_SECONDS', 60)), expiry: raw('OPTION_EXPIRY') || 'nearest',
    oiCompareMinutes: num('OI_COMPARE_MINUTES', 30), oiMinBaselineMinutes: num('OI_MIN_BASELINE_MINUTES', 5),
    // Path is case-sensitive (OpenAPI_File). Angel One's two domains are both tried (your SCRIP_MASTER_URL first). SCRIP_MASTER_FILE = local copy.
    scripMasterUrl: [raw('SCRIP_MASTER_URL'), 'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json', 'https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json'].filter(Boolean),
    scripMasterFile: raw('SCRIP_MASTER_FILE'),
    quoteUrl: raw('QUOTE_URL') || 'https://apiconnect.angelone.in/rest/secure/angelbroking/market/v1/quote/'
  },
  // Phase 07 - AI market intelligence (regime filter + optional Claude review)
  aiMode: mode('AI_MODE', 'advisory'),
  ai: { reviewEnabled: bool('AI_REVIEW_ENABLED', true), apiKey: raw('ANTHROPIC_API_KEY'), model: raw('AI_MODEL') || 'claude-sonnet-5-5', url: raw('ANTHROPIC_URL') || 'https://api.anthropic.com/v1/messages', autoOnBuy: bool('AI_REVIEW_ON_BUY', true), minGapSeconds: num('AI_MIN_GAP_SECONDS', 60) },
  // Phase 08 - Risk management (model account, no orders)
  risk: {
    enabled: bool('RISK_ENABLED', true), capital: num('RISK_CAPITAL', 500000), riskPerTradePct: num('RISK_PER_TRADE_PCT', 1), atrStopMult: num('RISK_ATR_STOP_MULT', 1.5),
    minStopPct: num('RISK_MIN_STOP_PCT', 0.15), maxStopPct: num('RISK_MAX_STOP_PCT', 2), rewardRisk: num('RISK_REWARD', 2), trailStartR: num('RISK_TRAIL_START_R', 1), trailMult: num('RISK_TRAIL_MULT', 1),
    maxDailyLossPct: num('RISK_MAX_DAILY_LOSS_PCT', 3), maxTradesPerDay: num('RISK_MAX_TRADES_PER_DAY', 3), maxOpen: num('RISK_MAX_OPEN', 2), cooldownCandles: num('RISK_COOLDOWN_CANDLES', 2),
    maxLeverage: num('RISK_MAX_LEVERAGE', 1), optionDelta: num('RISK_OPTION_DELTA', 0.5),
    noEntryBeforeMin: hhmm('RISK_NO_ENTRY_BEFORE', '09:20'), noEntryAfterMin: hhmm('RISK_NO_ENTRY_AFTER', '14:45'), squareOffMin: hhmm('RISK_SQUARE_OFF', '15:15')
  }
};
cfg.risk.noEntryBeforeMin ??= 0; cfg.risk.noEntryAfterMin ??= 24 * 60;
module.exports = cfg;
