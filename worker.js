// NoJunk Speech — paid (x402) speech-to-text, text-to-speech and translation for AI agents.
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
const SERVICE = "NoJunk Speech";
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

// ---------- helpers ----------
const b64e = (obj) => {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const b64d = (str) => {
  const bin = atob(str);
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
};
const b64url = (bytes) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE", ...headers },
  });

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((key) => deepEqual(a[key], b[key]));
}

// ---------- CDP auth (Ed25519 or EC P-256 key), mirrors @coinbase/cdp-sdk generateJwt ----------
async function cdpJwt(env, method, host, path) {
  const secret = String(env.CDP_API_KEY_SECRET).trim().replace(/\\n/g, "\n");
  const now = Math.floor(Date.now() / 1000);
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = [...nonceBytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const claims = { sub: env.CDP_API_KEY_ID, iss: "cdp", uris: [`${method} ${host}${path}`], iat: now, nbf: now, exp: now + 120 };
  let alg, key, signParams;
  if (secret.includes("BEGIN")) {
    // EC key in PEM (PKCS#8 or SEC1 "EC PRIVATE KEY")
    const body = secret.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
    let der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
    if (secret.includes("BEGIN EC PRIVATE KEY")) der = sec1ToPkcs8(der);
    key = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    alg = "ES256";
    signParams = { name: "ECDSA", hash: "SHA-256" };
  } else {
    const raw = Uint8Array.from(atob(secret), (c) => c.charCodeAt(0));
    if (raw.length !== 64) throw new Error("CDP_API_KEY_SECRET is not a valid Ed25519 key");
    key = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", d: b64url(raw.slice(0, 32)), x: b64url(raw.slice(32)) }, { name: "Ed25519" }, false, ["sign"]);
    alg = "EdDSA";
    signParams = { name: "Ed25519" };
  }
  const header = { alg, kid: env.CDP_API_KEY_ID, typ: "JWT", nonce };
  const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const input = `${enc(header)}.${enc(claims)}`;
  const sig = new Uint8Array(await crypto.subtle.sign(signParams, key, new TextEncoder().encode(input)));
  return `${input}.${b64url(sig)}`;
}
function der(tag, content) {
  const n = content.length;
  const len = n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255];
  return Uint8Array.from([tag, ...len, ...content]);
}
function sec1ToPkcs8(sec1) {
  // PKCS#8 = SEQUENCE { INTEGER 0, SEQUENCE { id-ecPublicKey, prime256v1 }, OCTET STRING sec1 }
  const algId = Uint8Array.from([0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]);
  return der(0x30, [0x02, 0x01, 0x00, ...algId, ...der(0x04, sec1)]);
}

function facilitator(env) {
  const useCdp = env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET;
  const base = useCdp ? CDP_URL : PAYAI_URL;
  const u = new URL(base);
  return {
    name: useCdp ? "cdp" : "payai",
    async call(op, body) {
      const headers = { "Content-Type": "application/json" };
      if (useCdp) headers.Authorization = `Bearer ${await cdpJwt(env, "POST", u.host, `${u.pathname.replace(/\/$/, "")}/${op}`)}`;
      const res = await fetch(`${base}/${op}`, { method: "POST", headers, body: JSON.stringify(body) });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 300) }; }
      return { ok: res.ok, status: res.status, data };
    },
  };
}


// ---------- small helpers ----------
const isStr = (v) => typeof v === "string";
const clean = (s) => s.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
const bad = (m, status = 400) => ({ status, error: m });
const nowIso = () => new Date().toISOString();

// Base64 <-> bytes for large buffers. Encoding works on 32 KB slices so String.fromCharCode never gets a
// multi-megabyte argument list (which overflows the call stack).
function bytesToBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
  return btoa(s);
}
function base64ToBytes(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
// Binary (audio) response with the same CORS headers as json().
const binary = (bytes, contentType, headers = {}) =>
  new Response(bytes, {
    status: 200,
    headers: { "Content-Type": contentType, "Content-Length": String(bytes.byteLength), "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-Audio-Bytes, X-Text-Chars", ...headers },
  });

// Media type check for audio inputs: audio/*, a few container/video types and octet-stream (empty is tolerated).
function audioTypeOk(ct) {
  const t = (ct || "").split(";")[0].trim().toLowerCase();
  if (!t) return true;
  return t.startsWith("audio/") || AUDIO_TYPES_EXTRA.includes(t);
}
// Quick sniff for an HTML/JSON/text page masquerading as audio (e.g. a login page served as octet-stream).
function looksLikeText(bytes) {
  let head = "";
  for (let i = 0; i < Math.min(bytes.length, 64); i++) head += String.fromCharCode(bytes[i]);
  const h = head.replace(/^﻿/, "").trimStart().toLowerCase();
  return h.startsWith("<!doctype") || h.startsWith("<html") || h.startsWith("<?xml") || h.startsWith("{\"") || h.startsWith("[{");
}

// ---------- SSRF guard (same rules as NoJunk Web Read) ----------
const BLOCKED_SUFFIXES = [".localhost", ".internal", ".local", ".localdomain", ".home.arpa", ".intranet", ".corp", ".lan"];
const BLOCKED_HOSTS = new Set(["localhost", "0.0.0.0", "broadcasthost", "ip6-localhost", "ip6-loopback", "metadata.google.internal", "metadata"]);
function privateV4(ip) {
  const o = ip.split(".").map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = o;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 0) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}
