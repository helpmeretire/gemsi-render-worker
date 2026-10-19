// AI Text Tools — paid (x402) text summarization, extraction and classification for AI agents.
// Runs on Cloudflare Workers AI (Llama 3.3 70B, Qwen 2.5 32B fallback). No API keys, no rate limits:
// agents pay per call in USDC on Base and are only charged when a valid result is returned.
// Settings (Cloudflare Worker > Settings > Variables and Secrets / Bindings):
//   AI                  (required) Workers AI binding (wrangler.toml: [ai] binding = "AI")
//   PAY_TO              (optional) Base wallet address that receives USDC (defaults to DEFAULT_PAY_TO)
//   CDP_API_KEY_ID      (optional) Coinbase Developer Platform API key id   -> enables Bazaar listing
//   CDP_API_KEY_SECRET  (optional, Secret) Coinbase Developer Platform API key secret
// Without the CDP keys the service uses the keyless PayAI facilitator.

const DEFAULT_PAY_TO = "0x6f762720b8515b7091e6aa69e8361f7b9909233f"; // Mick's Base wallet
const NETWORK = "eip155:8453"; // Base mainnet
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CDP_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
const PAYAI_URL = "https://facilitator.payai.network";
const SERVICE = "AI Text Tools";
const DESCRIPTION =
  "Pay-per-call text intelligence for agents: summarize any text (paragraph, bullets or TL;DR, in any language), extract named fields into strict JSON (null for anything not in the text, nothing invented), or classify text into your own labels. Up to 24,000 characters per call. You are only charged when a valid result is returned.";

const PRIMARY_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const FALLBACK_MODEL = "@cf/qwen/qwen2.5-coder-32b-instruct";
const TEMPERATURE = 0.2;
const MAX_TEXT_CHARS = 24000; // hard cap on input text; longer -> 413 before any payment work
const MAX_REQUEST_BYTES = 256 * 1024; // POST bodies larger than this are rejected with 413 immediately
const MAX_FIELDS = 20;
const MAX_LABELS = 20;
const MAX_FIELD_NAME_CHARS = 64;
const MAX_FIELD_DESC_CHARS = 300;
const MAX_LABEL_CHARS = 100;
const MAX_INSTRUCTIONS_CHARS = 1000;

// Per-route prices in USDC atomic units (6 decimals) and model output budgets.
const ROUTES = {
  "/summarize": { name: "summarize", price: "5000", usd: "0.005000", max_tokens: 400 },
  "/extract": { name: "extract", price: "5000", usd: "0.005000", max_tokens: 800 },
  "/classify": { name: "classify", price: "2000", usd: "0.002000", max_tokens: 60 },
};
const STYLES = ["paragraph", "bullets", "tldr"];
const CONFIDENCE = ["high", "medium", "low"];

