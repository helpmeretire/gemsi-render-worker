// ---------- email analysis ----------
const ATOM = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+";
const LOCAL_DOT_ATOM = new RegExp(`^${ATOM}(\\.${ATOM})*$`);
const LOCAL_QUOTED = /^"(?:[^"\\\r\n]|\\[^\r\n])*"$/;
const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

// Practical RFC 5322 subset: dot-atom or quoted-string local part (<= 64 chars), ASCII hostname
// domain with at least two labels and an alphabetic TLD, total length <= 254.
function parseEmail(raw) {
  const out = { valid_syntax: false, local: "", domain: "" };
  if (typeof raw !== "string") return out;
  const s = raw.trim();
  if (!s || s.length > 254 || /[\u0000-\u001f\u007f]/.test(s)) return out;
  const at = s.lastIndexOf("@");
  if (at <= 0 || at === s.length - 1) return out;
  const local = s.slice(0, at), domain = s.slice(at + 1);
  if (local.length > 64) return out;
  if (!LOCAL_DOT_ATOM.test(local) && !LOCAL_QUOTED.test(local)) return out;
  if (domain.length > 253 || /[^A-Za-z0-9.-]/.test(domain)) return out;
  const labels = domain.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return out;
  if (!/^[A-Za-z]{2,63}$/.test(labels[labels.length - 1])) return out;
  return { valid_syntax: true, local, domain: domain.toLowerCase() };
}

// Optimal string alignment distance (Levenshtein + adjacent transposition).
function editDistance(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => { const r = new Array(n + 1).fill(0); r[0] = i; return r; });
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[m][n];
}

// Returns { domain, distance } for the closest top provider within distance 2, or null.
function closestProvider(domain) {
  if (TOP_PROVIDERS.includes(domain) || FREE_PROVIDERS.has(domain) || DISPOSABLE_DOMAINS.has(domain)) return null;
  let best = null;
  for (const p of TOP_PROVIDERS) {
    if (Math.abs(p.length - domain.length) > 2) continue;
    const dist = editDistance(domain, p);
    if (dist <= 2 && (!best || dist < best.distance)) best = { domain: p, distance: dist };
  }
  return best;
}

const PLUS_TAG_DOMAINS = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "icloud.com", "me.com", "mac.com", "protonmail.com", "proton.me", "pm.me", "fastmail.com", "fastmail.fm", "zoho.com", "hey.com"]);
function normalize(local, domain) {
  let l = local.toLowerCase(), d = domain;
  if (d === "googlemail.com") d = "gmail.com";
  if (d === "gmail.com") l = l.replace(/\./g, "");
  if (PLUS_TAG_DOMAINS.has(d)) l = l.replace(/\+.*$/, "");
  return `${l}@${d}`;
}

function isRole(local) {
  const l = local.toLowerCase().replace(/^"|"$/g, "");
  if (ROLE_LOCALS.has(l)) return true;
  return /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer[-_.]?daemon)/.test(l);
}