function privateV6(host) {
  const halves = host.split("::");
  if (halves.length > 2) return true;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const groups = halves.length === 2 ? [...left, ...new Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
  if (groups.length !== 8) return true;
  const g = groups.map((x) => parseInt(x || "0", 16));
  if (g.some((n) => !Number.isFinite(n) || n < 0 || n > 0xffff)) return true;
  if (g.slice(0, 7).every((n) => n === 0) && (g[7] === 0 || g[7] === 1)) return true; // :: and ::1
  if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) return privateV4(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`); // IPv4-mapped
  if (g[0] === 0x64 && g[1] === 0xff9b) return privateV4(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`); // NAT64
  if ((g[0] & 0xfe00) === 0xfc00) return true; // unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // link local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  return false;
}
// Returns { error } or { url } (normalized absolute URL string).
function checkUrl(raw) {
  if (!isStr(raw) || !raw.trim()) return { error: "audio_url must be a non-empty string" };
  raw = raw.trim();
  if (raw.length > MAX_URL_LENGTH) return { error: `audio_url is too long (max ${MAX_URL_LENGTH} characters)` };
  if (!/^https?:\/\//i.test(raw)) return { error: "audio_url must start with http:// or https://" };
  let u;
  try { u = new URL(raw); } catch { return { error: "audio_url is not a valid absolute URL" }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { error: "Only http and https URLs are supported" };
  if (u.username || u.password) return { error: "URLs with embedded credentials are not allowed" };
  const host = u.hostname.toLowerCase();
  if (!host) return { error: "audio_url has no host" };
  if (host.startsWith("[")) {
    if (privateV6(host.slice(1, -1))) return { error: "Private, loopback and link-local addresses are not allowed" };
  } else if (/^\d+(\.\d+){3}$/.test(host)) {
    if (privateV4(host)) return { error: "Private, loopback and link-local addresses are not allowed" };
  } else {
    if (BLOCKED_HOSTS.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return { error: "Local and internal hostnames are not allowed" };
    if (!host.includes(".")) return { error: "Hostname must be a public, fully-qualified domain name" };
    if (!/^[a-z0-9.-]+$/.test(host) || host.endsWith(".")) return { error: "Hostname contains invalid characters" };
  }
  u.hash = "";
  return { url: u.toString() };
}

// ---------- input ----------
// Reads the JSON body, enforcing the route's byte cap even when Content-Length is absent. Returns { body } or { error, status }.
async function readBody(request, maxBytes) {
  let text;
  try { text = await request.text(); } catch { return bad("Request body could not be read"); }
  if (text.length > maxBytes) return bad(`Request body too large (max ${maxBytes} bytes)`, 413);
  let b;
  try { b = JSON.parse(text); } catch { return bad("Request body must be a JSON object"); }
  if (!b || typeof b !== "object" || Array.isArray(b)) return bad("Request body must be a JSON object");
  return { body: b };
}

function checkText(v, max) {
  if (v === undefined || v === null) return bad("Missing required parameter: text");
  if (!isStr(v)) return bad("text must be a string");
  if (v.length > max) return bad(`text is too long: ${v.length} characters (max ${max})`, 413);
  const text = clean(v).trim();
  if (!text) return bad("text is empty");
  return { text };
}

// Each validator returns { error, status } or the normalized params. Nothing here touches the network or the model.
function validateTranscribe(b) {
  const hasUrl = b.audio_url !== undefined && b.audio_url !== null;
  const hasB64 = b.audio_base64 !== undefined && b.audio_base64 !== null;
  if (hasUrl && hasB64) return bad("Provide either audio_url or audio_base64, not both");
  if (!hasUrl && !hasB64) return bad("Missing required parameter: audio_url (public http/https URL) or audio_base64");
  let language = null;
  if (b.language !== undefined && b.language !== null) {
    if (!isStr(b.language) || !/^[A-Za-z]{2,3}$/.test(b.language.trim())) return bad('language must be an ISO 639-1 code such as "en" or "es" (omit it to auto-detect)');
    language = b.language.trim().toLowerCase();
  }
  if (hasUrl) {
    const u = checkUrl(b.audio_url);
    if (u.error) return bad(u.error);
    return { audio_url: u.url, language };
  }
  if (!isStr(b.audio_base64)) return bad("audio_base64 must be a base64 string");
  let s = b.audio_base64.trim();
  const m = /^data:([^;,]+)(?:;[^,]*)?,/i.exec(s);
  let content_type = null;
  if (m) { content_type = m[1].toLowerCase(); s = s.slice(m[0].length); }
  if (b.content_type !== undefined && b.content_type !== null) {
    if (!isStr(b.content_type)) return bad("content_type must be a string, e.g. audio/mpeg");
    content_type = b.content_type.split(";")[0].trim().toLowerCase();
  }
  if (!content_type) content_type = "application/octet-stream";
  if (!audioTypeOk(content_type)) return bad(`Unsupported content_type "${content_type}": send audio/* (mp3, wav, m4a, ogg, flac, webm), video/mp4 or application/octet-stream`, 415);
  s = s.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!s) return bad("audio_base64 is empty");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s) || s.length % 4 === 1) return bad("audio_base64 is not valid base64");
  const approx = Math.floor((s.length * 3) / 4) - (s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0);
  if (approx > MAX_AUDIO_BYTES) return bad(`audio is too large: ${approx} bytes decoded (max ${MAX_AUDIO_BYTES} bytes, about 10 minutes of compressed audio)`, 413);
  let bytes;
  try { bytes = base64ToBytes(s.length % 4 ? s + "=".repeat(4 - (s.length % 4)) : s); } catch { return bad("audio_base64 is not valid base64"); }
  if (bytes.length === 0) return bad("audio_base64 decodes to zero bytes");
  if (looksLikeText(bytes)) return bad("audio_base64 does not look like audio (it decodes to an HTML/XML/JSON document)", 415);
  return { audio_bytes: bytes, content_type, language };
}

