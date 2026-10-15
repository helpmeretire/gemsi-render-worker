// NoJunk Document — paid (x402) document-to-Markdown conversion for AI agents.
// Point it at a PDF, Office file, spreadsheet, image or web page (by URL or base64) and get clean Markdown back.
// Runs on Cloudflare Workers AI toMarkdown. No API keys, no rate limits: agents pay per call in USDC on Base
// and are only charged when a valid conversion is returned.
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
const SERVICE = "NoJunk Document";
const DESCRIPTION =
  "Pay-per-call document reading for agents: convert a PDF, Word, Excel, OpenDocument, CSV, Apple Numbers, HTML, XML or image file (by public URL or base64) into clean Markdown you can reason over. One cent per document; you are only charged when a conversion is returned.";
const USER_AGENT = "NoJunk Document/1.0 (+https://nojunkcrypto.com)";

const PRICE = "10000"; // $0.01 in USDC atomic units (6 decimals)
const PRICE_USD = "0.010000";
const ROUTE = "/convert";

const MAX_FILE_BYTES = 20 * 1024 * 1024; // decoded document fed to toMarkdown
const MAX_REQUEST_BYTES = 28 * 1024 * 1024; // JSON body cap (20 MB file as base64 + overhead); 413 before any payment work
const MAX_URL_CHARS = 2048;
const MAX_FILENAME_CHARS = 255;
const FETCH_TIMEOUT_MS = 20000;
const FETCH_MAX_REDIRECTS = 3;
const MAX_MARKDOWN_CHARS = 400000;
const MIN_MAX_CHARS = 1000;

// Supported file types (what Cloudflare toMarkdown accepts): extension -> MIME type.
const EXT_MIME = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  svg: "image/svg+xml",
  html: "text/html",
  htm: "text/html",
  xml: "application/xml",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xlsm: "application/vnd.ms-excel.sheet.macroenabled.12",
  xlsb: "application/vnd.ms-excel.sheet.binary.macroenabled.12",
  xls: "application/vnd.ms-excel",
  et: "application/vnd.ms-excel",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odt: "application/vnd.oasis.opendocument.text",
  csv: "text/csv",
  numbers: "application/vnd.apple.numbers",
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
};
// Extensions whose files are ZIP containers ("PK" magic); the extension (or declared content type) decides which.
const ZIP_EXTS = ["docx", "xlsx", "xlsm", "xlsb", "ods", "odt", "numbers"];
// Content types that identify a supported type when the URL has no usable extension. Aliases included.
const MIME_EXT = Object.fromEntries(Object.entries(EXT_MIME).filter(([e]) => !["jpg", "htm", "markdown", "et"].includes(e)).map(([e, m]) => [m, e]));
Object.assign(MIME_EXT, {
  "text/xml": "xml",
  "application/xhtml+xml": "html",
  "image/jpg": "jpeg",
  "application/x-pdf": "pdf",
  "text/x-markdown": "md",
  "application/vnd.ms-excel.sheet.macroEnabled.12": "xlsm",
  "application/vnd.ms-excel.sheet.binary.macroEnabled.12": "xlsb",
  "application/x-vnd.oasis.opendocument.spreadsheet": "ods",
  "application/x-vnd.oasis.opendocument.text": "odt",
  "application/x-iwork-numbers-sffnumbers": "numbers",
});
const SUPPORTED_LIST = "PDF, DOCX, XLSX, XLSM, XLSB, XLS, ODS, ODT, CSV, Apple Numbers, HTML, XML, Markdown, plain text, PNG, JPEG, WebP, SVG";

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


// ---------- input ----------
const isStr = (v) => typeof v === "string";