// ---------- DNS over HTTPS ----------
async function dohQuery(name, type, ctx) {
  const u = `${DOH_URL}?name=${encodeURIComponent(name)}&type=${type}`;
  const cache = typeof caches !== "undefined" && caches && caches.default ? caches.default : null;
  if (cache) {
    try { const hit = await cache.match(u); if (hit) return await hit.json(); } catch {}
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), DOH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(u, { headers: { accept: "application/dns-json", "User-Agent": USER_AGENT }, signal: ac.signal });
  } finally { clearTimeout(timer); }
  if (!res.ok) throw new Error(`DNS resolver responded ${res.status}`);
  const data = await res.json();
  if (typeof data.Status !== "number") throw new Error("DNS resolver returned an unexpected response");
  if (data.Status !== 0 && data.Status !== 3) throw new Error(`DNS resolver returned RCODE ${data.Status} for ${name}`);
  if (cache) {
    const ttl = Math.max(60, Math.min(3600, ...(data.Answer || []).map((a) => Number(a.TTL) || 300)));
    const put = cache.put(u, new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${ttl}` } })).catch(() => {});
    if (ctx && ctx.waitUntil) ctx.waitUntil(put);
  }
  return data;
}

const answers = (data, type) => (Array.isArray(data.Answer) ? data.Answer.filter((a) => a.type === type && typeof a.data === "string") : []);
// Returns { status: "mx"|"null_mx"|"a"|"aaaa"|"nxdomain"|"none", mx_hosts: [...] }
async function lookupDomain(domain, ctx) {
  const mx = await dohQuery(domain, "MX", ctx);
  if (mx.Status === 3) return { status: "nxdomain", mx_hosts: [] };
  const recs = answers(mx, 15).map((a) => { const [pri, host] = a.data.trim().split(/\s+/); return { pri: Number(pri) || 0, host: (host || "").replace(/\.$/, "").toLowerCase() }; });
  if (recs.length) {
    if (recs.every((r) => r.host === "" || r.host === ".")) return { status: "null_mx", mx_hosts: [] }; // RFC 7505: domain refuses mail
    recs.sort((x, y) => x.pri - y.pri);
    return { status: "mx", mx_hosts: [...new Set(recs.filter((r) => r.host).map((r) => r.host))].slice(0, MAX_MX_HOSTS) };
  }
  const a = await dohQuery(domain, "A", ctx);
  if (answers(a, 1).length) return { status: "a", mx_hosts: [] };
  const aaaa = await dohQuery(domain, "AAAA", ctx);
  if (answers(aaaa, 28).length) return { status: "aaaa", mx_hosts: [] };
  return { status: "none", mx_hosts: [] };
}

// ---------- params ----------
async function readParams(request, url) {
  const p = Object.fromEntries(url.searchParams);
  if (request.method === "POST") {
    try { const b = await request.clone().json(); if (b && typeof b === "object" && !Array.isArray(b)) Object.assign(p, b); } catch {}
  }
  return { email: p.email, emails: p.emails };
}

// Returns { error } or { emails: [..] }
function validate(q) {
  const bad = (msg) => ({ error: `${msg} (no payment was taken)` });
  let list = [];
  if (q.emails !== undefined && q.emails !== null && q.emails !== "") {
    if (typeof q.emails === "string") list = q.emails.split(",");
    else if (Array.isArray(q.emails)) list = q.emails;
    else return bad("emails must be an array of strings (or a comma-separated string)");
  }
  if (q.email !== undefined && q.email !== null && q.email !== "") {
    if (typeof q.email !== "string") return bad("email must be a string");
    list.unshift(q.email);
  }
  if (!list.length) return bad("Missing required parameter: email (or emails: [...])");
  if (list.length > MAX_EMAILS) return bad(`Too many addresses: at most ${MAX_EMAILS} per request`);
  const emails = [];
  for (const e of list) {
    if (typeof e !== "string") return bad("Every entry in emails must be a string");
    const s = e.trim();
    if (!s) return bad("Empty email address in request");
    if (s.length > 320) return bad("Email address too long (max 320 characters)");
    emails.push(s);
  }
  return { emails };
}

// Resolves every syntactically valid domain once. Throws on DNS resolver failure.
async function loadDns(q, ctx) {
  const domains = [...new Set(q.emails.map((e) => parseEmail(e)).filter((p) => p.valid_syntax).map((p) => p.domain))];
  const results = await Promise.all(domains.map((d) => lookupDomain(d, ctx)));
  const dns = {};
  domains.forEach((d, i) => { dns[d] = results[i]; });
  return dns;
}

function analyze(email, dns) {
  const p = parseEmail(email);
  const reasons = [];
  const r = { email, normalized_email: null, valid_syntax: p.valid_syntax, domain: p.domain || null, has_mx: false, mx_hosts: [], disposable: false, role: false, free_provider: false, suggestion: null, risk: "high", reasons };
  if (!p.valid_syntax) { reasons.push("invalid_syntax"); return r; }
  r.normalized_email = normalize(p.local, p.domain);
  const d = dns[p.domain] || { status: "none", mx_hosts: [] };
  r.has_mx = d.status === "mx";
  r.mx_hosts = d.mx_hosts;
  r.disposable = DISPOSABLE_DOMAINS.has(p.domain);
  r.role = isRole(p.local);
  r.free_provider = FREE_PROVIDERS.has(p.domain);
  const close = closestProvider(p.domain);
  if (close && (close.distance === 1 || !r.has_mx)) r.suggestion = `${p.local.toLowerCase()}@${close.domain}`;

  let risk = "low";
  const bump = (level, reason) => { reasons.push(reason); if (level === "high" || (level === "medium" && risk === "low")) risk = level; };
  if (d.status === "nxdomain") bump("high", "domain_not_found");
  else if (d.status === "null_mx") bump("high", "null_mx_domain_refuses_mail");
  else if (d.status === "none") bump("high", "no_mx_or_address_records");
  else if (d.status === "a" || d.status === "aaaa") bump("medium", `no_mx_fallback_${d.status}`);
  if (r.disposable) bump("high", "disposable_domain");
  if (r.suggestion) bump("medium", "possible_typo");
  if (r.role) bump("medium", "role_address");
  if (r.free_provider) reasons.push("free_provider");
  r.risk = risk;
  return r;
}

// Returns { status, body } — status !== 200 means do not settle.
function compute(q, dns) {
  const results = q.emails.map((e) => analyze(e, dns));
  return { status: 200, body: { count: results.length, results, resolver: "cloudflare-dns.com (DNS over HTTPS)", note: "Checks are syntax, DNS (MX/A/AAAA), disposable/role/free-provider lists and typo heuristics. No SMTP mailbox probing is performed; has_mx=true means the domain accepts mail, not that the mailbox exists." } };
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
  count: 1,
  results: [
    {
      email: "John.Doe+news@gmail.com",
      normalized_email: "johndoe@gmail.com",
      valid_syntax: true,
      domain: "gmail.com",
      has_mx: true,
      mx_hosts: ["gmail-smtp-in.l.google.com", "alt1.gmail-smtp-in.l.google.com", "alt2.gmail-smtp-in.l.google.com", "alt3.gmail-smtp-in.l.google.com", "alt4.gmail-smtp-in.l.google.com"],
      disposable: false,
      role: false,
      free_provider: true,
      suggestion: null,
      risk: "low",
      reasons: ["free_provider"],
    },
  ],
  resolver: "cloudflare-dns.com (DNS over HTTPS)",
  note: "Checks are syntax, DNS (MX/A/AAAA), disposable/role/free-provider lists and typo heuristics. No SMTP mailbox probing is performed; has_mx=true means the domain accepts mail, not that the mailbox exists.",
};
function paymentRequired(env, url, error) {
  const resourceUrl = `${url.origin}/verify`;
  return {
    x402Version: 2,
    error,
    resource: { url: resourceUrl, description: DESCRIPTION, mimeType: "application/json" },
    accepts: [requirements(env)],
    extensions: {
      bazaar: {
        info: {
          input: { type: "http", method: "GET", queryParams: { email: "John.Doe+news@gmail.com" } },
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
                    email: { type: "string", description: "Email address to check, e.g. john@example.com" },
                    emails: { type: "string", description: "Optional comma-separated list of up to 20 addresses (same price as one)" },
                  },
                  required: ["email"],
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
      email: { type: "string", description: "Email address to check, e.g. 'john@example.com'. Either email or emails is required." },
      emails: { type: "array", items: { type: "string" }, maxItems: MAX_EMAILS, description: "Up to 20 addresses checked in one request for the same price (GET: comma-separated string)" },
    },
  };
  const result = {
    type: "object",
    properties: {
      email: { type: "string", description: "Address as submitted" },
      normalized_email: { type: ["string", "null"], description: "Lowercased; Gmail dots and +tags removed, googlemail.com mapped to gmail.com" },
      valid_syntax: { type: "boolean", description: "Passes the RFC 5322 practical subset" },
      domain: { type: ["string", "null"] },
      has_mx: { type: "boolean", description: "Domain publishes MX records" },
      mx_hosts: { type: "array", items: { type: "string" }, description: "Up to 5 MX hosts by priority" },
      disposable: { type: "boolean", description: "Domain is a known disposable/temporary mail service" },
      role: { type: "boolean", description: "Role or functional mailbox (admin@, info@, support@, noreply@ ...)" },
      free_provider: { type: "boolean", description: "Free consumer mailbox provider (Gmail, Yahoo, Outlook ...)" },
      suggestion: { type: ["string", "null"], description: "Likely intended address when the domain looks like a typo of a major provider" },
      risk: { type: "string", enum: ["low", "medium", "high"] },
      reasons: { type: "array", items: { type: "string" }, description: "Machine-readable reason codes behind the risk score" },
    },
    required: ["email", "normalized_email", "valid_syntax", "domain", "has_mx", "mx_hosts", "disposable", "role", "free_provider", "suggestion", "risk", "reasons"],
  };
  const out = {
    type: "object",
    properties: { count: { type: "integer" }, results: { type: "array", items: result }, resolver: { type: "string" }, note: { type: "string" } },
    required: ["count", "results"],
  };
  const op = (method) => ({
    operationId: method === "post" ? "verifyEmailPost" : "verifyEmail",
    summary: "Verify one email address or up to 20 at once: syntax, MX records, disposable, role, free provider, typo suggestion, normalized form and risk score",
    tags: ["Email", "Validation", "Data Quality"],
    "x-payment-info": { price: { mode: "fixed", currency: "USD", amount: "0.001000" }, protocols: [{ x402: {} }] },
    ...(method === "post"
      ? { requestBody: { required: true, content: { "application/json": { schema: params } } } }
      : { parameters: Object.entries(params.properties).map(([n, sch]) => ({ name: n, in: "query", required: false, schema: { type: "string" }, description: sch.description })) }),
    responses: {
      200: { description: "Verification results", content: { "application/json": { schema: out } } },
      400: { description: "Missing or malformed input, or more than 20 addresses (no charge)" },
      402: { description: "Payment Required" },
      413: { description: "Request too large (no charge)" },
      502: { description: "DNS resolver temporarily unavailable (no charge)" },
    },
  });
  return {
    openapi: "3.1.0",
    info: {
      title: SERVICE,
      version: "1.0.0",
      description: DESCRIPTION,
      "x-guidance": "Use GET /verify?email=john@example.com (or POST /verify with JSON {email} or {emails:[...]} for up to 20 addresses) to check an email address before you send to it, store it or trust it. Each result reports valid_syntax, has_mx with mx_hosts, disposable, role, free_provider, a typo suggestion (gmial.com -> gmail.com), normalized_email and a risk score of low/medium/high with reason codes. Costs $0.001 USDC on Base per request via x402, whether you send 1 or 20 addresses. Invalid addresses are returned as results (valid_syntax=false), not errors. No SMTP mailbox probing is done, so has_mx=true means the domain accepts mail, not that the specific mailbox exists.",
    },
    servers: [{ url: origin }],
    paths: { "/verify": { get: op("get"), post: op("post") } },
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
        endpoint: `${url.origin}/verify?email=john@example.com  (or POST JSON {email} / {emails:[...up to 20]})`,
        price: "$0.001 USDC on Base per request (x402), 1 to 20 addresses per request",
        checks: ["syntax (RFC 5322 subset)", "MX records via DNS over HTTPS (A/AAAA fallback)", "disposable domain list", "role address", "free-mail provider", "typo suggestion", "normalized form", "risk score"],
        resolver: "cloudflare-dns.com",
        configured: Boolean(env.PAY_TO),
        facilitator: env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET ? "cdp" : "payai",
      });
    }
    if (url.pathname === "/openapi.json" || url.pathname === "/.well-known/openapi.json") return json(openapi(url.origin));
    if (url.pathname !== "/verify") return json({ error: "Not found. Use /verify?email=john@example.com" }, 404);
    if (!env.PAY_TO || !/^0x[0-9a-fA-F]{40}$/.test(env.PAY_TO)) return json({ error: "Service not configured: PAY_TO wallet address missing" }, 500);
    if (request.method !== "GET" && request.method !== "POST") return json({ error: "Use GET or POST" }, 405);
    const clen = Number(request.headers.get("content-length") || 0);
    if (url.search.length > 8192 || clen > MAX_BODY_BYTES) return json({ error: `Request too large: at most ${MAX_EMAILS} addresses, ${MAX_BODY_BYTES} bytes (no payment was taken)` }, 413);

    const header = request.headers.get("PAYMENT-SIGNATURE") || request.headers.get("X-PAYMENT");
    if (!header) return send402(env, url, "PAYMENT-SIGNATURE header is required");
    if (request.method === "POST") {
      const raw = await request.clone().text();
      if (raw.length > MAX_BODY_BYTES) return json({ error: `Request too large: at most ${MAX_EMAILS} addresses, ${MAX_BODY_BYTES} bytes (no payment was taken)` }, 413);
    }
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

    let dns;
    try { dns = await loadDns(q, ctx); } catch (e) { return json({ error: "DNS resolver is temporarily unavailable; no payment was taken. Please retry.", detail: String(e.message || e) }, 502); }
    const result = compute(q, dns);
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