function validateSpeak(b) {
  const t = checkText(b.text, MAX_SPEAK_CHARS); if (t.error) return t;
  let speaker = DEFAULT_SPEAKER;
  if (b.speaker !== undefined && b.speaker !== null) {
    const norm = isStr(b.speaker) ? normalizeSpeaker(b.speaker) : null;
    if (!norm) return bad(`speaker must be one of ${SPEAKERS.join(", ")} (the older aura-<voice>-en names are also accepted)`);
    speaker = norm;
  }
  let format = "mp3";
  if (b.format !== undefined && b.format !== null) {
    if (!isStr(b.format) || !SPEAK_FORMATS.includes(b.format.trim().toLowerCase())) return bad(`format must be one of ${SPEAK_FORMATS.join(", ")}`);
    format = b.format.trim().toLowerCase();
  }
  return { text: t.text, speaker, format };
}

function langCode(v, name) {
  if (!isStr(v) || !/^[A-Za-z]{2,3}$/.test(v.trim())) return bad(`${name} must be an ISO 639-1 language code such as "en", "es", "fr", "zh"`);
  const code = v.trim().toLowerCase();
  if (!M2M100_LANGS.includes(code)) return bad(`${name} "${code}" is not supported; supported codes: ${M2M100_LANGS.join(", ")}`);
  return { code };
}
function validateTranslate(b) {
  const t = checkText(b.text, MAX_TRANSLATE_CHARS); if (t.error) return t;
  if (b.target_lang === undefined || b.target_lang === null) return bad("Missing required parameter: target_lang (ISO 639-1 code such as \"es\")");
  const tl = langCode(b.target_lang, "target_lang"); if (tl.error) return tl;
  let source_lang = "en";
  if (b.source_lang !== undefined && b.source_lang !== null) {
    const sl = langCode(b.source_lang, "source_lang"); if (sl.error) return sl;
    source_lang = sl.code;
  }
  if (source_lang === tl.code) return bad(`source_lang and target_lang are both "${source_lang}"; nothing to translate`);
  return { text: t.text, source_lang, target_lang: tl.code };
}

const VALIDATORS = { transcribe: validateTranscribe, speak: validateSpeak, translate: validateTranslate };

// ---------- audio download (for /transcribe audio_url) ----------
class FetchError extends Error { constructor(status, message) { super(message); this.status = status; } }

async function readCapped(res, cap) {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) { try { if (res.body) await res.body.cancel(); } catch {} return { bytes: null, over: true }; }
  if (!res.body || typeof res.body.getReader !== "function") {
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.length > cap ? { bytes: null, over: true } : { bytes: buf, over: false };
  }
  const reader = res.body.getReader();
  const chunks = [];
  let n = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    n += value.length;
    if (n > cap) { try { await reader.cancel(); } catch {} return { bytes: null, over: true }; }
  }
  const out = new Uint8Array(n);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return { bytes: out, over: false };
}

