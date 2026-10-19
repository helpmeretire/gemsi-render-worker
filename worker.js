// Web Page Reader — a paid (x402) web page reader for AI agents.
// Fetches one public web page and returns its title, metadata, clean readable text,
// Markdown and links as JSON. No API keys, no rate limits: agents pay per call.
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
const SERVICE = "Web Page Reader";
const DESCRIPTION =
  "Read any public web page as clean JSON: title, description, site name, publish date, language, readable text (boilerplate removed), Markdown and the page's links. Give it a URL, get the content back in one call. HTML, plain text, JSON and XML pages supported.";

const USER_AGENT = "NoJunk Web Read/1.0 (+https://nojunkcrypto.com)";
const ACCEPT = "text/html, application/xhtml+xml, text/plain, application/json, application/xml, text/xml;q=0.9, */*;q=0.1";
const TIMEOUT_MS = 8000; // whole upstream fetch (all redirects + body) must finish within this
const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 3 * 1024 * 1024; // 3 MB of upstream body is read, the rest is dropped
const MAX_TEXT_CHARS = 60000; // text / markdown are capped here; truncated=true when cut
const MAX_LINKS = 50;
const MAX_URL_LENGTH = 2048;
const MAX_REQUEST_BYTES = 16 * 1024; // POST bodies larger than this are rejected with 413


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


// ---------- URL safety ----------
const BLOCKED_SUFFIXES = [".localhost", ".internal", ".local", ".localdomain", ".home.arpa", ".intranet", ".corp", ".lan"];
const BLOCKED_HOSTS = new Set(["localhost", "0.0.0.0", "broadcasthost", "ip6-localhost", "ip6-loopback", "metadata.google.internal", "metadata"]);

function privateV4(ip) {
  const o = ip.split(".").map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = o;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 0) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}
function privateV6(host) {
  // host is the WHATWG-serialized address without brackets, e.g. "::1", "fe80::1", "::ffff:7f00:1"
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
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  return false;
}

// Returns { error } or { url } (normalized absolute URL string).
function checkUrl(raw) {
  if (typeof raw !== "string" || !raw.trim()) return { error: "Missing required parameter: url" };
  raw = raw.trim();
  if (raw.length > MAX_URL_LENGTH) return { error: `url is too long (max ${MAX_URL_LENGTH} characters)` };
  if (!/^https?:\/\//i.test(raw)) return { error: "url must start with http:// or https://" };
  let u;
  try { u = new URL(raw); } catch { return { error: "url is not a valid absolute URL" }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { error: "Only http and https URLs are supported" };
  if (u.username || u.password) return { error: "URLs with embedded credentials are not allowed" };
  const host = u.hostname.toLowerCase();
  if (!host) return { error: "url has no host" };
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

// ---------- HTML entities ----------
const LATIN1 = "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac12 frac14 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml".split(" ");
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", sbquo: "‚", ldquo: "“", rdquo: "”", bdquo: "„", bull: "•", dagger: "†", Dagger: "‡", permil: "‰", lsaquo: "‹", rsaquo: "›", euro: "€", trade: "™", larr: "←", uarr: "↑", rarr: "→", darr: "↓", harr: "↔", prime: "′", Prime: "″", oline: "‾", frasl: "⁄", ensp: " ", emsp: " ", thinsp: " ", zwnj: "‌", zwj: "‍", lrm: "‎", rlm: "‏", minus: "−", lowast: "∗", radic: "√", infin: "∞", ne: "≠", le: "≤", ge: "≥", asymp: "≈", equiv: "≡", sum: "∑", prod: "∏", part: "∂", int: "∫", hearts: "♥", spades: "♠", clubs: "♣", diams: "♦", loz: "◊", check: "✓", star: "☆", OElig: "Œ", oelig: "œ", Scaron: "Š", scaron: "š", Yuml: "Ÿ", fnof: "ƒ", circ: "ˆ", tilde: "˜", alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", lambda: "λ", mu: "μ", pi: "π", sigma: "σ", tau: "τ", phi: "φ", omega: "ω", Delta: "Δ", Sigma: "Σ", Omega: "Ω", Pi: "Π" };
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

// ---------- HTML parser (tolerant, builds a small tree) ----------
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr", "keygen", "command"]);
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "noscript", "xmp", "iframe", "noembed", "noframes"]);
const BLOCK = new Set(["address", "article", "aside", "blockquote", "body", "center", "dd", "details", "dialog", "dir", "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "html", "legend", "li", "main", "menu", "nav", "ol", "p", "pre", "section", "summary", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul", "caption", "colgroup"]);
// Opening one of these implicitly closes an open <p>
const CLOSES_P = new Set(["address", "article", "aside", "blockquote", "details", "dialog", "div", "dl", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "main", "menu", "nav", "ol", "p", "pre", "section", "table", "ul"]);
const IMPLIED_END = { li: ["li"], dt: ["dt", "dd"], dd: ["dt", "dd"], tr: ["tr", "td", "th"], td: ["td", "th"], th: ["td", "th"], option: ["option"], thead: ["tbody", "tfoot"], tbody: ["thead", "tfoot"], tfoot: ["thead", "tbody"] };
const LIST_SCOPE = new Set(["ul", "ol", "menu", "dl", "table", "tbody", "thead", "tfoot", "tr"]);

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

