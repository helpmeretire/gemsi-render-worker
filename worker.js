// NoJunk Domain Intel — a paid (x402) domain registration / DNS / web-reachability check for AI agents.
// Data: RDAP (via rdap.org bootstrap), DNS over HTTPS (Cloudflare 1.1.1.1), and a live HTTPS probe.
// Settings (Cloudflare Worker > Settings > Variables and Secrets):
//   PAY_TO              (optional) Base wallet address that receives USDC (defaults to DEFAULT_PAY_TO)
//   CDP_API_KEY_ID      (optional) Coinbase Developer Platform API key id   -> enables Bazaar listing
//   CDP_API_KEY_SECRET  (optional, Secret) Coinbase Developer Platform API key secret
// Without the CDP keys the service uses the keyless PayAI facilitator.

const DEFAULT_PAY_TO = "0x6f762720b8515b7091e6aa69e8361f7b9909233f"; // Mick's Base wallet
const PRICE_ATOMIC = "3000"; // $0.003 in USDC (6 decimals)
const NETWORK = "eip155:8453"; // Base mainnet
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CDP_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
const PAYAI_URL = "https://facilitator.payai.network";
const SERVICE = "NoJunk Domain Intel";
const DESCRIPTION =
  "Domain intelligence in one call: RDAP registration (registrar, created, expires, age, status, nameservers), DNS records (A, AAAA, MX, NS, TXT, CNAME, SPF, DMARC), a live HTTPS probe (reachable, status, server, redirect target, HSTS), plus risk flags and a 0-100 risk score for new, parked, unreachable or badly configured domains.";

const RDAP_URL = "https://rdap.org/domain/";
const DOH_URL = "https://cloudflare-dns.com/dns-query";
const USER_AGENT = "NoJunk Domain Intel/1.0 (+https://nojunkcrypto.com)";
const UPSTREAM_TIMEOUT_MS = 6000;
const MAX_INPUT_BYTES = 4096;
const MAX_DOMAIN_LEN = 253;
const NEW_DOMAIN_DAYS = 30;
const EXPIRING_DAYS = 30;
// Nameserver hostnames used by domain parking / for-sale landers.
const PARKED_NS = ["sedoparking", "sedo.com", "bodis", "parkingcrew", "afternic", "dan.com", "undeveloped", "above.com", "parklogic", "uniregistrymarket", "hugedomains", "domainmarket", "cashparking", "parkingpage", "smartname", "voodoo.com", "dnsparking", "squadhelp", "brandbucket", "ztomy", "domaincontrol-parking", "parked.com", "dnsowl-parking"];
const DISCLAIMER =
  "Registration data comes from the registry's RDAP service, DNS from Cloudflare 1.1.1.1, and the web probe from a single HTTPS request at check time. The risk score is a heuristic for triage, not a verdict.";

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