// Downloads the audio within AUDIO_FETCH_TIMEOUT_MS, following up to MAX_AUDIO_REDIRECTS redirects (each re-checked
// against the SSRF guard). Returns { bytes, contentType, final_url } or throws FetchError(status, message).
async function fetchAudio(startUrl) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), AUDIO_FETCH_TIMEOUT_MS);
  let url = startUrl;
  const drop = async (res) => { try { if (res.body) await res.body.cancel(); } catch {} };
  try {
    for (let hop = 0; ; hop++) {
      let res;
      try {
        res = await fetch(url, { method: "GET", redirect: "manual", signal: ctrl.signal, headers: { "User-Agent": USER_AGENT, Accept: "audio/*, video/mp4, application/octet-stream;q=0.9, */*;q=0.5" } });
      } catch (e) {
        if (ctrl.signal.aborted) throw new FetchError(502, `The audio did not download within ${AUDIO_FETCH_TIMEOUT_MS / 1000} seconds`);
        throw new FetchError(502, `Could not fetch the audio: ${String(e && e.message ? e.message : e).slice(0, 200)}`);
      }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        await drop(res);
        if (!loc) throw new FetchError(502, `The audio URL responded ${res.status} without a Location header`);
        if (hop >= MAX_AUDIO_REDIRECTS) throw new FetchError(502, `Too many redirects (more than ${MAX_AUDIO_REDIRECTS})`);
        let next;
        try { next = new URL(loc, url).toString(); } catch { throw new FetchError(502, "The audio URL redirected to an invalid URL"); }
        const chk = checkUrl(next);
        if (chk.error) throw new FetchError(502, `The audio URL redirected to an address that cannot be fetched: ${chk.error}`);
        url = chk.url;
        continue;
      }
      if (res.status === 404 || res.status === 410) { await drop(res); throw new FetchError(404, `The audio was not found (upstream ${res.status})`); }
      if (res.status < 200 || res.status >= 300) { await drop(res); throw new FetchError(502, `The audio URL responded with HTTP ${res.status}`); }
      const contentType = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!audioTypeOk(contentType)) { await drop(res); throw new FetchError(415, `The URL is not audio (content-type "${contentType}"): only audio/*, video/mp4 and application/octet-stream are accepted`); }
      let got;
      try { got = await readCapped(res, MAX_AUDIO_BYTES); } catch (e) {
        if (ctrl.signal.aborted) throw new FetchError(502, `The audio did not finish downloading within ${AUDIO_FETCH_TIMEOUT_MS / 1000} seconds`);
        throw new FetchError(502, `Could not read the audio body: ${String(e && e.message ? e.message : e).slice(0, 200)}`);
      }
      if (got.over) throw new FetchError(413, `The audio is larger than ${MAX_AUDIO_BYTES} bytes (max 20 MB, about 10 minutes of compressed audio)`);
      if (got.bytes.length === 0) throw new FetchError(502, "The audio URL returned an empty body");
      if (looksLikeText(got.bytes)) throw new FetchError(415, "The URL did not return audio (it returned an HTML/XML/JSON document)");
      return { bytes: got.bytes, contentType: contentType || "application/octet-stream", final_url: url };
    }
  } finally {
    clearTimeout(timer);
  }
}

// ---------- route logic: each returns { status, body } or { status: 200, binary: {bytes, contentType, headers} }; status !== 200 means do not settle ----------
const UNAVAILABLE = { status: 502, body: { error: "AI model temporarily unavailable, no payment taken" } };
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

async function doTranscribe(env, q) {
  let bytes = q.audio_bytes, source = "base64";
  if (q.audio_url) {
    try { ({ bytes } = await fetchAudio(q.audio_url)); source = "url"; }
    catch (e) { return { status: e instanceof FetchError ? e.status : 502, body: { error: `${e instanceof FetchError ? e.message : "Could not fetch the audio"} (no payment was taken)` } }; }
  }
  const input = { audio: bytesToBase64(bytes), task: "transcribe", vad_filter: true };
  if (q.language) input.language = q.language;
  let raw;
  try { raw = await env.AI.run(WHISPER_MODEL, input); } catch { return UNAVAILABLE; }
  if (!raw || typeof raw !== "object" || !isStr(raw.text)) return { status: 502, body: { error: "AI model returned no transcription, no payment taken" } };
  const info = raw.transcription_info && typeof raw.transcription_info === "object" ? raw.transcription_info : {};
  const segments = Array.isArray(raw.segments)
    ? raw.segments.filter((s) => s && typeof s === "object").map((s) => ({ start: num(s.start), end: num(s.end), text: isStr(s.text) ? s.text.trim() : "" }))
    : [];
  const text = raw.text.trim();
  return {
    status: 200,
    body: {
      text,
      language: isStr(info.language) ? info.language : q.language,
      language_probability: num(info.language_probability),
      duration_seconds: num(info.duration),
      word_count: Number.isInteger(raw.word_count) ? raw.word_count : (text ? text.split(/\s+/).length : 0),
      segments,
      audio_bytes: bytes.length,
      source,
      model: WHISPER_MODEL,
      generated_at: nowIso(),
    },
  };
}

// Normalizes whatever shape Aura returns (stream, Response, object with base64 `audio`, raw buffer) to a Uint8Array.
async function audioBytesOf(result) {
  if (result === null || result === undefined) return null;
  if (typeof ReadableStream !== "undefined" && result instanceof ReadableStream) return new Uint8Array(await new Response(result).arrayBuffer());
  if (typeof Response !== "undefined" && result instanceof Response) return new Uint8Array(await result.arrayBuffer());
  if (result instanceof ArrayBuffer) return new Uint8Array(result);
  if (result instanceof Uint8Array) return result;
  if (ArrayBuffer.isView(result)) return new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
  if (typeof result === "object") {
    if (isStr(result.audio)) { try { return base64ToBytes(result.audio.replace(/^data:[^,]*,/, "").replace(/\s+/g, "")); } catch { return null; } }
    if (result.audio && typeof result.audio === "object") return audioBytesOf(result.audio);
    if (typeof result.getReader === "function") return new Uint8Array(await new Response(result).arrayBuffer());
  }
  return null;
}

