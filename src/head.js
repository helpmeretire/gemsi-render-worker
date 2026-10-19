// Stock Quotes — paid (x402) market data for AI agents: quotes, OHLCV history and computed statistics.
// Four routes, each priced separately in USDC on Base per successful call:
//   /quote   $0.001  one symbol -> latest price, change, day range, volume, 52-week range
//   /quotes  $0.003  up to 20 symbols in one call (fetched in parallel)
//   /history $0.002  OHLCV candles for a range/interval plus dividends, splits and a summary
//   /stats   $0.002  returns, annualized volatility, max drawdown, SMA 20/50/200, RSI 14, 52-week distance, 30-day volume
// Symbols: stocks (AAPL, BRK-B), ETFs (SPY), indices (^GSPC), crypto (BTC-USD), FX (EURUSD=X), futures (GC=F).
// Data: Yahoo Finance public chart endpoint (keyless). No API keys, no rate limits for callers.
// Settings (Cloudflare Worker > Settings > Variables and Secrets):
//   PAY_TO              (optional) Base wallet address that receives USDC (defaults to DEFAULT_PAY_TO)
//   CDP_API_KEY_ID      (optional) Coinbase Developer Platform API key id   -> enables Bazaar listing
//   CDP_API_KEY_SECRET  (optional, Secret) Coinbase Developer Platform API key secret
// Without the CDP keys the service uses the keyless PayAI facilitator.

const DEFAULT_PAY_TO = "0x6f762720b8515b7091e6aa69e8361f7b9909233f"; // Mick's Base wallet
const NETWORK = "eip155:8453"; // Base mainnet
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CDP_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
const PAYAI_URL = "https://facilitator.payai.network";
const SERVICE = "Stock Quotes";
const DESCRIPTION =
  "Stock, ETF, index, FX and commodity quotes, OHLCV history and computed statistics (returns, volatility, drawdown, RSI, moving averages). Pay per call with USDC on Base (x402). No API key.";

// Per-route prices in USDC atomic units (6 decimals) and as a decimal USD string for OpenAPI.
const ROUTES = {
  "/quote": { name: "quote", price: "1000", usd: "0.001000", label: "$0.001" },
  "/quotes": { name: "quotes", price: "3000", usd: "0.003000", label: "$0.003" },
  "/history": { name: "history", price: "2000", usd: "0.002000", label: "$0.002" },
  "/stats": { name: "stats", price: "2000", usd: "0.002000", label: "$0.002" },
};

const YAHOO_HOSTS = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]; // second host is the fallback
const UPSTREAM_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 NoJunk Stocks/1.0 (+https://nojunkcrypto.com)";
const TIMEOUT_MS = 8000; // each upstream attempt must finish within this
const SOURCE = "Yahoo Finance";
const NOTICE = "Data provided for informational use only, not investment advice. Quotes may be delayed by the exchange.";

const SYMBOL_RE = /^[A-Z0-9.^=-]{1,12}$/;
const MAX_SYMBOLS = 20;
const MAX_REQUEST_BYTES = 16 * 1024; // POST bodies larger than this are rejected with 413
const RANGES = ["1d", "5d", "1mo", "3mo", "6mo", "1y", "2y", "5y", "max"];
const INTERVALS = ["1m", "5m", "15m", "1h", "1d", "1wk", "1mo"];
const INTRADAY = ["1m", "5m", "15m", "1h"];
const MINUTE_RANGES = ["1d", "5d"]; // 1m bars: Yahoo keeps 7 days
const INTRADAY_RANGES = ["1d", "5d", "1mo"]; // other intraday bars: Yahoo keeps 60 days
const DEFAULT_RANGE = "1mo";
const DEFAULT_INTERVAL = "1d";
const STATS_RANGE = "1y", STATS_INTERVAL = "1d";
const QUOTE_RANGE = "1d", QUOTE_INTERVAL = "1m";

// Cache TTLs (caches.default, keyed by upstream URL) so bursts of identical calls do not hammer Yahoo.
const CACHE_TTL_1M_S = 15;
const CACHE_TTL_INTRADAY_S = 60;
const CACHE_TTL_DAILY_S = 300;

// Stats parameters
const TRADING_DAYS_PER_YEAR = 252;
const RSI_PERIOD = 14;
const SMA_PERIODS = [20, 50, 200];
const AVG_VOLUME_DAYS = 30;
const RETURN_WINDOWS = { "1w": 7, "1m": 30, "3m": 91, "6m": 182, "1y": 365 }; // calendar days back
const RETURN_TOLERANCE_DAYS = 10; // earliest bar may be at most this far after the lookback target

// Free operator probe (/health/data) fetches this symbol's meta.
const HEALTH_SYMBOL = "^GSPC";