// ---------- upstream helpers ----------
async function timedFetch(u, init = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(u, { ...init, signal: ac.signal, headers: { "User-Agent": USER_AGENT, ...(init.headers || {}) } });
  } finally {
    clearTimeout(t);
  }
}
const isoDate = (v) => {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const dayDiff = (a, b) => Math.floor((a - b) / 86400000);

// ---------- RDAP ----------
// Returns { registered, registrar, created, expires, updated, status, nameservers } or throws.
async function fetchRdap(domain) {
  const res = await timedFetch(RDAP_URL + encodeURIComponent(domain), { headers: { Accept: "application/rdap+json, application/json" }, redirect: "follow" });
  if (res.status === 404) return { registered: false, registrar: null, created: null, expires: null, updated: null, status: [], nameservers: [] };
  if (!res.ok) throw new Error(`RDAP responded ${res.status}`);
  const d = await res.json();
  if (!d || typeof d !== "object") throw new Error("RDAP returned no object");
  if (d.errorCode === 404) return { registered: false, registrar: null, created: null, expires: null, updated: null, status: [], nameservers: [] };
  let registrar = null;
  for (const e of Array.isArray(d.entities) ? d.entities : []) {
    if (!Array.isArray(e.roles) || !e.roles.includes("registrar")) continue;
    const v = Array.isArray(e.vcardArray) && Array.isArray(e.vcardArray[1]) ? e.vcardArray[1] : [];
    const fn = v.find((x) => Array.isArray(x) && x[0] === "fn" && typeof x[3] === "string" && x[3].trim());
    if (fn) { registrar = fn[3].trim(); break; }
    if (typeof e.handle === "string" && e.handle.trim() && !registrar) registrar = e.handle.trim();
  }
  const ev = (names) => {
    for (const e of Array.isArray(d.events) ? d.events : []) if (e && names.includes(String(e.eventAction).toLowerCase())) return isoDate(e.eventDate);
    return null;
  };
  const nameservers = [...new Set((Array.isArray(d.nameservers) ? d.nameservers : []).map((n) => (n && typeof n.ldhName === "string" ? n.ldhName.toLowerCase().replace(/\.$/, "") : null)).filter(Boolean))];
  return {
    registered: true,
    registrar,
    created: ev(["registration"]),
    expires: ev(["expiration"]),
    updated: ev(["last changed", "last update of rdap database"]),
    status: Array.isArray(d.status) ? d.status.map(String) : [],
    nameservers,
  };
}

// ---------- DNS over HTTPS ----------
const RR = { A: 1, NS: 2, CNAME: 5, MX: 15, TXT: 16, AAAA: 28 };
async function doh(name, type) {
  const res = await timedFetch(`${DOH_URL}?name=${encodeURIComponent(name)}&type=${type}`, { headers: { Accept: "application/dns-json" } });
  if (!res.ok) throw new Error(`DoH ${type} responded ${res.status}`);
  const d = await res.json();
  if (!d || typeof d !== "object" || typeof d.Status !== "number") throw new Error("DoH returned no object");
  const ans = Array.isArray(d.Answer) ? d.Answer : [];
  return ans.filter((a) => a && a.type === RR[type] && typeof a.data === "string").map((a) => a.data);
}
const unquoteTxt = (s) => s.replace(/^"|"$/g, "").replace(/"\s*"/g, "").replace(/\\"/g, '"');
const stripDot = (s) => s.toLowerCase().replace(/\.$/, "");
// Returns { dns, ok } where ok=false means every DNS lookup failed.
async function fetchDns(domain) {
  const q = (name, type) => doh(name, type).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e: String(e.message || e) }));
  const [a, aaaa, mx, ns, txt, cname, dmarc] = await Promise.all([q(domain, "A"), q(domain, "AAAA"), q(domain, "MX"), q(domain, "NS"), q(domain, "TXT"), q(domain, "CNAME"), q(`_dmarc.${domain}`, "TXT")]);
  const all = [a, aaaa, mx, ns, txt, cname, dmarc];
  if (!all.some((r) => r.ok)) return { ok: false, dns: null, error: a.e };
  const txts = txt.ok ? txt.v.map(unquoteTxt) : [];
  const spf = txt.ok ? txts.find((t) => /^v=spf1(\s|$)/i.test(t.trim())) || null : null;
  const dm = dmarc.ok ? dmarc.v.map(unquoteTxt).find((t) => /^v=DMARC1(\s*;|\s|$)/i.test(t.trim())) || null : null;
  const mxHosts = mx.ok ? mx.v.map((m) => { const p = m.trim().split(/\s+/); return { priority: Number(p[0]), host: stripDot(p[1] || "") }; }).filter((m) => m.host).sort((x, y) => x.priority - y.priority) : null;
  return {
    ok: true,
    dns: {
      a: a.ok ? a.v : null,
      aaaa: aaaa.ok ? aaaa.v : null,
      mx: mxHosts,
      ns: ns.ok ? ns.v.map(stripDot) : null,
      txt_count: txt.ok ? txts.length : null,
      spf: txt.ok ? Boolean(spf) : null,
      spf_record: spf,
      dmarc: dmarc.ok ? Boolean(dm) : null,
      dmarc_record: dm,
      cname: cname.ok ? (cname.v.length ? stripDot(cname.v[0]) : null) : null,
    },
  };
}

// ---------- HTTPS probe ----------
async function probeWeb(domain) {
  const target = `https://${domain}/`;
  const build = (res) => {
    let redirects_to = null;
    try { const h = new URL(res.url || target).host.toLowerCase(); if (h && h !== domain) redirects_to = h; } catch {}
    return { reachable: true, status: res.status, server: res.headers.get("server") || null, redirects_to, hsts: res.headers.has("strict-transport-security") };
  };
  try {
    const res = await timedFetch(target, { method: "HEAD", redirect: "follow" });
    if (res.status !== 405 && res.status !== 501) return build(res);
  } catch {}
  try {
    const res = await timedFetch(target, { method: "GET", redirect: "follow" });
    try { if (res.body && res.body.cancel) await res.body.cancel(); } catch {}
    return build(res);
  } catch (e) {
    return { reachable: false, status: null, server: null, redirects_to: null, hsts: null, error: String(e && e.name === "AbortError" ? "timeout" : (e && e.message) || e).slice(0, 200) };
  }
}

