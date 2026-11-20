# Angel One VWAP + RSI Signal Terminal

A clean, local-first web dashboard that backfills Angel One SmartAPI history, streams live ticks and produces rule-based BUY / HOLD / EXIT / WAIT signals using **only session VWAP and RSI**. It does not place orders.

## Folder structure

```text
angelone-vwap-rsi/
├── backend/
│   ├── .env.example
│   ├── package.json
│   └── src/
│       ├── angelone.js       # SmartAPI login + WebSocket V2
│       ├── candles.js        # IST-aligned candle builder (seedable)
│       ├── engine.js         # backfill + replay + live state + position tracking
│       ├── config.js         # Environment configuration
│       ├── indicators.js     # VWAP + Wilder RSI only
│       ├── server.js         # Express API + SSE stream
│       ├── filters.js        # phases 02-07 confirmation checks
│       ├── risk.js           # phase 08 risk engine
│       ├── options.js        # phases 05-06 option chain, OI, PCR
│       ├── ai.js             # phase 07 regime + Claude review
│       └── strategy.js       # BUY / HOLD / EXIT / WAIT rules + condition checks
│   └── test/sim.js           # offline tests
├── frontend/
│   ├── app.js
│   ├── index.html
│   └── style.css
└── README.md
```

## Requirements

- Node.js 20 or newer
- Angel One SmartAPI access and market-data WebSocket permission
- Angel One API key, client code, PIN/password and TOTP secret
- Instrument tokens for the NSE index/instruments you want to monitor

## Windows setup (PowerShell)

1. Open the `backend` folder:

   ```powershell
   cd .\backend
   Copy-Item .env.example .env
   notepad .env
   ```

2. Add your Angel One credentials and replace the sample `WATCHLIST` tokens with valid NSE instrument tokens from Angel One's current scrip master. Format:

   ```env
   WATCHLIST=NIFTY:your_nifty_token,BANKNIFTY:your_banknifty_token
   ```

   The WebSocket subscription in this starter is configured for NSE instruments (`exchangeType: 1`). Use NSE index tokens or NSE cash instruments. This build does not subscribe to NFO option contracts.

3. Install and start:

   ```powershell
   npm install
   npm start
   ```

4. Open `http://127.0.0.1:8787` in your browser. Keep the backend terminal running.

## How data flows (history + live)

1. **Login**, then **backfill** each watchlist symbol with SmartAPI `getCandleData` (last `BACKFILL_LOOKBACK_DAYS` days).
2. Keep **today's full session** (VWAP needs 09:15 onward) plus **`HISTORY_CANDLES` (default 50) earlier candles** as RSI warm-up. RSI is valid on the very first live candle, no waiting.
3. The session is **replayed** through the strategy to rebuild the model position. Those past signals appear in the log tagged `BACKFILL`; they are not live alerts.
4. The WebSocket then streams ticks. Live candles continue the same series; candles also close on a timer, so a quiet symbol or the 15:25 candle doesn't wait for another tick.

The dashboard works after market hours too: it shows the last session computed from history.

## Watchlist (add symbols from the dashboard)

Type or paste a symbol (`RELIANCE`, `TCS-EQ`, `NIFTY`, `Nifty Bank`) or a token into the search box above the watchlist and press **Enter** (or click a result). The backend looks the token up in Angel One's instrument master, then backfills history, subscribes the live feed, sets up option-chain data if the symbol has options, and saves it. The **×** on a row removes it (an open model position for that symbol is discarded). Changes persist in `backend/data/watchlist.json`; `WATCHLIST` in `.env` only seeds the first run. Limits: NSE equities (`-EQ`) and NSE indices only, `WATCHLIST_MAX` (default 20) symbols, and adding is available once the dashboard shows CONNECTED. The first search downloads the instrument master (a large file, cached for the day). Two Angel One URLs are tried automatically; if both fail (404, firewall), download `OpenAPIScripMaster.json` in a browser and set `SCRIP_MASTER_FILE` in `.env` to its path (or `SCRIP_MASTER_URL` to a working link).

## Phases

| # | Phase | Role | Default |
|---|---|---|---|
| 01 | VWAP + RSI | Core entry/exit rules (below) | always on |
| 02 | EMA confirmation | EMA 9 above EMA 21, close above EMA 21, EMA 21 rising | required |
| 03 | Volume analysis | Relative volume ≥ 1.2x of 20-candle average, up-candle. NA for indices (no volume) | required |
| 04 | MACD confirmation | MACD above signal, histogram rising (optional zero-line) | required |
| 05 | Option-chain intelligence | ATM, ATM straddle (expected move), call wall / put wall, room below the call wall | advisory |
| 06 | OI + PCR analysis | Window PCR bias, OI buildup/unwinding around ATM vs a rolling baseline | advisory |
| 07 | AI market intelligence | Local regime read (trend / range / choppy / volatile) + optional Claude review | advisory |
| 08 | Risk management engine | ATR stop, R-multiple target, breakeven/trailing, sizing, entry gates, daily loss halt, square-off | enforced |

Each of 02-07 has a mode: `off`, `advisory` (shown, never vetoes) or `required` (a FAIL vetoes the BUY). The core setup can be valid while confirmations fail: the dashboard shows WAIT with `SETUP · UNCONFIRMED` and says which filter failed. A check that cannot be measured (no volume on an index, no option data, history backfill) is `NA` and never vetoes. Candle indicators that are still warming up fail closed.

## Signal rules (evaluated on candle close; the forming candle is shown as provisional)

