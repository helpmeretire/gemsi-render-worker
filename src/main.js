// ---------- SEC data ----------
const TICKER_RE = /^[A-Za-z]{1,5}([.\-][A-Za-z]{1,2})?$/;

async function getText(url, ttl) {
  const cache = typeof caches !== "undefined" && caches.default ? caches.default : null;
  const key = new Request(url);
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return { ok: true, status: 200, text: await hit.text() };
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 9000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, accept: "application/json, application/atom+xml, text/plain" }, signal: ctrl.signal });
    const text = await res.text();
    if (res.ok && cache) await cache.put(key, new Response(text, { headers: { "Cache-Control": `max-age=${ttl}` } }));
    return { ok: res.ok, status: res.status, text };
  } catch (e) {
    return { ok: false, status: 0, text: "", error: String(e) };
  } finally {
    clearTimeout(t);
  }
}

async function lookupCik(ticker) {
  const r = await getText("https://www.sec.gov/include/ticker.txt", 86400);
  if (!r.ok) return { error: "upstream", status: r.status };
  const t = ticker.toLowerCase().replace(".", "-");
  const esc = t.replace(/[-]/g, "\\-");
  const m = r.text.match(new RegExp("(?:^|\\n)" + esc + "\\t(\\d+)"));
  return m ? { cik: m[1] } : { cik: null };
}

const pad = (cik) => String(cik).padStart(10, "0");
const days = (a, b) => (Date.parse(b) - Date.parse(a)) / 86400000;

function pickFacts(units) {
  const out = { annual: null, quarter: null, instant: null };
  const better = (cur, f) => !cur || f.end > cur.end || (f.end === cur.end && String(f.filed) > String(cur.filed));
  for (const f of units || []) {
    if (typeof f.val !== "number" || !f.end) continue;
    if (f.start) {
      const d = days(f.start, f.end);
      if (d >= 350 && d <= 380 && /^(10-K|20-F|40-F)/.test(f.form || "") && better(out.annual, f)) out.annual = f;
      if (d >= 80 && d <= 100 && better(out.quarter, f)) out.quarter = f;
    } else if (better(out.instant, f)) out.instant = f;
  }
  return out;
}

async function fetchConcept(cik, names) {
  for (const n of names) {
    const r = await getText(`https://data.sec.gov/api/xbrl/companyconcept/CIK${pad(cik)}/${n}.json`, 21600);
    if (r.status === 404) continue;
    if (!r.ok) return { error: true, status: r.status };
    let j;
    try { j = JSON.parse(r.text); } catch { continue; }
    const units = j.units || {};
    const key = units.USD ? "USD" : units["USD/shares"] ? "USD/shares" : units.shares ? "shares" : Object.keys(units)[0];
    const picked = pickFacts(units[key]);
    if (picked.annual || picked.quarter || picked.instant) return { concept: n, unit: key, entityName: j.entityName, ...picked };
  }
  return null;
}

async function fetchFilings(cik) {
  const r = await getText(`https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${pad(cik)}&type=&dateb=&owner=include&count=40&output=atom`, 3600);
  if (!r.ok) return null;
  const out = [];
  const WANT = /^(10-K|10-Q|8-K|20-F|6-K|40-F|DEF 14A|S-1)(\/A)?$/;
  for (const e of r.text.split("<entry>").slice(1)) {
    const form = (e.match(/<category[^>]*term="([^"]+)"/) || [])[1];
    const filed = (e.match(/<filing-date>([^<]+)<\/filing-date>/) || [])[1];
    const href = (e.match(/<filing-href>([^<]+)<\/filing-href>/) || [])[1];
    if (form && WANT.test(form) && filed && href) out.push({ form, filed, url: href.replace(/&amp;/g, "&") });
    if (out.length >= 6) break;
  }
  return out;
}