function parseHtml(html) {
  const root = { type: "el", name: "#root", attrs: {}, children: [], parent: null };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const addText = (v) => { if (v) top().children.push({ type: "text", value: v, raw: false }); };
  const openEl = (name, attrs) => {
    if (CLOSES_P.has(name)) closeTo("p", new Set(["button", "td", "th", "li"]));
    if (IMPLIED_END[name]) for (const n of IMPLIED_END[name]) closeTo(n, LIST_SCOPE);
    const el = { type: "el", name, attrs, children: [], parent: top() };
    top().children.push(el);
    if (!VOID.has(name)) stack.push(el);
    return el;
  };
  // Pop up to and including the nearest open `name`, but not past a scope boundary.
  const closeTo = (name, scope) => {
    for (let i = stack.length - 1; i > 0; i--) {
      if (stack[i].name === name) { stack.length = i; return true; }
      if (scope && scope.has(stack[i].name)) return false;
    }
    return false;
  };
  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) { addText(html.slice(i)); break; }
    if (lt > i) addText(html.slice(i, lt));
    i = lt;
    if (html.startsWith("<!--", i)) { const e = html.indexOf("-->", i + 4); i = e === -1 ? n : e + 3; continue; }
    if (html.startsWith("<![CDATA[", i)) { const e = html.indexOf("]]>", i + 9); addText(html.slice(i + 9, e === -1 ? n : e)); i = e === -1 ? n : e + 3; continue; }
    if (html[i + 1] === "!" || html[i + 1] === "?") { const e = html.indexOf(">", i); i = e === -1 ? n : e + 1; continue; }
    if (html[i + 1] === "/") {
      const m = /^<\/([a-zA-Z][^\s>\/]*)\s*>/.exec(html.slice(i, i + 200));
      if (!m) { const e = html.indexOf(">", i); i = e === -1 ? n : e + 1; continue; }
      closeTo(m[1].toLowerCase());
      i += m[0].length;
      continue;
    }
    const nm = /^<([a-zA-Z][^\s>\/]*)/.exec(html.slice(i, i + 200));
    if (!nm) { addText("<"); i++; continue; }
    const name = nm[1].toLowerCase();
    // find the end of the tag, honoring quotes
    let j = i + nm[0].length, q = null;
    while (j < n) {
      const c = html[j];
      if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === ">") break;
      j++;
    }
    const inner = html.slice(i + nm[0].length, j);
    const selfClosing = /\/\s*$/.test(inner);
    const attrs = parseAttrs(selfClosing ? inner.replace(/\/\s*$/, "") : inner);
    i = j + 1;
    const el = openEl(name, attrs);
    if (selfClosing && !VOID.has(name) && top() === el) { stack.pop(); continue; }
    if (RAW_TEXT.has(name) && !VOID.has(name)) {
      const closeRe = new RegExp(`</${name}\\s*>`, "ig");
      closeRe.lastIndex = i;
      const m = closeRe.exec(html);
      const end = m ? m.index : n;
      const raw = html.slice(i, end);
      if (raw) el.children.push({ type: "text", value: name === "title" || name === "textarea" ? decodeEntities(raw) : raw, raw: true });
      i = m ? m.index + m[0].length : n;
      if (top() === el) stack.pop();
    }
  }
  // decode entities in regular text nodes
  const walk = (node) => { for (const c of node.children) { if (c.type === "text") { if (!c.raw) c.value = decodeEntities(c.value); } else walk(c); } };
  walk(root);
  return root;
}

function find(node, pred, out = []) {
  for (const c of node.children) if (c.type === "el") { if (pred(c)) out.push(c); find(c, pred, out); }
  return out;
}
function findFirst(node, name) {
  for (const c of node.children) if (c.type === "el") { if (c.name === name) return c; const r = findFirst(c, name); if (r) return r; }
  return null;
}
function hasAncestor(node, names) {
  for (let p = node.parent; p; p = p.parent) if (names.has(p.name)) return true;
  return false;
}
const squash = (s) => s.replace(/\s+/g, " ").trim();
function textOf(node) {
  if (node.type === "text") return node.value;
  let s = "";
  for (const c of node.children) s += c.type === "text" ? c.value : textOf(c);
  return s;
}