async function doSpeak(env, q) {
  let raw;
  try { raw = await env.AI.run(TTS_MODEL, { text: q.text, speaker: q.speaker }); } catch { return UNAVAILABLE; }
  let bytes;
  try { bytes = await audioBytesOf(raw); } catch { bytes = null; }
  if (!bytes || bytes.length < 4) return { status: 502, body: { error: "AI model returned no audio, no payment taken" } };
  const headers = { "X-Audio-Bytes": String(bytes.length), "X-Text-Chars": String(q.text.length), "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-Audio-Bytes, X-Text-Chars" };
  if (q.format === "json") {
    return { status: 200, body: { audio_base64: bytesToBase64(bytes), content_type: "audio/mpeg", bytes: bytes.length, text_chars: q.text.length, speaker: q.speaker, model: TTS_MODEL, generated_at: nowIso() }, headers };
  }
  return { status: 200, binary: { bytes, contentType: "audio/mpeg", headers } };
}

async function doTranslate(env, q) {
  let raw;
  try { raw = await env.AI.run(MT_MODEL, { text: q.text, source_lang: q.source_lang, target_lang: q.target_lang }); } catch { return UNAVAILABLE; }
  const out = raw && typeof raw === "object" ? raw.translated_text : isStr(raw) ? raw : null;
  if (!isStr(out) || !out.trim()) return { status: 502, body: { error: "AI model returned no translation, no payment taken" } };
  return { status: 200, body: { translated_text: out.trim(), source_lang: q.source_lang, target_lang: q.target_lang, input_chars: q.text.length, model: MT_MODEL, generated_at: nowIso() } };
}

const HANDLERS = { transcribe: doTranscribe, speak: doSpeak, translate: doTranslate };

// ---------- x402 ----------
function requirements(env, route) {
  return {
    scheme: "exact",
    network: NETWORK,
    amount: ROUTES[route].price,
    asset: USDC_BASE,
    payTo: env.PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { name: "USD Coin", version: "2" },
  };
}

const EXAMPLES = {
  "/transcribe": {
    input: { audio_url: "https://example.com/podcast-clip.mp3", language: "en" },
    output: { text: "Welcome back to the show. Today we are talking about how AI agents pay for the tools they use.", language: "en", language_probability: 0.99, duration_seconds: 6.4, word_count: 18, segments: [{ start: 0, end: 2.1, text: "Welcome back to the show." }, { start: 2.1, end: 6.4, text: "Today we are talking about how AI agents pay for the tools they use." }], audio_bytes: 102400, source: "url", model: WHISPER_MODEL, generated_at: "2026-10-15T12:00:00.000Z" },
  },
  "/speak": {
    input: { text: "Your order has shipped and should arrive on Thursday.", speaker: DEFAULT_SPEAKER, format: "json" },
    output: { audio_base64: "SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQxAAD...", content_type: "audio/mpeg", bytes: 38400, text_chars: 54, speaker: DEFAULT_SPEAKER, model: TTS_MODEL, generated_at: "2026-10-15T12:00:00.000Z" },
  },
  "/translate": {
    input: { text: "The meeting has been moved to Thursday at 3 pm.", source_lang: "en", target_lang: "es" },
    output: { translated_text: "La reunión se ha trasladado al jueves a las 3 de la tarde.", source_lang: "en", target_lang: "es", input_chars: 47, model: MT_MODEL, generated_at: "2026-10-15T12:00:00.000Z" },
  },
};
const BODY_PROPS = {
  "/transcribe": {
    audio_url: { type: "string", description: "Public http(s) URL of an audio file (mp3, wav, m4a, ogg, flac, webm, mp4), max 20 MB; use this OR audio_base64" },
    audio_base64: { type: "string", description: "Base64-encoded audio bytes (max 20 MB decoded); use this OR audio_url" },
    content_type: { type: "string", description: "Optional media type of audio_base64, e.g. audio/mpeg" },
    language: { type: "string", description: 'Optional ISO 639-1 language hint such as "en"; omit to auto-detect' },
  },
  "/speak": {
    text: { type: "string", description: `Text to speak (1 to ${MAX_SPEAK_CHARS} characters)` },
    speaker: { type: "string", description: `Optional voice, default ${DEFAULT_SPEAKER}; one of ${SPEAKERS.join(", ")} (legacy aura-<voice>-en names also accepted)` },
    format: { type: "string", description: '"mp3" (default: raw audio/mpeg body) or "json" ({audio_base64, ...})' },
  },
  "/translate": {
    text: { type: "string", description: `Text to translate (1 to ${MAX_TRANSLATE_CHARS} characters)` },
    target_lang: { type: "string", description: 'Target language, ISO 639-1 code such as "es", "fr", "de", "zh", "ja" (100 languages)' },
    source_lang: { type: "string", description: 'Optional source language code, default "en"' },
  },
};
const REQUIRED_PROPS = { "/transcribe": [], "/speak": ["text"], "/translate": ["text", "target_lang"] };
const ROUTE_DESCRIPTIONS = {
  "/transcribe": "Transcribe audio (URL or base64, up to 20 MB / about 10 minutes) to text with timestamps, word count and detected language (Whisper large-v3-turbo).",
  "/speak": "Convert text (up to 2,000 characters) into natural MP3 speech, returned as audio/mpeg bytes or base64 JSON (Deepgram Aura-1).",
  "/translate": "Translate text (up to 5,000 characters) between 100 languages, ISO 639-1 codes in and out (Meta M2M100 1.2B).",
};

