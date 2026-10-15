// NoJunk QR — paid (x402) QR Code generation for AI agents.
// A complete ISO/IEC 18004 QR Code encoder (versions 1-40, ECC L/M/Q/H, numeric/alphanumeric/byte modes,
// Reed-Solomon over GF(256), all 8 masks with the 4 penalty rules) plus SVG and PNG writers, all computed inside
// the Worker: no upstream services, no AI binding, no API keys. Agents pay per call in USDC on Base and are only
// charged when a valid QR code is returned.
// Settings (Cloudflare Worker > Settings > Variables and Secrets):
//   PAY_TO              (optional) Base wallet address that receives USDC (defaults to DEFAULT_PAY_TO)
//   CDP_API_KEY_ID      (optional) Coinbase Developer Platform API key id   -> enables Bazaar listing
//   CDP_API_KEY_SECRET  (optional, Secret) Coinbase Developer Platform API key secret
// Without the CDP keys the service uses the keyless PayAI facilitator.

const DEFAULT_PAY_TO = "0x6f762720b8515b7091e6aa69e8361f7b9909233f"; // Mick's Base wallet
const NETWORK = "eip155:8453"; // Base mainnet
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CDP_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
const PAYAI_URL = "https://facilitator.payai.network";
const SERVICE = "NoJunk QR";
const DESCRIPTION =
  "Pay-per-call QR Code generation for agents: turn any text, URL, Wi-Fi string or payment URI (up to 1500 characters) into a standards-compliant QR Code as crisp SVG, real PNG or a JSON module matrix; batch up to 25 codes in one call. Full ISO/IEC 18004 encoder (versions 1-40, ECC L/M/Q/H) computed in the Worker, no upstream services. You are only charged when a valid QR code is returned.";
const USER_AGENT = "NoJunk QR/1.0 (+https://nojunkcrypto.com)";
const SAMPLE_TEXT = "https://nojunkcrypto.com";

const MIN_TEXT_CHARS = 1;
const MAX_TEXT_CHARS = 1500;
const MIN_SIZE = 128;
const MAX_SIZE = 2048;
const DEFAULT_SIZE = 512;
const MIN_MARGIN = 0;
const MAX_MARGIN = 8;
const DEFAULT_MARGIN = 4;
const DEFAULT_ECC = "M";
const DEFAULT_DARK = "#000000";
const DEFAULT_LIGHT = "#FFFFFF";
const MAX_BATCH_ITEMS = 25;
const FORMATS = ["svg", "png", "json"];
const BATCH_FORMATS = ["svg", "json"];
const MAX_REQUEST_BYTES = 64 * 1024;

// Per-route prices in USDC atomic units (6 decimals) and request-body caps (413 before any payment work).
const ROUTES = {
  "/qr": { name: "qr", price: "1000", usd: "0.001000", max_request_bytes: MAX_REQUEST_BYTES },
  "/qr/batch": { name: "batch", price: "5000", usd: "0.005000", max_request_bytes: MAX_REQUEST_BYTES },
};

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

// Turns GET query parameters into the same object shape a POST body would have.
function queryBody(url, route) {
  const p = url.searchParams;
  const b = {};
  for (const k of ["format", "size", "margin", "ecc", "dark", "light"]) if (p.has(k)) b[k] = p.get(k);
  if (route === "/qr") {
    if (p.has("text")) b.text = p.get("text");
  } else {
    if (p.has("items")) {
      try { b.items = JSON.parse(p.get("items")); } catch { b.items = p.get("items"); }
    } else if (p.has("text")) {
      const texts = p.getAll("text"), labels = p.getAll("label");
      b.items = texts.map((text, i) => (labels[i] !== undefined ? { text, label: labels[i] } : { text }));
    }
  }
  return b;
}

// =====================================================================================================
// QR Code encoder (ISO/IEC 18004), implemented from scratch. Nothing here touches the network.
// =====================================================================================================

// ECC level -> ordinal (table index) and the 2-bit value used in the format information.
const ECC_LEVELS = { L: { ord: 0, fmt: 1 }, M: { ord: 1, fmt: 0 }, Q: { ord: 2, fmt: 3 }, H: { ord: 3, fmt: 2 } };
const ECC_NAMES = ["L", "M", "Q", "H"];

// Total number of codewords (data + error correction) per version; index = version (0 unused).
const TOTAL_CODEWORDS = [0,
  26, 44, 70, 100, 134, 172, 196, 242, 292, 346,
  404, 466, 532, 581, 655, 733, 815, 901, 991, 1085,
  1156, 1258, 1364, 1474, 1588, 1706, 1828, 1921, 2051, 2185,
  2323, 2465, 2611, 2761, 2876, 3034, 3196, 3362, 3532, 3706];

