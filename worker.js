// FX Reference Rates — a paid (x402) currency exchange rate service for AI agents.
// Data: European Central Bank euro foreign exchange reference rates (daily + last 90 days).
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
const SERVICE = "FX Reference Rates";
const DESCRIPTION =
  "Currency exchange rates from the European Central Bank's official euro reference rates: convert an amount from one ISO 4217 currency to up to 30 others, today or on any date in the last 90 days. Cross rates computed via EUR.";

const ECB_DAILY = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
const ECB_HIST = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml";
const ECB_INFO = "https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html";
const SOURCE = "European Central Bank euro foreign exchange reference rates";
const DISCLAIMER =
  "These reference rates are for information purposes only and are published free of charge by the ECB at https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html. Cross rates are calculated from ECB euro rates and are not official ECB rates.";
// Currencies in the ECB reference-rate basket (plus EUR itself).
const SUPPORTED = ["EUR", "USD", "JPY", "CZK", "DKK", "GBP", "HUF", "PLN", "RON", "SEK", "CHF", "ISK", "NOK", "TRY", "AUD", "BRL", "CAD", "CNY", "HKD", "IDR", "ILS", "INR", "KRW", "MXN", "MYR", "NZD", "PHP", "SGD", "THB", "ZAR"];
const MAX_TO = 30;
const CACHE_SECONDS = 3600;


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


// ---------- ECB data ----------
// Parses ECB eurofxref XML into [{ time, rates: { USD: 1.09, ... } }] sorted newest first.
function parseEcb(xml) {
  const days = [];
  const dayRe = /<Cube\s+time\s*=\s*['"](\d{4}-\d{2}-\d{2})['"]\s*>([\s\S]*?)<\/Cube>/g;
  const rateRe = /<Cube\s+currency\s*=\s*['"]([A-Z]{3})['"]\s+rate\s*=\s*['"]([0-9.]+)['"]\s*\/>/g;
  let d;
  while ((d = dayRe.exec(xml))) {
    const rates = { EUR: 1 };
    let r;
    rateRe.lastIndex = 0;
    while ((r = rateRe.exec(d[2]))) {
      const v = Number(r[2]);
      if (Number.isFinite(v) && v > 0) rates[r[1]] = v;
    }
    if (Object.keys(rates).length > 1) days.push({ time: d[1], rates });
  }
  days.sort((a, b) => (a.time < b.time ? 1 : -1));
  return days;
}

async function fetchXml(src, ctx) {
  const cache = typeof caches !== "undefined" && caches && caches.default ? caches.default : null;
  if (cache) {
    try { const hit = await cache.match(src); if (hit) return await hit.text(); } catch {}
  }
  const res = await fetch(src, { headers: { Accept: "application/xml, text/xml" } });
  if (!res.ok) throw new Error(`ECB responded ${res.status}`);
  const text = await res.text();
  if (cache) {
    const put = cache.put(src, new Response(text, { headers: { "Content-Type": "application/xml", "Cache-Control": `public, max-age=${CACHE_SECONDS}` } })).catch(() => {});
    if (ctx && ctx.waitUntil) ctx.waitUntil(put);
  }
  return text;
}

async function loadDays(date, ctx) {
  const src = date ? ECB_HIST : ECB_DAILY;
  const days = parseEcb(await fetchXml(src, ctx));
  if (!days.length) throw new Error("ECB data could not be parsed");
  return { src, days };
}

// ---------- params ----------
const todayUtc = () => new Date().toISOString().slice(0, 10);
async function readParams(request, url) {
  const p = Object.fromEntries(url.searchParams);
  if (request.method === "POST") {
    try { const b = await request.clone().json(); if (b && typeof b === "object") Object.assign(p, b); } catch {}
  }
  const s = (v) => (v === undefined || v === null || v === "" ? undefined : String(v).trim());
  const toList = Array.isArray(p.to) ? p.to.join(",") : s(p.to);
  return { from: s(p.from), to: toList, amount: s(p.amount), date: s(p.date) };
}

// Returns { error } or { from, to: [..], amount, date }
function validate(q) {
  const bad = (msg) => ({ error: `${msg} (no payment was taken)` });
  if (!q.from) return bad("Missing required parameter: from");
  if (!q.to) return bad("Missing required parameter: to");
  const from = q.from.toUpperCase();
  const to = [...new Set(q.to.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean))];
  if (!to.length) return bad("Missing required parameter: to");
  if (to.length > MAX_TO) return bad(`Too many target currencies: at most ${MAX_TO}`);
  const unsupported = [from, ...to].filter((c) => !SUPPORTED.includes(c));
  if (unsupported.length) return { error: `Unsupported currency: ${[...new Set(unsupported)].join(", ")} (no payment was taken)`, supported: SUPPORTED };
  let amount = 1;
  if (q.amount !== undefined) {
    amount = Number(q.amount);
    if (!/^\d+(\.\d+)?$/.test(q.amount) || !Number.isFinite(amount)) return bad("amount must be a non-negative number, e.g. 100 or 25.50");
  }
  let date;
  if (q.date !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(q.date) || Number.isNaN(Date.parse(q.date + "T00:00:00Z")) || new Date(q.date + "T00:00:00Z").toISOString().slice(0, 10) !== q.date) return bad("date must be YYYY-MM-DD");
    const today = todayUtc();
    if (q.date > today) return bad("date cannot be in the future");
    const oldest = new Date(Date.parse(today + "T00:00:00Z") - 90 * 86400000).toISOString().slice(0, 10);
    if (q.date < oldest) return bad(`date must be within the last 90 days (on or after ${oldest})`);
    if (q.date !== today) date = q.date; // today's request uses the latest daily file
  }
  return { from, to, amount, date };
}