| State | Rule |
|---|---|
| **BUY (A: crossover)** | Close above session VWAP, previous close at/below VWAP, RSI inside 50-95 and rising, plus all `required` confirmations, plus the risk gate |
| **BUY (B: continuation)** *(optional)* | Same, but no fresh cross: already above VWAP for `CONTINUATION_MIN_CANDLES` closes and no more than `CONTINUATION_MAX_DIST_PCT`% above VWAP |
| **BLOCKED** | The rules want a BUY but the risk engine vetoed it (time window, daily loss, trades/day, open positions, cooldown, stop too wide, size < 1). Nothing is opened |
| **HOLD** | Model position open, still above VWAP, RSI >= 45, no stop/target hit |
| **EXIT** | Only with an open position: `STOP_LOSS`, `TRAIL_STOP`, `TARGET`, `SQUARE_OFF`, or rule exit (close below VWAP / RSI < 45) |
| **WAIT** | Everything else. The reason lists what failed |

## Risk engine (phase 08)

A *model account*: it never places orders. Each BUY gets a plan: stop = entry - ATR x 1.5 (floor `RISK_MIN_STOP_PCT`), target = entry + 2R, size = `RISK_PER_TRADE_PCT` of `RISK_CAPITAL` divided by the stop distance. After +1R the stop moves to breakeven and trails by 1R. Live, stops/targets are checked on every tick; in backfill replay they are checked per candle (if stop and target fall in one candle the stop is assumed first). Realised P&L feeds the daily loss halt. For index symbols "units" are only a sizing reference; with option data the plan also shows an approximate lot count assuming ATM delta 0.5. Positions are intraday and reset each day.

## Option chain, OI and PCR (phases 05-06)

At startup the scrip master is downloaded once per day (filtered copy cached in `backend/.cache/`) to find NFO option tokens. Every `OPTION_POLL_SECONDS` (market hours only) the nearest-expiry ATM ± `OPTION_STRIKES_EACH_SIDE` strikes are quoted in FULL mode (LTP + OI). Only symbols that have NFO options (e.g. NIFTY, BANKNIFTY, stocks) get data; others show `NO DATA`. The quote API has no "previous OI", so OI change is measured against our own snapshots from ~30 minutes ago (needs ≥ 5 minutes of running). Walls and PCR cover the fetched window, not the whole chain. The OI-flow bias is a heuristic (call premium up / put premium down = bullish, weighted by whether OI rose), where equal time decay on both sides cancels out. Option phases are `NA` during history backfill because past chain snapshots aren't available.

## AI (phase 07)

The regime read is local and deterministic. The Claude review is optional: set `ANTHROPIC_API_KEY` and it runs on every live BUY (rate-limited) or via the **Ask Claude** button. It receives indicator values, check results and the chain summary (no credentials) and returns a stance (SUPPORTS / CAUTION / CONTRADICTS), concerns and things to watch. It is advisory only and never changes a signal or position.

## Configuration

See `backend/.env.example` (all phases are documented there). Phase 01 backfill options: `BACKFILL_ENABLED`, `HISTORY_CANDLES`, `BACKFILL_LOOKBACK_DAYS`, `VWAP_FALLBACK`, `ENABLE_CONTINUATION`, `CONTINUATION_MIN_CANDLES`, `CONTINUATION_MAX_DIST_PCT`. `TIMEFRAME` must be 1, 3, 5, 10, 15, 30 or 60.

## Tests (no credentials needed)

```powershell
cd backend
npm test
```

44 checks (incl. watchlist search/add/remove/persistence): RSI/EMA/MACD/ATR against references, VWAP day reset, backfill + live continuity, filter modes and vetoes, option analytics and OI flow, regime, Claude request/parse (mocked), risk sizing/gates/stops/trailing, and full engine replay (BUY → EXIT, P&L ledger, daily-loss block, tick-level stop).

## API

- `GET /api/health`
- `GET /api/snapshot`
- `GET /api/events` — Server-Sent Events for live dashboard updates
- `GET /api/search?q=` — symbol search · `POST /api/watchlist` `{symbol|token}` · `DELETE /api/watchlist/:symbol`
- `POST /api/backfill` — re-fetch history (e.g. after a feed drop)
- `GET /api/risk` — model account summary · `GET /api/chain/:symbol` — option-chain summary
- `POST /api/ai/review` `{symbol}` — Claude review · `GET /api/ai/:symbol` — last review

## Important limitations / safety

- This is a **signal dashboard**, not an automated trading bot. No order placement endpoint or auto-execution is included.
- Signals are calculated on the configured underlying NSE instruments. They do not automatically select an option strike, expiry, or lot size.
- **Indices have no volume.** NSE index tokens (NIFTY, BANKNIFTY) report zero volume, so a true VWAP is impossible. With `VWAP_FALLBACK=true` the dashboard uses the session average of typical price and says so. For a real VWAP use a volume-bearing NSE instrument (e.g. an index ETF or stock).
- Backfill and live candles come from different feeds, so tiny OHLC/volume differences versus Angel One charts are normal. The ticks received between the backfill call and the first live tick are not in the forming candle.
- Ticks outside 09:15-15:30 IST are ignored (pre-open would otherwise distort VWAP).
- Verify the SmartAPI tick field format and instrument tokens against your account and current Angel One API documentation. If volume is missing or cumulative volume resets, VWAP volume weighting may be incomplete until a valid session feed is received.
- Test with paper trades and compare against Angel One charts before relying on alerts. This is not investment advice and no signal guarantees profit.
- Keep `.env` private. Never share API keys, PINs, or TOTP secrets.
