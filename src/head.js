// Web Search — a paid (x402) web search API for AI agents.
// Runs one web search (DuckDuckGo lite HTML, parsed in-worker, no libs) and returns up to
// 10 results {rank, title, url, domain, snippet} as JSON. No API keys, no rate limits: agents pay per call.
// Settings (Cloudflare Worker > Settings > Variables and Secrets):
//   PAY_TO              (optional) Base wallet address that receives USDC (defaults to DEFAULT_PAY_TO)
//   CDP_API_KEY_ID      (optional) Coinbase Developer Platform API key id   -> enables Bazaar listing
//   CDP_API_KEY_SECRET  (optional, Secret) Coinbase Developer Platform API key secret
// Without the CDP keys the service uses the keyless PayAI facilitator.

const DEFAULT_PAY_TO = "0x6f762720b8515b7091e6aa69e8361f7b9909233f"; // Mick's Base wallet
const PRICE_ATOMIC = "2000"; // $0.002 in USDC (6 decimals)
const NETWORK = "eip155:8453"; // Base mainnet
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CDP_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
const PAYAI_URL = "https://facilitator.payai.network";
const SERVICE = "Web Search";
const DESCRIPTION =
  "Cheap web search for AI agents: give it a query, get up to 10 live web results back as JSON (rank, title, url, domain, snippet). Optional region (e.g. us-en) and safe-search level. Sources tried in order: DuckDuckGo, Bing, Yahoo. Results link to the live web; pair with a /read service to fetch the pages.";

// Sources are tried in this order; the first one that yields at least one organic result wins.
const DDG_URL = "https://lite.duckduckgo.com/lite/";
const BING_URL = "https://www.bing.com/search";
const YAHOO_URL = "https://search.yahoo.com/search";
// The engines serve plain HTML pages to browser-like clients; this UA is what they expect.
const UPSTREAM_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const TIMEOUT_MS = 8000; // each upstream fetch must finish within this
const CACHE_TTL_S = 120; // upstream HTML cached in caches.default for this long, keyed by the upstream URL
const MAX_QUERY_CHARS = 400;
const MAX_COUNT = 10;
const DEFAULT_COUNT = 10;
const MAX_REQUEST_BYTES = 16 * 1024; // POST bodies larger than this are rejected with 413
const SAFE_LEVELS = { strict: "1", moderate: "-1", off: "-2" }; // DDG kp values
const HEALTH_QUERY = "cloudflare workers";