// Reads the JSON body with a hard byte cap. Returns { error, status } or { body }.
async function readBody(request, maxBytes) {
  let buf;
  try { buf = await request.arrayBuffer(); } catch { return { status: 400, error: "Request body could not be read" }; }
  if (buf.byteLength > maxBytes) return { status: 413, error: `Request body too large (max ${maxBytes} bytes)` };
  let b = null;
  try { b = JSON.parse(new TextDecoder().decode(buf)); } catch { return { status: 400, error: "Request body must be a JSON object" }; }
  if (!b || typeof b !== "object" || Array.isArray(b)) return { status: 400, error: "Request body must be a JSON object" };
  return { body: b };
}

// ---------- base64 / bytes ----------
// Decodes base64 (standard or url-safe, optional data: prefix, whitespace ignored) in 64 KiB chunks. Throws on bad input.
function b64ToBytes(input) {
  let s = String(input).replace(/^data:[^,]*,/, "").replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new Error("invalid base64");
  const rem = s.length % 4;
  if (rem === 1) throw new Error("invalid base64 length");
  if (rem) s += "=".repeat(4 - rem);
  if (!s.length) throw new Error("empty base64");
  const padding = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((s.length / 4) * 3 - padding);
  const CHUNK = 65536; // multiple of 4, so each slice is a valid standalone base64 block
  let o = 0;
  for (let i = 0; i < s.length; i += CHUNK) {
    const bin = atob(s.slice(i, i + CHUNK));
    for (let k = 0; k < bin.length; k++) out[o++] = bin.charCodeAt(k);
  }
  return out;
}

// ---------- file type detection ----------
// Magic-byte sniff: returns an extension for self-identifying formats, "zip" for PK containers, or null.
function sniffMagic(b) {
  if (b.length < 4) return null;
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "pdf"; // %PDF
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "webp";
  if (b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07) && (b[3] === 0x04 || b[3] === 0x06 || b[3] === 0x08)) return "zip";
  if (b.length >= 8 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0 && b[4] === 0xa1 && b[5] === 0xb1 && b[6] === 0x1a && b[7] === 0xe1) return "ole"; // legacy Office (xls)
  return null;
}
// Sniffs text-like content (HTML / XML / SVG) from the first bytes; null when not recognizable.
function sniffText(b) {
  const head = new TextDecoder("utf-8", { fatal: false }).decode(b.subarray(0, 2048)).replace(/^﻿/, "").trimStart().toLowerCase();
  if (head.startsWith("<!doctype html") || head.startsWith("<html")) return "html";
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "svg";
  if (head.startsWith("<?xml")) return "xml";
  return null;
}
// Extension (lower-case, without the dot) from a filename or URL path; null when none.
function extOf(name) {
  if (!isStr(name)) return null;
  const base = name.split(/[\\/]/).pop();
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(base);
  return m ? m[1].toLowerCase() : null;
}
function baseName(name) {
  if (!isStr(name)) return "";
  let base = name.split(/[\\/]/).pop();
  try { base = decodeURIComponent(base); } catch {}
  return base.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_FILENAME_CHARS);
}
// Normalizes a content-type header to its bare lower-case MIME.
const bareMime = (ct) => (ct || "").split(";")[0].trim().toLowerCase();