// ---------- rendering (text + markdown + links) ----------
const SKIP = new Set(["script", "style", "noscript", "template", "svg", "math", "canvas", "iframe", "object", "embed", "applet", "head", "title", "meta", "link", "base", "nav", "aside", "select", "option", "datalist", "map", "area", "video", "audio", "source", "track", "dialog", "menu", "xmp", "noembed", "noframes"]);
const KEEP_IN_ARTICLE = new Set(["article", "main", "section", "figure", "blockquote", "li", "td", "th", "details"]);
const HEADING = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

function skipNode(el) {
  if (SKIP.has(el.name)) return true;
  if (el.name === "header" || el.name === "footer") return !hasAncestor(el, KEEP_IN_ARTICLE); // site chrome vs. article header/footer
  if (el.name === "form" && !hasAncestor(el, KEEP_IN_ARTICLE)) return true;
  const a = el.attrs;
  if ("hidden" in a || a["aria-hidden"] === "true") return true;
  if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(a.style || "")) return true;
  const role = (a.role || "").toLowerCase();
  if (role === "navigation" || role === "banner" || role === "contentinfo" || role === "complementary" || role === "search" || role === "dialog" || role === "alert" || role === "alertdialog") return true;
  if (el.name === "input" && (a.type || "").toLowerCase() !== "submit") return true;
  return false;
}