function paymentRequired(env, url, route, error) {
  const resourceUrl = `${url.origin}${route}`;
  return {
    x402Version: 2,
    error,
    resource: { url: resourceUrl, description: `${SERVICE} ${ROUTES[route].name}: ${ROUTE_DESCRIPTIONS[route]}`, mimeType: "application/json" },
    accepts: [requirements(env, route)],
    extensions: {
      bazaar: {
        info: {
          input: { type: "http", method: "POST", bodyType: "json", body: EXAMPLES[route].input },
          output: { type: "json", example: EXAMPLES[route].output },
        },
        schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            input: {
              type: "object",
              properties: {
                type: { type: "string", const: "http" },
                method: { type: "string", enum: ["POST", "PUT", "PATCH"] },
                bodyType: { type: "string", enum: ["json"] },
                body: { type: "object", properties: BODY_PROPS[route], required: REQUIRED_PROPS[route] },
              },
              required: ["type", "method", "bodyType", "body"],
              additionalProperties: false,
            },
            output: {
              type: "object",
              properties: { type: { type: "string" }, example: { type: "object" } },
              required: ["type"],
            },
          },
          required: ["input"],
        },
      },
    },
  };
}
function send402(env, url, route, error) {
  const pr = paymentRequired(env, url, route, error);
  return json(pr, 402, { "PAYMENT-REQUIRED": b64e(pr) });
}