// Decides the file type from magic bytes, the filename / URL extension and the declared content type.
// Returns { ext, mime, name } or { status, error }.
function resolveType(bytes, nameHint, ctHint) {
  const fail = (m, status = 415) => ({ status, error: m });
  const hintExt = extOf(nameHint);
  const hintExtOk = hintExt && EXT_MIME[hintExt] ? hintExt : null;
  const ctExt = MIME_EXT[bareMime(ctHint)] || null;
  const magic = sniffMagic(bytes);
  let ext = null;
  if (magic === "pdf" || magic === "png" || magic === "jpeg" || magic === "webp") ext = magic;
  else if (magic === "zip") {
    if (hintExtOk && ZIP_EXTS.includes(hintExtOk)) ext = hintExtOk;
    else if (ctExt && ZIP_EXTS.includes(ctExt)) ext = ctExt;
    else return fail(`file is a ZIP container but its type could not be determined; give a filename or content_type for one of ${ZIP_EXTS.join(", ")}`);
  } else if (magic === "ole") {
    ext = hintExtOk === "et" ? "et" : "xls";
  } else if (hintExtOk) ext = hintExtOk;
  else if (ctExt) ext = ctExt;
  else ext = sniffText(bytes);
  if (!ext) return fail(`unsupported file type (${bareMime(ctHint) || hintExt || "unknown"}); supported: ${SUPPORTED_LIST}`);
  const mime = EXT_MIME[ext];
  let name = baseName(nameHint);
  if (!name || name.startsWith(".")) name = "document";
  const cur = extOf(name);
  if (cur === ext || (cur && EXT_MIME[cur])) name = name.replace(/\.[A-Za-z0-9]{1,10}$/, ""); // normalize case / drop a wrong known extension
  if (extOf(name) !== ext) name = `${name || "document"}.${ext}`;
  return { ext, mime, name };
}