// Error-correction codewords per block, [ecc ordinal][version] (version 0 unused).
const EC_CODEWORDS_PER_BLOCK = [
  [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // L
  [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28], // M
  [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // Q
  [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // H
];

// Number of error-correction blocks, [ecc ordinal][version] (version 0 unused).
const EC_BLOCKS = [
  [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25], // L
  [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49], // M
  [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68], // Q
  [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81], // H
];

const ALPHANUMERIC_CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
// Mode indicator (4 bits) and character-count indicator widths for version groups 1-9, 10-26, 27-40.
const MODES = {
  numeric: { indicator: 1, ccBits: [10, 12, 14] },
  alphanumeric: { indicator: 2, ccBits: [9, 11, 13] },
  byte: { indicator: 4, ccBits: [8, 16, 16] },
};
const ccBitsFor = (mode, version) => MODES[mode].ccBits[version <= 9 ? 0 : version <= 26 ? 1 : 2];

// Picks the cheapest mode that can represent the text; returns { mode, chars, count, bytes? }.
function analyzeText(text) {
  if (/^[0-9]+$/.test(text)) return { mode: "numeric", count: text.length };
  const chars = Array.from(text);
  if (chars.every((c) => ALPHANUMERIC_CHARSET.includes(c))) return { mode: "alphanumeric", count: chars.length };
  const bytes = new TextEncoder().encode(text);
  return { mode: "byte", count: bytes.length, bytes };
}

// Number of bits the data payload takes (excluding mode indicator and character count).
function payloadBits(info) {
  if (info.mode === "numeric") return Math.floor(info.count / 3) * 10 + [0, 4, 7][info.count % 3];
  if (info.mode === "alphanumeric") return Math.floor(info.count / 2) * 11 + (info.count % 2) * 6;
  return info.count * 8;
}

const dataCodewords = (version, eccOrd) => TOTAL_CODEWORDS[version] - EC_CODEWORDS_PER_BLOCK[eccOrd][version] * EC_BLOCKS[eccOrd][version];

// Smallest version whose data capacity fits the text at the given ECC, or null when even version 40 is too small.
function chooseVersion(info, eccOrd) {
  for (let v = 1; v <= 40; v++) {
    const needed = 4 + ccBitsFor(info.mode, v) + payloadBits(info);
    if (needed <= dataCodewords(v, eccOrd) * 8) return v;
  }
  return null;
}

// ---- bit buffer ----
class BitBuffer {
  constructor() { this.bits = []; }
  append(value, length) { for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1); }
  get length() { return this.bits.length; }
}

// Builds the final data codewords (mode, count, payload, terminator, padding) for the chosen version.
function buildDataCodewords(text, info, version, eccOrd) {
  const bb = new BitBuffer();
  bb.append(MODES[info.mode].indicator, 4);
  bb.append(info.count, ccBitsFor(info.mode, version));
  if (info.mode === "numeric") {
    for (let i = 0; i < text.length; i += 3) {
      const chunk = text.slice(i, i + 3);
      bb.append(parseInt(chunk, 10), chunk.length * 3 + 1);
    }
  } else if (info.mode === "alphanumeric") {
    const chars = Array.from(text);
    let i = 0;
    for (; i + 1 < chars.length; i += 2) bb.append(ALPHANUMERIC_CHARSET.indexOf(chars[i]) * 45 + ALPHANUMERIC_CHARSET.indexOf(chars[i + 1]), 11);
    if (i < chars.length) bb.append(ALPHANUMERIC_CHARSET.indexOf(chars[i]), 6);
  } else {
    for (const b of info.bytes) bb.append(b, 8);
  }
  const capacityBits = dataCodewords(version, eccOrd) * 8;
  if (bb.length > capacityBits) throw new Error("data overflow");
  bb.append(0, Math.min(4, capacityBits - bb.length)); // terminator
  if (bb.length % 8) bb.append(0, 8 - (bb.length % 8)); // byte-align
  for (let pad = 0xec; bb.length < capacityBits; pad ^= 0xec ^ 0x11) bb.append(pad, 8); // pad codewords 236, 17, 236, 17 ...
  const out = new Uint8Array(bb.length / 8);
  bb.bits.forEach((bit, i) => { out[i >>> 3] |= bit << (7 - (i & 7)); });
  return out;
}

// ---- Reed-Solomon over GF(256) with the QR primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11D) ----
function gfMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}
// Generator polynomial of the given degree: product of (x - a^i) for i = 0 .. degree-1 (coefficients, leading term omitted).
function rsGenerator(degree) {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 2);
  }
  return result;
}
// Remainder of data(x) * x^degree divided by the generator: the error-correction codewords for one block.
function rsRemainder(data, generator) {
  const result = new Uint8Array(generator.length);
  for (const b of data) {
    const factor = b ^ result[0];
    result.copyWithin(0, 1);
    result[generator.length - 1] = 0;
    for (let i = 0; i < generator.length; i++) result[i] ^= gfMultiply(generator[i], factor);
  }
  return result;
}

// Splits the data codewords into blocks, appends EC codewords to each and interleaves them per the standard.
function addEccAndInterleave(data, version, eccOrd) {
  const numBlocks = EC_BLOCKS[eccOrd][version];
  const blockEccLen = EC_CODEWORDS_PER_BLOCK[eccOrd][version];
  const rawCodewords = TOTAL_CODEWORDS[version];
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const shortDataLen = shortBlockLen - blockEccLen;
  const generator = rsGenerator(blockEccLen);
  const blocks = [];
  let k = 0;
  for (let i = 0; i < numBlocks; i++) {
    const datLen = shortDataLen + (i < numShortBlocks ? 0 : 1);
    const dat = data.slice(k, k + datLen);
    k += datLen;
    blocks.push({ data: dat, ec: rsRemainder(dat, generator) });
  }
  const result = new Uint8Array(rawCodewords);
  let o = 0;
  for (let i = 0; i <= shortDataLen; i++) for (let j = 0; j < numBlocks; j++) if (i < blocks[j].data.length) result[o++] = blocks[j].data[i];
  for (let i = 0; i < blockEccLen; i++) for (let j = 0; j < numBlocks; j++) result[o++] = blocks[j].ec[i];
  return { codewords: result, blocks };
}

