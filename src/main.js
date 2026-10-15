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
