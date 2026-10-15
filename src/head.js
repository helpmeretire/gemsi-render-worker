// FX Reference Rates — a paid (x402) currency exchange rate service for AI agents.
// Data: European Central Bank euro foreign exchange reference rates (daily + last 90 days).
// Settings (Cloudflare Worker > Settings > Variables and Secrets):
//   PAY_TO              (optional) Base wallet address that receives USDC (defaults to DEFAULT_PAY_TO)
//   CDP_API_KEY_ID      (optional) Coinbase Developer Platform API key id   -> enables Bazaar listing
//   CDP_API_KEY_SECRET  (optional, Secret) Coinbase Developer Platform API key secret
// Without the CDP keys the service uses the keyless PayAI facilitator.

const DEFAULT_PAY_TO = "0x6f762720b8515b7091e6aa69e8361f7b9909233f"; // Mick's Base wallet
const PRICE_ATOMIC = "3000"; // $0.003 in USDC (6 decimals)
const NETWORK = "eip155:8453"; // Base mainnet
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CDP_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
const PAYAI_URL = "https://facilitator.payai.network";
const SERVICE = "FX Reference Rates";
const DESCRIPTION =
  "Currency exchange rates from the European Central Bank's official euro reference rates: convert an amount from one ISO 4217 currency to up to 30 others, today or on any date in the last 90 days. Cross rates computed via EUR.";

const ECB_DAILY = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
const ECB_HIST = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml";
const ECB_INFO = "https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html";
const SOURCE = "European Central Bank euro foreign exchange reference rates";
const DISCLAIMER =
  "These reference rates are for information purposes only and are published free of charge by the ECB at https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html. Cross rates are calculated from ECB euro rates and are not official ECB rates.";
// Currencies in the ECB reference-rate basket (plus EUR itself).
const SUPPORTED = ["EUR", "USD", "JPY", "CZK", "DKK", "GBP", "HUF", "PLN", "RON", "SEK", "CHF", "ISK", "NOK", "TRY", "AUD", "BRL", "CAD", "CNY", "HKD", "IDR", "ILS", "INR", "KRW", "MXN", "MYR", "NZD", "PHP", "SGD", "THB", "ZAR"];
const MAX_TO = 30;
const CACHE_SECONDS = 3600;

