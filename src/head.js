// Speech — paid (x402) speech-to-text, text-to-speech and translation for AI agents.
// Runs on Cloudflare Workers AI (Whisper large-v3-turbo, Deepgram Aura-1, Meta M2M100 1.2B). No API keys,
// no rate limits: agents pay per call in USDC on Base and are only charged when a valid result is returned.
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
const SERVICE = "Speech";
const DESCRIPTION =
  "Pay-per-call speech and language tools for agents: transcribe audio (URL or base64, up to 20 MB / about 10 minutes) to text with timestamps and detected language, turn text into natural MP3 speech, or translate text between 100 languages. USDC on Base via x402; you are only charged when a valid result is returned.";
const USER_AGENT = "NoJunk Speech/1.0 (+https://nojunkcrypto.com)";

const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";
const TTS_MODEL = "@cf/deepgram/aura-1";
const MT_MODEL = "@cf/meta/m2m100-1.2b";

// Per-route prices in USDC atomic units (6 decimals) and request-body caps (413 above, before any payment work).
const ROUTES = {
  "/transcribe": { name: "transcribe", price: "20000", usd: "0.020000", max_request_bytes: 28 * 1024 * 1024 },
  "/speak": { name: "speak", price: "10000", usd: "0.010000", max_request_bytes: 64 * 1024 },
  "/translate": { name: "translate", price: "2000", usd: "0.002000", max_request_bytes: 64 * 1024 },
};

// /transcribe limits
const MAX_AUDIO_BYTES = 20 * 1024 * 1024; // decoded audio, from URL or base64
const AUDIO_FETCH_TIMEOUT_MS = 20000; // whole audio download (redirects + body)
const MAX_AUDIO_REDIRECTS = 3;
const MAX_URL_LENGTH = 2048;
const AUDIO_TYPES_EXTRA = ["video/mp4", "video/webm", "video/mpeg", "video/quicktime", "application/octet-stream", "application/ogg", "application/x-wav"]; // plus any audio/*
// /speak limits
const MAX_SPEAK_CHARS = 400;
// @cf/deepgram/aura-1 now takes bare voice names (enum angus, asteria, ...); the old
// "aura-<voice>-en" names are rejected with Workers AI error 5006. Callers may send either
// form; it is normalized to the bare name before the model call.
const DEFAULT_SPEAKER = "asteria";
const SPEAKERS = ["asteria", "luna", "stella", "athena", "hera", "orion", "arcas", "perseus", "angus", "orpheus", "helios", "zeus"];
const LEGACY_SPEAKERS = SPEAKERS.map((s) => `aura-${s}-en`);
const SPEAKERS_ACCEPTED = [...SPEAKERS, ...LEGACY_SPEAKERS];
// "aura-asteria-en" / "Asteria" / "asteria" -> "asteria"; null when not a known voice.
function normalizeSpeaker(v) {
  const s = String(v).trim().toLowerCase();
  const m = /^aura-([a-z]+)-en$/.exec(s);
  const name = m ? m[1] : s;
  return SPEAKERS.includes(name) ? name : null;
}
const SPEAK_FORMATS = ["mp3", "json"];
// /translate limits
const MAX_TRANSLATE_CHARS = 5000;
// The 100 languages of Meta's M2M100 (ISO 639-1, with a few ISO 639-2/3 codes where no 2-letter code exists).
const M2M100_LANGS = ["af", "am", "ar", "ast", "az", "ba", "be", "bg", "bn", "br", "bs", "ca", "ceb", "cs", "cy", "da", "de", "el", "en", "es", "et", "fa", "ff", "fi", "fr", "fy", "ga", "gd", "gl", "gu", "ha", "he", "hi", "hr", "ht", "hu", "hy", "id", "ig", "ilo", "is", "it", "ja", "jv", "ka", "kk", "km", "kn", "ko", "lb", "lg", "ln", "lo", "lt", "lv", "mg", "mk", "ml", "mn", "mr", "ms", "my", "ne", "nl", "no", "ns", "oc", "or", "pa", "pl", "ps", "pt", "ro", "ru", "sd", "si", "sk", "sl", "so", "sq", "sr", "ss", "su", "sv", "sw", "ta", "th", "tl", "tn", "tr", "uk", "ur", "uz", "vi", "wo", "xh", "yi", "yo", "zh", "zu"];
