// NoJunk Web Search — a paid (x402) web search API for AI agents.
// Runs one web search (DuckDuckGo lite HTML, parsed in-worker, no libs) and returns up to
// 10 results {rank, title, url, domain, snippet} as JSON. No API keys, no rate limits: agents pay per call.
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
const SERVICE = "NoJunk Web Search";
const DESCRIPTION =
  "Cheap web search for AI agents: give it a query, get up to 10 live web results back as JSON (rank, title, url, domain, snippet). Optional region (e.g. us-en) and safe-search level. Sources tried in order: DuckDuckGo, Bing, Yahoo. Results link to the live web; pair with a /read service to fetch the pages.";

// Sources are tried in this order; the first one that yields at least one organic result wins.
const DDG_URL = "https://lite.duckduckgo.com/lite/";
const BING_URL = "https://www.bing.com/search";
const YAHOO_URL = "https://search.yahoo.com/search";
// The engines serve plain HTML pages to browser-like clients; this UA is what they expect.
const UPSTREAM_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const TIMEOUT_MS = 8000; // each upstream fetch must finish within this
const CACHE_TTL_S = 120; // upstream HTML cached in caches.default for this long, keyed by the upstream URL
const MAX_QUERY_CHARS = 400;
const MAX_COUNT = 10;
const DEFAULT_COUNT = 10;
const MAX_REQUEST_BYTES = 16 * 1024; // POST bodies larger than this are rejected with 413
const SAFE_LEVELS = { strict: "1", moderate: "-1", off: "-2" }; // DDG kp values
const HEALTH_QUERY = "cloudflare workers";

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


// ---------- HTML entities ----------
const LATIN1 = "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac12 frac14 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml".split(" ");
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", sbquo: "‚", ldquo: "“", rdquo: "”", bdquo: "„", bull: "•", dagger: "†", Dagger: "‡", permil: "‰", lsaquo: "‹", rsaquo: "›", euro: "€", trade: "™", larr: "←", uarr: "↑", rarr: "→", darr: "↓", harr: "↔", prime: "′", Prime: "″", minus: "−", ne: "≠", le: "≤", ge: "≥", asymp: "≈", infin: "∞", ensp: " ", emsp: " ", thinsp: " ", zwnj: "‌", zwj: "‍", lrm: "‎", rlm: "‏", check: "✓", star: "☆", OElig: "Œ", oelig: "œ", Scaron: "Š", scaron: "š", Yuml: "Ÿ", fnof: "ƒ", alpha: "α", beta: "β", gamma: "γ", delta: "δ", lambda: "λ", mu: "μ", pi: "π", sigma: "σ", omega: "ω", Delta: "Δ", Sigma: "Σ", Omega: "Ω" };
LATIN1.forEach((n, i) => { ENTITIES[n] = String.fromCharCode(160 + i); });
// Windows-1252 code points that are commonly (mis)used as numeric references (e.g. &#146;)
const CP1252 = { 128: 0x20ac, 130: 0x201a, 131: 0x0192, 132: 0x201e, 133: 0x2026, 134: 0x2020, 135: 0x2021, 136: 0x02c6, 137: 0x2030, 138: 0x0160, 139: 0x2039, 140: 0x0152, 142: 0x017d, 145: 0x2018, 146: 0x2019, 147: 0x201c, 148: 0x201d, 149: 0x2022, 150: 0x2013, 151: 0x2014, 152: 0x02dc, 153: 0x2122, 154: 0x0161, 155: 0x203a, 156: 0x0153, 158: 0x017e, 159: 0x0178 };

function decodeEntities(s) {
  if (s.indexOf("&") === -1) return s;
  return s.replace(/&(?:#[xX]([0-9a-fA-F]{1,6})|#([0-9]{1,7})|([a-zA-Z][a-zA-Z0-9]{1,31}));?/g, (m, hex, dec, name) => {
    let cp;
    if (hex !== undefined) cp = parseInt(hex, 16);
    else if (dec !== undefined) cp = parseInt(dec, 10);
    else return name in ENTITIES ? ENTITIES[name] : m;
    if (CP1252[cp]) cp = CP1252[cp];
    if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "�";
    return String.fromCodePoint(cp);
  });
}