// ---------- params ----------
async function readParams(request, url) {
  const p = Object.fromEntries(url.searchParams);
  if (request.method === "POST") {
    try { const b = await request.clone().json(); if (b && typeof b === "object") Object.assign(p, b); } catch {}
  }
  const s = (v) => (v === undefined || v === null || v === "" ? undefined : String(v).trim());
  return { domain: s(p.domain) };
}

const IPV4 = /^(\d{1,3})(\.\d{1,3}){3}$/;
// Returns { error } or { domain }
function validate(q) {
  const bad = (msg) => ({ error: `${msg} (no payment was taken)` });
  if (!q.domain) return bad("Missing required parameter: domain");
  let raw = q.domain;
  if (raw.length > 2048) return bad("domain is too long");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || raw.includes("/") || raw.includes("?") || raw.includes("#")) {
    try { raw = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : "https://" + raw).hostname; } catch { return bad("domain must be a hostname or URL, e.g. example.com or https://example.com/page"); }
  }
  if (raw.includes("@")) raw = raw.slice(raw.lastIndexOf("@") + 1);
  const notIp = "domain must be a registered hostname, not an IP address";
  if (raw.startsWith("[") || (raw.split(":").length > 2)) return bad(notIp); // IPv6 literal
  raw = raw.split(":")[0]; // strip port
  let domain = raw.toLowerCase().replace(/\.$/, "");
  if (!domain) return bad("domain must be a hostname or URL, e.g. example.com");
  if (domain.length > MAX_DOMAIN_LEN) return bad(`domain must be at most ${MAX_DOMAIN_LEN} characters`);
  if (IPV4.test(domain)) return bad(notIp);
  if (domain === "localhost" || domain.endsWith(".localhost") || domain.endsWith(".local") || domain.endsWith(".internal") || domain.endsWith(".home.arpa")) return bad("domain must be a public hostname, not a local name");
  const labels = domain.split(".");
  if (labels.length < 2) return bad("domain must include a top-level domain, e.g. example.com");
  for (const l of labels) {
    if (!l || l.length > 63 || !/^[a-z0-9-]+$/.test(l) || l.startsWith("-") || l.endsWith("-")) return bad(`domain contains an invalid label: "${l}"`);
  }
  const tld = labels[labels.length - 1];
  if (!/^(xn--[a-z0-9-]+|[a-z]{2,63})$/.test(tld)) return bad("domain must end in a valid top-level domain");
  return { domain };
}

// ---------- compute ----------
const isParkedNs = (ns) => PARKED_NS.some((p) => ns.includes(p));
// Returns { status, body } — status !== 200 means do not settle.
function compute(q, data, now = Date.now()) {
  const { rdap, dnsRes, web } = data;
  if (!rdap && !dnsRes.ok) {
    return { status: 502, body: { error: "Domain registration (RDAP) and DNS lookups are both temporarily unavailable; no payment was taken. Please retry.", detail: { rdap: data.rdapError, dns: dnsRes.error } } };
  }
  const dns = dnsRes.ok ? dnsRes.dns : null;
  const flags = [];
  let risk = 0;
  const reg = rdap || { registered: null, registrar: null, created: null, expires: null, updated: null, status: null, nameservers: null };
  let age_days = null;
  if (reg.registered === false) { flags.push("not_registered"); risk += 40; }
  if (reg.created) {
    age_days = Math.max(0, dayDiff(now, Date.parse(reg.created)));
    if (age_days < NEW_DOMAIN_DAYS) { flags.push(`registered_under_${NEW_DOMAIN_DAYS}_days`); risk += 40; }
  }
  if (reg.expires) {
    const left = dayDiff(Date.parse(reg.expires), now);
    if (left < EXPIRING_DAYS) { flags.push(left < 0 ? "expired" : `expires_under_${EXPIRING_DAYS}_days`); risk += 10; }
  }
  if (dns) {
    if (dns.mx !== null && dns.mx.length === 0) { flags.push("no_mx"); risk += 10; }
    if (dns.spf === false) { flags.push("no_spf"); risk += 10; }
    if (dns.dmarc === false) { flags.push("no_dmarc"); risk += 10; }
    if (dns.a !== null && dns.aaaa !== null && dns.cname !== null && !dns.a.length && !dns.aaaa.length && !dns.cname) flags.push("no_address_records");
  }
  if (!web.reachable) { flags.push("not_reachable"); risk += 15; }
  const nsAll = [...(reg.nameservers || []), ...((dns && dns.ns) || [])];
  if (nsAll.some(isParkedNs)) { flags.push("parked_nameservers"); risk += 25; }
  if (!rdap) flags.push("rdap_unavailable");
  if (!dns) flags.push("dns_unavailable");
  const body = {
    domain: q.domain,
    registered: reg.registered,
    registrar: reg.registrar,
    created: reg.created,
    expires: reg.expires,
    updated: reg.updated,
    age_days,
    status: reg.status,
    nameservers: reg.nameservers,
    dns,
    web,
    flags,
    risk_score: Math.min(100, risk),
    checked_at: new Date(now).toISOString(),
    sources: { rdap: RDAP_URL + q.domain, dns: DOH_URL, web: `https://${q.domain}/` },
    disclaimer: DISCLAIMER,
  };
  return { status: 200, body };
}