async function buildSnapshot(ticker) {
  const look = await lookupCik(ticker);
  if (look.error) return { status: 502 };
  if (!look.cik) return { status: 404 };
  const cik = look.cik;
  const fields = Object.keys(CONCEPTS);
  const res = {};
  let errors = 0;
  for (let i = 0; i < fields.length; i += 3) {
    const batch = fields.slice(i, i + 3);
    const got = await Promise.all(batch.map((f) => fetchConcept(cik, CONCEPTS[f])));
    batch.forEach((f, k) => { if (got[k] && got[k].error) errors++; else res[f] = got[k]; });
  }
  const filings = await fetchFilings(cik);
  if (errors >= fields.length) return { status: 502 };
  const entityName = Object.values(res).find((v) => v && v.entityName)?.entityName || null;
  const cite = (v, which) => (v && v[which] ? { value: v[which].val, period_end: v[which].end, form: v[which].form || null, filed: v[which].filed || null, fiscal_year: v[which].fy || null, fiscal_period: v[which].fp || null, concept: v.concept } : null);
  const val = (v, which) => (v && v[which] ? v[which].val : null);
  const annual = {
    period_end: res.revenue?.annual?.end || res.net_income?.annual?.end || null,
    fiscal_year: res.revenue?.annual?.fy || res.net_income?.annual?.fy || null,
    revenue: val(res.revenue, "annual"),
    net_income: val(res.net_income, "annual"),
    eps_diluted: val(res.eps_diluted, "annual"),
  };
  const quarter = {
    period_end: res.revenue?.quarter?.end || res.net_income?.quarter?.end || null,
    revenue: val(res.revenue, "quarter"),
    net_income: val(res.net_income, "quarter"),
    eps_diluted: val(res.eps_diluted, "quarter"),
  };
  const balance = {
    as_of: res.total_assets?.instant?.end || res.cash?.instant?.end || null,
    cash_and_equivalents: val(res.cash, "instant"),
    total_assets: val(res.total_assets, "instant"),
    total_liabilities: val(res.total_liabilities, "instant"),
    stockholders_equity: val(res.stockholders_equity, "instant"),
    long_term_debt: val(res.long_term_debt, "instant"),
  };
  const netMargin = annual.revenue && annual.net_income !== null ? Math.round((annual.net_income / annual.revenue) * 10000) / 100 : null;
  return {
    status: 200,
    body: {
      ticker: ticker.toUpperCase(),
      company: entityName,
      cik: pad(cik),
      currency: "USD",
      latest_fiscal_year: annual,
      latest_quarter: quarter,
      net_margin_pct_latest_fy: netMargin,
      balance_sheet: balance,
      shares_outstanding: res.shares_outstanding?.instant ? { value: res.shares_outstanding.instant.val, as_of: res.shares_outstanding.instant.end } : null,
      recent_filings: filings || [],
      citations: {
        revenue: cite(res.revenue, "annual"),
        net_income: cite(res.net_income, "annual"),
        total_assets: cite(res.total_assets, "instant"),
        edgar_company_page: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${pad(cik)}`,
      },
      missing_fields: Object.keys(CONCEPTS).filter((f) => !res[f]),
      checked_at: new Date().toISOString(),
      disclaimer: DISCLAIMER,
      sources: SOURCES,
    },
  };
}

// ---------- x402 ----------
function requirements(env) {
  return { scheme: "exact", network: NETWORK, amount: PRICE_ATOMIC, asset: USDC_BASE, payTo: env.PAY_TO, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } };
}
const EXAMPLE_OUT = {
  ticker: "AAPL",
  company: "Apple Inc.",
  cik: "0000320193",
  latest_fiscal_year: { period_end: "YYYY-MM-DD", fiscal_year: 0, revenue: 0, net_income: 0, eps_diluted: 0 },
  balance_sheet: { as_of: "YYYY-MM-DD", cash_and_equivalents: 0, total_assets: 0 },
  recent_filings: [{ form: "10-K", filed: "YYYY-MM-DD", url: "https://www.sec.gov/Archives/edgar/data/320193/..." }],
  note: "Shape only; see GET /sample for a live AAPL snapshot.",
  disclaimer: DISCLAIMER,
};
function paymentRequired(env, url, error) {
  return {
    x402Version: 2,
    error,
    resource: { url: `${url.origin}/company`, description: DESCRIPTION, mimeType: "application/json" },
    accepts: [requirements(env)],
    extensions: {
      bazaar: {
        info: {
          input: { type: "http", method: "POST", bodyType: "json", body: { ticker: "AAPL" } },
          output: { type: "json", example: EXAMPLE_OUT },
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
                bodyType: { type: "string", enum: ["json", "form-data", "text"] },
                body: { type: "object", properties: { ticker: { type: "string", description: "US stock ticker, e.g. AAPL or BRK.B" } }, required: ["ticker"] },
                queryParams: { type: "object", additionalProperties: { type: "string" } },
                headers: { type: "object", additionalProperties: { type: "string" } },
              },
              required: ["type", "method", "bodyType", "body"],
              additionalProperties: false,
            },
            output: { type: "object", properties: { type: { type: "string" }, example: { type: "object" } }, required: ["type"] },
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
async function readTicker(request, url) {
  const p = Object.fromEntries(url.searchParams);
  if (request.method === "POST") {
    try { const b = await request.clone().json(); if (b && typeof b === "object") Object.assign(p, b); } catch {}
  }
  return String(p.ticker || p.symbol || "").trim();
}
function openapi(origin) {
  const body = { type: "object", properties: { ticker: { type: "string", minLength: 1, maxLength: 8, description: "US stock ticker, e.g. AAPL or BRK.B" } }, required: ["ticker"] };
  const out = {
    type: "object",
    properties: {
      ticker: { type: "string" },
      company: { type: ["string", "null"] },
      cik: { type: "string" },
      latest_fiscal_year: { type: "object" },
      latest_quarter: { type: "object" },
      balance_sheet: { type: "object" },
      shares_outstanding: { type: ["object", "null"] },
      recent_filings: { type: "array", items: { type: "object", properties: { form: { type: "string" }, filed: { type: "string" }, url: { type: "string" } } } },
      citations: { type: "object" },
      disclaimer: { type: "string" },
    },
    required: ["ticker", "cik", "latest_fiscal_year", "balance_sheet"],
  };
  const pay = { price: { mode: "fixed", currency: "USD", amount: PRICE_USD }, protocols: [{ x402: {} }] };
  const responses = { 200: { description: "Company snapshot", content: { "application/json": { schema: out } } }, 402: { description: "Payment Required" } };
  return {
    openapi: "3.1.0",
    info: {
      title: SERVICE,
      version: "1.0.0",
      description: DESCRIPTION,
      "x-guidance": "POST /company with JSON {\"ticker\": \"AAPL\"} (or GET /company?ticker=AAPL) to get a factual SEC-sourced fundamentals snapshot: latest fiscal-year and quarter revenue, net income, diluted EPS, balance sheet, shares outstanding and recent filing links with citations. $0.02 USDC on Base via x402. Unknown tickers and invalid input are rejected before payment is settled. A free example for AAPL is at GET /sample.",
    },
    servers: [{ url: origin }],
    paths: {
      "/company": {
        post: { operationId: "companySnapshot", summary: "SEC fundamentals snapshot for a US-listed company", tags: ["Finance", "SEC"], "x-payment-info": pay, requestBody: { required: true, content: { "application/json": { schema: body } } }, responses },
        get: { operationId: "companySnapshotGet", summary: "SEC fundamentals snapshot for a US-listed company", tags: ["Finance", "SEC"], "x-payment-info": pay, parameters: [{ name: "ticker", in: "query", required: true, schema: { type: "string" }, description: body.properties.ticker.description }], responses },
      },
    },
  };
}

export default {
  async fetch(request, env0) {
    const env = { ...(env0 || {}), PAY_TO: (env0 && env0.PAY_TO) || DEFAULT_PAY_TO };
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "PAYMENT-SIGNATURE, X-PAYMENT, Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" } });
    }
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        service: SERVICE,
        description: DESCRIPTION,
        endpoint: `${url.origin}/company`,
        openapi: `${url.origin}/openapi.json`,
        free_sample: `${url.origin}/sample`,
        usage: 'POST /company {"ticker":"AAPL"} or GET /company?ticker=AAPL',
        price: "$0.02 USDC on Base per snapshot (x402)",
        facilitator: env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET ? "cdp" : "payai",
        sources: SOURCES,
        disclaimer: DISCLAIMER,
      });
    }
    if (url.pathname === "/openapi.json" || url.pathname === "/.well-known/openapi.json") return json(openapi(url.origin));
    if (url.pathname === "/sample") {
      const snap = await buildSnapshot("AAPL");
      if (snap.status !== 200) return json({ error: "Sample temporarily unavailable" }, 502);
      return json({ note: "Free sample. Paid endpoint: POST /company {\"ticker\": \"...\"}", ...snap.body });
    }
    if (url.pathname !== "/company") return json({ error: "Not found. Use POST /company" }, 404);
    if (!/^0x[0-9a-fA-F]{40}$/.test(env.PAY_TO)) return json({ error: "Service not configured: PAY_TO wallet address invalid" }, 500);
    if (request.method !== "GET" && request.method !== "POST") return json({ error: "Use GET or POST" }, 405);

    const header = request.headers.get("PAYMENT-SIGNATURE") || request.headers.get("X-PAYMENT");
    if (!header) return send402(env, url, "PAYMENT-SIGNATURE header is required");
    const ticker = await readTicker(request, url);
    if (!ticker) return json({ error: "Missing required parameter: ticker (no payment was taken)" }, 400);
    if (!TICKER_RE.test(ticker)) return json({ error: "Invalid ticker format (no payment was taken)" }, 400);

    let payload;
    try { payload = b64d(header); } catch { return json({ error: "Invalid payment payload" }, 400); }
    const reqs = requirements(env);
    if (payload.x402Version !== 2 || !deepEqual(payload.accepted, reqs)) return send402(env, url, "No matching payment requirements found");

    const fac = facilitator(env);
    const body = { x402Version: 2, paymentPayload: payload, paymentRequirements: reqs };
    let v;
    try { v = await fac.call("verify", body); } catch (e) { return json({ error: "Facilitator unreachable", detail: String(e) }, 500); }
    if (!v.ok || !v.data.isValid) return send402(env, url, v.data.invalidReason || v.data.error || `verify failed (${v.status})`);

    const snap = await buildSnapshot(ticker);
    if (snap.status === 404) return json({ error: `Ticker ${ticker.toUpperCase()} not found in SEC EDGAR. No payment was taken.` }, 404);
    if (snap.status !== 200) return json({ error: "SEC data temporarily unavailable. No payment was taken; please retry." }, 502);

    let s;
    try { s = await fac.call("settle", body); } catch (e) { return json({ error: "Facilitator unreachable", detail: String(e) }, 500); }
    if (!s.ok || !s.data.success) {
      const fail = { success: false, errorReason: s.data.errorReason || s.data.error || `settle failed (${s.status})`, transaction: "", network: NETWORK, payer: s.data.payer || v.data.payer };
      return json({}, 402, { "PAYMENT-RESPONSE": b64e(fail) });
    }
    const receipt = { success: true, transaction: s.data.transaction, network: s.data.network || NETWORK, payer: s.data.payer || v.data.payer };
    return json(snap.body, 200, { "PAYMENT-RESPONSE": b64e(receipt) });
  },
};