// ---------- DDG lite HTML parsing (tolerant: regex + attribute scanner, no DOM) ----------
function parseAttrs(s) {
  const attrs = {};
  const re = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(s))) {
    const name = m[1].toLowerCase();
    if (!(name in attrs)) attrs[name] = decodeEntities(m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : "");
  }
  return attrs;
}
const hasClass = (attrs, cls) => (" " + (attrs.class || "") + " ").toLowerCase().includes(" " + cls + " ");
// Visible text of an HTML fragment: tags stripped, entities decoded, whitespace (incl. nbsp) collapsed.
// Inline tags (<b>, <i>, <a>, <span>...) vanish; line/block tags (<br>, <p>, <td>, <div>...) become a space.
const textOf = (frag) => decodeEntities(frag.replace(/<\/?(?:br|p|div|td|tr|th|li|ul|ol|table|h[1-6]|hr)\b[^>]*>/gi, " ").replace(/<[^>]*>/g, "")).replace(/[\s ]+/g, " ").trim();

// First element `tag` inside `seg` whose class list contains `cls`; returns its inner HTML or null.
function innerOfClass(seg, tag, cls) {
  const re = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}\\s*>`, "gi");
  let m;
  while ((m = re.exec(seg))) if (hasClass(parseAttrs(m[1]), cls)) return m[2];
  return null;
}

// DDG result hrefs are either direct, or redirectors like //duckduckgo.com/l/?uddg=<encoded target>&rut=...
function resolveResultUrl(href) {
  if (!href) return null;
  href = href.trim();
  if (href.startsWith("//")) href = "https:" + href;
  else if (href.startsWith("/")) href = "https://duckduckgo.com" + href;
  let u;
  try { u = new URL(href); } catch { return null; }
  if (/(^|\.)duckduckgo\.com$/i.test(u.hostname) && /^\/l\/?$/.test(u.pathname)) {
    const target = u.searchParams.get("uddg");
    if (!target) return null;
    try { u = new URL(target); } catch { return null; }
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (/(^|\.)duckduckgo\.com$/i.test(u.hostname)) return null; // internal links (y.js ads, settings, ...)
  return u.toString();
}
const domainOf = (url) => { try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };

// A page with no parseable results is a block/CAPTCHA page if it talks like one; otherwise a clean "no results".
const looksBlocked = (html) => /anomaly|bots? use|challenge|captcha|unusual traffic|not a robot|verify (?:that )?you|automated (?:queries|access|traffic)/i.test(html);
// Open tags <tag ...> whose class list contains `cls`, with their positions and parsed attrs.
function openTags(html, tag, cls) {
  const out = [];
  const re = new RegExp(`<${tag}\\b([^>]*)>`, "gi");
  let m;
  while ((m = re.exec(html))) { const attrs = parseAttrs(m[1]); if (cls === null || hasClass(attrs, cls)) out.push({ start: m.index, end: re.lastIndex, attrs }); }
  return out;
}
// Finalize a raw result list: drop broken ones, dedupe by URL, attach domain.
function finalize(raw) {
  const results = [], seen = new Set();
  for (const r of raw) {
    if (!r.url || !r.title || seen.has(r.url)) continue;
    seen.add(r.url);
    results.push({ title: r.title, url: r.url, domain: domainOf(r.url), snippet: r.snippet || "" });
  }
  return results;
}
const firstInner = (seg, tag) => { const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, "i").exec(seg); return m ? m[1] : null; };

// ---- DuckDuckGo lite: table rows; <a class="result-link"> + <td class="result-snippet"> + <span class="link-text"> ----
function parseDdg(html) {
  const anchors = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = parseAttrs(m[1]);
    if (hasClass(attrs, "result-link")) anchors.push({ start: m.index, end: re.lastIndex, attrs, inner: m[2] });
  }
  if (!anchors.length) return { results: [], anomaly: looksBlocked(html) };
  const raw = [];
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    const href = a.attrs.href || "";
    if (hasClass(a.attrs, "result-sponsored") || /result-sponsored/i.test(a.attrs.class || "") || /duckduckgo\.com\/y\.js/i.test(href) || /^\/\/?y\.js/i.test(href)) continue;
    // Everything up to the next result anchor belongs to this result (snippet row, url row).
    const seg = html.slice(a.end, i + 1 < anchors.length ? anchors[i + 1].start : html.length);
    const sn = innerOfClass(seg, "td", "result-snippet");
    raw.push({ title: textOf(a.inner), url: resolveResultUrl(href), snippet: sn === null ? "" : textOf(sn) });
  }
  return { results: finalize(raw), anomaly: false };
}

// ---- Bing HTML: <li class="b_algo"> blocks with <h2><a href>TITLE</a></h2> and a <p> snippet; ads are <li class="b_ad"> ----
// bing.com/ck/a redirector: the real URL is in the "u" param, base64url after an "a1" prefix.
function resolveBingUrl(href) {
  if (!href) return null;
  href = href.trim();
  let u;
  try { u = new URL(href, "https://www.bing.com/"); } catch { return null; }
  if (/(^|\.)bing\.com$/i.test(u.hostname) && /^\/ck\/a\/?$/i.test(u.pathname)) {
    const enc = u.searchParams.get("u");
    if (!enc || !/^a1/.test(enc)) return null;
    try {
      const b64 = enc.slice(2).replace(/-/g, "+").replace(/_/g, "/");
      const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
      u = new URL(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    } catch { return null; }
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (/(^|\.)bing\.com$/i.test(u.hostname) || /(^|\.)microsoft\.com$/i.test(u.hostname) && /^\/?(ads|aclick)/i.test(u.pathname)) return null;
  return u.toString();
}
function parseBing(html) {
  // Segment by result/ad <li> boundaries so an ad block never leaks into an organic one.
  const lis = openTags(html, "li", null).filter((t) => hasClass(t.attrs, "b_algo") || hasClass(t.attrs, "b_ad") || hasClass(t.attrs, "b_ans"));
  const algos = lis.filter((t) => hasClass(t.attrs, "b_algo"));
  if (!algos.length) return { results: [], anomaly: looksBlocked(html) };
  const raw = [];
  for (const t of algos) {
    const next = lis.find((x) => x.start > t.start);
    const seg = html.slice(t.end, next ? next.start : html.length);
    const h2 = firstInner(seg, "h2");
    if (h2 === null) continue;
    const am = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/i.exec(h2);
    if (!am) continue;
    const attrs = parseAttrs(am[1]);
    const after = seg.slice(seg.indexOf(h2) + h2.length);
    const p = firstInner(after, "p"); // snippet <p> is either a direct child or inside <div class="b_caption">
    raw.push({ title: textOf(am[2]), url: resolveBingUrl(attrs.href), snippet: p === null ? "" : textOf(p) });
  }
  return { results: finalize(raw), anomaly: false };
}

// ---- Yahoo: <div class="algo"> blocks with <h3 class="title"><a href>TITLE</a></h3> and <p class="s-desc"> / <div class="compText"><p> ----
// r.search.yahoo.com redirector: the real URL is the URL-encoded "/RU=...../RK=" path segment.
function resolveYahooUrl(href) {
  if (!href) return null;
  href = href.trim();
  let u;
  try { u = new URL(href, "https://search.yahoo.com/"); } catch { return null; }
  if (/(^|\.)yahoo\.com$/i.test(u.hostname) && /^r\./i.test(u.hostname)) {
    const m = /\/RU=([^/]+?)\/R[KS]=/i.exec(u.pathname) || /\/RU=([^/]+)$/i.exec(u.pathname);
    if (!m) return null;
    try { u = new URL(decodeURIComponent(m[1])); } catch { return null; }
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (/(^|\.)yahoo\.com$/i.test(u.hostname) && /^(r|search|s)\./i.test(u.hostname)) return null;
  return u.toString();
}
function parseYahoo(html) {
  const divs = openTags(html, "div", null).filter((t) => hasClass(t.attrs, "algo") || hasClass(t.attrs, "ads") || hasClass(t.attrs, "ad"));
  const algos = divs.filter((t) => hasClass(t.attrs, "algo"));
  if (!algos.length) return { results: [], anomaly: looksBlocked(html) };
  const raw = [];
  for (const t of algos) {
    const next = divs.find((x) => x.start > t.start);
    const seg = html.slice(t.end, next ? next.start : html.length);
    const h3 = innerOfClass(seg, "h3", "title");
    if (h3 === null) continue;
    const am = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/i.exec(h3);
    if (!am) continue;
    const attrs = parseAttrs(am[1]);
    const after = seg.slice(seg.indexOf(h3) + h3.length);
    let sn = innerOfClass(after, "p", "s-desc");
    if (sn === null) { const comp = innerOfClass(after, "div", "compText"); if (comp !== null) sn = firstInner(comp, "p"); }
    if (sn === null) sn = firstInner(after, "p");
    raw.push({ title: textOf(am[2]), url: resolveYahooUrl(attrs.href), snippet: sn === null ? "" : textOf(sn) });
  }
  return { results: finalize(raw), anomaly: false };
}

const SOURCES = [
  { name: "DuckDuckGo", parse: parseDdg, url: (q) => { const u = new URL(DDG_URL); u.searchParams.set("q", q.q); if (q.region) u.searchParams.set("kl", q.region); u.searchParams.set("kp", SAFE_LEVELS[q.safe]); return u.toString(); } },
  // Fallbacks always ask for MAX_COUNT results (count is applied after parsing) so cache keys do not fragment by count.
  { name: "Bing", parse: parseBing, url: (q) => { const u = new URL(BING_URL); u.searchParams.set("q", q.q); u.searchParams.set("count", String(MAX_COUNT)); u.searchParams.set("setlang", "en"); u.searchParams.set("cc", "us"); return u.toString(); } },
  { name: "Yahoo", parse: parseYahoo, url: (q) => { const u = new URL(YAHOO_URL); u.searchParams.set("p", q.q); u.searchParams.set("n", String(MAX_COUNT)); return u.toString(); } },
];

// ---------- fetching ----------
class FetchError extends Error { constructor(status, message) { super(message); this.status = status; } }

function cacheStore() {
  try { return typeof caches !== "undefined" && caches && caches.default ? caches.default : null; } catch { return null; }
}

// Returns { html, cached } or throws FetchError(502, message).
async function fetchUpstream(ddgUrl) {
  const cache = cacheStore();
  if (cache) {
    try { const hit = await cache.match(ddgUrl); if (hit) return { html: await hit.text(), cached: true }; } catch {}
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    let res;
    try {
      res = await fetch(ddgUrl, { method: "GET", redirect: "follow", signal: ctrl.signal, headers: { "user-agent": UPSTREAM_UA, accept: "text/html", "accept-language": "en-US,en;q=0.9" } });
    } catch (e) {
      if (ctrl.signal.aborted) throw new FetchError(502, `The search engine did not respond within ${TIMEOUT_MS / 1000} seconds`);
      throw new FetchError(502, `Could not reach the search engine: ${String(e && e.message ? e.message : e).slice(0, 200)}`);
    }
    if (res.status < 200 || res.status >= 300) { try { if (res.body) await res.body.cancel(); } catch {} throw new FetchError(502, `The search engine responded with HTTP ${res.status}`); }
    let html;
    try { html = await res.text(); } catch (e) {
      if (ctrl.signal.aborted) throw new FetchError(502, `The search engine did not finish sending within ${TIMEOUT_MS / 1000} seconds`);
      throw new FetchError(502, `Could not read the search engine response: ${String(e && e.message ? e.message : e).slice(0, 200)}`);
    }
    return { html, cached: false };
  } finally {
    clearTimeout(timer);
  }
}

function cachePut(ddgUrl, html, ctx) {
  const cache = cacheStore();
  if (!cache) return;
  const res = new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": `public, max-age=${CACHE_TTL_S}` } });
  const p = Promise.resolve().then(() => cache.put(ddgUrl, res)).catch(() => {});
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(p);
  return p;
}

// Runs the search end to end, trying each source in order until one yields results.
// Returns { status, body } — status !== 200 means do not settle.
async function search(q, ctx) {
  const problems = [];
  let sawEmpty = false;
  for (const src of SOURCES) {
    const upstream = src.url(q);
    let page;
    try { page = await fetchUpstream(upstream); } catch (e) { problems.push(`${src.name}: ${e.message || "could not be reached"}`); continue; }
    let parsed;
    try { parsed = src.parse(page.html); } catch (e) { problems.push(`${src.name}: results could not be parsed (${String(e && e.message ? e.message : e).slice(0, 100)})`); continue; }
    if (parsed.anomaly) { problems.push(`${src.name}: refusing automated queries (challenge page)`); continue; }
    if (!parsed.results.length) { sawEmpty = true; problems.push(`${src.name}: no results`); continue; }
    if (!page.cached) { const p = cachePut(upstream, page.html, ctx); if (p && !(ctx && typeof ctx.waitUntil === "function")) await p; }
    const results = parsed.results.slice(0, q.count).map((r, i) => ({ rank: i + 1, title: r.title, url: r.url, domain: r.domain, snippet: r.snippet }));
    return {
      status: 200,
      body: { query: q.q, region: q.region, safe: q.safe, count: results.length, results, source: src.name, fetched_at: new Date().toISOString() },
    };
  }
  if (sawEmpty) return { status: 404, body: { error: `No results found for this query (${problems.join("; ")}); no payment was taken.`, query: q.q, region: q.region, safe: q.safe } };
  return { status: 502, body: { error: `All search sources failed: ${problems.join("; ")}. Try again shortly; no payment was taken.`, query: q.q } };
}

// ---------- params ----------
async function readParams(request, url) {
  const p = Object.fromEntries(url.searchParams);
  if (request.method === "POST") {
    try { const b = await request.clone().json(); if (b && typeof b === "object" && !Array.isArray(b)) Object.assign(p, b); } catch {}
  }
  const str = (v) => (v === undefined || v === null ? undefined : String(v));
  return { q: str(p.q), count: p.count, region: str(p.region), safe: str(p.safe) };
}

// Returns { error } or { q, count, region, safe }
function validate(p) {
  const fail = (msg) => ({ error: `${msg} (no payment was taken)` });
  if (typeof p.q !== "string" || !p.q.trim()) return fail("Missing required parameter: q (the search query)");
  const q = p.q.replace(/\s+/g, " ").trim();
  if (q.length > MAX_QUERY_CHARS) return fail(`q is too long (max ${MAX_QUERY_CHARS} characters)`);
  let count = DEFAULT_COUNT;
  if (p.count !== undefined && p.count !== null && p.count !== "") {
    const n = typeof p.count === "number" ? p.count : /^\s*\d+\s*$/.test(String(p.count)) ? Number(p.count) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > MAX_COUNT) return fail(`count must be an integer from 1 to ${MAX_COUNT}`);
    count = n;
  }
  let region = null;
  if (p.region !== undefined && p.region.trim() !== "") {
    region = p.region.trim().toLowerCase();
    if (!/^[a-z]{2,3}-[a-z]{2,3}$/.test(region)) return fail("region must be a DuckDuckGo region code like us-en, uk-en, de-de or wt-wt");
  }
  let safe = "moderate";
  if (p.safe !== undefined && p.safe.trim() !== "") {
    safe = p.safe.trim().toLowerCase();
    if (!(safe in SAFE_LEVELS)) return fail('safe must be one of "moderate", "off" or "strict"');
  }
  return { q, count, region, safe };
}

// ---------- x402 ----------
function requirements(env) {
  return {
    scheme: "exact",
    network: NETWORK,
    amount: PRICE_ATOMIC,
    asset: USDC_BASE,
    payTo: env.PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { name: "USD Coin", version: "2" },
  };
}
const EXAMPLE_OUTPUT = {
  query: "cloudflare workers pricing",
  region: null,
  safe: "moderate",
  count: 2,
  results: [
    { rank: 1, title: "Pricing · Cloudflare Workers docs", url: "https://developers.cloudflare.com/workers/platform/pricing/", domain: "developers.cloudflare.com", snippet: "Workers Free and Workers Paid plans: 100,000 requests per day free, then $5 per month for 10 million requests..." },
    { rank: 2, title: "Cloudflare Workers | Serverless Computing", url: "https://workers.cloudflare.com/", domain: "workers.cloudflare.com", snippet: "Build serverless applications and deploy instantly across the globe for exceptional performance, reliability, and scale." },
  ],
  source: "DuckDuckGo",
  fetched_at: "2026-10-15T12:00:00.000Z",
};
function paymentRequired(env, url, error) {
  const resourceUrl = `${url.origin}/search`;
  return {
    x402Version: 2,
    error,
    resource: { url: resourceUrl, description: DESCRIPTION, mimeType: "application/json" },
    accepts: [requirements(env)],
    extensions: {
      bazaar: {
        info: {
          input: { type: "http", method: "GET", queryParams: { q: "cloudflare workers pricing", count: "10", region: "us-en", safe: "moderate" } },
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
                method: { type: "string", enum: ["GET", "HEAD", "DELETE"] },
                queryParams: {
                  type: "object",
                  properties: {
                    q: { type: "string", minLength: 1, maxLength: MAX_QUERY_CHARS, description: "Search query, 1-400 characters" },
                    count: { type: "string", description: "Max results to return, 1-10 (default 10)" },
                    region: { type: "string", description: "Optional DuckDuckGo region code such as us-en, uk-en, de-de (default: no region)" },
                    safe: { type: "string", enum: ["moderate", "off", "strict"], description: "Safe-search level (default moderate)" },
                  },
                  required: ["q"],
                },
              },
              required: ["type", "method"],
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
  const params = {
    type: "object",
    properties: {
      q: { type: "string", minLength: 1, maxLength: MAX_QUERY_CHARS, description: "The search query, 1-400 characters, e.g. 'cloudflare workers pricing'. Plain keywords work best; quotes and site:example.com operators are passed through." },
      count: { type: "integer", minimum: 1, maximum: MAX_COUNT, default: DEFAULT_COUNT, description: "Maximum number of results to return (1-10, default 10)" },
      region: { type: "string", pattern: "^[a-z]{2,3}-[a-z]{2,3}$", description: "Optional DuckDuckGo region code to bias results, e.g. us-en, uk-en, ca-en, de-de, fr-fr, jp-jp, wt-wt (worldwide). Default: none." },
      safe: { type: "string", enum: ["moderate", "off", "strict"], default: "moderate", description: "Safe-search level: moderate (default), off, or strict" },
    },
    required: ["q"],
  };
  const out = {
    type: "object",
    properties: {
      query: { type: "string", description: "The query that was searched (whitespace normalized)" },
      region: { type: ["string", "null"], description: "Region code requested, or null (applied by the DuckDuckGo source; fallbacks use en/us defaults)" },
      safe: { type: "string", enum: ["moderate", "off", "strict"] },
      count: { type: "integer", description: "Number of results returned (1-10)" },
      results: {
        type: "array", minItems: 1, maxItems: MAX_COUNT,
        items: {
          type: "object",
          properties: {
            rank: { type: "integer", description: "1-based position in the result list" },
            title: { type: "string", description: "Result title, HTML entities decoded" },
            url: { type: "string", format: "uri", description: "Absolute http(s) URL of the result page (redirector links resolved to the real destination)" },
            domain: { type: "string", description: "Hostname of the result without a leading www." },
            snippet: { type: "string", description: "Short text excerpt from the page as shown by the search engine (may be empty)" },
          },
          required: ["rank", "title", "url", "domain", "snippet"],
        },
      },
      source: { type: "string", enum: SOURCES.map((s) => s.name), description: "Search engine that served this result set (sources are tried in order until one returns results)" },
      fetched_at: { type: "string", format: "date-time" },
    },
    required: ["query", "region", "safe", "count", "results", "source", "fetched_at"],
  };
  const op = (method) => ({
    operationId: method === "post" ? "webSearchPost" : "webSearch",
    summary: "Search the web: up to 10 live results with title, url, domain and snippet as JSON",
    tags: ["Web", "Search", "Research", "Agents"],
    "x-payment-info": { price: { mode: "fixed", currency: "USD", amount: "0.002000" }, protocols: [{ x402: {} }] },
    ...(method === "post"
      ? { requestBody: { required: true, content: { "application/json": { schema: params } } } }
      : { parameters: Object.entries(params.properties).map(([n, sch]) => ({ name: n, in: "query", required: params.required.includes(n), schema: { type: "string" }, description: sch.description })) }),
    responses: {
      200: { description: "Search results (at least one)", content: { "application/json": { schema: out } } },
      400: { description: "Missing or invalid q, count, region or safe (no charge)" },
      402: { description: "Payment Required" },
      404: { description: "The search returned no results (no charge)" },
      413: { description: "Request body too large (no charge)" },
      502: { description: "Every search source failed: unreachable, timed out (8 s each), error status, or bot-challenge page (no charge)" },
    },
  });
  return {
    openapi: "3.1.0",
    info: {
      title: SERVICE,
      version: "1.0.0",
      description: DESCRIPTION,
      "x-guidance": "Cheap web search for AI agents. GET /search?q=your+query (or POST /search with JSON body {\"q\": \"...\", \"count\": 10, \"region\": \"us-en\", \"safe\": \"moderate\"}) returns up to 10 live web results as JSON: for each result its rank, title, url, domain and snippet. Costs $0.002 USDC on Base per request via x402; you are only charged when at least one result is returned (no charge on 400/404/502). Results link to the live web: use a /read service (such as NoJunk Web Read) to fetch and read the pages you pick. Optional region (DuckDuckGo code like us-en, uk-en, de-de) biases results by country/language; safe is moderate by default and can be off or strict. Results come from DuckDuckGo's HTML interface, falling back to Bing and then Yahoo when a source is blocked or empty (the source field says which one answered); upstream pages are cached for 2 minutes per identical query. region/safe apply to DuckDuckGo; fallbacks use English/US defaults. Best for: finding sources, looking up current facts, discovering URLs to read, checking what exists on a topic before answering.",
    },
    servers: [{ url: origin }],
    paths: { "/search": { get: op("get"), post: op("post") } },
  };
}

export default {
  async fetch(request, env0, ctx) {
    const env = { ...env0, PAY_TO: (env0 && env0.PAY_TO) || DEFAULT_PAY_TO };
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "PAYMENT-SIGNATURE, Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" } });
    }
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        service: SERVICE,
        description: DESCRIPTION,
        openapi: `${url.origin}/openapi.json`,
        endpoint: `${url.origin}/search?q=cloudflare+workers+pricing`,
        health: `${url.origin}/health/search`,
        price: "$0.002 USDC on Base per request (x402)",
        params: { q: "required, 1-400 chars", count: "1-10, default 10", region: "optional DuckDuckGo region code, e.g. us-en", safe: "moderate (default) | off | strict" },
        sources: SOURCES.map((s) => s.name),
        limits: { timeout_seconds: TIMEOUT_MS / 1000, max_results: MAX_COUNT, max_query_chars: MAX_QUERY_CHARS, cache_seconds: CACHE_TTL_S },
        no_charge_on: ["400 invalid input", "404 no results", "502 all search sources failed (error, timeout or bot challenge)"],
        configured: Boolean(env.PAY_TO),
        facilitator: env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET ? "cdp" : "payai",
      });
    }
    if (url.pathname === "/openapi.json" || url.pathname === "/.well-known/openapi.json") return json(openapi(url.origin));
    if (url.pathname === "/health/search") {
      // Free operator probe: runs a fixed query, reports only shape/health (no result data).
      if (request.method !== "GET") return json({ error: "Use GET" }, 405);
      const t0 = Date.now();
      const r = await search({ q: HEALTH_QUERY, count: MAX_COUNT, region: null, safe: "moderate" }, ctx);
      const result_count = r.status === 200 ? r.body.results.length : 0;
      const status = r.status === 200 ? "ok" : r.status === 404 ? "degraded" : "down";
      return json({ status, result_count, ms: Date.now() - t0, source: r.status === 200 ? r.body.source : null }, status === "ok" ? 200 : 503);
    }
    if (url.pathname !== "/search") return json({ error: "Not found. Use /search?q=your+query" }, 404);
    if (!env.PAY_TO || !/^0x[0-9a-fA-F]{40}$/.test(env.PAY_TO)) return json({ error: "Service not configured: PAY_TO wallet address missing" }, 500);
    if (request.method !== "GET" && request.method !== "POST") return json({ error: "Use GET or POST" }, 405);
    const len = Number(request.headers.get("content-length"));
    if (Number.isFinite(len) && len > MAX_REQUEST_BYTES) return json({ error: `Request body too large (max ${MAX_REQUEST_BYTES} bytes); send {"q": "..."} only (no payment was taken)` }, 413);

    const header = request.headers.get("PAYMENT-SIGNATURE") || request.headers.get("X-PAYMENT");
    if (!header) return send402(env, url, "PAYMENT-SIGNATURE header is required");
    const q = validate(await readParams(request, url));
    if (q.error) return json(q, 400);

    let payload;
    try { payload = b64d(header); } catch { return json({ error: "Invalid payment payload" }, 400); }
    const reqs = requirements(env);
    if (payload.x402Version !== 2 || !deepEqual(payload.accepted, reqs)) return send402(env, url, "No matching payment requirements found");

    const fac = facilitator(env);
    const body = { x402Version: 2, paymentPayload: payload, paymentRequirements: reqs };
    let v;
    try { v = await fac.call("verify", body); } catch (e) { return json({ error: "Facilitator unreachable", detail: String(e) }, 500); }
    if (!v.ok || !v.data.isValid) return send402(env, url, v.data.invalidReason || v.data.error || `verify failed (${v.status})`);

    const result = await search(q, ctx);
    if (result.status !== 200) return json(result.body, result.status);

    let s;
    try { s = await fac.call("settle", body); } catch (e) { return json({ error: "Facilitator unreachable", detail: String(e) }, 500); }
    if (!s.ok || !s.data.success) {
      const fail = { success: false, errorReason: s.data.errorReason || s.data.error || `settle failed (${s.status})`, transaction: "", network: NETWORK, payer: s.data.payer || v.data.payer };
      return json({}, 402, { "PAYMENT-RESPONSE": b64e(fail) });
    }
    const receipt = { success: true, transaction: s.data.transaction, network: s.data.network || NETWORK, payer: s.data.payer || v.data.payer };
    return json(result.body, 200, { "PAYMENT-RESPONSE": b64e(receipt) });
  },
};