function openapi(origin) {
  const common = { model: { type: "string", description: "Model that produced the result" }, generated_at: { type: "string", format: "date-time" } };
  const bodies = {
    "/transcribe": {
      type: "object",
      properties: {
        audio_url: { type: "string", format: "uri", maxLength: MAX_URL_LENGTH, description: "Public http(s) URL of the audio file (mp3, wav, m4a, ogg, flac, webm, mp4 audio). Max 20 MB, downloaded within 20 s. Localhost, private-network and internal hostnames are rejected. Provide this or audio_base64." },
        audio_base64: { type: "string", contentEncoding: "base64", description: "Base64 (or data: URI) of the audio bytes, max 20 MB decoded. Provide this or audio_url." },
        content_type: { type: "string", description: "Media type of audio_base64 (audio/*, video/mp4 or application/octet-stream). Default application/octet-stream." },
        language: { type: "string", minLength: 2, maxLength: 3, description: "Optional ISO 639-1 hint, e.g. en, es, de; omit to auto-detect" },
      },
      oneOf: [{ required: ["audio_url"] }, { required: ["audio_base64"] }],
    },
    "/speak": {
      type: "object",
      properties: {
        text: { type: "string", minLength: 1, maxLength: MAX_SPEAK_CHARS, description: `Text to speak (max ${MAX_SPEAK_CHARS} characters)` },
        speaker: { type: "string", enum: SPEAKERS_ACCEPTED, default: DEFAULT_SPEAKER, description: "Deepgram Aura voice (English). Bare names (asteria, luna, ...) are preferred; legacy aura-<voice>-en names are accepted and normalized." },
        format: { type: "string", enum: SPEAK_FORMATS, default: "mp3", description: "mp3: the response body is the raw audio/mpeg file; json: {audio_base64, content_type, bytes, ...}" },
      },
      required: ["text"],
    },
    "/translate": {
      type: "object",
      properties: {
        text: { type: "string", minLength: 1, maxLength: MAX_TRANSLATE_CHARS, description: `Text to translate (max ${MAX_TRANSLATE_CHARS} characters)` },
        target_lang: { type: "string", enum: M2M100_LANGS, description: "Target language code (ISO 639-1; 100 M2M100 languages)" },
        source_lang: { type: "string", enum: M2M100_LANGS, default: "en", description: "Source language code (ISO 639-1); must differ from target_lang" },
      },
      required: ["text", "target_lang"],
    },
  };
  const segment = { type: "object", properties: { start: { type: ["number", "null"], description: "Segment start, seconds" }, end: { type: ["number", "null"], description: "Segment end, seconds" }, text: { type: "string" } }, required: ["start", "end", "text"] };
  const outputs = {
    "/transcribe": {
      type: "object",
      properties: {
        text: { type: "string", description: "Full transcript" },
        language: { type: ["string", "null"], description: "Detected (or given) language code" },
        language_probability: { type: ["number", "null"], description: "Confidence of the language detection, 0-1" },
        duration_seconds: { type: ["number", "null"], description: "Audio duration in seconds" },
        word_count: { type: "integer" },
        segments: { type: "array", items: segment, description: "Timestamped segments" },
        audio_bytes: { type: "integer", description: "Size of the audio that was transcribed" },
        source: { type: "string", enum: ["url", "base64"] },
        ...common,
      },
      required: ["text", "language", "language_probability", "duration_seconds", "word_count", "segments", "audio_bytes", "source", "model", "generated_at"],
    },
    "/speak": {
      type: "object",
      properties: { audio_base64: { type: "string", contentEncoding: "base64", description: "MP3 bytes, base64" }, content_type: { type: "string", const: "audio/mpeg" }, bytes: { type: "integer" }, text_chars: { type: "integer" }, speaker: { type: "string" }, ...common },
      required: ["audio_base64", "content_type", "bytes", "text_chars", "speaker", "model", "generated_at"],
    },
    "/translate": {
      type: "object",
      properties: { translated_text: { type: "string" }, source_lang: { type: "string" }, target_lang: { type: "string" }, input_chars: { type: "integer" }, ...common },
      required: ["translated_text", "source_lang", "target_lang", "input_chars", "model", "generated_at"],
    },
  };
  const summaries = {
    "/transcribe": "Transcribe audio (URL or base64) to text with timestamps and detected language",
    "/speak": "Text to speech: natural MP3 audio from up to 2,000 characters",
    "/translate": "Translate text between 100 languages",
  };
  const tags = { "/transcribe": ["AI", "Speech", "Transcription", "Audio"], "/speak": ["AI", "Speech", "TTS", "Audio"], "/translate": ["AI", "Translation", "Language"] };
  const op = (route) => {
    const o = {
      operationId: ROUTES[route].name,
      summary: summaries[route],
      tags: tags[route],
      "x-payment-info": { price: { mode: "fixed", currency: "USD", amount: ROUTES[route].usd }, protocols: [{ x402: {} }] },
      requestBody: { required: true, content: { "application/json": { schema: bodies[route] } } },
      responses: {
        200: { description: "Result", content: { "application/json": { schema: outputs[route] } } },
        400: { description: "Invalid input (no charge)" },
        402: { description: "Payment Required" },
        413: { description: `Request body larger than ${ROUTES[route].max_request_bytes} bytes${route === "/transcribe" ? ", or audio larger than 20 MB" : ""} (no charge)` },
        502: { description: "AI model temporarily unavailable or returned an unusable result (no charge)" },
      },
    };
    if (route === "/transcribe") {
      o.responses[404] = { description: "audio_url was not found upstream (HTTP 404/410) (no charge)" };
      o.responses[415] = { description: "The URL or base64 payload is not audio (e.g. an HTML page) (no charge)" };
      o.responses[502].description = "Audio download failed (upstream error, 20 s timeout, too many redirects, redirect to a blocked address) or the AI model is unavailable (no charge)";
    }
    if (route === "/speak") {
      o.responses[200] = {
        description: "With format=mp3 (default) the body is the raw MP3 file (audio/mpeg) and the headers carry PAYMENT-RESPONSE, X-Audio-Bytes and X-Text-Chars. With format=json the body is JSON with the MP3 as base64.",
        headers: { "X-Audio-Bytes": { schema: { type: "integer" }, description: "Size of the MP3 in bytes" }, "X-Text-Chars": { schema: { type: "integer" }, description: "Characters spoken" }, "PAYMENT-RESPONSE": { schema: { type: "string" }, description: "Base64 x402 settlement receipt" } },
        content: { "audio/mpeg": { schema: { type: "string", format: "binary" } }, "application/json": { schema: outputs[route] } },
      };
    }
    return o;
  };
  return {
    openapi: "3.1.0",
    info: {
      title: SERVICE,
      version: "1.0.0",
      description: DESCRIPTION,
      "x-guidance": `Three POST endpoints paid per call in USDC on Base via x402 (you are only charged when a valid result is returned; all 4xx/5xx are free). POST /transcribe {audio_url} or {audio_base64, content_type?}, optional language hint -> {text, language, language_probability, duration_seconds, word_count, segments:[{start,end,text}], ...} costs $0.02 per call and covers one file up to 20 MB (about 10 minutes of compressed audio); the URL must be public (no localhost or private networks) and is downloaded within 20 s. POST /speak {text (<= ${MAX_SPEAK_CHARS} chars), speaker?, format?: mp3|json} costs $0.01: with format=mp3 (default) the response body IS the MP3 file (Content-Type audio/mpeg; save the bytes as .mp3), with format=json you get {audio_base64, content_type, bytes, ...}. POST /translate {text (<= ${MAX_TRANSLATE_CHARS} chars), target_lang, source_lang?: default en} -> {translated_text, ...} costs $0.002 and supports the 100 M2M100 languages by ISO 639-1 code (en, es, fr, de, it, pt, ru, zh, ja, ko, ar, hi, ...). Models: Whisper large-v3-turbo, Deepgram Aura-1, Meta M2M100 1.2B on Cloudflare Workers AI. Best for: turning voice notes, podcasts, meetings or voicemail into text; voicing replies, alerts or summaries for voice interfaces; localizing messages, product copy or support replies.`,
    },
    servers: [{ url: origin }],
    paths: Object.fromEntries(Object.keys(ROUTES).map((r) => [r, { post: op(r) }])),
  };
}