async function gather(q) {
  const [r, dnsRes, web] = await Promise.all([
    fetchRdap(q.domain).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e: String(e && e.name === "AbortError" ? "timeout" : (e && e.message) || e) })),
    fetchDns(q.domain),
    probeWeb(q.domain),
  ]);
  return { rdap: r.ok ? r.v : null, rdapError: r.ok ? null : r.e, dnsRes, web };
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
  domain: "example.com",
  registered: true,
  registrar: "RESERVED-Internet Assigned Numbers Authority",
  created: "1995-08-14T04:00:00.000Z",
  expires: "2027-08-13T04:00:00.000Z",
  updated: "2026-08-14T07:01:34.000Z",
  age_days: 11385,
  status: ["client delete prohibited", "client transfer prohibited", "client update prohibited"],
  nameservers: ["a.iana-servers.net", "b.iana-servers.net"],
  dns: { a: ["23.192.228.80"], aaaa: ["2600:1406:3a00:21::173e:2e65"], mx: [], ns: ["a.iana-servers.net", "b.iana-servers.net"], txt_count: 2, spf: true, spf_record: "v=spf1 -all", dmarc: true, dmarc_record: "v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s", cname: null },
  web: { reachable: true, status: 200, server: null, redirects_to: null, hsts: false },
  flags: ["no_mx"],
  risk_score: 10,
  checked_at: "2026-10-15T14:00:00.000Z",
  sources: { rdap: "https://rdap.org/domain/example.com", dns: DOH_URL, web: "https://example.com/" },
  disclaimer: DISCLAIMER,
};
function paymentRequired(env, url, error) {
  const resourceUrl = `${url.origin}/domain`;
  return {
    x402Version: 2,
    error,
    resource: { url: resourceUrl, description: DESCRIPTION, mimeType: "application/json" },
    accepts: [requirements(env)],
    extensions: {
      bazaar: {
        info: {
          input: { type: "http", method: "GET", queryParams: { domain: "example.com" } },
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
                    domain: { type: "string", description: "Domain name or URL to check, e.g. example.com or https://example.com/page (hostname is extracted; IPs and local names are rejected)" },
                  },
                  required: ["domain"],
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
      domain: { type: "string", minLength: 3, maxLength: 2048, description: "Domain name or URL to check, e.g. 'example.com' or 'https://example.com/page'. The hostname is extracted from a URL. IP addresses and local names (localhost, .local) are rejected." },
    },
    required: ["domain"],
  };
  const nullable = (t) => ({ type: [t, "null"] });
  const out = {
    type: "object",
    properties: {
      domain: { type: "string" },
      registered: { type: ["boolean", "null"], description: "false when RDAP reports no registration; null when RDAP was unavailable" },
      registrar: nullable("string"),
      created: { ...nullable("string"), description: "Registration date, ISO 8601" },
      expires: nullable("string"),
      updated: nullable("string"),
      age_days: { ...nullable("integer"), description: "Days since registration" },
      status: { type: ["array", "null"], items: { type: "string" }, description: "RDAP/EPP status values" },
      nameservers: { type: ["array", "null"], items: { type: "string" } },
      dns: {
        type: ["object", "null"],
        properties: {
          a: { type: ["array", "null"], items: { type: "string" } },
          aaaa: { type: ["array", "null"], items: { type: "string" } },
          mx: { type: ["array", "null"], items: { type: "object", properties: { priority: { type: "integer" }, host: { type: "string" } } } },
          ns: { type: ["array", "null"], items: { type: "string" } },
          txt_count: nullable("integer"),
          spf: { ...nullable("boolean"), description: "true if a v=spf1 TXT record exists" },
          spf_record: nullable("string"),
          dmarc: { ...nullable("boolean"), description: "true if _dmarc.<domain> has a v=DMARC1 TXT record" },
          dmarc_record: nullable("string"),
          cname: nullable("string"),
        },
      },
      web: {
        type: "object",
        properties: {
          reachable: { type: "boolean" },
          status: nullable("integer"),
          server: nullable("string"),
          redirects_to: { ...nullable("string"), description: "Final host if https://<domain>/ redirected elsewhere" },
          hsts: { ...nullable("boolean"), description: "Strict-Transport-Security header present" },
        },
      },
      flags: { type: "array", items: { type: "string", enum: ["not_registered", "registered_under_30_days", "expires_under_30_days", "expired", "no_mx", "no_spf", "no_dmarc", "no_address_records", "not_reachable", "parked_nameservers", "rdap_unavailable", "dns_unavailable"] } },
      risk_score: { type: "integer", minimum: 0, maximum: 100, description: "new domain +40, not registered +40, no MX +10, no SPF +10, no DMARC +10, not reachable +15, parked nameservers +25, expires within 30 days +10 (capped at 100)" },
      checked_at: { type: "string" },
      sources: { type: "object" },
      disclaimer: { type: "string" },
    },
    required: ["domain", "registered", "dns", "web", "flags", "risk_score", "checked_at"],
  };
  const op = (method) => ({
    operationId: method === "post" ? "domainIntelPost" : "domainIntel",
    summary: "Domain registration (RDAP), DNS records, HTTPS reachability, risk flags and a 0-100 risk score for any domain",
    tags: ["Domains", "DNS", "Security", "Verification"],
    "x-payment-info": { price: { mode: "fixed", currency: "USD", amount: "0.003000" }, protocols: [{ x402: {} }] },
    ...(method === "post"
      ? { requestBody: { required: true, content: { "application/json": { schema: params } } } }
      : { parameters: Object.entries(params.properties).map(([n, sch]) => ({ name: n, in: "query", required: params.required.includes(n), schema: { type: "string" }, description: sch.description })) }),
    responses: {
      200: { description: "Domain intelligence report", content: { "application/json": { schema: out } } },
      400: { description: "Invalid domain (IP address, local name, malformed) (no charge)" },
      402: { description: "Payment Required" },
      413: { description: "Input too large (no charge)" },
      502: { description: "RDAP and DNS both unavailable (no charge)" },
    },
  });
  return {
    openapi: "3.1.0",
    info: {
      title: SERVICE,
      version: "1.0.0",
      description: DESCRIPTION,
      "x-guidance": "Use GET /domain?domain=example.com (or POST /domain with JSON {domain}) to get a domain's RDAP registration (registrar, created, expires, age_days, status, nameservers), DNS records (A, AAAA, MX, NS, TXT count, SPF, DMARC, CNAME), a live HTTPS probe (reachable, status, server, redirects_to, hsts), risk flags and a 0-100 risk_score. A URL is accepted and its hostname extracted; IP addresses and localhost are rejected with 400. Costs $0.003 USDC on Base per request via x402. Good for vetting senders, links, vendors and crypto projects: new (<30 days), unregistered, parked, unreachable or mail-misconfigured domains score high. Partial upstream failures return null fields; a 502 (no charge) means both RDAP and DNS were unavailable.",
    },
    servers: [{ url: origin }],
    paths: { "/domain": { get: op("get"), post: op("post") } },
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
        endpoint: `${url.origin}/domain?domain=example.com`,
        price: "$0.003 USDC on Base per request (x402)",
        checks: ["rdap registration", "dns (A, AAAA, MX, NS, TXT, CNAME, SPF, DMARC)", "https probe", "risk flags + score"],
        sources: { rdap: "https://rdap.org", dns: DOH_URL },
        disclaimer: DISCLAIMER,
        configured: Boolean(env.PAY_TO),
        facilitator: env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET ? "cdp" : "payai",
      });
    }
    if (url.pathname === "/openapi.json" || url.pathname === "/.well-known/openapi.json") return json(openapi(url.origin));
    if (url.pathname !== "/domain") return json({ error: "Not found. Use /domain?domain=example.com" }, 404);
    if (!env.PAY_TO || !/^0x[0-9a-fA-F]{40}$/.test(env.PAY_TO)) return json({ error: "Service not configured: PAY_TO wallet address missing" }, 500);
    if (request.method !== "GET" && request.method !== "POST") return json({ error: "Use GET or POST" }, 405);
    const clen = Number(request.headers.get("content-length") || 0);
    if (request.url.length > MAX_INPUT_BYTES || clen > MAX_INPUT_BYTES) return json({ error: `Input too large: at most ${MAX_INPUT_BYTES} bytes (no payment was taken)` }, 413);

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

    let data;
    try { data = await gather(q); } catch (e) { return json({ error: "Domain lookups are temporarily unavailable; no payment was taken. Please retry.", detail: String(e.message || e) }, 502); }
    const result = compute(q, data);
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
