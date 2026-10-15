// NoJunk Image — paid (x402) image generation and image description for AI agents.
// Runs on Cloudflare Workers AI (FLUX.1 [schnell] for generation; LLaVA 1.5 7B with a uform-gen2 fallback
// for description). No API keys, no rate limits: agents pay per call in USDC on Base and are only charged
// when a valid result is returned.
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
const SERVICE = "NoJunk Image";
const DESCRIPTION =
  "Pay-per-call image intelligence for agents: generate an image from a text prompt (FLUX.1 schnell, PNG bytes or base64 JSON), or describe any image you point at by URL or base64 (LLaVA 1.5 7B, answers your own question about the picture). You are only charged when a valid result is returned.";
const USER_AGENT = "NoJunk Image/1.0 (+https://nojunkcrypto.com)";

const GENERATE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
const DESCRIBE_MODEL = "@cf/llava-hf/llava-1.5-7b-hf";
const DESCRIBE_FALLBACK_MODEL = "@cf/unum/uform-gen2-qwen-500m";

const MIN_PROMPT_CHARS = 3;
const MAX_PROMPT_CHARS = 1500;
const DEFAULT_STEPS = 4;
const MAX_STEPS = 8;
const MAX_QUESTION_CHARS = 500;
const DEFAULT_QUESTION = "Describe this image in detail.";
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // decoded image fed to the describe model
const MAX_IMAGE_URL_CHARS = 2048;
const IMAGE_FETCH_TIMEOUT_MS = 15000;
const IMAGE_FETCH_MAX_REDIRECTS = 3;
const DESCRIBE_MAX_TOKENS = 512;
const FORMATS = ["png", "json"];

// Per-route prices in USDC atomic units (6 decimals) and request-body caps (413 before any payment work).
const ROUTES = {
  "/generate": { name: "generate", price: "10000", usd: "0.010000", max_request_bytes: 8 * 1024 },
  "/describe": { name: "describe", price: "5000", usd: "0.005000", max_request_bytes: 14 * 1024 * 1024 },
};

// Prompt blocklist: any "minor" term together with any "sexual" term, or a standalone term, -> 400 "prompt not allowed" (no charge).
const MINOR_TERMS = ["child", "children", "kid", "kids", "minor", "minors", "teen", "teens", "teenager", "teenagers", "underage", "toddler", "toddlers", "infant", "infants", "baby", "babies", "boy", "boys", "girl", "girls", "preteen", "preteens", "schoolgirl", "schoolgirls", "schoolboy", "schoolboys", "loli", "lolita", "shota", "youth", "juvenile", "daughter", "son", "niece", "nephew"];
const SEXUAL_TERMS = ["nude", "nudes", "nudity", "naked", "nsfw", "sex", "sexy", "sexual", "sexualized", "sexualised", "porn", "porno", "pornographic", "erotic", "erotica", "explicit", "topless", "bottomless", "lingerie", "undress", "undressed", "undressing", "genital", "genitals", "genitalia", "penis", "vagina", "breasts", "boobs", "orgasm", "masturbat", "hentai", "xxx", "intercourse", "fellatio", "blowjob", "seductive", "lewd", "fetish", "bondage", "panties", "thong", "stripper"];
const STANDALONE_BLOCKED = ["loli", "lolicon", "shota", "shotacon", "pedo", "pedophile", "paedophile", "child porn", "cp porn", "jailbait"];
