// NoJunk LLM — paid (x402) OpenAI-compatible chat completions and embeddings for AI agents.
// Runs on Cloudflare Workers AI (Llama 3.3 70B, Qwen 2.5 Coder 32B, BGE-M3). No API keys, no rate limits:
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
const SERVICE = "NoJunk LLM";
const DESCRIPTION =
  "Pay-per-call, OpenAI-compatible LLM API for agents: POST /v1/chat/completions (Llama 3.3 70B or Qwen 2.5 Coder 32B, up to 32,000 characters of messages, up to 1,024 output tokens, optional JSON mode) and POST /v1/embeddings (BGE-M3, 1,024 dimensions, up to 32 inputs per call). Point any OpenAI client at this base URL and pay per request in USDC on Base via x402: no API key, no account, no rate limits. You are only charged when a valid result is returned.";

// Chat model names accepted in the request body -> Workers AI model ids.
const CHAT_MODELS = {
  "llama-3.3-70b": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "qwen2.5-coder-32b": "@cf/qwen/qwen2.5-coder-32b-instruct",
};
const DEFAULT_CHAT_MODEL = "llama-3.3-70b";
const CHAT_MODEL_ALIASES = { "gpt-4o-mini": DEFAULT_CHAT_MODEL, default: DEFAULT_CHAT_MODEL, "": DEFAULT_CHAT_MODEL };
const EMBED_MODEL_NAME = "bge-m3";
const EMBED_MODEL = "@cf/baai/bge-m3";
const EMBED_DIMS = 1024;

const MAX_REQUEST_BYTES = 160 * 1024; // POST bodies larger than this are rejected with 413 immediately
const MAX_CHAT_CHARS = 32000; // total characters across all message contents
const MAX_MESSAGES = 200;
const MAX_TOKENS_DEFAULT = 512;
const MAX_TOKENS_CAP = 1024;
const DEFAULT_TEMPERATURE = 0.7;
const MAX_EMBED_ITEMS = 32;
const MAX_EMBED_CHARS = 8000; // per input string
const ROLES = ["system", "user", "assistant"];

// Per-route prices in USDC atomic units (6 decimals).
const ROUTES = {
  "/v1/chat/completions": { name: "chat", price: "5000", usd: "0.005000" },
  "/v1/embeddings": { name: "embeddings", price: "1000", usd: "0.001000" },
};