// ---- matrix ----
// Alignment pattern centre coordinates for a version (same list for rows and columns).
function alignmentPositions(version) {
  if (version === 1) return [];
  const size = version * 4 + 17;
  const numAlign = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

// 15-bit format information: 2 ECC bits + 3 mask bits, BCH(15,5) remainder, XOR mask 0x5412.
function formatBits(eccFmt, mask) {
  const data = (eccFmt << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}
// 18-bit version information (versions 7-40): 6 version bits + BCH(18,6) remainder.
function versionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

class Matrix {
  constructor(size) {
    this.size = size;
    this.modules = new Uint8Array(size * size); // 1 = dark
    this.isFunction = new Uint8Array(size * size);
  }
  get(x, y) { return this.modules[y * this.size + x]; }
  set(x, y, dark) { this.modules[y * this.size + x] = dark ? 1 : 0; }
  setFunction(x, y, dark) { const i = y * this.size + x; this.modules[i] = dark ? 1 : 0; this.isFunction[i] = 1; }
}

function drawFinder(m, cx, cy) {
  for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
    const x = cx + dx, y = cy + dy;
    if (x < 0 || y < 0 || x >= m.size || y >= m.size) continue;
    const dist = Math.max(Math.abs(dx), Math.abs(dy));
    m.setFunction(x, y, dist !== 2 && dist !== 4); // includes the light separator ring (dist 4)
  }
}
function drawAlignment(m, cx, cy) {
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) m.setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
}
function drawFormat(m, eccFmt, mask) {
  const bits = formatBits(eccFmt, mask);
  const bit = (i) => ((bits >>> i) & 1) === 1;
  const s = m.size;
  // First copy around the top-left finder
  for (let i = 0; i <= 5; i++) m.setFunction(8, i, bit(i));
  m.setFunction(8, 7, bit(6));
  m.setFunction(8, 8, bit(7));
  m.setFunction(7, 8, bit(8));
  for (let i = 9; i < 15; i++) m.setFunction(14 - i, 8, bit(i));
  // Second copy: bottom-left column and top-right row
  for (let i = 0; i < 8; i++) m.setFunction(s - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) m.setFunction(8, s - 15 + i, bit(i));
  m.setFunction(8, s - 8, true); // dark module
}
function drawVersion(m, version) {
  if (version < 7) return;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) === 1;
    const a = m.size - 11 + (i % 3), b = Math.floor(i / 3);
    m.setFunction(a, b, dark);
    m.setFunction(b, a, dark);
  }
}
function drawFunctionPatterns(m, version, eccFmt) {
  for (let i = 0; i < m.size; i++) { m.setFunction(6, i, i % 2 === 0); m.setFunction(i, 6, i % 2 === 0); } // timing
  drawFinder(m, 3, 3); drawFinder(m, m.size - 4, 3); drawFinder(m, 3, m.size - 4);
  const pos = alignmentPositions(version), n = pos.length;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue; // overlaps a finder
    drawAlignment(m, pos[i], pos[j]);
  }
  drawFormat(m, eccFmt, 0); // placeholder, redrawn with the chosen mask
  drawVersion(m, version);
}
// Places the interleaved codewords in the zigzag order (two columns at a time, skipping the vertical timing column).
function drawCodewords(m, codewords) {
  const s = m.size;
  let i = 0;
  const total = codewords.length * 8;
  for (let right = s - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < s; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? s - 1 - vert : vert;
        if (!m.isFunction[y * s + x] && i < total) {
          m.set(x, y, ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1);
          i++;
        }
        // remaining modules (remainder bits) stay light
      }
    }
  }
}
// The 8 mask conditions: a module is inverted when the condition is true.
const MASK_FN = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];
function applyMask(m, mask) {
  const fn = MASK_FN[mask], s = m.size;
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const i = y * s + x;
    if (!m.isFunction[i] && fn(x, y)) m.modules[i] ^= 1;
  }
}

// Penalty score of the current matrix per the four ISO 18004 rules.
const PENALTY_N1 = 3, PENALTY_N2 = 3, PENALTY_N3 = 40, PENALTY_N4 = 10;
const FINDER_PATTERNS = [/(?=00001011101)/g, /(?=10111010000)/g]; // 1:1:3:1:1 with four light modules on one side
function penaltyScore(m) {
  const s = m.size;
  let score = 0;
  const lines = [];
  for (let y = 0; y < s; y++) { let row = ""; for (let x = 0; x < s; x++) row += m.get(x, y); lines.push(row); }
  for (let x = 0; x < s; x++) { let col = ""; for (let y = 0; y < s; y++) col += m.get(x, y); lines.push(col); }
  for (const line of lines) {
    // Rule 1: runs of 5 or more same-coloured modules
    let run = 1;
    for (let i = 1; i <= s; i++) {
      if (i < s && line[i] === line[i - 1]) run++;
      else { if (run >= 5) score += PENALTY_N1 + run - 5; run = 1; }
    }
    // Rule 3: finder-like patterns
    for (const re of FINDER_PATTERNS) { re.lastIndex = 0; let mt; while ((mt = re.exec(line)) !== null) { score += PENALTY_N3; re.lastIndex = mt.index + 1; } }
  }
  // Rule 2: 2x2 blocks of the same colour
  for (let y = 0; y < s - 1; y++) for (let x = 0; x < s - 1; x++) {
    const c = m.get(x, y);
    if (c === m.get(x + 1, y) && c === m.get(x, y + 1) && c === m.get(x + 1, y + 1)) score += PENALTY_N2;
  }
  // Rule 4: deviation of the dark-module proportion from 50%, in 5% steps
  let dark = 0;
  for (const v of m.modules) dark += v;
  const total = s * s;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  score += k * PENALTY_N4;
  return score;
}

// Encodes text at the given ECC level. Returns { version, ecc, mode, mask, modules, matrix (Uint8Array), size, penalties, data, blocks }.
// Throws when the text does not fit version 40. forceMask (0-7) skips mask selection; only used by tests.
function encodeQR(text, ecc, forceMask = -1) {
  const eccOrd = ECC_LEVELS[ecc].ord, eccFmt = ECC_LEVELS[ecc].fmt;
  const info = analyzeText(text);
  const version = chooseVersion(info, eccOrd);
  if (!version) throw new Error("text does not fit");
  const data = buildDataCodewords(text, info, version, eccOrd);
  const { codewords, blocks } = addEccAndInterleave(data, version, eccOrd);
  const size = version * 4 + 17;
  const m = new Matrix(size);
  drawFunctionPatterns(m, version, eccFmt);
  drawCodewords(m, codewords);
  let best = -1, bestScore = Infinity;
  const penalties = [];
  for (let mask = 0; mask < 8; mask++) {
    applyMask(m, mask);
    drawFormat(m, eccFmt, mask);
    const score = penaltyScore(m);
    penalties.push(score);
    if (score < bestScore) { bestScore = score; best = mask; }
    applyMask(m, mask); // undo (XOR)
  }
  if (forceMask >= 0) best = forceMask;
  applyMask(m, best);
  drawFormat(m, eccFmt, best);
  return { version, ecc, mode: info.mode, mask: best, modules: size, size, matrix: m.modules, isFunction: m.isFunction, penalties, data, blocks, codewords };
}

// ---------- renderers ----------
const rowStrings = (q) => Array.from({ length: q.size }, (_, y) => { let s = ""; for (let x = 0; x < q.size; x++) s += q.matrix[y * q.size + x]; return s; });

