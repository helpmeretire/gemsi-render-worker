// ---------- upstream (CoinGecko) ----------
const num = (v) => { const n = Number(v); return v === null || v === undefined || v === "" || !Number.isFinite(n) ? null : n; };
const round = (v, d) => (v === null ? null : Number(v.toFixed(d)));

// GET JSON with 8s timeout, identifying User-Agent, optional 30s edge cache.
// Returns { ok, status, data } — ok=false and status=0 on network/timeout failure. Never throws.
async function fetchJson(url, headers, ctx) {
  const cache = typeof caches !== "undefined" && caches && caches.default ? caches.default : null;
  if (cache) {
    try { const hit = await cache.match(url); if (hit) return { ok: true, status: 200, data: await hit.json(), cached: true }; } catch {}
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": USER_AGENT, ...headers }, signal: ctrl.signal });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    if (res.ok && data && typeof data === "object" && cache) {
      const put = cache.put(url, new Response(text, { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${CACHE_SECONDS}` } })).catch(() => {});
      if (ctx && ctx.waitUntil) ctx.waitUntil(put);
    }
    return { ok: res.ok && data !== null && typeof data === "object", status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: null, error: String(e && e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

function cgHeaders(env) {
  const key = String((env && env.CG_DEMO_KEY) || "").trim();
  return key ? { "x-cg-demo-api-key": key } : {};
}

// ---------- params ----------
async function readParams(request, url, bodyText) {
  const p = Object.fromEntries(url.searchParams);
  if (request.method === "POST" && bodyText) {
    try { const b = JSON.parse(bodyText); if (b && typeof b === "object" && !Array.isArray(b)) Object.assign(p, b); } catch {}
  }
  const s = (v) => (v === undefined || v === null || v === "" ? undefined : String(v).trim());
  const symRaw = p.symbol !== undefined ? p.symbol : p.symbols;
  const symbol = Array.isArray(symRaw) ? symRaw.map((x) => String(x)).join(",") : s(symRaw);
  return { symbol, address: s(p.address), chain: s(p.chain) };
}

// Returns { error } or { mode: "symbols", symbols } or { mode: "onchain", address, chain }
function validate(q) {
  const bad = (msg, extra = {}) => ({ error: `${msg} (no payment was taken)`, ...extra });
  const hasSym = q.symbol !== undefined, hasAddr = q.address !== undefined || q.chain !== undefined;
  if (!hasSym && !hasAddr) return bad("Provide either symbol (e.g. BTC or BTC,ETH,SOL) or address + chain");
  if (hasSym && hasAddr) return bad("Provide either symbol or address + chain, not both");
  if (hasSym) {
    const symbols = [...new Set(q.symbol.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean))];
    if (!symbols.length) return bad("Missing required parameter: symbol");
    if (symbols.length > MAX_SYMBOLS) return bad(`Too many symbols: at most ${MAX_SYMBOLS} per request`);
    const malformed = symbols.filter((x) => !/^[A-Z0-9][A-Z0-9.$_-]{0,19}$/.test(x));
    if (malformed.length) return bad(`Invalid symbol: ${malformed.join(", ")}`);
    return { mode: "symbols", symbols };
  }
  if (!q.address) return bad("Missing required parameter: address");
  if (!q.chain) return bad("Missing required parameter: chain", { supported_chains: Object.keys(CHAINS) });
  const key = q.chain.toLowerCase();
  const chain = CHAINS[key] ? key : CHAIN_ALIASES[key];
  if (!chain) return bad(`Unsupported chain: ${q.chain}`, { supported_chains: Object.keys(CHAINS) });
  const address = q.address;
  if (CHAINS[chain].evm) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return bad(`address must be a 0x-prefixed 40-hex-character contract address on ${chain}`);
    return { mode: "onchain", address: address.toLowerCase(), chain };
  }
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return bad("address must be a base58 Solana mint address");
  return { mode: "onchain", address, chain };
}

// ---------- data ----------
// Returns { status, body } — status !== 200 means do not settle.
async function loadSymbols(q, env, ctx) {
  const fetched_at = new Date().toISOString();
  const known = q.symbols.filter((s) => SYMBOLS[s]);
  const unknown = q.symbols.filter((s) => !SYMBOLS[s]);
  if (!known.length) return { status: 404, body: { error: `Unknown symbol${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")} — not in the supported list (no payment was taken)`, unknown, hint: "Use a top-market-cap ticker like BTC, ETH, SOL, or look up an on-chain token with address + chain." } };
  const ids = [...new Set(known.map((s) => SYMBOLS[s][0]))].join(",");
  const url = `${CG_API}/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=usd&include_market_cap=true&include_24hr_vol=true&include_24hr_change=true&include_last_updated_at=true`;
  const r = await fetchJson(url, cgHeaders(env), ctx);
  if (!r.ok) return { status: 502, body: { error: "CoinGecko is temporarily unavailable; no payment was taken. Please retry.", upstream_status: r.status || undefined, detail: r.error } };
  const results = [];
  for (const s of known) {
    const [id, name] = SYMBOLS[s], d = r.data[id];
    if (!d || num(d.usd) === null) { unknown.push(s); continue; }
    results.push({
      query: s, id, name, symbol: s,
      price_usd: num(d.usd),
      market_cap_usd: round(num(d.usd_market_cap), 2),
      volume_24h_usd: round(num(d.usd_24h_vol), 2),
      change_24h_pct: round(num(d.usd_24h_change), 4),
      last_updated: num(d.last_updated_at) !== null ? new Date(num(d.last_updated_at) * 1000).toISOString() : null,
    });
  }
  if (!results.length) return { status: 404, body: { error: `No price data returned for: ${q.symbols.join(", ")} (no payment was taken)`, unknown } };
  return { status: 200, body: { results, unknown, source: SOURCE, attribution: ATTRIBUTION, fetched_at } };
}

async function loadOnchain(q, env, ctx) {
  const fetched_at = new Date().toISOString();
  const net = CHAINS[q.chain].cg;
  const headers = cgHeaders(env);
  const path = `/networks/${net}/tokens/${encodeURIComponent(q.address)}`;
  const url = Object.keys(headers).length ? `${CG_API}/onchain${path}` : `${GT_API}${path}`;
  const r = await fetchJson(url, headers, ctx);
  if (r.status === 404) return { status: 404, body: { error: `Token ${q.address} not found on ${q.chain} (no payment was taken)`, unknown: [q.address] } };
  const a = r.ok && r.data && r.data.data && r.data.data.attributes;
  if (!r.ok) return { status: 502, body: { error: "CoinGecko on-chain data is temporarily unavailable; no payment was taken. Please retry.", upstream_status: r.status || undefined, detail: r.error } };
  if (!a || num(a.price_usd) === null) return { status: 404, body: { error: `No price data for token ${q.address} on ${q.chain} (no payment was taken)`, unknown: [q.address] } };
  const vol = a.volume_usd && typeof a.volume_usd === "object" ? a.volume_usd.h24 : a.volume_usd;
  const result = {
    query: q.address, id: r.data.data.id || `${net}_${q.address}`, name: a.name || null, symbol: a.symbol || null,
    price_usd: num(a.price_usd),
    market_cap_usd: round(num(a.market_cap_usd) !== null ? num(a.market_cap_usd) : num(a.fdv_usd), 2),
    volume_24h_usd: round(num(vol), 2),
    change_24h_pct: null,
    last_updated: fetched_at,
    chain: q.chain, address: a.address || q.address,
    fdv_usd: round(num(a.fdv_usd), 2),
    liquidity_usd: round(num(a.total_reserve_in_usd), 2),
    decimals: num(a.decimals),
  };
  return { status: 200, body: { results: [result], unknown: [], source: SOURCE, attribution: ATTRIBUTION, fetched_at } };
}

const loadData = (q, env, ctx) => (q.mode === "onchain" ? loadOnchain(q, env, ctx) : loadSymbols(q, env, ctx));

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
  results: [
    { query: "BTC", id: "bitcoin", name: "Bitcoin", symbol: "BTC", price_usd: 112345.67, market_cap_usd: 2235000000000, volume_24h_usd: 48200000000, change_24h_pct: 1.2345, last_updated: "2026-10-15T14:02:11.000Z" },
    { query: "ETH", id: "ethereum", name: "Ethereum", symbol: "ETH", price_usd: 4012.34, market_cap_usd: 484000000000, volume_24h_usd: 31500000000, change_24h_pct: -0.4567, last_updated: "2026-10-15T14:02:09.000Z" },
  ],
  unknown: [],
  source: SOURCE,
  attribution: ATTRIBUTION,
  fetched_at: "2026-10-15T14:02:15.123Z",
};
function paymentRequired(env, url, error) {
  const resourceUrl = `${url.origin}/price`;
  return {
    x402Version: 2,
    error,
    resource: { url: resourceUrl, description: DESCRIPTION, mimeType: "application/json" },
    accepts: [requirements(env)],
    extensions: {
      bazaar: {
        info: {
          input: { type: "http", method: "GET", queryParams: { symbol: "BTC,ETH" } },
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
                    symbol: { type: "string", description: "Ticker symbol or comma-separated list of up to 10, e.g. BTC or BTC,ETH,SOL" },
                    address: { type: "string", description: "On-chain token contract address (use with chain instead of symbol)" },
                    chain: { type: "string", enum: Object.keys(CHAINS), description: "Chain of the contract address" },
                  },
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
      symbol: { type: "string", description: "Ticker symbol or comma-separated list of up to 10 (JSON array also accepted in POST), e.g. 'BTC' or 'BTC,ETH,SOL'. Use this OR address+chain." },
      address: { type: "string", description: "Token contract address (0x... for EVM chains, base58 mint for Solana). Requires chain." },
      chain: { type: "string", enum: Object.keys(CHAINS), description: "Chain of the contract address." },
    },
  };
  const resultItem = {
    type: "object",
    properties: {
      query: { type: "string" }, id: { type: "string", description: "CoinGecko coin id or on-chain token id" }, name: { type: ["string", "null"] }, symbol: { type: ["string", "null"] },
      price_usd: { type: "number" }, market_cap_usd: { type: ["number", "null"] }, volume_24h_usd: { type: ["number", "null"] }, change_24h_pct: { type: ["number", "null"] },
      last_updated: { type: ["string", "null"] },
      chain: { type: "string" }, address: { type: "string" }, fdv_usd: { type: ["number", "null"] }, liquidity_usd: { type: ["number", "null"] }, decimals: { type: ["number", "null"] },
    },
    required: ["query", "id", "price_usd"],
  };
  const out = {
    type: "object",
    properties: {
      results: { type: "array", items: resultItem },
      unknown: { type: "array", items: { type: "string" }, description: "Requested symbols that were not recognised or had no data" },
      source: { type: "string" },
      attribution: { type: "string", description: "Must be displayed when surfacing the data: Powered by CoinGecko" },
      fetched_at: { type: "string" },
    },
    required: ["results", "unknown", "source", "attribution", "fetched_at"],
  };
  const op = (method) => ({
    operationId: method === "post" ? "getPricePost" : "getPrice",
    summary: "Current USD price, market cap, 24h volume and 24h change for crypto tickers or an on-chain token",
    tags: ["Crypto", "Finance", "Prices"],
    "x-payment-info": { price: { mode: "fixed", currency: "USD", amount: "0.001000" }, protocols: [{ x402: {} }] },
    ...(method === "post"
      ? { requestBody: { required: true, content: { "application/json": { schema: params } } } }
      : { parameters: Object.entries(params.properties).map(([n, sch]) => ({ name: n, in: "query", required: false, schema: { type: "string" }, description: sch.description })) }),
    responses: {
      200: { description: "Prices", content: { "application/json": { schema: out } } },
      400: { description: "Invalid parameters (no charge)" },
      402: { description: "Payment Required" },
      404: { description: "No recognised symbols / token not found (no charge)" },
      413: { description: "Request too large (no charge)" },
      502: { description: "CoinGecko temporarily unavailable (no charge)" },
    },
  });
  return {
    openapi: "3.1.0",
    info: {
      title: SERVICE,
      version: "1.0.0",
      description: DESCRIPTION,
      "x-guidance": "Use GET /price?symbol=BTC,ETH,SOL (up to 10 tickers; or POST /price with JSON {symbol: [...]}) for a quick current USD price with market cap, 24h volume and 24h % change. For a token that is not a listed ticker, use ?address=0x...&chain=base (chains: " + Object.keys(CHAINS).join(", ") + "). Costs $0.001 USDC on Base per request via x402; nothing is charged for unknown symbols (listed in `unknown`), 400/404 or upstream failures. Data is from CoinGecko and cached about 30 seconds — when you show the price, include the `attribution` string (Powered by CoinGecko). Not investment advice.",
    },
    servers: [{ url: origin }],
    paths: { "/price": { get: op("get"), post: op("post") } },
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
        endpoint: `${url.origin}/price?symbol=BTC,ETH,SOL  |  ${url.origin}/price?address=<contract>&chain=<${Object.keys(CHAINS).join("|")}>`,
        price: "$0.001 USDC on Base per request (x402)",
        max_symbols: MAX_SYMBOLS,
        supported_symbols: Object.keys(SYMBOLS),
        supported_chains: Object.keys(CHAINS),
        source: SOURCE,
        attribution: ATTRIBUTION,
        configured: Boolean(env.PAY_TO),
        facilitator: env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET ? "cdp" : "payai",
      });
    }
    if (url.pathname === "/openapi.json" || url.pathname === "/.well-known/openapi.json") return json(openapi(url.origin));
    if (url.pathname !== "/price") return json({ error: "Not found. Use /price?symbol=BTC,ETH or /price?address=0x...&chain=base" }, 404);
    if (!env.PAY_TO || !/^0x[0-9a-fA-F]{40}$/.test(env.PAY_TO)) return json({ error: "Service not configured: PAY_TO wallet address missing" }, 500);
    if (request.method !== "GET" && request.method !== "POST") return json({ error: "Use GET or POST" }, 405);

    // Size guard before any payment work.
    if (url.search.length > MAX_QUERY_CHARS) return json({ error: `Query string too long (max ${MAX_QUERY_CHARS} characters; no payment was taken)` }, 413);
    let bodyText = "";
    if (request.method === "POST") {
      const cl = Number(request.headers.get("content-length"));
      if (Number.isFinite(cl) && cl > MAX_BODY_BYTES) return json({ error: `Request body too large (max ${MAX_BODY_BYTES} bytes; no payment was taken)` }, 413);
      try { bodyText = await request.clone().text(); } catch { bodyText = ""; }
      if (bodyText.length > MAX_BODY_BYTES) return json({ error: `Request body too large (max ${MAX_BODY_BYTES} bytes; no payment was taken)` }, 413);
    }

    const header = request.headers.get("PAYMENT-SIGNATURE") || request.headers.get("X-PAYMENT");
    if (!header) return send402(env, url, "PAYMENT-SIGNATURE header is required");
    const q = validate(await readParams(request, url, bodyText));
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

    let result;
    try { result = await loadData(q, env, ctx); } catch (e) { return json({ error: "CoinGecko is temporarily unavailable; no payment was taken. Please retry.", detail: String(e.message || e) }, 502); }
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