// ---------- SSRF guard ----------
function privateIPv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}
function privateIPv6(host) {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!h.includes(":")) return false;
  if (h === "::" || h === "::1") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h) || h.startsWith("ff")) return true; // fc00::/7, fe80::/10, multicast
  const mapped = /^(?:0*:)*ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h) || /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (mapped) {
    if (mapped[2] !== undefined) { const hi = parseInt(mapped[1], 16), lo = parseInt(mapped[2], 16); return privateIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`); }
    return privateIPv4(mapped[1]);
  }
  return false;
}
// Returns null when the URL may be fetched, otherwise a reason string.
function urlBlockReason(u) {
  if (u.protocol !== "http:" && u.protocol !== "https:") return "url must use http or https";
  if (u.username || u.password) return "url must not contain credentials";
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return "url has no host";
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localdomain") || host === "metadata.google.internal") return "url must not point at a local or internal host";
  if (host.startsWith("[") || host.includes(":")) return privateIPv6(host) ? "url must not point at a private or loopback address" : null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return privateIPv4(host) ? "url must not point at a private or loopback address" : null;
  if (!host.includes(".")) return "url host must be a public domain name or address";
  return null;
}

// ---------- validator (nothing here touches the network or the model) ----------
function validateConvert(b) {
  const bad = (m, status = 400) => ({ status, error: m });
  const hasUrl = b.url !== undefined && b.url !== null;
  const hasB64 = b.file_base64 !== undefined && b.file_base64 !== null;
  if (!hasUrl && !hasB64) return bad("Missing required parameter: url (http/https) or file_base64");
  if (hasUrl && hasB64) return bad("Provide either url or file_base64, not both");
  let maxChars = MAX_MARKDOWN_CHARS;
  if (b.max_chars !== undefined && b.max_chars !== null) {
    const n = Number(b.max_chars);
    if (typeof b.max_chars === "boolean" || !Number.isInteger(n) || n < MIN_MAX_CHARS || n > MAX_MARKDOWN_CHARS) return bad(`max_chars must be an integer from ${MIN_MAX_CHARS} to ${MAX_MARKDOWN_CHARS}`);
    maxChars = n;
  }
  let filename = null;
  if (b.filename !== undefined && b.filename !== null) {
    if (!isStr(b.filename)) return bad("filename must be a string");
    filename = b.filename.trim();
    if (filename.length > MAX_FILENAME_CHARS) return bad(`filename is too long (max ${MAX_FILENAME_CHARS} characters)`);
    if (!filename) filename = null;
  }
  let contentType = null;
  if (b.content_type !== undefined && b.content_type !== null) {
    if (!isStr(b.content_type)) return bad("content_type must be a string");
    contentType = bareMime(b.content_type) || null;
    if (contentType && !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(contentType)) return bad("content_type is not a valid MIME type");
  }
  if (hasUrl) {
    if (!isStr(b.url)) return bad("url must be a string");
    const raw = b.url.trim();
    if (!raw) return bad("url is empty");
    if (raw.length > MAX_URL_CHARS) return bad(`url is too long (max ${MAX_URL_CHARS} characters)`);
    let u;
    try { u = new URL(raw); } catch { return bad("url is not a valid URL"); }
    const why = urlBlockReason(u);
    if (why) return bad(why);
    return { source: "url", url: u.href, filename, contentType, maxChars };
  }
  if (!isStr(b.file_base64)) return bad("file_base64 must be a string");
  if (!b.file_base64.trim()) return bad("file_base64 is empty");
  let bytes;
  try { bytes = b64ToBytes(b.file_base64); } catch { return bad("file_base64 is not valid base64"); }
  if (bytes.length > MAX_FILE_BYTES) return bad(`file is too large: ${bytes.length} bytes (max ${MAX_FILE_BYTES})`, 413);
  const type = resolveType(bytes, filename, contentType);
  if (type.error) return bad(type.error, type.status);
  return { source: "base64", bytes, type, maxChars };
}

// ---------- upstream document fetch (convert via URL) ----------
// Returns { bytes, content_type, final_url } or { status, error }. Follows up to FETCH_MAX_REDIRECTS redirects, re-checking each hop.
async function fetchDocument(startUrl) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    let url = startUrl;
    for (let hop = 0; hop <= FETCH_MAX_REDIRECTS; hop++) {
      let res;
      try { res = await fetch(url, { method: "GET", redirect: "manual", signal: ctl.signal, headers: { "User-Agent": USER_AGENT, Accept: "application/pdf, application/vnd.openxmlformats-officedocument.*, application/vnd.oasis.opendocument.*, text/html, text/plain, text/csv, application/xml, image/*, */*;q=0.5" } }); }
      catch { return { status: 502, error: "Could not fetch url (network error or timeout), no payment taken" }; }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) return { status: 502, error: "url redirected without a location, no payment taken" };
        let next;
        try { next = new URL(loc, url); } catch { return { status: 502, error: "url redirected to an invalid URL, no payment taken" }; }
        if (urlBlockReason(next)) return { status: 502, error: "url redirected to a blocked address, no payment taken" };
        url = next.href;
        try { await res.body?.cancel(); } catch {}
        continue;
      }
      if (!res.ok) return { status: 502, error: `url returned HTTP ${res.status}, no payment taken` };
      const ct = bareMime(res.headers.get("content-type"));
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > MAX_FILE_BYTES) { try { await res.body?.cancel(); } catch {} return { status: 413, error: `file is too large: ${declared} bytes (max ${MAX_FILE_BYTES}), no payment taken` }; }
      const bytes = await readCapped(res, MAX_FILE_BYTES);
      if (!bytes) return { status: 413, error: `file is too large (max ${MAX_FILE_BYTES} bytes), no payment taken` };
      if (!bytes.length) return { status: 502, error: "url returned an empty body, no payment taken" };
      return { bytes, content_type: ct, final_url: url };
    }
    return { status: 502, error: "url redirected too many times, no payment taken" };
  } finally {
    clearTimeout(timer);
  }
}
// Reads a response body up to max bytes; returns null when it exceeds the cap.
async function readCapped(res, max) {
  if (!res.body || typeof res.body.getReader !== "function") {
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.length > max ? null : buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { try { await reader.cancel(); } catch {} return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}

// ---------- conversion ----------
// Runs toMarkdown. Returns { markdown, tokens, mimeType } or { status, error } (422 = file could not be converted, 502 = service failure).
async function runConvert(env, bytes, type) {
  let raw;
  try { raw = await env.AI.toMarkdown({ name: type.name, blob: new Blob([bytes], { type: type.mime }) }); }
  catch { return { status: 502, error: "Document conversion temporarily unavailable, no payment taken" }; }
  const m = Array.isArray(raw) ? raw[0] : raw;
  if (!m || typeof m !== "object") return { status: 502, error: "Document conversion returned no result, no payment taken" };
  if (m.format === "error") return { status: 422, error: `could not convert the file${isStr(m.data) && m.data.trim() ? `: ${m.data.replace(/\s+/g, " ").trim().slice(0, 300)}` : ""} (no payment taken)` };
  if (!isStr(m.data)) return { status: 502, error: "Document conversion returned no text, no payment taken" };
  const tokens = Number.isFinite(Number(m.tokens)) ? Number(m.tokens) : null;
  return { markdown: m.data, tokens, mimeType: isStr(m.mimeType) ? m.mimeType : null };
}
const wordCount = (s) => { const w = s.match(/[\p{L}\p{N}]+(?:['’._-][\p{L}\p{N}]+)*/gu); return w ? w.length : 0; };
function pagesHint(md) {
  const headings = md.match(/^#{1,6} +Page\b/gim);
  if (headings) return headings.length;
  const ff = md.match(/\f/g);
  return ff ? ff.length : null;
}

// ---------- route logic: returns { status, body } (status !== 200 means do not settle) ----------
async function doConvert(env, q) {
  let bytes = q.bytes, type = q.type, sourceUrl = null;
  if (q.source === "url") {
    const got = await fetchDocument(q.url);
    if (got.error) return { status: got.status, body: { error: got.error } };
    bytes = got.bytes;
    sourceUrl = q.url;
    const t = resolveType(bytes, q.filename || new URL(got.final_url).pathname, q.contentType || got.content_type);
    if (t.error) return { status: t.status, body: { error: `${t.error}, no payment taken` } };
    type = t;
  }
  const out = await runConvert(env, bytes, type);
  if (out.error) return { status: out.status, body: { error: out.error } };
  const full = out.markdown.replace(/\r\n?/g, "\n");
  const truncated = full.length > q.maxChars;
  const markdown = truncated ? full.slice(0, q.maxChars) : full;
  return {
    status: 200,
    body: {
      name: type.name,
      mime_type: out.mimeType || type.mime,
      bytes: bytes.length,
      markdown,
      truncated,
      total_chars: full.length,
      tokens: out.tokens,
      word_count: wordCount(full),
      pages_hint: pagesHint(full),
      source_url: sourceUrl,
      converted_at: new Date().toISOString(),
    },
  };
}

// ---------- x402 ----------
function requirements(env) {
  return {
    scheme: "exact",
    network: NETWORK,
    amount: PRICE,
    asset: USDC_BASE,
    payTo: env.PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { name: "USD Coin", version: "2" },
  };
}

const EXAMPLE_INPUT = { url: "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf" };
const EXAMPLE_OUTPUT = {
  name: "dummy.pdf",
  mime_type: "application/pdf",
  bytes: 13264,
  markdown: "Dummy PDF file",
  truncated: false,
  total_chars: 14,
  tokens: 4,
  word_count: 3,
  pages_hint: null,
  source_url: "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
  converted_at: "2026-10-15T12:00:00.000Z",
};
const BODY_PROPS = {
  url: { type: "string", description: `Public http/https URL of the document (${SUPPORTED_LIST}; max ${MAX_FILE_BYTES} bytes). Use this OR file_base64.` },
  file_base64: { type: "string", description: `The file as base64 (data: URL prefix allowed, max ${MAX_FILE_BYTES} decoded bytes). Use this OR url.` },
  filename: { type: "string", description: "Optional: original filename with extension (needed for Office/OpenDocument files sent as base64, e.g. report.docx)" },
  content_type: { type: "string", description: "Optional: MIME type of the file when the filename has no extension" },
  max_chars: { type: "integer", description: `Optional: cap on returned markdown characters, ${MIN_MAX_CHARS}-${MAX_MARKDOWN_CHARS} (default ${MAX_MARKDOWN_CHARS})` },
};
const ROUTE_DESCRIPTION = "Convert a PDF, Office document, spreadsheet, HTML/XML page or image (by URL or base64) to Markdown with Cloudflare toMarkdown.";

function paymentRequired(env, url, error) {
  const bodySchema = { type: "object", properties: BODY_PROPS, required: [], anyOf: [{ required: ["url"] }, { required: ["file_base64"] }] };
  return {
    x402Version: 2,
    error,
    resource: { url: `${url.origin}${ROUTE}`, description: `${SERVICE} convert: ${ROUTE_DESCRIPTION}`, mimeType: "application/json" },
    accepts: [requirements(env)],
    extensions: {
      bazaar: {
        info: {
          input: { type: "http", method: "POST", bodyType: "json", body: EXAMPLE_INPUT },
          output: { type: "json", example: EXAMPLE_OUTPUT },
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
                body: bodySchema,
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
function send402(env, url, error) {
  const pr = paymentRequired(env, url, error);
  return json(pr, 402, { "PAYMENT-REQUIRED": b64e(pr) });
}

function openapi(origin) {
  const convertBody = {
    type: "object",
    properties: {
      url: { type: "string", format: "uri", maxLength: MAX_URL_CHARS, description: `Public http(s) URL of the document (max ${MAX_FILE_BYTES} bytes, ${FETCH_TIMEOUT_MS / 1000} s fetch timeout, up to ${FETCH_MAX_REDIRECTS} redirects). Private, loopback and internal hosts are refused. The type is taken from magic bytes, then the URL path extension, then the Content-Type header.` },
      file_base64: { type: "string", description: `File bytes as base64 (standard or url-safe, data: prefix allowed), max ${MAX_FILE_BYTES} decoded bytes` },
      filename: { type: "string", maxLength: MAX_FILENAME_CHARS, description: "Original filename with extension. PDFs and images are recognized from their bytes; ZIP-based Office/OpenDocument files (docx, xlsx, xlsm, xlsb, ods, odt, numbers) need this or content_type." },
      content_type: { type: "string", description: "MIME type of the file, used when no usable extension is available" },
      max_chars: { type: "integer", minimum: MIN_MAX_CHARS, maximum: MAX_MARKDOWN_CHARS, default: MAX_MARKDOWN_CHARS, description: "Cap on the number of markdown characters returned; truncated is true when the cap cut the text" },
    },
    oneOf: [{ required: ["url"] }, { required: ["file_base64"] }],
  };
  const convertOut = {
    type: "object",
    properties: {
      name: { type: "string", description: "Filename the document was converted as (extension reflects the detected type)" },
      mime_type: { type: "string", description: "MIME type of the source document" },
      bytes: { type: "integer", description: "Size of the source document in bytes" },
      markdown: { type: "string", description: `The document as Markdown (at most max_chars, default ${MAX_MARKDOWN_CHARS} characters)` },
      truncated: { type: "boolean", description: "True when markdown was cut at max_chars" },
      total_chars: { type: "integer", description: "Length of the full conversion before any truncation" },
      tokens: { type: ["integer", "null"], description: "Token count reported by the converter" },
      word_count: { type: "integer", description: "Word count of the full conversion" },
      pages_hint: { type: ["integer", "null"], description: "Number of page markers found in the markdown, or null when the converter emitted none" },
      source_url: { type: ["string", "null"], description: "The url that was fetched, or null for base64 input" },
      converted_at: { type: "string", format: "date-time" },
    },
    required: ["name", "mime_type", "bytes", "markdown", "truncated", "total_chars", "tokens", "word_count", "pages_hint", "source_url", "converted_at"],
  };
  const hdr = (d, type = "string") => ({ description: d, schema: { type } });
  return {
    openapi: "3.1.0",
    info: {
      title: SERVICE,
      version: "1.0.0",
      description: DESCRIPTION,
      "x-guidance": `One POST endpoint paid per call in USDC on Base via x402 (you are only charged when a conversion is returned; every 4xx/5xx is free). If you need to read a PDF, Word/Excel/OpenDocument file, CSV, Apple Numbers, HTML or XML page, or an image (PNG/JPEG/WebP/SVG) and only have a link or the raw bytes, POST /convert {url} or {file_base64, filename?, content_type?}, max_chars? (${MIN_MAX_CHARS}-${MAX_MARKDOWN_CHARS}) for $0.01 and get {name, mime_type, bytes, markdown, truncated, total_chars, tokens, word_count, pages_hint, source_url, converted_at}. url must be a public http(s) URL serving a supported file up to ${MAX_FILE_BYTES} bytes (private/loopback hosts refused, ${FETCH_TIMEOUT_MS / 1000} s timeout, ${FETCH_MAX_REDIRECTS} redirects re-checked). PDFs and images are detected from their bytes; for ZIP-based Office files sent as base64 include filename (e.g. "deck.xlsx") or content_type. Markdown is capped at ${MAX_MARKDOWN_CHARS} characters (truncated=true when cut), so pass a smaller max_chars when you only need the start. Errors, all unpaid: 400 bad input, 413 body over ${MAX_REQUEST_BYTES} bytes or file over ${MAX_FILE_BYTES} bytes, 415 unsupported type, 422 file could not be converted (corrupt or password-protected), 502 url unreachable or converter unavailable. Best for: reading papers, filings, manuals, invoices, spreadsheets and slides behind a link; turning scanned-looking PDFs into text; extracting tables from Excel; pulling the article out of a web page.`,
    },
    servers: [{ url: origin }],
    paths: {
      [ROUTE]: {
        post: {
          operationId: "convertDocument",
          summary: "Convert a document (PDF, Office, spreadsheet, HTML, image) to Markdown",
          tags: ["Documents", "PDF", "Markdown", "Extraction"],
          "x-payment-info": { price: { mode: "fixed", currency: "USD", amount: PRICE_USD }, protocols: [{ x402: {} }] },
          requestBody: { required: true, content: { "application/json": { schema: convertBody } } },
          responses: {
            200: { description: "The document as Markdown", headers: { "PAYMENT-RESPONSE": hdr("Base64 x402 settlement receipt") }, content: { "application/json": { schema: convertOut } } },
            400: { description: "Invalid input: missing url/file_base64, bad URL, private or internal host, bad base64, bad max_chars (no charge)" },
            402: { description: "Payment Required: the PAYMENT-REQUIRED header carries the base64 x402 requirements; also returned when payment verification or settlement fails (no charge)" },
            413: { description: `Request body larger than ${MAX_REQUEST_BYTES} bytes, or file larger than ${MAX_FILE_BYTES} bytes (no charge)` },
            415: { description: `Unsupported file type; supported: ${SUPPORTED_LIST} (no charge)` },
            422: { description: "The file was recognized but could not be converted (corrupt, encrypted or empty) (no charge)" },
            502: { description: "url unreachable, non-2xx, empty, redirected to a blocked address or too many times; or the converter is temporarily unavailable (no charge)" },
          },
        },
      },
    },
  };
}

export default {
  async fetch(request, env0) {
    const env = { ...env0, PAY_TO: (env0 && env0.PAY_TO) || DEFAULT_PAY_TO };
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "PAYMENT-SIGNATURE, Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE" } });
    }
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        service: SERVICE,
        description: DESCRIPTION,
        openapi: `${url.origin}/openapi.json`,
        endpoints: { [ROUTE]: { method: "POST", url: `${url.origin}${ROUTE}`, price: `$${PRICE_USD.replace(/0+$/, "")} USDC on Base per request (x402)`, description: ROUTE_DESCRIPTION, example_body: EXAMPLE_INPUT, max_request_bytes: MAX_REQUEST_BYTES } },
        supported_types: Object.keys(EXT_MIME),
        limits: { max_file_bytes: MAX_FILE_BYTES, max_request_bytes: MAX_REQUEST_BYTES, max_markdown_chars: MAX_MARKDOWN_CHARS, max_chars_range: [MIN_MAX_CHARS, MAX_MARKDOWN_CHARS], fetch_timeout_ms: FETCH_TIMEOUT_MS, max_redirects: FETCH_MAX_REDIRECTS },
        no_charge_on: ["400 invalid input or blocked url", "413 body or file too large", "415 unsupported file type", "422 file could not be converted", "502 url unreachable or converter unavailable"],
        configured: Boolean(env.PAY_TO) && Boolean(env.AI),
        facilitator: env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET ? "cdp" : "payai",
      });
    }
    if (url.pathname === "/openapi.json" || url.pathname === "/.well-known/openapi.json") return json(openapi(url.origin));
    const route = url.pathname.replace(/\/+$/, "") || url.pathname;
    if (route !== ROUTE) return json({ error: `Not found. Use POST ${ROUTE}` }, 404);
    if (!env.PAY_TO || !/^0x[0-9a-fA-F]{40}$/.test(env.PAY_TO)) return json({ error: "Service not configured: PAY_TO wallet address missing" }, 500);
    if (!env.AI || typeof env.AI.toMarkdown !== "function") return json({ error: "Service not configured: Workers AI binding (AI) with toMarkdown missing" }, 500);
    if (request.method !== "GET" && request.method !== "POST") return json({ error: "Use POST" }, 405);
    const len = Number(request.headers.get("content-length"));
    if (Number.isFinite(len) && len > MAX_REQUEST_BYTES) return json({ error: `Request body too large (max ${MAX_REQUEST_BYTES} bytes) (no payment was taken)` }, 413);

    const header = request.headers.get("PAYMENT-SIGNATURE") || request.headers.get("X-PAYMENT");
    if (!header) return send402(env, url, "PAYMENT-SIGNATURE header is required");
    if (request.method !== "POST") return json({ error: `Use POST ${ROUTE} with a JSON body (no payment was taken)` }, 405);
    const rb = await readBody(request, MAX_REQUEST_BYTES);
    if (rb.error) return json({ error: `${rb.error} (no payment was taken)` }, rb.status || 400);
    const q = validateConvert(rb.body);
    if (q.error) return json({ error: `${q.error} (no payment was taken)` }, q.status || 400);

    let payload;
    try { payload = b64d(header); } catch { return json({ error: "Invalid payment payload" }, 400); }
    const reqs = requirements(env);
    if (payload.x402Version !== 2 || !deepEqual(payload.accepted, reqs)) return send402(env, url, "No matching payment requirements found");

    const fac = facilitator(env);
    const body = { x402Version: 2, paymentPayload: payload, paymentRequirements: reqs };
    let v;
    try { v = await fac.call("verify", body); } catch (e) { return json({ error: "Facilitator unreachable", detail: String(e) }, 500); }
    if (!v.ok || !v.data.isValid) return send402(env, url, v.data.invalidReason || v.data.error || `verify failed (${v.status})`);

    let result;
    try { result = await doConvert(env, q); } catch { return json({ error: "Document conversion temporarily unavailable, no payment taken" }, 502); }
    if (result.status !== 200) return json(result.body, result.status);

    let s;
    try { s = await fac.call("settle", body); } catch (e) { return json({ error: "Facilitator unreachable", detail: String(e) }, 500); }
    if (!s.ok || !s.data.success) {
      const fail = { success: false, errorReason: s.data.errorReason || s.data.error || `settle failed (${s.status})`, transaction: "", network: NETWORK, payer: s.data.payer || v.data.payer };
      return json({}, 402, { "PAYMENT-RESPONSE": b64e(fail) });
    }
    const receipt = b64e({ success: true, transaction: s.data.transaction, network: s.data.network || NETWORK, payer: s.data.payer || v.data.payer });
    return json(result.body, 200, { "PAYMENT-RESPONSE": receipt });
  },
};