// SVG: viewBox in modules (including the quiet zone), one path for every dark module, crisp edges.
function renderSvg(q, opts) {
  const total = q.size + 2 * opts.margin;
  let d = "";
  for (let y = 0; y < q.size; y++) {
    for (let x = 0; x < q.size; x++) {
      if (!q.matrix[y * q.size + x]) continue;
      let run = 1;
      while (x + run < q.size && q.matrix[y * q.size + x + run]) run++;
      d += `M${x + opts.margin} ${y + opts.margin}h${run}v1h-${run}z`;
      x += run - 1;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${opts.size}" height="${opts.size}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img"><rect width="${total}" height="${total}" fill="${opts.light}"/><path d="${d}" fill="${opts.dark}"/></svg>`;
}

// ---- minimal PNG writer: 1-bit palette image, zlib "stored" deflate blocks, CRC32 + Adler-32 ----
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(bytes) { let c = 0xffffffff; for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function adler32(bytes) { let a = 1, b = 0; for (let i = 0; i < bytes.length; i++) { a = (a + bytes[i]) % 65521; b = (b + a) % 65521; } return ((b << 16) | a) >>> 0; }
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
function pngChunk(type, data) {
  const td = new Uint8Array(4 + data.length);
  for (let i = 0; i < 4; i++) td[i] = type.charCodeAt(i);
  td.set(data, 4);
  const out = new Uint8Array(12 + data.length);
  out.set(u32(data.length), 0);
  out.set(td, 4);
  out.set(u32(crc32(td)), 8 + data.length);
  return out;
}
// zlib stream with uncompressed deflate blocks (max 65535 bytes each).
function zlibStored(raw) {
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const out = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  out[0] = 0x78; out[1] = 0x01;
  let o = 2, p = 0;
  for (let i = 0; i < blocks; i++) {
    const len = Math.min(65535, raw.length - p);
    out[o++] = i === blocks - 1 ? 1 : 0;
    out[o++] = len & 255; out[o++] = len >>> 8;
    out[o++] = ~len & 255; out[o++] = (~len >>> 8) & 255;
    out.set(raw.subarray(p, p + len), o);
    o += len; p += len;
  }
  out.set(u32(adler32(raw)), o);
  return out;
}
const hexRgb = (hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
// Pixel geometry shared by the PNG writer (and documented for clients): integer module scale, centred.
function pngGeometry(q, opts) {
  const total = q.size + 2 * opts.margin;
  const scale = Math.floor(opts.size / total);
  const offset = Math.floor((opts.size - scale * total) / 2);
  return { total, scale, offset };
}
function renderPng(q, opts) {
  const { scale, offset } = pngGeometry(q, opts);
  const px = opts.size;
  const rowBytes = Math.ceil(px / 8);
  const raw = new Uint8Array(px * (rowBytes + 1));
  for (let y = 0; y < px; y++) {
    const my = Math.floor((y - offset) / scale) - opts.margin;
    const rowStart = y * (rowBytes + 1) + 1; // filter byte 0 at rowStart - 1
    if (y < offset || my < 0 || my >= q.size) continue; // light row
    const rowOff = my * q.size;
    for (let x = offset; x < px; x++) {
      const mx = Math.floor((x - offset) / scale) - opts.margin;
      if (mx < 0 || mx >= q.size) continue;
      if (q.matrix[rowOff + mx]) raw[rowStart + (x >>> 3)] |= 0x80 >>> (x & 7);
    }
  }
  const ihdr = new Uint8Array([...u32(px), ...u32(px), 1, 3, 0, 0, 0]); // 1-bit, indexed colour
  const plte = new Uint8Array([...hexRgb(opts.light), ...hexRgb(opts.dark)]); // index 0 light, 1 dark
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", ihdr), pngChunk("PLTE", plte), pngChunk("IDAT", zlibStored(raw)), pngChunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ---------- validators (pure functions; the encoder is deterministic so fit checks happen here, before payment) ----------
const HEX_RE = /^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/;
function parseColor(v, name) {
  if (!isStr(v)) return { error: `${name} must be a hex color string like #RRGGBB` };
  const m = HEX_RE.exec(v.trim());
  if (!m) return { error: `${name} must be a hex color like #RRGGBB or #RGB` };
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return { value: `#${h.toUpperCase()}` };
}
function parseIntIn(v, name, min, max) {
  if (typeof v === "boolean" || (isStr(v) && !v.trim())) return { error: `${name} must be an integer from ${min} to ${max}` };
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) return { error: `${name} must be an integer from ${min} to ${max}` };
  return { value: n };
}
// Shared rendering options. Returns { error } or the options object.
function parseOptions(b, formats) {
  const bad = (m) => ({ status: 400, error: m });
  let format = "svg";
  if (b.format !== undefined && b.format !== null) {
    if (!isStr(b.format) || !formats.includes(b.format.toLowerCase())) return bad(`format must be one of ${formats.join(", ")}`);
    format = b.format.toLowerCase();
  }
  let size = DEFAULT_SIZE, margin = DEFAULT_MARGIN, ecc = DEFAULT_ECC, dark = DEFAULT_DARK, light = DEFAULT_LIGHT;
  if (b.size !== undefined && b.size !== null) { const r = parseIntIn(b.size, "size", MIN_SIZE, MAX_SIZE); if (r.error) return bad(r.error); size = r.value; }
  if (b.margin !== undefined && b.margin !== null) { const r = parseIntIn(b.margin, "margin", MIN_MARGIN, MAX_MARGIN); if (r.error) return bad(r.error); margin = r.value; }
  if (b.ecc !== undefined && b.ecc !== null) {
    if (!isStr(b.ecc) || !ECC_NAMES.includes(b.ecc.toUpperCase())) return bad("ecc must be one of L, M, Q, H");
    ecc = b.ecc.toUpperCase();
  }
  if (b.dark !== undefined && b.dark !== null) { const r = parseColor(b.dark, "dark"); if (r.error) return bad(r.error); dark = r.value; }
  if (b.light !== undefined && b.light !== null) { const r = parseColor(b.light, "light"); if (r.error) return bad(r.error); light = r.value; }
  if (dark === light) return bad("dark and light colors must differ");
  return { format, size, margin, ecc, dark, light };
}
// Validates one text and checks it fits version 40 at the ECC. Returns { error } or { text, info, version }.
function checkText(v, ecc, label) {
  if (v === undefined || v === null) return { error: `Missing required parameter: ${label}` };
  if (!isStr(v)) return { error: `${label} must be a string` };
  const chars = Array.from(v).length;
  if (chars < MIN_TEXT_CHARS) return { error: `${label} must not be empty` };
  if (chars > MAX_TEXT_CHARS) return { error: `${label} is too long: ${chars} characters (max ${MAX_TEXT_CHARS})` };
  const info = analyzeText(v);
  const version = chooseVersion(info, ECC_LEVELS[ecc].ord);
  if (!version) {
    const bits = dataCodewords(40, ECC_LEVELS[ecc].ord) * 8 - 4 - ccBitsFor(info.mode, 40);
    const max = info.mode === "byte" ? Math.floor(bits / 8) : info.mode === "numeric" ? Math.floor(bits / 10) * 3 : Math.floor(bits / 11) * 2;
    return { error: `${label} does not fit a QR code at ECC ${ecc}: ${info.count} ${info.mode === "byte" ? "UTF-8 bytes" : info.mode + " characters"}, version 40 holds ${max} - use a lower ecc or shorter text` };
  }
  return { text: v, info, version };
}

function validateQr(b) {
  const bad = (m, status = 400) => ({ status, error: m });
  const o = parseOptions(b, FORMATS);
  if (o.error) return o;
  const t = checkText(b.text, o.ecc, "text");
  if (t.error) return bad(t.error);
  if (o.format === "png") {
    const total = t.version * 4 + 17 + 2 * o.margin;
    if (o.size < total) return bad(`size ${o.size} is too small for this QR code: version ${t.version} with margin ${o.margin} needs at least ${total} px (one pixel per module)`);
  }
  return { ...o, text: t.text, version: t.version };
}

function validateBatch(b) {
  const bad = (m, status = 400) => ({ status, error: m });
  const o = parseOptions(b, BATCH_FORMATS);
  if (o.error) return o;
  if (b.items === undefined || b.items === null) return bad("Missing required parameter: items (array of {text, label?})");
  if (!Array.isArray(b.items)) return bad("items must be an array of {text, label?}");
  if (b.items.length < 1) return bad("items must contain at least 1 item");
  if (b.items.length > MAX_BATCH_ITEMS) return bad(`items has ${b.items.length} entries (max ${MAX_BATCH_ITEMS})`);
  const items = [];
  for (let i = 0; i < b.items.length; i++) {
    const it = b.items[i];
    if (!it || typeof it !== "object" || Array.isArray(it)) return bad(`items[${i}] must be an object {text, label?}`);
    const t = checkText(it.text, o.ecc, `items[${i}].text`);
    if (t.error) return bad(t.error);
    let label = null;
    if (it.label !== undefined && it.label !== null) {
      if (!isStr(it.label)) return bad(`items[${i}].label must be a string`);
      label = it.label.trim().slice(0, 200);
      if (!label) label = null;
    }
    items.push({ text: t.text, label, version: t.version });
  }
  return { ...o, items };
}

const VALIDATORS = { qr: validateQr, batch: validateBatch };

// ---------- route logic (runs after verify; deterministic, so any throw -> 502 without settle) ----------
function doQr(q) {
  const code = encodeQR(q.text, q.ecc);
  const headers = { "X-QR-Version": String(code.version), "X-QR-Modules": String(code.modules) };
  if (q.format === "png") return { status: 200, bytes: renderPng(code, q), contentType: "image/png", headers };
  const svg = renderSvg(code, q);
  if (q.format === "svg") return { status: 200, text: svg, contentType: "image/svg+xml; charset=utf-8", headers };
  return { status: 200, body: { version: code.version, ecc: code.ecc, modules: code.modules, mask: code.mask, mode: code.mode, matrix: rowStrings(code), svg }, headers };
}

function doBatch(q) {
  const items = q.items.map((it) => {
    const code = encodeQR(it.text, q.ecc);
    const out = { label: it.label, text: it.text, version: code.version, modules: code.modules };
    if (q.format === "svg") out.svg = renderSvg(code, q);
    else out.matrix = rowStrings(code);
    return out;
  });
  return { status: 200, body: { count: items.length, ecc: q.ecc, format: q.format, items }, headers: { "X-QR-Count": String(items.length) } };
}

const HANDLERS = { qr: doQr, batch: doBatch };

const EXPOSE = "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-QR-Version, X-QR-Modules, X-QR-Count";
// Builds the 200 response once payment has settled.
function successResponse(result, receiptHeader) {
  const common = { "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": EXPOSE, "PAYMENT-RESPONSE": receiptHeader, "Cache-Control": "no-store", ...result.headers };
  if (result.bytes) return new Response(result.bytes, { status: 200, headers: { "Content-Type": result.contentType, "Content-Length": String(result.bytes.length), ...common } });
  if (result.text !== undefined) return new Response(result.text, { status: 200, headers: { "Content-Type": result.contentType, ...common } });
  return new Response(JSON.stringify(result.body, null, 2), { status: 200, headers: { "Content-Type": "application/json", ...common } });
}

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

const exampleCode = (text) => { const c = encodeQR(text, "M"); const o = { size: 256, margin: 4, dark: DEFAULT_DARK, light: DEFAULT_LIGHT }; return { version: c.version, ecc: c.ecc, modules: c.modules, mask: c.mask, mode: c.mode, matrix: rowStrings(c), svg: renderSvg(c, o) }; };
const EXAMPLE_QR = exampleCode("https://nojunkcrypto.com/?ref=agent");
const EXAMPLE_BATCH = [["home", "https://nojunkcrypto.com"], ["wifi", "WIFI:T:WPA;S:MyNetwork;P:secret123;;"]].map(([label, text]) => { const c = exampleCode(text); return { label, text, version: c.version, modules: c.modules, matrix: c.matrix }; });
const EXAMPLES = {
  "/qr": {
    input: { text: "https://nojunkcrypto.com/?ref=agent", format: "json", size: 256, margin: 4, ecc: "M", dark: "#000000", light: "#FFFFFF" },
    output: EXAMPLE_QR,
  },
  "/qr/batch": {
    input: { items: EXAMPLE_BATCH.map(({ label, text }) => ({ text, label })), format: "json", ecc: "M" },
    output: { count: 2, ecc: "M", format: "json", items: EXAMPLE_BATCH },
  },
};
const OPTION_PROPS = {
  size: { type: "integer", description: `Optional: output width/height in pixels, ${MIN_SIZE}-${MAX_SIZE} (default ${DEFAULT_SIZE}); SVG scales freely, PNG uses whole pixels per module centred in the image` },
  margin: { type: "integer", description: `Optional: quiet zone in modules, ${MIN_MARGIN}-${MAX_MARGIN} (default ${DEFAULT_MARGIN}; the standard recommends 4)` },
  ecc: { type: "string", description: `Optional: error correction level L (7%), M (15%, default), Q (25%) or H (30%); higher levels survive more damage but hold less text` },
  dark: { type: "string", description: `Optional: hex color of the dark modules (default ${DEFAULT_DARK})` },
  light: { type: "string", description: `Optional: hex color of the background (default ${DEFAULT_LIGHT})` },
};
const BODY_PROPS = {
  "/qr": {
    text: { type: "string", description: `The content to encode (${MIN_TEXT_CHARS}-${MAX_TEXT_CHARS} characters, UTF-8): URL, plain text, WIFI:..., mailto:, tel:, vCard, payment URI...` },
    format: { type: "string", description: 'Optional: "svg" (default; body is the SVG document), "png" (body is PNG bytes) or "json" ({version, ecc, modules, matrix, svg})' },
    ...OPTION_PROPS,
  },
  "/qr/batch": {
    items: { type: "array", description: `1-${MAX_BATCH_ITEMS} items, each {text (${MIN_TEXT_CHARS}-${MAX_TEXT_CHARS} chars), label?}`, items: { type: "object", properties: { text: { type: "string" }, label: { type: "string" } }, required: ["text"] } },
    format: { type: "string", description: 'Optional: "svg" (default; each item carries its SVG document) or "json" (each item carries its 0/1 matrix)' },
    ...OPTION_PROPS,
  },
};
const REQUIRED_PROPS = { "/qr": ["text"], "/qr/batch": ["items"] };
const ROUTE_DESCRIPTIONS = {
  "/qr": "Encode one text as a QR Code (ISO/IEC 18004, versions 1-40, ECC L/M/Q/H) and return it as SVG, PNG or a JSON matrix.",
  "/qr/batch": `Encode up to ${MAX_BATCH_ITEMS} texts as QR Codes in one call; returns JSON with an SVG or matrix per item.`,
};
const RESOURCE_MIME = { "/qr": "image/svg+xml", "/qr/batch": "application/json" };

function paymentRequired(env, url, route, error) {
  const resourceUrl = `${url.origin}${route}`;
  const bodySchema = { type: "object", properties: BODY_PROPS[route], required: REQUIRED_PROPS[route] };
  return {
    x402Version: 2,
    error,
    resource: { url: resourceUrl, description: `${SERVICE} ${ROUTES[route].name}: ${ROUTE_DESCRIPTIONS[route]}`, mimeType: RESOURCE_MIME[route] },
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
function send402(env, url, route, error) {
  const pr = paymentRequired(env, url, route, error);
  return json(pr, 402, { "PAYMENT-REQUIRED": b64e(pr) });
}

function openapi(origin) {
  const optionSchemas = {
    size: { type: "integer", minimum: MIN_SIZE, maximum: MAX_SIZE, default: DEFAULT_SIZE, description: "Output width and height in pixels. SVG: width/height attributes (scales losslessly). PNG: image dimensions; each module is drawn with a whole number of pixels and the code is centred, so sizes that are a multiple of (modules + 2*margin) fill the image exactly." },
    margin: { type: "integer", minimum: MIN_MARGIN, maximum: MAX_MARGIN, default: DEFAULT_MARGIN, description: "Quiet zone around the code, in modules" },
    ecc: { type: "string", enum: ECC_NAMES, default: DEFAULT_ECC, description: "Error correction level: L recovers ~7% damage, M ~15%, Q ~25%, H ~30%. Higher levels need a bigger version for the same text." },
    dark: { type: "string", pattern: "^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$", default: DEFAULT_DARK, description: "Hex color of the dark modules" },
    light: { type: "string", pattern: "^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$", default: DEFAULT_LIGHT, description: "Hex color of the light modules / background (must differ from dark)" },
  };
  const qrBody = {
    type: "object",
    properties: {
      text: { type: "string", minLength: MIN_TEXT_CHARS, maxLength: MAX_TEXT_CHARS, description: "Content to encode, UTF-8. Digits-only text uses numeric mode and A-Z 0-9 space $%*+-./: uses alphanumeric mode automatically (smaller codes); everything else is byte mode (UTF-8, no ECI). Must fit version 40 at the chosen ecc (byte mode: 2953 bytes at L, 2331 at M, 1663 at Q, 1273 at H)." },
      format: { type: "string", enum: FORMATS, default: "svg", description: "svg: the response body is an SVG document (image/svg+xml). png: the body is a PNG image (image/png, 1-bit palette). json: {version, ecc, modules, mask, mode, matrix, svg}." },
      ...optionSchemas,
    },
    required: ["text"],
  };
  const batchBody = {
    type: "object",
    properties: {
      items: { type: "array", minItems: 1, maxItems: MAX_BATCH_ITEMS, items: { type: "object", properties: { text: { type: "string", minLength: MIN_TEXT_CHARS, maxLength: MAX_TEXT_CHARS }, label: { type: "string", description: "Optional: echoed back to help you match results (max 200 chars)" } }, required: ["text"] } },
      format: { type: "string", enum: BATCH_FORMATS, default: "svg", description: "svg: each item has an svg string; json: each item has a matrix (array of 0/1 strings)" },
      ...optionSchemas,
    },
    required: ["items"],
  };
  const matrixSchema = { type: "array", items: { type: "string", pattern: "^[01]+$" }, description: "One string per row, one character per module: 1 = dark, 0 = light, without the quiet zone" };
  const qrJson = {
    type: "object",
    properties: {
      version: { type: "integer", minimum: 1, maximum: 40, description: "QR version (symbol size = 17 + 4*version modules)" },
      ecc: { type: "string", enum: ECC_NAMES },
      modules: { type: "integer", description: "Modules per side" },
      mask: { type: "integer", minimum: 0, maximum: 7, description: "Mask pattern that was chosen (lowest penalty)" },
      mode: { type: "string", enum: ["numeric", "alphanumeric", "byte"], description: "Encoding mode selected for the text" },
      matrix: matrixSchema,
      svg: { type: "string", description: "The same code as an SVG document (with quiet zone and colors applied)" },
    },
    required: ["version", "ecc", "modules", "mask", "mode", "matrix", "svg"],
  };
  const batchOut = {
    type: "object",
    properties: {
      count: { type: "integer" },
      ecc: { type: "string", enum: ECC_NAMES },
      format: { type: "string", enum: BATCH_FORMATS },
      items: { type: "array", items: { type: "object", properties: { label: { type: ["string", "null"] }, text: { type: "string" }, version: { type: "integer" }, modules: { type: "integer" }, svg: { type: "string" }, matrix: matrixSchema }, required: ["label", "text", "version", "modules"] } },
    },
    required: ["count", "ecc", "format", "items"],
  };
  const hdr = (d, type = "string") => ({ description: d, schema: { type } });
  const payInfo = (route) => ({ price: { mode: "fixed", currency: "USD", amount: ROUTES[route].usd }, protocols: [{ x402: {} }] });
  const commonErrors = {
    400: { description: "Invalid input: empty or too-long text, text that does not fit version 40 at the chosen ecc, bad size/margin/ecc/color, too many items, or PNG size smaller than the module count (no charge)" },
    402: { description: "Payment Required: the PAYMENT-REQUIRED header carries the base64 x402 requirements; also returned when payment verification or settlement fails (no charge)" },
    413: { description: `Request body (or URL) larger than ${MAX_REQUEST_BYTES} bytes (no charge)` },
    502: { description: "Encoder failure (no charge)" },
  };
  const queryParams = (props, required) => Object.entries(props).map(([name, schema]) => ({ name, in: "query", required: required.includes(name), schema: name === "items" ? { type: "string", description: "JSON-encoded array of {text, label?}; alternatively repeat text= (and label=) parameters" } : schema, description: schema.description }));
  const qrResponses = {
    200: {
      description: "The QR code. format=svg (default): the body is the SVG document; format=png: the body is the PNG image; format=json: a JSON object with the module matrix and the SVG.",
      headers: { "PAYMENT-RESPONSE": hdr("Base64 x402 settlement receipt"), "X-QR-Version": hdr("QR version 1-40", "integer"), "X-QR-Modules": hdr("Modules per side (17 + 4*version)", "integer") },
      content: { "image/svg+xml": { schema: { type: "string" } }, "image/png": { schema: { type: "string", format: "binary" } }, "application/json": { schema: qrJson } },
    },
    ...commonErrors,
  };
  const batchResponses = {
    200: { description: "One result per item, in input order", headers: { "PAYMENT-RESPONSE": hdr("Base64 x402 settlement receipt"), "X-QR-Count": hdr("Number of codes returned", "integer") }, content: { "application/json": { schema: batchOut } } },
    ...commonErrors,
  };
  return {
    openapi: "3.1.0",
    info: {
      title: SERVICE,
      version: "1.0.0",
      description: DESCRIPTION,
      "x-guidance": `Two endpoints paid per call in USDC on Base via x402 (you are only charged when a valid QR code is returned; every 4xx/5xx is free). Both accept POST with a JSON body or GET with the same fields as query parameters. POST /qr {text (${MIN_TEXT_CHARS}-${MAX_TEXT_CHARS} chars), format?: "svg"|"png"|"json" (default svg), size?: ${MIN_SIZE}-${MAX_SIZE} px (default ${DEFAULT_SIZE}), margin?: ${MIN_MARGIN}-${MAX_MARGIN} modules (default ${DEFAULT_MARGIN}), ecc?: "L"|"M"|"Q"|"H" (default ${DEFAULT_ECC}), dark?: hex (default ${DEFAULT_DARK}), light?: hex (default ${DEFAULT_LIGHT})} costs $0.001; with format=svg the 200 body IS the SVG document (Content-Type image/svg+xml), with format=png the body IS the PNG (image/png), with format=json you get {version, ecc, modules, mask, mode, matrix (array of "0/1" strings per row), svg}; every response carries X-QR-Version and X-QR-Modules. POST /qr/batch {items: [{text, label?}] (1-${MAX_BATCH_ITEMS}), format?: "svg"|"json", same options} costs $0.005 and returns {count, ecc, format, items: [{label, text, version, modules, svg or matrix}]}. The encoder is a full ISO/IEC 18004 implementation (versions 1-40, numeric/alphanumeric/byte mode selection, Reed-Solomon, all 8 masks) running inside the Worker, so results are deterministic and there is no upstream to fail. Request bodies over ${MAX_REQUEST_BYTES} bytes are rejected with 413 before any payment work. Free: GET /sample.svg shows the QR for ${SAMPLE_TEXT}. Best for: links on receipts, invoices, tickets and posters, Wi-Fi join codes, crypto payment URIs, vCards, 2FA/otpauth URIs, app deep links, batch label printing.`,
    },
    servers: [{ url: origin }],
    paths: {
      "/qr": {
        post: { operationId: "createQr", summary: "Encode text as a QR Code (SVG, PNG or JSON)", tags: ["QR", "Image", "Encoding"], "x-payment-info": payInfo("/qr"), requestBody: { required: true, content: { "application/json": { schema: qrBody } } }, responses: qrResponses },
        get: { operationId: "createQrGet", summary: "Encode text as a QR Code via query parameters", tags: ["QR", "Image", "Encoding"], "x-payment-info": payInfo("/qr"), parameters: queryParams(qrBody.properties, qrBody.required), responses: qrResponses },
      },
      "/qr/batch": {
        post: { operationId: "createQrBatch", summary: `Encode up to ${MAX_BATCH_ITEMS} texts as QR Codes in one call`, tags: ["QR", "Image", "Encoding", "Batch"], "x-payment-info": payInfo("/qr/batch"), requestBody: { required: true, content: { "application/json": { schema: batchBody } } }, responses: batchResponses },
        get: { operationId: "createQrBatchGet", summary: "Batch encode via query parameters (items as JSON, or repeated text=)", tags: ["QR", "Image", "Encoding", "Batch"], "x-payment-info": payInfo("/qr/batch"), parameters: queryParams(batchBody.properties, batchBody.required), responses: batchResponses },
      },
      "/sample.svg": {
        get: { operationId: "sampleQr", summary: `Free sample: the QR Code for ${SAMPLE_TEXT}`, tags: ["QR", "Free"], responses: { 200: { description: "SVG document", content: { "image/svg+xml": { schema: { type: "string" } } } } } },
      },
    },
  };
}

export default {
  async fetch(request, env0) {
    const env = { ...env0, PAY_TO: (env0 && env0.PAY_TO) || DEFAULT_PAY_TO };
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "PAYMENT-SIGNATURE, Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Expose-Headers": EXPOSE } });
    }
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        service: SERVICE,
        description: DESCRIPTION,
        openapi: `${url.origin}/openapi.json`,
        sample: `${url.origin}/sample.svg`,
        endpoints: Object.fromEntries(Object.keys(ROUTES).map((r) => [r, { method: "POST or GET", url: `${url.origin}${r}`, price: `$${ROUTES[r].usd.replace(/0+$/, "")} USDC on Base per request (x402)`, description: ROUTE_DESCRIPTIONS[r], example_body: EXAMPLES[r].input, max_request_bytes: ROUTES[r].max_request_bytes }])),
        limits: { text_chars: [MIN_TEXT_CHARS, MAX_TEXT_CHARS], size_px: [MIN_SIZE, MAX_SIZE], margin_modules: [MIN_MARGIN, MAX_MARGIN], ecc: ECC_NAMES, formats: FORMATS, batch_items: [1, MAX_BATCH_ITEMS], versions: [1, 40] },
        no_charge_on: ["400 invalid input or text that does not fit", "413 body too large", "502 encoder failure"],
        configured: Boolean(env.PAY_TO),
        facilitator: env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET ? "cdp" : "payai",
      });
    }
    if (url.pathname === "/openapi.json" || url.pathname === "/.well-known/openapi.json") return json(openapi(url.origin));
    if (url.pathname === "/sample.svg") {
      if (request.method !== "GET") return json({ error: "Use GET" }, 405);
      const code = encodeQR(SAMPLE_TEXT, DEFAULT_ECC);
      const svg = renderSvg(code, { size: 256, margin: DEFAULT_MARGIN, dark: DEFAULT_DARK, light: DEFAULT_LIGHT });
      return new Response(svg, { status: 200, headers: { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "public, max-age=86400", "Access-Control-Allow-Origin": "*", "X-QR-Version": String(code.version), "X-QR-Modules": String(code.modules) } });
    }
    const route = url.pathname.replace(/\/+$/, "") || url.pathname;
    if (!ROUTES[route]) return json({ error: `Not found. Use POST or GET ${Object.keys(ROUTES).join(", ")}` }, 404);
    if (!env.PAY_TO || !/^0x[0-9a-fA-F]{40}$/.test(env.PAY_TO)) return json({ error: "Service not configured: PAY_TO wallet address missing" }, 500);
    if (request.method !== "GET" && request.method !== "POST") return json({ error: "Use POST or GET" }, 405);
    const maxBytes = ROUTES[route].max_request_bytes;
    const len = Number(request.headers.get("content-length"));
    if (Number.isFinite(len) && len > maxBytes) return json({ error: `Request body too large (max ${maxBytes} bytes) (no payment was taken)` }, 413);
    if (request.url.length > maxBytes) return json({ error: `Request URL too long (max ${maxBytes} bytes) (no payment was taken)` }, 413);

    const header = request.headers.get("PAYMENT-SIGNATURE") || request.headers.get("X-PAYMENT");
    if (!header) return send402(env, url, route, "PAYMENT-SIGNATURE header is required");
    let body;
    if (request.method === "POST") {
      const rb = await readBody(request, maxBytes);
      if (rb.error) return json({ error: `${rb.error} (no payment was taken)` }, rb.status || 400);
      body = rb.body;
    } else {
      body = queryBody(url, route);
    }
    const q = VALIDATORS[ROUTES[route].name](body);
    if (q.error) return json({ error: `${q.error} (no payment was taken)` }, q.status || 400);

    let payload;
    try { payload = b64d(header); } catch { return json({ error: "Invalid payment payload" }, 400); }
    const reqs = requirements(env, route);
    if (payload.x402Version !== 2 || !deepEqual(payload.accepted, reqs)) return send402(env, url, route, "No matching payment requirements found");

    const fac = facilitator(env);
    const fbody = { x402Version: 2, paymentPayload: payload, paymentRequirements: reqs };
    let v;
    try { v = await fac.call("verify", fbody); } catch (e) { return json({ error: "Facilitator unreachable", detail: String(e) }, 500); }
    if (!v.ok || !v.data.isValid) return send402(env, url, route, v.data.invalidReason || v.data.error || `verify failed (${v.status})`);

    let result;
    try { result = HANDLERS[ROUTES[route].name](q); } catch { return json({ error: "QR encoder failed, no payment taken" }, 502); }
    if (result.status !== 200) return json(result.body, result.status);

    let s;
    try { s = await fac.call("settle", fbody); } catch (e) { return json({ error: "Facilitator unreachable", detail: String(e) }, 500); }
    if (!s.ok || !s.data.success) {
      const fail = { success: false, errorReason: s.data.errorReason || s.data.error || `settle failed (${s.status})`, transaction: "", network: NETWORK, payer: s.data.payer || v.data.payer };
      return json({}, 402, { "PAYMENT-RESPONSE": b64e(fail) });
    }
    const receipt = b64e({ success: true, transaction: s.data.transaction, network: s.data.network || NETWORK, payer: s.data.payer || v.data.payer });
    return successResponse(result, receipt);
  },
};

// Encoder internals exported for the test suite (ignored by the Workers runtime).
export const qr = { encodeQR, analyzeText, chooseVersion, buildDataCodewords, addEccAndInterleave, rsGenerator, rsRemainder, formatBits, versionBits, alignmentPositions, penaltyScore, applyMask, Matrix, MASK_FN, renderSvg, renderPng, pngGeometry, TOTAL_CODEWORDS, EC_CODEWORDS_PER_BLOCK, EC_BLOCKS, ECC_LEVELS };