function resolveHref(href, base) {
  if (!href) return null;
  href = href.trim();
  if (!href || /^(javascript|mailto|tel|data|vbscript|about|blob):/i.test(href)) return null;
  try {
    const u = new URL(href, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch { return null; }
}

// Renders a node to a string. mode: "text" | "md". ctx: { base, links, seen, pres, pre (bool) }
function render(node, mode, ctx) {
  if (node.type === "text") {
    const v = node.value.replace(/[\u0000\u0001]/g, ""); // our internal markers must never come from the page
    return ctx.pre ? v : v.replace(/[\s ]+/g, " ");
  }
  const name = node.name;
  if (name !== "#root" && skipNode(node)) return "";
  const md = mode === "md";
  const inner = () => { let s = ""; for (const c of node.children) s += render(c, mode, ctx); return s; };
  const block = (s) => `\n\n${s.trim()}\n\n`;

  if (name === "br") return "\n";
  if (name === "hr") return md ? block("---") : "\n\n";
  if (name === "img") { const alt = squash(node.attrs.alt || ""); return alt ? (md ? `![${alt}](${resolveHref(node.attrs.src, ctx.base) || ""})` : alt) : ""; }
  if (name === "wbr") return "";
  if (HEADING[name]) { const t = squash(inner()); return t ? block(md ? `${"#".repeat(HEADING[name])} ${t}` : t) : ""; }
  if (name === "pre") {
    const wasPre = ctx.pre; ctx.pre = true;
    let s = inner(); ctx.pre = wasPre;
    s = s.replace(/^\n/, "").replace(/\s+$/, "");
    if (!s.trim()) return "";
    const id = ctx.pres.push(md ? "```\n" + s + "\n```" : s) - 1;
    return block(`\u0000${id}\u0000`);
  }
  if (name === "code" && !ctx.pre) { const t = inner().trim(); return t ? (md ? "`" + t.replace(/`/g, "\\`") + "`" : t) : ""; }
  if (name === "a") {
    const href = resolveHref(node.attrs.href, ctx.base);
    const t = inner();
    const label = squash(t);
    if (href && label && !ctx.seen.has(href) && ctx.links.length < MAX_LINKS) { ctx.seen.add(href); ctx.links.push({ text: label.slice(0, 200), href }); }
    if (!md || !href || !label || ctx.pre) return t;
    const lead = /^\s/.test(t) ? " " : "", tail = /\s$/.test(t) ? " " : "";
    return `${lead}[${label.replace(/[\[\]]/g, "\\$&")}](${href})${tail}`;
  }
  if (md && (name === "strong" || name === "b" || name === "em" || name === "i")) {
    const t = inner(); const mark = name === "strong" || name === "b" ? "**" : "*";
    const core = t.trim();
    if (!core || ctx.pre) return t;
    return `${/^\s/.test(t) ? " " : ""}${mark}${core}${mark}${/\s$/.test(t) ? " " : ""}`;
  }
  if (name === "ul" || name === "ol" || name === "menu") {
    let idx = 0, out = "";
    for (const c of node.children) {
      if (c.type !== "el" || c.name !== "li") { if (c.type === "el") out += render(c, mode, ctx); continue; }
      const body = render(c, mode, ctx).replace(/^\n+|\n+$/g, "");
      if (!body.trim()) continue;
      idx++;
      const marker = name === "ol" ? `${Number(node.attrs.start) > 0 ? Number(node.attrs.start) + idx - 1 : idx}. ` : "- ";
      const lines = body.split("\n");
      // \u0001 marks intentional indentation that finish() must keep (it collapses other whitespace)
      out += marker + lines[0].trim() + lines.slice(1).map((l) => (l.trim() ? "\n" + INDENT + l.replace(/^\s+/, "") : "")).join("") + "\n";
    }
    return out.trim() ? block(out) : "";
  }
  if (name === "li") return block(inner()); // stray li outside a list
  if (name === "dt") { const t = squash(inner()); return t ? `\n${md ? "**" + t + "**" : t}\n` : ""; }
  if (name === "dd") { const t = inner().trim(); return t ? `${md ? ": " : INDENT}${t}\n` : ""; }
  if (name === "blockquote") {
    const t = inner().replace(/\u0000(\d+)\u0000/g, (m, id) => ctx.pres[id]).trim();
    if (!t) return "";
    return block(md ? t.split("\n").map((l) => "> " + l).join("\n") : t);
  }
  if (name === "table") {
    const rows = [];
    const caption = findFirst(node, "caption");
    const trs = find(node, (e) => e.name === "tr");
    let headerRow = -1;
    for (const tr of trs) {
      const cells = tr.children.filter((c) => c.type === "el" && (c.name === "td" || c.name === "th"));
      if (!cells.length) continue;
      const vals = cells.map((c) => { const v = squash(render(c, mode, ctx)); return md ? v.replace(/\|/g, "\\|") : v; });
      if (vals.every((v) => !v)) continue;
      if (headerRow === -1 && cells.every((c) => c.name === "th")) headerRow = rows.length;
      rows.push(vals);
    }
    if (!rows.length) return "";
    const lines = rows.map((r) => (md ? `| ${r.join(" | ")} |` : r.join(" | ")));
    if (md) { const width = rows[0].length; const sep = `| ${new Array(width).fill("---").join(" | ")} |`; if (headerRow === 0) lines.splice(1, 0, sep); else lines.unshift(`| ${new Array(width).fill(" ").join(" | ")} |`, sep); }
    const cap = caption ? squash(textOf(caption)) : "";
    return block((cap ? (md ? `**${cap}**` : cap) + "\n\n" : "") + lines.join("\n"));
  }
  if (name === "td" || name === "th" || name === "tr" || name === "thead" || name === "tbody" || name === "tfoot" || name === "caption") return inner();
  if (name === "input") return squash(node.attrs.value || "");
  if (BLOCK.has(name) || name === "#root") return block(inner());
  return inner(); // inline element
}

const INDENT = "\u0001\u0001"; // two spaces, protected from whitespace collapsing until finish()
function finish(s, pres) {
  s = s.replace(/[ \t]*\n[ \t]*/g, "\n").replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  s = s.replace(/\u0001/g, " ");
  s = s.replace(/\u0000(\d+)\u0000/g, (m, id) => pres[id]);
  return s.replace(/^[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}

function metaOf(root) {
  const out = {};
  for (const m of find(root, (e) => e.name === "meta")) {
    const key = (m.attrs.property || m.attrs.name || m.attrs.itemprop || (m.attrs["http-equiv"] ? "http-equiv:" + m.attrs["http-equiv"] : "") || "").toLowerCase();
    const val = m.attrs.content;
    if (key && val !== undefined && !(key in out)) out[key] = squash(val);
  }
  return out;
}
const pick = (meta, keys) => { for (const k of keys) if (meta[k]) return meta[k]; return null; };

function extractHtml(html, baseUrl) {
  const root = parseHtml(html);
  const meta = metaOf(root);
  const baseEl = find(root, (e) => e.name === "base" && e.attrs.href)[0];
  const base = (baseEl && resolveHref(baseEl.attrs.href, baseUrl)) || baseUrl;
  const titleEl = findFirst(root, "title");
  const h1 = findFirst(root, "h1");
  const title = pick(meta, ["og:title", "twitter:title"]) || (titleEl && squash(textOf(titleEl))) || (h1 && squash(textOf(h1))) || null;
  const description = pick(meta, ["description", "og:description", "twitter:description"]);
  const site_name = pick(meta, ["og:site_name", "application-name", "apple-mobile-web-app-title"]);
  let published = pick(meta, ["article:published_time", "og:article:published_time", "datepublished", "pubdate", "publishdate", "publish-date", "date", "dc.date.issued", "dc.date", "dcterms.created", "sailthru.date", "parsely-pub-date"]);
  if (!published) {
    const t = find(root, (e) => e.name === "time" && e.attrs.datetime && (e.attrs.itemprop === "datePublished" || "pubdate" in e.attrs))[0] || find(root, (e) => e.name === "time" && e.attrs.datetime)[0];
    if (t) published = squash(t.attrs.datetime);
  }
  const htmlEl = findFirst(root, "html");
  const lang = (htmlEl && htmlEl.attrs.lang && squash(htmlEl.attrs.lang)) || pick(meta, ["http-equiv:content-language", "language", "og:locale"]) || null;

  // content root: <article> (longest if several), then <main>, then [role=main], then <body>
  const articles = find(root, (e) => e.name === "article");
  let content = null;
  if (articles.length) content = articles.map((a) => ({ a, n: squash(textOf(a)).length })).sort((x, y) => y.n - x.n)[0].a;
  if (!content || squash(textOf(content)).length < 200) {
    const main = findFirst(root, "main") || find(root, (e) => (e.attrs.role || "").toLowerCase() === "main")[0];
    if (main && (!content || squash(textOf(main)).length > squash(textOf(content)).length)) content = main;
  }
  if (!content) content = findFirst(root, "body") || root;

  const ctxT = { base, links: [], seen: new Set(), pres: [], pre: false };
  const text = finish(render(content, "text", ctxT), ctxT.pres);
  const ctxM = { base, links: [], seen: new Set(), pres: [], pre: false };
  const markdown = finish(render(content, "md", ctxM), ctxM.pres);
  // links: those in the content first, then the rest of the page, up to MAX_LINKS
  const links = ctxM.links;
  if (links.length < MAX_LINKS) {
    const seen = ctxM.seen;
    for (const a of find(root, (e) => e.name === "a" && e.attrs.href)) {
      if (links.length >= MAX_LINKS) break;
      const href = resolveHref(a.attrs.href, base);
      const label = squash(textOf(a)) || squash(a.attrs.title || a.attrs["aria-label"] || "");
      if (href && label && !seen.has(href)) { seen.add(href); links.push({ text: label.slice(0, 200), href }); }
    }
  }
  return { title, description, site_name, published, lang, text, markdown, links };
}

// ---------- fetching ----------
function kindOf(contentType, head) {
  const mime = (contentType || "").split(";")[0].trim().toLowerCase();
  if (mime === "text/html" || mime === "application/xhtml+xml") return "html";
  if (mime === "application/json" || mime.endsWith("+json") || mime === "text/json") return "json";
  if (mime === "application/xml" || mime === "text/xml" || mime.endsWith("+xml")) return "xml";
  if (mime.startsWith("text/")) return "text";
  if (mime === "application/octet-stream" || mime === "") {
    const s = head.replace(/^﻿/, "").trimStart().slice(0, 64).toLowerCase();
    if (s.startsWith("<!doctype html") || s.startsWith("<html") || /^<[a-z!?]/.test(s) && /<(html|head|body|div|p|meta|title)\b/i.test(head)) return "html";
    if (s.startsWith("<?xml") || /^<[a-z]/.test(s)) return "xml";
    if (/^[\[{]/.test(s)) return "json";
    return "text";
  }
  return null;
}

// Lossy ASCII view of the first n bytes (for sniffing only); works on every runtime.
function asciiHead(bytes, n) {
  let s = "";
  const end = Math.min(n, bytes.length);
  for (let i = 0; i < end; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function decodeBody(bytes, contentType) {
  const m = /charset\s*=\s*"?([a-z0-9_.:-]+)/i.exec(contentType || "");
  let charset = m ? m[1].toLowerCase() : null;
  if (!charset) {
    const head = asciiHead(bytes, 4096);
    const mm = /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_.:-]+)/i.exec(head);
    if (mm) charset = mm[1].toLowerCase();
  }
  if (charset) {
    try { return new TextDecoder(charset).decode(bytes); } catch {}
  }
  return new TextDecoder("utf-8").decode(bytes);
}

async function readCapped(res, cap) {
  const declared = Number(res.headers.get("content-length"));
  let capped = Number.isFinite(declared) && declared > cap;
  if (!res.body || typeof res.body.getReader !== "function") {
    const buf = new Uint8Array(await res.arrayBuffer());
    return { bytes: buf.length > cap ? buf.subarray(0, cap) : buf, capped: capped || buf.length > cap };
  }
  const reader = res.body.getReader();
  const chunks = [];
  let n = 0;
  while (n < cap) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    n += value.length;
  }
  if (n >= cap) { capped = capped || n > cap; try { await reader.cancel(); } catch {} }
  if (n > cap) {
    // keep exactly cap bytes
    const last = chunks[chunks.length - 1];
    chunks[chunks.length - 1] = last.subarray(0, last.length - (n - cap));
    n = cap;
  } else if (!capped) {
    // stream may not be finished if n === cap exactly; peek once more
    if (n === cap) { try { const { done } = await reader.read(); capped = !done; } catch {} }
  }
  const bytes = new Uint8Array(n);
  let off = 0;
  for (const c of chunks) { bytes.set(c, off); off += c.length; }
  return { bytes, capped };
}

class FetchError extends Error { constructor(status, message) { super(message); this.status = status; } }

// Fetches a page following up to MAX_REDIRECTS redirects within TIMEOUT_MS. Returns
// { final_url, status, contentType, bytes, capped } or throws FetchError(status, message).
async function fetchPage(startUrl) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let url = startUrl;
  try {
    for (let hop = 0; ; hop++) {
      let res;
      try {
        res = await fetch(url, { method: "GET", redirect: "manual", signal: ctrl.signal, headers: { "User-Agent": USER_AGENT, Accept: ACCEPT, "Accept-Language": "en-US,en;q=0.8" } });
      } catch (e) {
        if (ctrl.signal.aborted) throw new FetchError(502, `The page did not respond within ${TIMEOUT_MS / 1000} seconds`);
        throw new FetchError(502, `Could not fetch the page: ${String(e && e.message ? e.message : e).slice(0, 200)}`);
      }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        try { if (res.body) await res.body.cancel(); } catch {}
        if (!loc) throw new FetchError(502, `The page responded ${res.status} without a Location header`);
        if (hop >= MAX_REDIRECTS) throw new FetchError(502, `Too many redirects (more than ${MAX_REDIRECTS})`);
        let next;
        try { next = new URL(loc, url).toString(); } catch { throw new FetchError(502, "The page redirected to an invalid URL"); }
        const chk = checkUrl(next);
        if (chk.error) throw new FetchError(502, `The page redirected to a URL that cannot be fetched: ${chk.error}`);
        url = chk.url;
        continue;
      }
      if (res.status === 404 || res.status === 410) { try { if (res.body) await res.body.cancel(); } catch {} throw new FetchError(404, `The page was not found (upstream ${res.status})`); }
      if (res.status < 200 || res.status >= 300) { try { if (res.body) await res.body.cancel(); } catch {} throw new FetchError(502, `The page responded with HTTP ${res.status}`); }
      const contentType = res.headers.get("content-type") || "";
      let body;
      try { body = await readCapped(res, MAX_BODY_BYTES); } catch (e) {
        if (ctrl.signal.aborted) throw new FetchError(502, `The page did not finish sending within ${TIMEOUT_MS / 1000} seconds`);
        throw new FetchError(502, `Could not read the page body: ${String(e && e.message ? e.message : e).slice(0, 200)}`);
      }
      return { final_url: url, status: res.status, contentType, bytes: body.bytes, capped: body.capped };
    }
  } finally {
    clearTimeout(timer);
  }
}

// Returns { status, body } — status !== 200 means do not settle.
function compute(q, page) {
  const kind = kindOf(page.contentType, asciiHead(page.bytes, 512));
  if (!kind) return { status: 415, body: { error: `Unsupported content type "${(page.contentType || "").split(";")[0].trim() || "unknown"}": only HTML, plain text, JSON and XML pages can be read (no payment was taken)`, final_url: page.final_url } };
  const raw = decodeBody(page.bytes, page.contentType);
  let out = { title: null, description: null, site_name: null, published: null, lang: null, text: "", markdown: "", links: [] };
  if (kind === "html") {
    out = extractHtml(raw, page.final_url);
  } else if (kind === "json") {
    let pretty = raw.trim();
    try { pretty = JSON.stringify(JSON.parse(raw), null, 2); } catch {}
    out.text = pretty;
    out.markdown = "```json\n" + pretty + "\n```";
  } else {
    const t = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
    out.text = t;
    out.markdown = kind === "xml" ? "```xml\n" + t + "\n```" : t;
    if (kind === "xml") { const tm = /<title[^>]*>([^<]{1,300})<\/title>/i.exec(raw); if (tm) out.title = squash(decodeEntities(tm[1])); }
  }
  const words = out.text ? out.text.split(/\s+/).filter(Boolean).length : 0;
  let truncated = page.capped;
  if (out.text.length > MAX_TEXT_CHARS) { out.text = out.text.slice(0, MAX_TEXT_CHARS); truncated = true; }
  if (out.markdown.length > MAX_TEXT_CHARS) { out.markdown = out.markdown.slice(0, MAX_TEXT_CHARS); truncated = true; }
  return {
    status: 200,
    body: {
      url: q.url,
      final_url: page.final_url,
      status: page.status,
      content_type: (page.contentType || "").split(";")[0].trim() || null,
      title: out.title,
      description: out.description,
      site_name: out.site_name,
      published: out.published,
      lang: out.lang,
      text: out.text,
      markdown: out.markdown,
      links: out.links,
      word_count: words,
      truncated,
      fetched_at: new Date().toISOString(),
    },
  };
}

// ---------- params ----------
async function readParams(request, url) {
  const p = Object.fromEntries(url.searchParams);
  if (request.method === "POST") {
    try { const b = await request.clone().json(); if (b && typeof b === "object") Object.assign(p, b); } catch {}
  }
  return { url: p.url === undefined || p.url === null ? undefined : String(p.url) };
}

// Returns { error } or { url }
function validate(q) {
  const r = checkUrl(q.url);
  if (r.error) return { error: `${r.error} (no payment was taken)` };
  return { url: r.url };
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
  url: "https://example.com/",
  final_url: "https://example.com/",
  status: 200,
  content_type: "text/html",
  title: "Example Domain",
  description: null,
  site_name: null,
  published: null,
  lang: "en",
  text: "Example Domain\n\nThis domain is for use in illustrative examples in documents. You may use this domain in literature without prior coordination or asking for permission.\n\nMore information...",
  markdown: "# Example Domain\n\nThis domain is for use in illustrative examples in documents. You may use this domain in literature without prior coordination or asking for permission.\n\n[More information...](https://www.iana.org/domains/example)",
  links: [{ text: "More information...", href: "https://www.iana.org/domains/example" }],
  word_count: 30,
  truncated: false,
  fetched_at: "2026-10-15T12:00:00.000Z",
};
function paymentRequired(env, url, error) {
  const resourceUrl = `${url.origin}/read`;
  return {
    x402Version: 2,
    error,
    resource: { url: resourceUrl, description: DESCRIPTION, mimeType: "application/json" },
    accepts: [requirements(env)],
    extensions: {
      bazaar: {
        info: {
          input: { type: "http", method: "GET", queryParams: { url: "https://example.com/" } },
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
                    url: { type: "string", description: "Absolute http(s) URL of the public web page to read, e.g. https://example.com/article" },
                  },
                  required: ["url"],
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
      url: { type: "string", format: "uri", maxLength: MAX_URL_LENGTH, description: "Absolute http(s) URL of the public web page to read, e.g. 'https://example.com/article'. Localhost, private-network and internal hostnames are rejected." },
    },
    required: ["url"],
  };
  const out = {
    type: "object",
    properties: {
      url: { type: "string", description: "The URL that was requested (normalized)" },
      final_url: { type: "string", description: "The URL that actually served the page, after up to 5 redirects" },
      status: { type: "integer", description: "Upstream HTTP status (always 2xx on success)" },
      content_type: { type: ["string", "null"], description: "Upstream media type, e.g. text/html" },
      title: { type: ["string", "null"], description: "Page title (og:title, <title> or first <h1>)" },
      description: { type: ["string", "null"], description: "Meta description / og:description" },
      site_name: { type: ["string", "null"], description: "og:site_name if present" },
      published: { type: ["string", "null"], description: "Publish date from page metadata if present (article:published_time, meta date, <time datetime>)" },
      lang: { type: ["string", "null"], description: "Page language (<html lang> or content-language)" },
      text: { type: "string", description: "Clean readable text of the main content: navigation, headers, footers, sidebars, scripts and styles removed; entities decoded; whitespace collapsed; paragraph breaks kept. For JSON pages: pretty-printed JSON. Capped at 60,000 characters." },
      markdown: { type: "string", description: "Same content as Markdown: headings as #, links as [text](href), lists as -, code blocks fenced, tables as rows. Capped at 60,000 characters." },
      links: { type: "array", maxItems: MAX_LINKS, items: { type: "object", properties: { text: { type: "string" }, href: { type: "string" } }, required: ["text", "href"] }, description: "Up to 50 absolute http(s) links, main content first, duplicates removed" },
      word_count: { type: "integer", description: "Words in the full (uncapped) text" },
      truncated: { type: "boolean", description: "true if the body exceeded 3 MB or text/markdown were cut at 60,000 characters" },
      fetched_at: { type: "string", format: "date-time" },
    },
    required: ["url", "final_url", "status", "title", "text", "markdown", "links", "word_count", "truncated", "fetched_at"],
  };
  const op = (method) => ({
    operationId: method === "post" ? "readPagePost" : "readPage",
    summary: "Read a public web page: title, metadata, clean text, Markdown and links as JSON",
    tags: ["Web", "Scraping", "Reader", "Content"],
    "x-payment-info": { price: { mode: "fixed", currency: "USD", amount: "0.002000" }, protocols: [{ x402: {} }] },
    ...(method === "post"
      ? { requestBody: { required: true, content: { "application/json": { schema: params } } } }
      : { parameters: Object.entries(params.properties).map(([n, sch]) => ({ name: n, in: "query", required: params.required.includes(n), schema: { type: "string" }, description: sch.description })) }),
    responses: {
      200: { description: "Page content", content: { "application/json": { schema: out } } },
      400: { description: "Missing, malformed, non-http(s) or private/internal URL (no charge)" },
      402: { description: "Payment Required" },
      404: { description: "The page was not found upstream (HTTP 404/410) (no charge)" },
      413: { description: "Request body too large (no charge)" },
      415: { description: "The URL is not an HTML, text, JSON or XML document, e.g. a PDF, image or binary file (no charge)" },
      502: { description: "The page could not be fetched: upstream error status, timeout (8 s), too many redirects, or a redirect to a blocked address (no charge)" },
    },
  });
  return {
    openapi: "3.1.0",
    info: {
      title: SERVICE,
      version: "1.0.0",
      description: DESCRIPTION,
      "x-guidance": "Use this to read the content of a web page cheaply instead of scraping it yourself: GET /read?url=https://example.com/article (or POST /read with JSON body {\"url\": \"...\"}) returns the page's title, description, site name, publish date, language, clean readable text with navigation/ads/scripts stripped, a Markdown rendering, and up to 50 links, all as JSON. Costs $0.002 USDC on Base per request via x402; you are only charged for a successful read (2xx upstream, readable content type). It fetches live, server-rendered HTML; pages that render only with JavaScript may return little text. Only public http(s) URLs are accepted (no localhost, private networks or internal hostnames). Text and markdown are capped at 60,000 characters (truncated=true when cut) and bodies at 3 MB. Follows up to 5 redirects, 8 second timeout. Best for: reading articles, docs, blog posts, product pages, JSON APIs and feeds for summarizing, answering questions or extracting facts.",
    },
    servers: [{ url: origin }],
    paths: { "/read": { get: op("get"), post: op("post") } },
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
        endpoint: `${url.origin}/read?url=https://example.com/`,
        price: "$0.002 USDC on Base per request (x402)",
        accepts: ["text/html", "text/plain", "application/json", "application/xml"],
        limits: { timeout_seconds: TIMEOUT_MS / 1000, max_redirects: MAX_REDIRECTS, max_body_bytes: MAX_BODY_BYTES, max_text_chars: MAX_TEXT_CHARS, max_links: MAX_LINKS },
        user_agent: USER_AGENT,
        no_charge_on: ["400 invalid or private URL", "404 page not found", "415 unsupported content type", "502 upstream error or timeout"],
        configured: Boolean(env.PAY_TO),
        facilitator: env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET ? "cdp" : "payai",
      });
    }
    if (url.pathname === "/openapi.json" || url.pathname === "/.well-known/openapi.json") return json(openapi(url.origin));
    if (url.pathname !== "/read") return json({ error: "Not found. Use /read?url=https://example.com/" }, 404);
    if (!env.PAY_TO || !/^0x[0-9a-fA-F]{40}$/.test(env.PAY_TO)) return json({ error: "Service not configured: PAY_TO wallet address missing" }, 500);
    if (request.method !== "GET" && request.method !== "POST") return json({ error: "Use GET or POST" }, 405);
    const len = Number(request.headers.get("content-length"));
    if (Number.isFinite(len) && len > MAX_REQUEST_BYTES) return json({ error: `Request body too large (max ${MAX_REQUEST_BYTES} bytes); send {"url": "..."} only (no payment was taken)` }, 413);

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

    let page;
    try { page = await fetchPage(q.url); } catch (e) {
      const status = e instanceof FetchError ? e.status : 502;
      return json({ error: `${e.message || "The page could not be fetched"}; no payment was taken.`, url: q.url }, status);
    }
    let result;
    try { result = compute(q, page); } catch (e) { return json({ error: "The page could not be parsed; no payment was taken.", detail: String(e && e.message ? e.message : e).slice(0, 200), url: q.url }, 502); }
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
