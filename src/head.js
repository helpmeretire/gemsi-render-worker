// NoJunk Web Read — a paid (x402) web page reader for AI agents.
// Fetches one public web page and returns its title, metadata, clean readable text,
// Markdown and links as JSON. No API keys, no rate limits: agents pay per call.
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
const SERVICE = "NoJunk Web Read";
const DESCRIPTION =
  "Read any public web page as clean JSON: title, description, site name, publish date, language, readable text (boilerplate removed), Markdown and the page's links. Give it a URL, get the content back in one call. HTML, plain text, JSON and XML pages supported.";

const USER_AGENT = "NoJunk Web Read/1.0 (+https://nojunkcrypto.com)";
const ACCEPT = "text/html, application/xhtml+xml, text/plain, application/json, application/xml, text/xml;q=0.9, */*;q=0.1";
const TIMEOUT_MS = 8000; // whole upstream fetch (all redirects + body) must finish within this
const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 3 * 1024 * 1024; // 3 MB of upstream body is read, the rest is dropped
const MAX_TEXT_CHARS = 60000; // text / markdown are capped here; truncated=true when cut
const MAX_LINKS = 50;
const MAX_URL_LENGTH = 2048;
const MAX_REQUEST_BYTES = 16 * 1024; // POST bodies larger than this are rejected with 413

