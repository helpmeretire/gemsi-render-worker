// Text Moderation — paid (x402) content moderation and text analysis for AI agents.
// Runs on Cloudflare Workers AI (DistilBERT sentiment, Llama Guard 3, BGE reranker, Llama 3.3 70B).
// No API keys, no rate limits: agents pay per call in USDC on Base and are only charged when a valid result is returned.
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
const SERVICE = "Text Moderation";
const DESCRIPTION =
  "Content moderation and text analysis: sentiment, safety classification (14 harm categories), semantic reranking, PII detection and redaction, language detection. Pay per call with USDC on Base (x402). No API key.";

const SENTIMENT_MODEL = "@cf/huggingface/distilbert-sst-2-int8";
const SAFETY_MODEL = "@cf/meta/llama-guard-3-8b";
const RERANK_MODEL = "@cf/baai/bge-reranker-base";
const LLM_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const MAX_TEXT_CHARS = 20000; // per text input (and combined for safety messages); longer -> 400, no payment work
const MAX_REQUEST_BYTES = 128 * 1024; // request bodies larger than this -> 413 before any payment work
const MAX_TEXTS = 50; // sentiment / language batch size
const MAX_MESSAGES = 20; // safety conversation length
const MAX_DOCUMENTS = 100; // rerank documents and top_k ceiling
const MAX_QUERY_CHARS = 2000; // rerank query
const MAX_DOC_ID_CHARS = 128;
const LANGUAGE_SAMPLE_CHARS = 2000; // language detection only needs the start of a text
const LLM_PII_MAX_TOKENS = 1200;
const LLM_LANG_MAX_TOKENS = 120;

// Per-route prices in USDC atomic units (6 decimals).
const ROUTES = {
  "/sentiment": { name: "sentiment", price: "1000", usd: "0.001000" },
  "/safety": { name: "safety", price: "2000", usd: "0.002000" },
  "/rerank": { name: "rerank", price: "2000", usd: "0.002000" },
  "/pii": { name: "pii", price: "3000", usd: "0.003000" },
  "/language": { name: "language", price: "1000", usd: "0.001000" },
};

// Llama Guard 3 hazard taxonomy.
const SAFETY_CATEGORIES = {
  S1: "Violent Crimes", S2: "Non-Violent Crimes", S3: "Sex-Related Crimes", S4: "Child Sexual Exploitation", S5: "Defamation",
  S6: "Specialized Advice", S7: "Privacy", S8: "Intellectual Property", S9: "Indiscriminate Weapons", S10: "Hate",
  S11: "Suicide & Self-Harm", S12: "Sexual Content", S13: "Elections", S14: "Code Interpreter Abuse",
};
const SAFETY_ROLES = ["user", "assistant"];

// PII types: regex types are detected deterministically in the Worker; llm types use Llama 3.3 with a JSON schema.
const PII_REGEX_TYPES = ["email", "phone", "ssn", "credit_card", "ip", "iban", "crypto_address"];
const PII_LLM_TYPES = ["name", "address", "date_of_birth", "passport"];
const PII_TYPES = [...PII_REGEX_TYPES, ...PII_LLM_TYPES];
// When spans overlap, the type earlier in this list wins (longer structured identifiers before loose ones).
const PII_PRIORITY = ["iban", "credit_card", "crypto_address", "email", "ssn", "phone", "ip", "passport", "date_of_birth", "address", "name"];

// ISO 639-1 codes -> English names (codes outside this list are still returned, with name null).
const LANGUAGE_NAMES = {
  af: "Afrikaans", am: "Amharic", ar: "Arabic", az: "Azerbaijani", be: "Belarusian", bg: "Bulgarian", bn: "Bengali", bs: "Bosnian", ca: "Catalan", cs: "Czech",
  cy: "Welsh", da: "Danish", de: "German", el: "Greek", en: "English", eo: "Esperanto", es: "Spanish", et: "Estonian", eu: "Basque", fa: "Persian",
  fi: "Finnish", fil: "Filipino", fr: "French", ga: "Irish", gl: "Galician", gu: "Gujarati", ha: "Hausa", he: "Hebrew", hi: "Hindi", hr: "Croatian",
  hu: "Hungarian", hy: "Armenian", id: "Indonesian", is: "Icelandic", it: "Italian", ja: "Japanese", jv: "Javanese", ka: "Georgian", kk: "Kazakh", km: "Khmer",
  kn: "Kannada", ko: "Korean", ku: "Kurdish", ky: "Kyrgyz", la: "Latin", lb: "Luxembourgish", lo: "Lao", lt: "Lithuanian", lv: "Latvian", mk: "Macedonian",
  ml: "Malayalam", mn: "Mongolian", mr: "Marathi", ms: "Malay", mt: "Maltese", my: "Burmese", ne: "Nepali", nl: "Dutch", no: "Norwegian", pa: "Punjabi",
  pl: "Polish", ps: "Pashto", pt: "Portuguese", ro: "Romanian", ru: "Russian", sd: "Sindhi", si: "Sinhala", sk: "Slovak", sl: "Slovenian", so: "Somali",
  sq: "Albanian", sr: "Serbian", sv: "Swedish", sw: "Swahili", ta: "Tamil", te: "Telugu", tg: "Tajik", th: "Thai", tl: "Tagalog", tr: "Turkish",
  uk: "Ukrainian", ur: "Urdu", uz: "Uzbek", vi: "Vietnamese", xh: "Xhosa", yi: "Yiddish", yo: "Yoruba", zh: "Chinese", zu: "Zulu", und: "Undetermined",
};