const sig = (x) => Number(x.toPrecision(8));
// Returns { status, body } — status !== 200 means do not settle.
function compute(q, data) {
  let day = data.days[0];
  let note = "ECB reference rates are published around 16:00 CET on TARGET working days. Cross rates are calculated via EUR.";
  if (q.date) {
    day = data.days.find((d) => d.time <= q.date);
    if (!day) return { status: 404, body: { error: `No ECB reference rates available on or before ${q.date} (no payment was taken)` } };
    if (day.time !== q.date) note = `${q.date} was not an ECB publication day; using the most recent prior ECB reference date ${day.time}. ` + note;
  } else {
    note = `Latest available ECB reference rates (${day.time}). ` + note;
  }
  const missing = [q.from, ...q.to].filter((c) => !(c in day.rates));
  if (missing.length) return { status: 404, body: { error: `ECB published no rate for ${[...new Set(missing)].join(", ")} on ${day.time} (no payment was taken)` } };
  const rates = {}, converted = {};
  for (const c of q.to) {
    const raw = day.rates[c] / day.rates[q.from];
    rates[c] = sig(raw);
    converted[c] = Number((q.amount * raw).toFixed(6));
  }
  const body = { from: q.from, to: q.to, amount: q.amount, rates, converted, date: day.time };
  if (q.date) body.requested_date = q.date;
  Object.assign(body, { note, source: SOURCE, source_url: data.src, disclaimer: DISCLAIMER });
  return { status: 200, body };
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
  from: "USD",
  to: ["GBP", "JPY"],
  amount: 100,
  rates: { GBP: 0.79324238, JPY: 149.82144 },
  converted: { GBP: 79.324238, JPY: 14982.144492 },
  date: "2026-10-14",
  note: "Latest available ECB reference rates (2026-10-14). ECB reference rates are published around 16:00 CET on TARGET working days. Cross rates are calculated via EUR.",
  source: SOURCE,
  source_url: ECB_DAILY,
  disclaimer: DISCLAIMER,
};
function paymentRequired(env, url, error) {
  const resourceUrl = `${url.origin}/rate`;
  return {
    x402Version: 2,
    error,
    resource: { url: resourceUrl, description: DESCRIPTION, mimeType: "application/json" },
    accepts: [requirements(env)],
    extensions: {
      bazaar: {
        info: {
          input: { type: "http", method: "GET", queryParams: { from: "USD", to: "GBP,JPY", amount: "100" } },
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
                    from: { type: "string", description: "Source currency, ISO 4217 code, e.g. USD" },
                    to: { type: "string", description: "Target currency or comma-separated list (max 30), e.g. GBP,JPY" },
                    amount: { type: "string", description: "Optional amount to convert (default 1)" },
                    date: { type: "string", description: "Optional YYYY-MM-DD within the last 90 days; non-publication days use the most recent prior ECB date" },
                  },
                  required: ["from", "to"],
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
      from: { type: "string", enum: SUPPORTED, description: "Source currency, ISO 4217 code, e.g. 'USD'" },
      to: { type: "string", minLength: 3, description: "Target currency or comma-separated list of up to 30 codes, e.g. 'GBP,JPY'" },
      amount: { type: "number", minimum: 0, default: 1, description: "Optional amount to convert (default 1)" },
      date: { type: "string", format: "date", description: "Optional YYYY-MM-DD within the last 90 days. On a non-publication day the most recent prior ECB reference date is used." },
    },
    required: ["from", "to"],
  };
  const out = {
    type: "object",
    properties: {
      from: { type: "string" },
      to: { type: "array", items: { type: "string" } },
      amount: { type: "number" },
      rates: { type: "object", additionalProperties: { type: "number" }, description: "1 unit of `from` in each target currency" },
      converted: { type: "object", additionalProperties: { type: "number" }, description: "`amount` converted into each target currency" },
      date: { type: "string", description: "ECB reference date used" },
      requested_date: { type: "string" },
      note: { type: "string" },
      source: { type: "string" },
      source_url: { type: "string" },
      disclaimer: { type: "string" },
    },
    required: ["from", "to", "rates", "converted", "date"],
  };
  const op = (method) => ({
    operationId: method === "post" ? "getRatePost" : "getRate",
    summary: "Currency exchange rates and conversion from ECB euro reference rates (today or last 90 days)",
    tags: ["Finance", "Currency", "FX"],
    "x-payment-info": { price: { mode: "fixed", currency: "USD", amount: "0.003000" }, protocols: [{ x402: {} }] },
    ...(method === "post"
      ? { requestBody: { required: true, content: { "application/json": { schema: params } } } }
      : { parameters: Object.entries(params.properties).map(([n, sch]) => ({ name: n, in: "query", required: params.required.includes(n), schema: { type: "string" }, description: sch.description })) }),
    responses: {
      200: { description: "Exchange rates", content: { "application/json": { schema: out } } },
      400: { description: "Invalid or unsupported parameters (no charge)" },
      402: { description: "Payment Required" },
      502: { description: "ECB data temporarily unavailable (no charge)" },
    },
  });
  return {
    openapi: "3.1.0",
    info: {
      title: SERVICE,
      version: "1.0.0",
      description: DESCRIPTION,
      "x-guidance": "Use GET /rate?from=USD&to=GBP,JPY&amount=100 (or POST /rate with a JSON body {from, to, amount, date}) to get exchange rates and converted amounts from the European Central Bank's euro foreign exchange reference rates. Add date=YYYY-MM-DD for any date in the last 90 days; weekends/holidays use the most recent prior ECB date. Costs $0.003 USDC on Base per request via x402. Supported currencies: " + SUPPORTED.join(", ") + ". Rates are daily reference rates (about 16:00 CET), not live market quotes.",
    },
    servers: [{ url: origin }],
    paths: { "/rate": { get: op("get"), post: op("post") } },
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
        endpoint: `${url.origin}/rate?from=USD&to=GBP,JPY&amount=100&date=<optional YYYY-MM-DD>`,
        price: "$0.003 USDC on Base per request (x402)",
        supported_currencies: SUPPORTED,
        source: SOURCE,
        source_info: ECB_INFO,
        disclaimer: DISCLAIMER,
        configured: Boolean(env.PAY_TO),
        facilitator: env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET ? "cdp" : "payai",
      });
    }
    if (url.pathname === "/openapi.json" || url.pathname === "/.well-known/openapi.json") return json(openapi(url.origin));
    if (url.pathname !== "/rate") return json({ error: "Not found. Use /rate?from=USD&to=EUR" }, 404);
    if (!env.PAY_TO || !/^0x[0-9a-fA-F]{40}$/.test(env.PAY_TO)) return json({ error: "Service not configured: PAY_TO wallet address missing" }, 500);
    if (request.method !== "GET" && request.method !== "POST") return json({ error: "Use GET or POST" }, 405);

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
    try { data = await loadDays(q.date, ctx); } catch (e) { return json({ error: "ECB reference rates are temporarily unavailable; no payment was taken. Please retry.", detail: String(e.message || e) }, 502); }
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