export default {
  async fetch(request, env0) {
    const env = { ...env0, PAY_TO: (env0 && env0.PAY_TO) || DEFAULT_PAY_TO };
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "PAYMENT-SIGNATURE, Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-Audio-Bytes, X-Text-Chars" } });
    }
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        service: SERVICE,
        description: DESCRIPTION,
        openapi: `${url.origin}/openapi.json`,
        endpoints: Object.fromEntries(Object.keys(ROUTES).map((r) => [r, { method: "POST", url: `${url.origin}${r}`, price: `$${ROUTES[r].usd.replace(/0+$/, "")} USDC on Base per request (x402)`, description: ROUTE_DESCRIPTIONS[r], example_body: EXAMPLES[r].input }])),
        models: { transcribe: WHISPER_MODEL, speak: TTS_MODEL, translate: MT_MODEL },
        limits: { transcribe: { max_audio_bytes: MAX_AUDIO_BYTES, approx_max_minutes: 10, download_timeout_seconds: AUDIO_FETCH_TIMEOUT_MS / 1000, max_request_bytes: ROUTES["/transcribe"].max_request_bytes }, speak: { max_text_chars: MAX_SPEAK_CHARS, speakers: SPEAKERS, formats: SPEAK_FORMATS }, translate: { max_text_chars: MAX_TRANSLATE_CHARS, languages: M2M100_LANGS } },
        no_charge_on: ["400 invalid input or private/local audio_url", "404 audio not found", "413 body or audio too large", "415 not audio", "502 audio download failed or AI model unavailable"],
        configured: Boolean(env.PAY_TO) && Boolean(env.AI),
        facilitator: env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET ? "cdp" : "payai",
      });
    }
    if (url.pathname === "/openapi.json" || url.pathname === "/.well-known/openapi.json") return json(openapi(url.origin));
    const route = url.pathname.replace(/\/+$/, "") || url.pathname;
    if (!ROUTES[route]) return json({ error: `Not found. Use POST ${Object.keys(ROUTES).join(", ")}` }, 404);
    if (!env.PAY_TO || !/^0x[0-9a-fA-F]{40}$/.test(env.PAY_TO)) return json({ error: "Service not configured: PAY_TO wallet address missing" }, 500);
    if (!env.AI || typeof env.AI.run !== "function") return json({ error: "Service not configured: Workers AI binding (AI) missing" }, 500);
    if (request.method !== "GET" && request.method !== "POST") return json({ error: "Use POST" }, 405);
    const maxBytes = ROUTES[route].max_request_bytes;
    const len = Number(request.headers.get("content-length"));
    if (Number.isFinite(len) && len > maxBytes) return json({ error: `Request body too large (max ${maxBytes} bytes for ${route}) (no payment was taken)` }, 413);

    const header = request.headers.get("PAYMENT-SIGNATURE") || request.headers.get("X-PAYMENT");
    if (!header) return send402(env, url, route, "PAYMENT-SIGNATURE header is required");
    if (request.method !== "POST") return json({ error: `Use POST ${route} with a JSON body (no payment was taken)` }, 405);
    const rb = await readBody(request, maxBytes);
    if (rb.error) return json({ error: `${rb.error} (no payment was taken)` }, rb.status || 400);
    const q = VALIDATORS[ROUTES[route].name](rb.body);
    if (q.error) return json({ error: `${q.error} (no payment was taken)` }, q.status || 400);

    let payload;
    try { payload = b64d(header); } catch { return json({ error: "Invalid payment payload" }, 400); }
    const reqs = requirements(env, route);
    if (payload.x402Version !== 2 || !deepEqual(payload.accepted, reqs)) return send402(env, url, route, "No matching payment requirements found");

    const fac = facilitator(env);
    const body = { x402Version: 2, paymentPayload: payload, paymentRequirements: reqs };
    let v;
    try { v = await fac.call("verify", body); } catch (e) { return json({ error: "Facilitator unreachable", detail: String(e) }, 500); }
    if (!v.ok || !v.data.isValid) return send402(env, url, route, v.data.invalidReason || v.data.error || `verify failed (${v.status})`);

    let result;
    try { result = await HANDLERS[ROUTES[route].name](env, q); } catch { return json({ error: "AI model temporarily unavailable, no payment taken" }, 502); }
    if (result.status !== 200) return json(result.body, result.status);

    let s;
    try { s = await fac.call("settle", body); } catch (e) { return json({ error: "Facilitator unreachable", detail: String(e) }, 500); }
    if (!s.ok || !s.data.success) {
      const fail = { success: false, errorReason: s.data.errorReason || s.data.error || `settle failed (${s.status})`, transaction: "", network: NETWORK, payer: s.data.payer || v.data.payer };
      return json({}, 402, { "PAYMENT-RESPONSE": b64e(fail) });
    }
    const receipt = { success: true, transaction: s.data.transaction, network: s.data.network || NETWORK, payer: s.data.payer || v.data.payer };
    if (result.binary) return binary(result.binary.bytes, result.binary.contentType, { ...result.binary.headers, "PAYMENT-RESPONSE": b64e(receipt) });
    return json(result.body, 200, { ...(result.headers || {}), "PAYMENT-RESPONSE": b64e(receipt) });
  },
};
