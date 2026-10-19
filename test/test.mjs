// Usage: node test/test.mjs ./worker.js /path/bazaar-out.json
import { generateKeyPairSync, verify as nverify } from "node:crypto";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const W = (await import(pathToFileURL(resolve(process.argv[2])).href)).default;
const PAY = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const dec = (h) => JSON.parse(Buffer.from(h, "base64").toString());
const near = (a, b, eps = 1e-4) => typeof a === "number" && Math.abs(a - b) <= eps;

// ---- fixtures in Yahoo's real chart shape ----
const DAY = 86400;
const LAST_TS = Math.floor(Date.parse("2026-10-14T13:30:00Z") / 1000); // Wed, market open bar time
const META_AAPL = {
  currency: "USD", symbol: "AAPL", exchangeName: "NMS", fullExchangeName: "NasdaqGS", instrumentType: "EQUITY", firstTradeDate: 345479400, regularMarketTime: 1760471998,
  hasPrePostMarketData: true, gmtoffset: -14400, timezone: "EDT", exchangeTimezoneName: "America/New_York",
  regularMarketPrice: 247.77, fiftyTwoWeekHigh: 260.1, fiftyTwoWeekLow: 169.21, regularMarketDayHigh: 249.12, regularMarketDayLow: 245.9, regularMarketVolume: 48213400,
  longName: "Apple Inc.", shortName: "Apple Inc.", chartPreviousClose: 245.46, previousClose: 245.46, scale: 3, priceHint: 2, marketState: "REGULAR",
  currentTradingPeriod: { pre: {}, regular: {}, post: {} }, tradingPeriods: [[{}]], dataGranularity: "1m", range: "1d", validRanges: ["1d", "5d", "1mo", "3mo", "6mo", "1y", "2y", "5y", "10y", "ytd", "max"],
};
const chart = (result) => ({ chart: { result: [result], error: null } });
const quoteChart = (meta) => chart({ meta, timestamp: [LAST_TS], indicators: { quote: [{ open: [meta.regularMarketPrice], high: [meta.regularMarketPrice], low: [meta.regularMarketPrice], close: [meta.regularMarketPrice], volume: [100] }] } });
const genericMeta = (symbol, extra = {}) => ({ ...META_AAPL, symbol, longName: `${symbol} Long Name`, shortName: `${symbol} Short`, ...extra });

// /history fixture: 1mo/1d with 7 timestamps; bar 2 has a null close (dropped), bar 4 has a null volume (kept), adjclose given.
const HIST_TS = [0, 1, 2, 3, 4, 5, 6].map((i) => LAST_TS - (6 - i) * DAY);
const HIST = chart({
  meta: { ...META_AAPL, dataGranularity: "1d", range: "1mo" },
  timestamp: HIST_TS,
  indicators: {
    quote: [{
      open: [100, 102, null, 105, 103, 101, 104],
      high: [103, 106, 107, 108, 104, 102, 109],
      low: [99, 101, 100, 104, 100, 98, 103],
      close: [102, 104, null, 103, 101, 100, 108],
      volume: [1000, 2000, 3000, 4000, null, 6000, 7000],
    }],
    adjclose: [{ adjclose: [101, 103, null, 102, 100, 99, 108] }],
  },
  events: {
    dividends: { [String(HIST_TS[1])]: { amount: 0.26, date: HIST_TS[1] }, [String(HIST_TS[5])]: { amount: 0.27, date: HIST_TS[5] } },
    splits: { [String(HIST_TS[3])]: { date: HIST_TS[3], numerator: 4, denominator: 1, splitRatio: "4:1" } },
  },
});
// Hand-computed expectations for HIST: kept bars = indices 0,1,3,4,5,6 -> closes 102,104,103,101,100,108
//   first 102, last 108, change% = 6/102*100 = 5.8824, high = max(103,106,108,104,102,109) = 109, low = min(99,101,104,100,98,103) = 98,
//   volumes 1000,2000,4000,6000,7000 (null dropped) -> avg 4000; adj of bar 6 = 108.

// /stats fixture A ("RSIX"): 16 consecutive calendar days; changes +1 x7, -1 x7, then +2.
//   Wilder RSI14: first 14 changes -> avgGain 7/14 = 0.5, avgLoss 0.5; day 15 change +2 -> avgGain (0.5*13+2)/14 = 8.5/14, avgLoss (0.5*13)/14 = 6.5/14
//   RS = 8.5/6.5, RSI = 100*8.5/15 = 56.6667. Max drawdown: peak 107 -> 100 = -6.5421%. 1w return: bar 7 days back is index 8 (close 106): 102/106-1 = -3.7736%.
//   1m and longer: history only reaches 15 days back -> null. SMA20/50/200: only 16 bars -> null. avgVolume30d of volumes 1000..16000 = 8500.
const RSI_CLOSES = [100, 101, 102, 103, 104, 105, 106, 107, 106, 105, 104, 103, 102, 101, 100, 102];
const RSIX = chart({
  meta: { ...genericMeta("RSIX"), regularMarketPrice: 102, fiftyTwoWeekHigh: 107, fiftyTwoWeekLow: 100, dataGranularity: "1d", range: "1y" },
  timestamp: RSI_CLOSES.map((_, i) => LAST_TS - (RSI_CLOSES.length - 1 - i) * DAY),
  indicators: { quote: [{ open: RSI_CLOSES, high: RSI_CLOSES.map((c) => c + 1), low: RSI_CLOSES.map((c) => c - 1), close: RSI_CLOSES, volume: RSI_CLOSES.map((_, i) => 1000 * (i + 1)) }], adjclose: [{ adjclose: RSI_CLOSES }] },
});
// /stats fixture B ("LINEAR"): 260 weekday bars ending Wed 2026-10-14 with close = 100 + i (first bar Thu 2025-10-16), price 360.
//   SMA20 = mean(340..359) = 349.5, SMA50 = mean(310..359) = 334.5, SMA200 = mean(160..359) = 259.5, all below price 360 -> priceAbove true.
//   RSI14 = 100 (no losses). Max drawdown 0. 1w: Oct 7 = 5 bars back, close 354 -> 5/354 = 1.4124%. 1m: Sep 14 (Mon) = 22 bars back, close 337 -> 22/337 = 6.5282%.
//   3m: Jul 15 (91 days, 13 weeks) = 65 bars back, close 294 -> 65/294 = 22.1088%. 6m: Apr 15 (182 days) = 130 bars back, close 229 -> 130/229 = 56.7686%.
//   1y: target Oct 14 2025, first bar Oct 16 2025 is 2 days later (within tolerance) -> 259/100 = 259%.
//   52w from meta high 365 / low 95 vs price 360: -1.3699% / 278.9474%. avgVolume30d = 1000000.
const LIN_TS = []; { let t = LAST_TS; while (LIN_TS.length < 260) { const dow = new Date(t * 1000).getUTCDay(); if (dow !== 0 && dow !== 6) LIN_TS.unshift(t); t -= DAY; } }
const LIN_CLOSES = LIN_TS.map((_, i) => 100 + i);
const LINEAR = chart({
  meta: { ...genericMeta("LINEAR"), regularMarketPrice: 360, fiftyTwoWeekHigh: 365, fiftyTwoWeekLow: 95, dataGranularity: "1d", range: "1y" },
  timestamp: LIN_TS,
  indicators: { quote: [{ open: LIN_CLOSES.map((c) => c - 0.5), high: LIN_CLOSES.map((c) => c + 1), low: LIN_CLOSES.map((c) => c - 1), close: LIN_CLOSES, volume: LIN_CLOSES.map(() => 1000000) }], adjclose: [{ adjclose: LIN_CLOSES }] },
});
const NOT_FOUND = { chart: { result: null, error: { code: "Not Found", description: "No data found, symbol may be delisted" } } };
const BAD_REQ = { chart: { result: null, error: { code: "Bad Request", description: "1m data not available for startTime=1 and endTime=2. Only 7 days worth of 1m granularity data are allowed to be fetched per request." } } };

// ---- cache mock (Cloudflare caches.default) ----
const cacheMap = new Map(); let cachePuts = 0, cacheHits = 0;
const keyOf = (k) => (typeof k === "string" ? k : k.url);
globalThis.caches = { default: {
  async match(k) { const v = cacheMap.get(keyOf(k)); if (v) { cacheHits++; return new Response(v.body, { status: 200, headers: { "Content-Type": "application/json" } }); } return undefined; },
  async put(k, res) { cachePuts++; cacheMap.set(keyOf(k), { body: await res.text(), cc: res.headers.get("Cache-Control") }); },
} };

// ---- fetch mock: never touches the network ----
let calls = [], mode = "good", upstream = [];
const jres = (body, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
const hang = (init) => new Promise((_, rej) => { init.signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))); });
globalThis.fetch = async (u, init) => {
  u = String(u);
  if (u.startsWith("https://facilitator.payai.network/") || u.startsWith("https://api.cdp.coinbase.com/")) {
    calls.push({ u, init });
    const op = u.split("/").pop();
    if (mode === "badverify" && op === "verify") return new Response(JSON.stringify({ isValid: false, invalidReason: "insufficient_funds", payer: "0xabc" }), { status: 200 });
    if (mode === "badsettle" && op === "settle") return new Response(JSON.stringify({ success: false, errorReason: "invalid_transaction_state", payer: "0xabc", transaction: "", network: "eip155:8453" }), { status: 400 });
    if (op === "verify") return new Response(JSON.stringify({ isValid: true, payer: "0xabc" }));
    return new Response(JSON.stringify({ success: true, payer: "0xabc", transaction: "0xdeadbeef", network: "eip155:8453" }));
  }
  upstream.push({ u, init });
  const url = new URL(u);
  const m = url.pathname.match(/^\/v8\/finance\/chart\/([^/]+)$/);
  if (!m || !/^query[12]\.finance\.yahoo\.com$/.test(url.host)) return new Response("Not Found", { status: 404 });
  const host = url.host, symbol = decodeURIComponent(m[1]), range = url.searchParams.get("range"), interval = url.searchParams.get("interval");
  const q1 = host === "query1.finance.yahoo.com";
  switch (symbol) {
    case "NOPE": return jres(NOT_FOUND, 404);
    case "ERR422": return jres(BAD_REQ, 422);
    case "EMPTY": return jres({ chart: { result: [], error: null } });
    case "NORESULT": return jres({ chart: { result: null, error: null } });
    case "NOPRICE": return jres(quoteChart({ ...genericMeta("NOPRICE"), regularMarketPrice: undefined }));
    case "DOWN": return jres("<html>Internal Server Error</html>", 500);
    case "RATE": return jres("Too Many Requests", 429);
    case "NETERR": throw new TypeError("fetch failed");
    case "BADJSON": return jres("<html>not json</html>");
    case "NOCHART": return jres({ finance: { result: null } });
    case "FLAKY": return q1 ? jres("Bad Gateway", 502) : jres(quoteChart(genericMeta("FLAKY", { regularMarketPrice: 50, previousClose: 40 })));
    case "FLAKYNET": if (q1) throw new TypeError("fetch failed"); return jres(quoteChart(genericMeta("FLAKYNET", { regularMarketPrice: 10, previousClose: 10 })));
    case "HANG": return q1 ? hang(init) : jres("Service Unavailable", 503);
    case "RSIX": return jres(RSIX);
    case "LINEAR": return jres(LINEAR);
    case "AAPL":
      if (interval === "1m") return jres(quoteChart(META_AAPL));
      if (range === "1y" && interval === "1d") return jres(LINEAR);
      return jres(HIST);
    default:
      if (interval === "1m") return jres(quoteChart(genericMeta(symbol, { regularMarketPrice: 20, previousClose: 16, chartPreviousClose: 15, fiftyTwoWeekHigh: 30, fiftyTwoWeekLow: 10 })));
      return jres(HIST);
  }
};

const env = { PAY_TO: PAY };
const base = "https://stocks.example.workers.dev";
const ctx = { waitUntil(p) { ctx.pending.push(p); }, pending: [] };
const reset = () => { calls = []; upstream = []; };
const ROUTES = ["/quote", "/quotes", "/history", "/stats"];
const PRICES = { "/quote": "1000", "/quotes": "3000", "/history": "2000", "/stats": "2000" };
const NOTICE_RE = /informational use only, not investment advice/;

// ---- unpaid / info ----
let r = await W.fetch(new Request(base + "/"), env, ctx); let j = await r.json();
ok(r.status === 200 && j.service === "Stock Quotes" && j.facilitator === "payai" && Object.keys(j.endpoints).join() === ROUTES.join() && j.price["/quote"].includes("$0.001") && j.price["/quotes"].includes("$0.003") && j.price["/history"].includes("$0.002") && j.price["/stats"].includes("$0.002") && j.health.endsWith("/health/data") && j.source === "Yahoo Finance" && NOTICE_RE.test(j.notice) && j.description.startsWith("Stock, ETF, index, FX and commodity quotes"), "info page lists 4 routes, per-route prices, health, source, notice");
r = await W.fetch(new Request(base + "/quote?symbol=AAPL"), {}, ctx); ok(r.status === 402 && dec(r.headers.get("PAYMENT-REQUIRED")).accepts[0].payTo === "0x6f762720b8515b7091e6aa69e8361f7b9909233f", "default wallet used");
r = await W.fetch(new Request(base + "/nope"), env, ctx); ok(r.status === 404, "unknown path -> 404");
r = await W.fetch(new Request(base + "/quote", { method: "PUT" }), env, ctx); ok(r.status === 405, "PUT -> 405");
r = await W.fetch(new Request(base + "/quote", { method: "OPTIONS" }), env, ctx); ok(r.status === 200 && r.headers.get("Access-Control-Allow-Origin") === "*" && /PAYMENT-SIGNATURE/.test(r.headers.get("Access-Control-Allow-Headers")) && /POST/.test(r.headers.get("Access-Control-Allow-Methods")), "OPTIONS CORS preflight");
reset(); r = await W.fetch(new Request(base + "/quotes", { method: "POST", headers: { "content-length": String(20 * 1024) } }), env, ctx); ok(r.status === 413 && calls.length === 0 && upstream.length === 0, "oversized content-length -> 413 before 402");
r = await W.fetch(new Request(base + "/quote?symbol=AAPL"), { PAY_TO: "nope" }, ctx); ok(r.status === 500, "bad PAY_TO -> 500");

// ---- 402 probes per route: own amount + resource url, bad input still 402 first ----
const prs = {}, payloads = {}, hdrs = {};
for (const route of ROUTES) {
  reset();
  r = await W.fetch(new Request(base + route), env, ctx);
  const pr = dec(r.headers.get("PAYMENT-REQUIRED")); prs[route] = pr;
  const a0 = pr.accepts[0];
  ok(r.status === 402 && upstream.length === 0 && calls.length === 0 && pr.x402Version === 2 && pr.accepts.length === 1 && a0.scheme === "exact" && a0.amount === PRICES[route] && a0.payTo === PAY && a0.network === "eip155:8453" && a0.asset === "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" && a0.extra.name === "USD Coin" && a0.extra.version === "2" && a0.maxTimeoutSeconds === 300, `${route} GET probe -> 402 requirements (amount ${PRICES[route]}), nothing fetched`);
  ok(pr.resource.url === base + route && pr.resource.mimeType === "application/json" && pr.resource.description.includes(route.slice(1)), `${route} resource url + description`);
  const bz = pr.extensions.bazaar;
  ok(bz.info.input.type === "http" && bz.info.input.method === "GET" && typeof bz.info.input.queryParams === "object" && bz.info.output.type === "json" && bz.schema.properties.input.required.includes("method") && typeof bz.info.output.example === "object" && NOTICE_RE.test(bz.info.output.example.notice), `${route} bazaar ext with GET queryParams and notice in example`);
  ok(JSON.stringify(pr) === Buffer.from(r.headers.get("PAYMENT-REQUIRED"), "base64").toString() && (await r.json()).x402Version === 2, `${route} 402 body equals header payload`);
  r = await W.fetch(new Request(base + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }), env, ctx);
  ok(r.status === 402 && dec(r.headers.get("PAYMENT-REQUIRED")).resource.url === base + route, `${route} POST probe without payment -> 402`);
  payloads[route] = { x402Version: 2, resource: pr.resource, accepted: pr.accepts[0], payload: { signature: "0x00", authorization: {} }, extensions: pr.extensions };
  hdrs[route] = Buffer.from(JSON.stringify(payloads[route])).toString("base64");
}
ok(prs["/quote"].extensions.bazaar.info.input.queryParams.symbol === "AAPL" && prs["/quotes"].extensions.bazaar.info.input.queryParams.symbols.includes(",") && prs["/history"].extensions.bazaar.info.input.queryParams.range === "1mo" && prs["/stats"].extensions.bazaar.info.output.example.sma.sma200.value && prs["/quotes"].extensions.bazaar.info.output.example.results.length === 3, "bazaar examples are route specific");
reset(); r = await W.fetch(new Request(base + "/quote?symbol=bad!!"), env, ctx); ok(r.status === 402 && calls.length === 0 && upstream.length === 0, "bad symbol unpaid -> 402 first");
r = await W.fetch(new Request(base + "/history?symbol=AAPL&range=max&interval=1m"), env, ctx); ok(r.status === 402, "bad range/interval unpaid -> 402 first");
writeFileSync(process.argv[3], JSON.stringify(prs["/quote"].extensions.bazaar));

const paid = (route, qs, extra = {}) => W.fetch(new Request(base + route + qs, { ...extra, headers: { "PAYMENT-SIGNATURE": hdrs[route], ...(extra.headers || {}) } }), env, ctx);
const paidPost = (route, body, extra = {}) => paid(route, "", { method: "POST", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body), ...extra });

// ---- cross-route payment -> 402, nothing called (includes /history <-> /stats which share a price) ----
for (const [route, other, q] of [["/quote", "/quotes", "?symbol=AAPL"], ["/quotes", "/quote", "?symbols=AAPL"], ["/history", "/stats", "?symbol=AAPL"], ["/stats", "/history", "?symbol=AAPL"], ["/quote", "/stats", "?symbol=AAPL"]]) {
  reset();
  r = await W.fetch(new Request(base + route + q, { headers: { "PAYMENT-SIGNATURE": hdrs[other] } }), env, ctx);
  const pr = dec(r.headers.get("PAYMENT-REQUIRED"));
  ok(r.status === 402 && pr.error === "No matching payment requirements found" && pr.resource.url === base + route && pr.accepts[0].amount === PRICES[route] && calls.length === 0 && upstream.length === 0, `${route} paid with ${other} payment -> 402 with ${route}'s own requirements, nothing called`);
}
reset();
const under = { ...payloads["/quote"], accepted: { ...payloads["/quote"].accepted, amount: "1" } };
r = await W.fetch(new Request(base + "/quote?symbol=AAPL", { headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(under)).toString("base64") } }), env, ctx); ok(r.status === 402 && calls.length === 0 && upstream.length === 0, "underpaid accepted -> 402");
const v1 = { ...payloads["/quote"], x402Version: 1 };
r = await W.fetch(new Request(base + "/quote?symbol=AAPL", { headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(v1)).toString("base64") } }), env, ctx); ok(r.status === 402 && calls.length === 0, "x402Version 1 -> 402");
r = await W.fetch(new Request(base + "/quote?symbol=AAPL", { headers: { "PAYMENT-SIGNATURE": "!!!notbase64" } }), env, ctx); ok(r.status === 400 && calls.length === 0 && upstream.length === 0, "garbage payment header -> 400");
reset();
const noRes = { ...payloads["/quote"] }; delete noRes.resource;
r = await W.fetch(new Request(base + "/quote?symbol=AAPL", { headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(noRes)).toString("base64") } }), env, ctx); ok(r.status === 200 && calls.length === 2, "payload without resource field accepted (requirements match)");
reset(); cacheMap.clear();
r = await W.fetch(new Request(base + "/quote?symbol=AAPL", { headers: { "X-PAYMENT": hdrs["/quote"] } }), env, ctx); ok(r.status === 200 && calls.length === 2, "legacy X-PAYMENT header accepted");

// ---- bad input with payment -> 400, zero facilitator + zero upstream calls ----
const twentyOne = Array.from({ length: 21 }, (_, i) => `S${i}`).join(",");
const BAD = [
  ["/quote", "?symbol=", "empty symbol"],
  ["/quote", "", "missing symbol"],
  ["/quote", "?symbol=TOOLONGSYMBOL1", "symbol 13 chars"],
  ["/quote", "?symbol=AA%20PL", "symbol with space"],
  ["/quote", "?symbol=AAPL%3Bdrop", "symbol with ;"],
  ["/quote", "?symbol=A%2FB", "symbol with /"],
  ["/quote", "?symbol=%C3%A9", "non-ascii symbol"],
  ["/quotes", "", "missing symbols"],
  ["/quotes", "?symbols=,,", "symbols all empty"],
  ["/quotes", "?symbols=AAPL,BAD!", "one invalid symbol in list"],
  ["/quotes", "?symbols=" + twentyOne, "21 symbols"],
  ["/history", "?symbol=AAPL&range=10y", "bad range"],
  ["/history", "?symbol=AAPL&interval=2m", "bad interval"],
  ["/history", "?symbol=AAPL&range=1mo&interval=1m", "1m with 1mo"],
  ["/history", "?symbol=AAPL&range=max&interval=1m", "1m with max"],
  ["/history", "?symbol=AAPL&range=3mo&interval=5m", "5m with 3mo"],
  ["/history", "?symbol=AAPL&range=1y&interval=1h", "1h with 1y"],
  ["/history", "?symbol=AAPL&range=6mo&interval=15m", "15m with 6mo"],
  ["/history", "?range=1d", "history missing symbol"],
  ["/stats", "?symbol=", "stats empty symbol"],
  ["/stats", "?symbol=AAPL%24", "stats symbol with $"],
];
for (const [route, q, label] of BAD) {
  reset();
  r = await paid(route, q); j = await r.json();
  ok(r.status === 400 && calls.length === 0 && upstream.length === 0 && /no payment was taken/.test(j.error), `paid ${route} ${label} -> 400, nothing called`);
}
for (const [route, body, label] of [
  ["/quote", "[1,2]", "JSON array body"],
  ["/quote", "{not json", "unparseable body"],
  ["/quote", { symbol: 123 }, "symbol not a string"],
  ["/quotes", { symbols: [1, 2] }, "symbols array of numbers"],
  ["/quotes", { symbols: {} }, "symbols object"],
  ["/quotes", { symbols: [] }, "symbols empty array"],
  ["/quotes", { symbols: Array.from({ length: 21 }, (_, i) => `S${i}`) }, "21 symbols array"],
  ["/history", { symbol: "AAPL", range: 5 }, "range not a string"],
  ["/history", { symbol: "AAPL", interval: ["1d"] }, "interval not a string"],
]) {
  reset();
  r = await paidPost(route, body); j = await r.json();
  ok(r.status === 400 && calls.length === 0 && upstream.length === 0 && /no payment was taken/.test(j.error), `paid POST ${route} ${label} -> 400, nothing called`);
}
reset(); r = await paidPost("/quotes", JSON.stringify({ symbols: "A".repeat(17 * 1024) }), { headers: { "Content-Type": "application/json" } }); j = await r.json();
ok(r.status === 413 && calls.length === 0 && upstream.length === 0 && /no payment was taken/.test(j.error), "paid POST body > 16 KB without content-length -> 413, nothing called");
reset(); r = await paid("/quotes", "?symbols=" + twentyOne, { method: "POST", headers: { "content-length": String(17 * 1024) } }); ok(r.status === 413 && calls.length === 0, "paid oversized content-length -> 413");

// ---- /quote happy path ----
reset(); cacheMap.clear();
r = await paid("/quote", "?symbol=aapl"); j = await r.json();
ok(r.status === 200 && dec(r.headers.get("PAYMENT-RESPONSE")).transaction === "0xdeadbeef" && dec(r.headers.get("PAYMENT-RESPONSE")).success === true, "/quote paid -> 200 + PAYMENT-RESPONSE receipt (lowercase symbol accepted)");
ok(calls.length === 2 && calls[0].u === "https://facilitator.payai.network/verify" && calls[1].u.endsWith("/settle"), "verify then settle via payai");
ok(upstream.length === 1 && upstream[0].u === "https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1d&interval=1m&includePrePost=false&events=div,splits", "quote uses query1 chart URL range=1d interval=1m with events");
ok(/^Mozilla\/5\.0 .*NoJunk Stocks\/1\.0 \(\+https:\/\/nojunkcrypto\.com\)$/.test(upstream[0].init.headers["user-agent"]) && upstream[0].init.headers.accept === "application/json" && upstream[0].init.signal instanceof AbortSignal, "browser-like identifying User-Agent, Accept json, abort signal");
const sent = JSON.parse(calls[0].init.body); ok(sent.x402Version === 2 && sent.paymentRequirements.payTo === PAY && sent.paymentRequirements.amount === "1000" && sent.paymentPayload.accepted.amount === "1000" && sent.paymentPayload.resource.url === base + "/quote", "facilitator body shape (quote $0.001)");
ok(j.symbol === "AAPL" && j.price === 247.77 && near(j.change, 2.31) && near(j.changePercent, 0.9411) && j.previousClose === 245.46 && j.dayHigh === 249.12 && j.dayLow === 245.9 && j.volume === 48213400 && j.fiftyTwoWeekHigh === 260.1 && j.fiftyTwoWeekLow === 169.21 && j.currency === "USD" && j.exchange === "NMS" && j.exchangeName === "NasdaqGS" && j.name === "Apple Inc." && j.instrumentType === "EQUITY" && j.marketState === "REGULAR" && j.asOf === new Date(1760471998 * 1000).toISOString() && j.source === "Yahoo Finance" && NOTICE_RE.test(j.notice) && j.fetched_at, "/quote output fields (change = price - previousClose, asOf ISO, notice)");
ok(!JSON.stringify(j).includes("validRanges") && !("tradingPeriods" in j), "/quote does not leak raw Yahoo meta");
// cache: identical call served from caches.default
reset(); r = await paid("/quote", "?symbol=AAPL"); j = await r.json();
ok(r.status === 200 && upstream.length === 0 && cacheHits >= 1 && j.price === 247.77 && [...cacheMap.values()].some((v) => v.cc === "public, max-age=15"), "second /quote served from cache (15 s TTL), still charged");
for (const s of ["BRK-B", "^GSPC", "BTC-USD", "EURUSD=X", "GC=F", "0700.HK"]) {
  reset();
  r = await paid("/quote", "?symbol=" + encodeURIComponent(s)); j = await r.json();
  ok(r.status === 200 && j.symbol === s && upstream[0].u.includes("/v8/finance/chart/" + encodeURIComponent(s) + "?") && j.price === 20 && j.change === 4 && j.changePercent === 25 && j.name === `${s} Long Name`, `/quote symbol ${s} accepted and URL-encoded`);
}
reset(); r = await paidPost("/quote", { symbol: "msft" }); j = await r.json(); ok(r.status === 200 && j.symbol === "MSFT" && j.shortName === "MSFT Short", "/quote POST JSON body");
reset(); r = await W.fetch(new Request(base + "/quote/?symbol=MSFT", { headers: { "PAYMENT-SIGNATURE": hdrs["/quote"] } }), env, ctx); ok(r.status === 200, "trailing slash route accepted");
// previousClose falls back to chartPreviousClose; name falls back to shortName then symbol
const noPrev = quoteChart({ ...genericMeta("NOPREV"), previousClose: undefined, chartPreviousClose: 16, longName: undefined, shortName: undefined, regularMarketPrice: 20 });
const origFetch0 = globalThis.fetch;
globalThis.fetch = async (u, init) => (String(u).includes("/chart/NOPREV?") ? (upstream.push({ u }), jres(noPrev)) : origFetch0(u, init));
reset(); r = await paid("/quote", "?symbol=NOPREV"); j = await r.json();
ok(r.status === 200 && j.previousClose === 16 && j.change === 4 && j.changePercent === 25 && j.name === "NOPREV" && j.shortName === null, "previousClose falls back to chartPreviousClose, name falls back to symbol");
globalThis.fetch = origFetch0;

// ---- /quote not found / upstream failures: NO settle ----
const noSettle = (label) => ok(calls.length === 1 && calls[0].u.endsWith("/verify") && !r.headers.get("PAYMENT-RESPONSE"), `${label}: verify only, no settle, no receipt`);
reset(); r = await paid("/quote", "?symbol=NOPE"); j = await r.json();
ok(r.status === 404 && /not found/i.test(j.error) && /delisted/.test(j.error) && /no payment was taken/.test(j.error) && j.symbol === "NOPE", "/quote unknown symbol (Yahoo 404 + chart.error) -> 404"); noSettle("404");
ok(upstream.length === 1 && upstream[0].u.startsWith("https://query1."), "not-found is final: no fallback to query2");
reset(); r = await paid("/quote", "?symbol=ERR422"); j = await r.json(); ok(r.status === 404 && /1m data not available/.test(j.error) && upstream.length === 1, "chart.error with HTTP 422 -> 404 with Yahoo's description, no fallback"); noSettle("422");
reset(); r = await paid("/quote", "?symbol=EMPTY"); ok(r.status === 404 && upstream.length === 1, "empty result array -> 404"); noSettle("empty");
reset(); r = await paid("/quote", "?symbol=NORESULT"); ok(r.status === 404, "null result, null error -> 404"); noSettle("null result");
reset(); r = await paid("/quote", "?symbol=NOPRICE"); j = await r.json(); ok(r.status === 404 && /no price data/.test(j.error), "meta without regularMarketPrice -> 404"); noSettle("no price");
reset(); r = await paid("/quote", "?symbol=DOWN"); j = await r.json();
ok(r.status === 502 && /HTTP 500/.test(j.error) && /no payment taken/.test(j.error) && upstream.length === 2 && upstream[0].u.startsWith("https://query1.") && upstream[1].u.startsWith("https://query2."), "both hosts 500 -> 502 after trying query1 then query2"); noSettle("502");
reset(); r = await paid("/quote", "?symbol=RATE"); ok(r.status === 502 && upstream.length === 2, "429 on both hosts -> 502"); noSettle("429");
reset(); r = await paid("/quote", "?symbol=NETERR"); j = await r.json(); ok(r.status === 502 && /unreachable/.test(j.error) && upstream.length === 2, "network error on both hosts -> 502"); noSettle("neterr");
reset(); r = await paid("/quote", "?symbol=BADJSON"); j = await r.json(); ok(r.status === 502 && /unreadable/.test(j.error) && upstream.length === 2, "non-JSON 200 on both hosts -> 502"); noSettle("badjson");
reset(); r = await paid("/quote", "?symbol=NOCHART"); ok(r.status === 502 && upstream.length === 2, "JSON without chart on both hosts -> 502"); noSettle("nochart");
ok(!JSON.stringify(j).includes("CDP") && !JSON.stringify(j).includes("Bearer"), "502 body has no secrets");
// fallback host
reset(); r = await paid("/quote", "?symbol=FLAKY"); j = await r.json();
ok(r.status === 200 && j.price === 50 && j.previousClose === 40 && j.change === 10 && j.changePercent === 25 && upstream.length === 2 && upstream[0].u.startsWith("https://query1.finance.yahoo.com/v8/finance/chart/FLAKY?") && upstream[1].u.startsWith("https://query2.finance.yahoo.com/v8/finance/chart/FLAKY?") && upstream[1].u.slice(upstream[1].u.indexOf("?")) === upstream[0].u.slice(upstream[0].u.indexOf("?")) && calls.length === 2, "query1 502 -> query2 fallback used with same path/query -> 200 and settled");
reset(); r = await paid("/quote", "?symbol=FLAKYNET"); j = await r.json(); ok(r.status === 200 && j.price === 10 && j.change === 0 && j.changePercent === 0 && upstream.length === 2 && upstream[1].u.startsWith("https://query2."), "query1 network error -> query2 fallback -> 200");
// timeout (8 s) on query1, 503 on query2 -> 502
reset(); const t0 = Date.now(); r = await paid("/quote", "?symbol=HANG"); j = await r.json(); const dt = Date.now() - t0;
ok(r.status === 502 && /query1: did not respond within 8 seconds/.test(j.error) && /query2: HTTP 503/.test(j.error) && dt >= 7900 && dt < 12000 && upstream.length === 2, `query1 hang aborted after 8 s (${dt} ms), query2 503 -> 502`); noSettle("timeout");

// ---- /quotes ----
reset(); cacheMap.clear();
r = await paid("/quote", "?symbol=AAPL"); // warm the cache for AAPL only
reset(); r = await paid("/quotes", "?symbols=AAPL,msft,%5EGSPC,aapl"); j = await r.json();
ok(r.status === 200 && j.count === 3 && j.found === 3 && j.results.map((x) => x.symbol).join() === "AAPL,MSFT,^GSPC" && j.results.every((x) => x.ok === true && typeof x.price === "number" && x.asOf && !("status" in x)) && j.results[0].price === 247.77 && j.results[1].price === 20 && NOTICE_RE.test(j.notice) && j.source === "Yahoo Finance", "/quotes dedupes, uppercases, keeps order, per-symbol fields");
ok(upstream.length === 2 && JSON.parse(calls[0].init.body).paymentRequirements.amount === "3000" && dec(r.headers.get("PAYMENT-RESPONSE")).success === true, "/quotes: AAPL from cache, 2 upstream fetches, $0.003 requirements, settled");
cacheMap.clear(); reset();
const order = []; const origFetch = globalThis.fetch;
globalThis.fetch = async (u, init) => { if (String(u).includes("yahoo")) order.push(["start", new URL(String(u)).pathname.split("/").pop()]); const res = await origFetch(u, init); if (String(u).includes("yahoo")) order.push(["end"]); return res; };
r = await paidPost("/quotes", { symbols: ["A1", "A2", "A3", "A4"] }); j = await r.json();
globalThis.fetch = origFetch;
ok(r.status === 200 && j.found === 4 && order.slice(0, 4).every((x) => x[0] === "start") && upstream.length === 4, "/quotes fetches all symbols in parallel (4 starts before any end), POST array body");
reset(); r = await paid("/quotes", "?symbols=AAPL,NOPE,DOWN"); j = await r.json();
ok(r.status === 200 && j.count === 3 && j.found === 1 && j.results[1].ok === false && j.results[1].error === "not found" && j.results[1].symbol === "NOPE" && j.results[2].ok === false && j.results[2].error === "unavailable" && j.results[0].ok === true && calls.length === 2, "/quotes partial: ok + {ok:false,error:'not found'} + unavailable -> 200 settled");
reset(); r = await paid("/quotes", "?symbols=NOPE,EMPTY"); j = await r.json(); ok(r.status === 404 && /None of the symbols/.test(j.error) && /no payment was taken/.test(j.error) && j.symbols.join() === "NOPE,EMPTY", "/quotes all not found -> 404"); noSettle("quotes 404");
reset(); r = await paid("/quotes", "?symbols=NOPE,DOWN"); j = await r.json(); ok(r.status === 502 && /temporarily unavailable/.test(j.error), "/quotes all failed with an upstream outage -> 502"); noSettle("quotes 502");
reset(); r = await paid("/quotes", "?symbols=" + Array.from({ length: 20 }, (_, i) => `T${i}`).join(",")); j = await r.json(); ok(r.status === 200 && j.count === 20 && upstream.length === 20, "/quotes accepts exactly 20 symbols");
reset(); r = await paidPost("/quotes", { symbols: "AAPL, msft ,," }); j = await r.json(); ok(r.status === 200 && j.results.map((x) => x.symbol).join() === "AAPL,MSFT", "/quotes trims blanks in comma list (POST string)");
reset(); r = await paid("/quotes", "?symbol=AAPL"); j = await r.json(); ok(r.status === 200 && j.count === 1, "/quotes accepts singular symbol param as alias");

// ---- /history ----
reset(); cacheMap.clear();
r = await paid("/history", "?symbol=aapl"); j = await r.json();
ok(r.status === 200 && upstream[0].u === "https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1mo&interval=1d&includePrePost=false&events=div,splits" && j.range === "1mo" && j.interval === "1d", "/history defaults range=1mo interval=1d");
ok(j.count === 6 && j.candles.length === 6 && j.candles.every((c) => c.o !== null && c.h !== null && c.l !== null && c.c !== null && typeof c.t === "string" && !("ts" in c)) && !j.candles.some((c) => c.c === null), "null-close bar dropped (7 -> 6 candles), no internal ts field");
const c0 = j.candles[0], c6 = j.candles[5], c4 = j.candles[3];
ok(c0.t === new Date(HIST_TS[0] * 1000).toISOString() && c0.o === 100 && c0.h === 103 && c0.l === 99 && c0.c === 102 && c0.v === 1000 && c0.adj === 101 && c6.c === 108 && c6.adj === 108 && c4.v === null && c4.c === 101 && c4.adj === 100, "candle fields t/o/h/l/c/v/adj (null volume kept as null, adj from adjclose)");
ok(j.summary.first === 102 && j.summary.last === 108 && near(j.summary.changePercent, 5.8824) && j.summary.high === 109 && j.summary.low === 98 && j.summary.avgVolume === 4000 && j.summary.bars === 6 && j.summary.from === c0.t && j.summary.to === c6.t, "summary first/last/changePercent/high/low/avgVolume hand-checked");
ok(j.dividends.length === 2 && j.dividends[0].amount === 0.26 && j.dividends[0].date === new Date(HIST_TS[1] * 1000).toISOString() && j.dividends[1].amount === 0.27 && j.splits.length === 1 && j.splits[0].ratio === "4:1" && j.splits[0].numerator === 4 && j.splits[0].denominator === 1 && j.splits[0].date === new Date(HIST_TS[3] * 1000).toISOString(), "dividends and splits arrays");
ok(j.symbol === "AAPL" && j.currency === "USD" && j.exchange === "NMS" && j.name === "Apple Inc." && j.timezone === "America/New_York" && j.meta.price === 247.77 && j.meta.marketState === "REGULAR" && NOTICE_RE.test(j.notice) && j.source === "Yahoo Finance" && JSON.parse(calls[0].init.body).paymentRequirements.amount === "2000", "history meta, notice, $0.002 requirements");
ok([...cacheMap.values()].some((v) => v.cc === "public, max-age=300"), "daily history cached 300 s");
for (const [q, want] of [["range=1d&interval=1m", "range=1d&interval=1m"], ["range=5d&interval=1m", "range=5d&interval=1m"], ["range=1mo&interval=5m", "range=1mo&interval=5m"], ["range=5d&interval=15m", "range=5d&interval=15m"], ["range=1mo&interval=1h", "range=1mo&interval=1h"], ["range=max&interval=1d", "range=max&interval=1d"], ["range=5y&interval=1wk", "range=5y&interval=1wk"], ["range=2y&interval=1mo", "range=2y&interval=1mo"], ["range=1D&interval=1M", "range=1d&interval=1m"]]) {
  reset(); cacheMap.clear();
  r = await paid("/history", "?symbol=MSFT&" + q); j = await r.json();
  ok(r.status === 200 && upstream[0].u.includes(`?${want}&`) && j.range === want.split("&")[0].split("=")[1] && j.interval === want.split("=")[2], `/history ${q} allowed -> upstream ${want}`);
}
ok([...cacheMap.values()].some((v) => v.cc === "public, max-age=15"), "1m history cached 15 s");
reset(); cacheMap.clear(); r = await paid("/history", "?symbol=MSFT&range=5d&interval=5m"); ok([...cacheMap.values()].some((v) => v.cc === "public, max-age=60"), "intraday history cached 60 s");
reset(); r = await paidPost("/history", { symbol: "AAPL", range: "3mo", interval: "1wk" }); j = await r.json(); ok(r.status === 200 && j.range === "3mo" && j.interval === "1wk" && upstream[0].u.includes("range=3mo&interval=1wk"), "/history POST body range/interval");
// history 404 / 502 no settle
const allNull = chart({ meta: META_AAPL, timestamp: [1, 2], indicators: { quote: [{ open: [null, null], high: [null, null], low: [null, null], close: [null, null], volume: [null, null] }] } });
globalThis.fetch = async (u, init) => (String(u).includes("/chart/ALLNULL?") ? (upstream.push({ u }), jres(allNull)) : origFetch(u, init));
reset(); r = await paid("/history", "?symbol=ALLNULL"); j = await r.json(); ok(r.status === 404 && /No 1d bars/.test(j.error) && /no payment was taken/.test(j.error), "/history all-null bars -> 404"); noSettle("history all null");
globalThis.fetch = origFetch;
reset(); r = await paid("/history", "?symbol=NOPE"); ok(r.status === 404, "/history unknown symbol -> 404"); noSettle("history 404");
reset(); r = await paid("/history", "?symbol=DOWN&range=1y"); ok(r.status === 502, "/history upstream down -> 502"); noSettle("history 502");
reset(); r = await paid("/history", "?symbol=FLAKY"); ok(r.status === 200 && upstream.length === 2 && upstream[1].u.startsWith("https://query2."), "/history uses query2 fallback");

// ---- /stats: math on known fixtures ----
reset(); cacheMap.clear();
r = await paid("/stats", "?symbol=RSIX"); j = await r.json();
ok(r.status === 200 && upstream[0].u === "https://query1.finance.yahoo.com/v8/finance/chart/RSIX?range=1y&interval=1d&includePrePost=false&events=div,splits" && JSON.parse(calls[0].init.body).paymentRequirements.amount === "2000", "/stats fetches range=1y interval=1d, $0.002 requirements");
ok(j.rsi14 === 56.6667, `RSI14 on +1x7/-1x7/+2 fixture = 56.6667 (got ${j.rsi14})`);
ok(j.maxDrawdownPct === -6.5421, `max drawdown 107 -> 100 = -6.5421% (got ${j.maxDrawdownPct})`);
ok(j.returns["1w"] === -3.7736 && j.returns["1m"] === null && j.returns["3m"] === null && j.returns["6m"] === null && j.returns["1y"] === null, `returns: 1w = 102/106-1 = -3.7736%, longer windows null on 16 bars (got ${JSON.stringify(j.returns)})`);
ok(j.sma.sma20.value === null && j.sma.sma20.priceAbove === null && j.sma.sma50.value === null && j.sma.sma200.value === null, "SMA20/50/200 null with only 16 bars");
{ // volatility: independent computation of stdev(log returns) * sqrt(252) * 100
  const lr = []; for (let i = 1; i < RSI_CLOSES.length; i++) lr.push(Math.log(RSI_CLOSES[i] / RSI_CLOSES[i - 1]));
  const m = lr.reduce((a, b) => a + b, 0) / lr.length; const sd = Math.sqrt(lr.reduce((a, x) => a + (x - m) ** 2, 0) / (lr.length - 1));
  const vol = Number((sd * Math.sqrt(252) * 100).toFixed(4));
  ok(j.volatilityAnnualizedPct === vol && vol > 10 && vol < 30, `annualized volatility = ${vol}% (sample stdev of daily log returns x sqrt(252))`);
}
ok(j.avgVolume30d === 8500 && j.bars === 16 && j.lastClose === 102 && j.price === 102 && j.lastCloseDate === new Date(LAST_TS * 1000).toISOString() && j.from === new Date((LAST_TS - 15 * DAY) * 1000).toISOString(), "avgVolume30d 8500, bars 16, lastClose/price/dates");
ok(j.fiftyTwoWeek.high === 107 && j.fiftyTwoWeek.low === 100 && j.fiftyTwoWeek.distanceFromHighPct === -4.6729 && j.fiftyTwoWeek.distanceFromLowPct === 2, "52-week high/low and distances (102/107-1 = -4.6729%, 102/100-1 = 2%)");
ok(j.symbol === "RSIX" && j.name === "RSIX Long Name" && j.currency === "USD" && NOTICE_RE.test(j.notice) && j.source === "Yahoo Finance", "stats identity fields + notice");

reset(); r = await paid("/stats", "?symbol=LINEAR"); j = await r.json();
ok(r.status === 200 && j.bars === 260 && j.lastClose === 359 && j.price === 360, "linear fixture: 260 bars, lastClose 359, price 360 from meta");
ok(j.sma.sma20.value === 349.5 && j.sma.sma50.value === 334.5 && j.sma.sma200.value === 259.5, `SMA20/50/200 = 349.5/334.5/259.5 (got ${j.sma.sma20.value}/${j.sma.sma50.value}/${j.sma.sma200.value})`);
ok(j.sma.sma20.priceAbove === true && j.sma.sma50.priceAbove === true && j.sma.sma200.priceAbove === true, "price 360 above all SMAs");
ok(j.rsi14 === 100 && j.maxDrawdownPct === 0, "monotonic rise: RSI 100, drawdown 0");
ok(j.returns["1w"] === 1.4124 && j.returns["1m"] === 6.5282 && j.returns["3m"] === 22.1088 && j.returns["6m"] === 56.7686 && j.returns["1y"] === 259, `returns 1w/1m/3m/6m/1y = 1.4124/6.5282/22.1088/56.7686/259 (got ${JSON.stringify(j.returns)})`);
ok(j.fiftyTwoWeek.distanceFromHighPct === -1.3699 && j.fiftyTwoWeek.distanceFromLowPct === 278.9474 && j.avgVolume30d === 1000000, "52w distances from meta (360/365, 360/95) and avgVolume30d");
{ const lr = []; for (let i = 1; i < LIN_CLOSES.length; i++) lr.push(Math.log(LIN_CLOSES[i] / LIN_CLOSES[i - 1])); const m = lr.reduce((a, b) => a + b, 0) / lr.length; const sd = Math.sqrt(lr.reduce((a, x) => a + (x - m) ** 2, 0) / (lr.length - 1));
  ok(j.volatilityAnnualizedPct === Number((sd * Math.sqrt(252) * 100).toFixed(4)), "linear fixture volatility matches independent computation"); }
// price-above false when meta price below SMA; and 52w computed from bars when meta lacks it
const lowMeta = chart({ ...LINEAR.chart.result[0], meta: { ...LINEAR.chart.result[0].meta, regularMarketPrice: 300, fiftyTwoWeekHigh: undefined, fiftyTwoWeekLow: undefined } });
globalThis.fetch = async (u, init) => (String(u).includes("/chart/LOWP?") ? (upstream.push({ u }), jres(lowMeta)) : origFetch(u, init));
reset(); r = await paid("/stats", "?symbol=LOWP"); j = await r.json();
ok(r.status === 200 && j.price === 300 && j.sma.sma20.priceAbove === false && j.sma.sma50.priceAbove === false && j.sma.sma200.priceAbove === true && j.fiftyTwoWeek.high === 360 && j.fiftyTwoWeek.low === 99 && j.fiftyTwoWeek.distanceFromHighPct === -16.6667, "priceAbove false below SMA20/50, 52w from bar highs/lows (360/99) when meta lacks them");
globalThis.fetch = origFetch;
// stats 404 / 502 no settle
const oneBar = chart({ meta: META_AAPL, timestamp: [LAST_TS], indicators: { quote: [{ open: [1], high: [1], low: [1], close: [1], volume: [1] }] } });
globalThis.fetch = async (u, init) => (String(u).includes("/chart/ONEBAR?") ? (upstream.push({ u }), jres(oneBar)) : origFetch(u, init));
reset(); r = await paid("/stats", "?symbol=ONEBAR"); j = await r.json(); ok(r.status === 404 && /Not enough daily history/.test(j.error), "/stats with 1 bar -> 404"); noSettle("stats 1 bar");
globalThis.fetch = origFetch;
reset(); r = await paid("/stats", "?symbol=NOPE"); ok(r.status === 404, "/stats unknown symbol -> 404"); noSettle("stats 404");
reset(); r = await paid("/stats", "?symbol=DOWN"); ok(r.status === 502 && upstream.length === 2, "/stats upstream down -> 502"); noSettle("stats 502");
reset(); r = await paidPost("/stats", { symbol: "rsix" }); j = await r.json(); ok(r.status === 200 && j.rsi14 === 56.6667 && upstream.length === 0, "/stats POST body, served from cache");

// ---- facilitator failures ----
mode = "badverify"; reset();
r = await paid("/quote", "?symbol=FRESH1"); ok(r.status === 402 && dec(r.headers.get("PAYMENT-REQUIRED")).error === "insufficient_funds" && dec(r.headers.get("PAYMENT-REQUIRED")).resource.url === base + "/quote" && calls.length === 1 && upstream.length === 0, "verify fail -> 402, upstream never fetched");
mode = "badsettle"; reset(); cacheMap.clear();
r = await paid("/quote", "?symbol=AAPL"); const txt = await r.text();
ok(r.status === 402 && txt === "{}" && !txt.includes("247") && dec(r.headers.get("PAYMENT-RESPONSE")).success === false && dec(r.headers.get("PAYMENT-RESPONSE")).errorReason === "invalid_transaction_state" && calls.length === 2, "settle fail -> 402 with empty body, no data leaked");
reset(); r = await paid("/stats", "?symbol=LINEAR"); ok(r.status === 402 && (await r.text()) === "{}", "settle fail on /stats -> empty body");
mode = "good";
const savedFetch = globalThis.fetch;
globalThis.fetch = async (u, init) => { if (String(u).includes("facilitator.payai.network")) { calls.push({ u }); throw new TypeError("fetch failed"); } return savedFetch(u, init); };
reset(); r = await paid("/quote", "?symbol=AAPL"); j = await r.json(); ok(r.status === 500 && /Facilitator unreachable/.test(j.error) && upstream.length === 0, "facilitator unreachable -> 500, upstream never fetched");
globalThis.fetch = savedFetch;

// ---- /health/data (free) ----
reset(); r = await W.fetch(new Request(base + "/health/data"), env, ctx); j = await r.json();
ok(r.status === 200 && j.status === "ok" && j.symbol === "^GSPC" && j.price === 20 && typeof j.ms === "number" && j.asOf && calls.length === 0 && upstream.length === 1 && upstream[0].u.includes("/chart/%5EGSPC?range=1d&interval=1m"), "/health/data fetches ^GSPC meta, no facilitator, reports ok + latency");
reset(); r = await W.fetch(new Request(base + "/health/data"), env, ctx); ok(upstream.length === 1, "/health/data bypasses cache");
globalThis.fetch = async (u, init) => (String(u).includes("yahoo") ? (upstream.push({ u }), jres("down", 503)) : savedFetch(u, init));
reset(); r = await W.fetch(new Request(base + "/health/data"), env, ctx); j = await r.json(); ok(r.status === 503 && j.status === "down" && j.price === null && upstream.length === 2, "/health/data reports down (503) when both hosts fail");
globalThis.fetch = savedFetch;
r = await W.fetch(new Request(base + "/health/data", { method: "POST" }), env, ctx); ok(r.status === 405, "/health/data POST -> 405");

// ---- openapi ----
r = await W.fetch(new Request(base + "/openapi.json"), env, ctx); const o = await r.json();
ok(r.status === 200 && o.openapi === "3.1.0" && o.info.title === "Stock Quotes" && o.info["x-guidance"].includes("$0.001") && o.info["x-guidance"].includes("$0.003") && o.info["x-guidance"].includes("$0.002") && o.info["x-guidance"].includes("not investment advice") && o.servers[0].url === base && Object.keys(o.paths).join() === ROUTES.join() && o.info.description.startsWith("Stock, ETF, index, FX and commodity quotes") && o.info.description.includes("No API key"), "openapi.json: 3.1.0, x-guidance with prices, 4 paths, agent description");
const USD = { "/quote": "0.001000", "/quotes": "0.003000", "/history": "0.002000", "/stats": "0.002000" };
for (const route of ROUTES) {
  const g = o.paths[route].get, p = o.paths[route].post;
  ok(g["x-payment-info"].price.amount === USD[route] && g["x-payment-info"].price.mode === "fixed" && g["x-payment-info"].price.currency === "USD" && g["x-payment-info"].protocols[0].x402 && p["x-payment-info"].price.amount === USD[route] && p["x-payment-info"].protocols[0].x402 && g.responses["402"] && p.responses["402"] && g.responses["404"] && g.responses["413"] && g.responses["502"] && g.responses["200"].content["application/json"].schema.properties.notice && p.requestBody.content["application/json"].schema, `${route} openapi ops: x-payment-info ${USD[route]}, 402/404/413/502, schemas with notice`);
}
ok(o.paths["/quote"].get.parameters.map((x) => x.name).join() === "symbol" && o.paths["/quote"].get.parameters[0].required === true && o.paths["/quotes"].get.parameters.map((x) => x.name).join() === "symbols" && o.paths["/history"].get.parameters.map((x) => x.name).join() === "symbol,range,interval" && o.paths["/history"].get.parameters[1].required === false && o.paths["/stats"].get.parameters.map((x) => x.name).join() === "symbol", "openapi GET parameters per route");
ok(o.paths["/history"].post.requestBody.content["application/json"].schema.properties.range.enum.join() === "1d,5d,1mo,3mo,6mo,1y,2y,5y,max" && o.paths["/history"].post.requestBody.content["application/json"].schema.properties.interval.enum.join() === "1m,5m,15m,1h,1d,1wk,1mo" && o.paths["/stats"].get.responses["200"].content["application/json"].schema.properties.sma.properties.sma200 && o.paths["/history"].get.responses["200"].content["application/json"].schema.properties.candles.items.properties.adj && o.paths["/quotes"].post.requestBody.content["application/json"].schema.properties.symbols.oneOf.length === 2, "openapi schemas per route (enums, sma, candles, symbols oneOf)");
r = await W.fetch(new Request(base + "/.well-known/openapi.json"), env, ctx); ok(r.status === 200 && (await r.json()).openapi === "3.1.0", "well-known openapi alias");
reset(); r = await paid("/quote", "?symbol=AAPL"); ok(r.headers.get("Access-Control-Allow-Origin") === "*" && /PAYMENT-RESPONSE/.test(r.headers.get("Access-Control-Expose-Headers")) && r.headers.get("Content-Type") === "application/json", "CORS headers on paid response");

// ---- no ctx and no caches API: still works ----
const savedCaches = globalThis.caches; delete globalThis.caches; reset();
r = await W.fetch(new Request(base + "/stats?symbol=LINEAR", { headers: { "PAYMENT-SIGNATURE": hdrs["/stats"] } }), env); j = await r.json();
ok(r.status === 200 && j.sma.sma200.value === 259.5 && upstream.length === 1, "works without caches.default and without ctx");
globalThis.caches = savedCaches;

// ---- CDP facilitator ----
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const jwk = privateKey.export({ format: "jwk" });
const secret = Buffer.concat([Buffer.from(jwk.d, "base64url"), Buffer.from(jwk.x, "base64url")]).toString("base64");
const envC = { PAY_TO: PAY, CDP_API_KEY_ID: "test-key-id", CDP_API_KEY_SECRET: secret };
reset();
r = await W.fetch(new Request(base + "/quote?symbol=AAPL", { headers: { "PAYMENT-SIGNATURE": hdrs["/quote"] } }), envC, ctx);
ok(r.status === 200 && calls[0].u === "https://api.cdp.coinbase.com/platform/v2/x402/verify", "cdp facilitator used");
const checkJwt = (tok, pub, uri, alg) => { const [hh, pl, s] = tok.split("."); const H = JSON.parse(Buffer.from(hh, "base64url")), P = JSON.parse(Buffer.from(pl, "base64url"));
  const sigOk = alg === "EdDSA" ? nverify(null, Buffer.from(hh + "." + pl), pub, Buffer.from(s, "base64url")) : nverify("sha256", Buffer.from(hh + "." + pl), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
  return sigOk && H.alg === alg && H.kid === "test-key-id" && H.nonce.length === 32 && P.iss === "cdp" && P.sub === "test-key-id" && P.uris[0] === uri && P.exp - P.nbf === 120; };
ok(checkJwt(calls[0].init.headers.Authorization.slice(7), publicKey, "POST api.cdp.coinbase.com/platform/v2/x402/verify", "EdDSA"), "Ed25519 JWT valid (verify)");
ok(checkJwt(calls[1].init.headers.Authorization.slice(7), publicKey, "POST api.cdp.coinbase.com/platform/v2/x402/settle", "EdDSA"), "Ed25519 JWT valid (settle)");
const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pem = ec.privateKey.export({ type: "sec1", format: "pem" });
reset();
r = await W.fetch(new Request(base + "/quote?symbol=AAPL", { headers: { "PAYMENT-SIGNATURE": hdrs["/quote"] } }), { ...envC, CDP_API_KEY_SECRET: pem.replace(/\n/g, "\\n") }, ctx);
ok(r.status === 200 && checkJwt(calls[0].init.headers.Authorization.slice(7), ec.publicKey, "POST api.cdp.coinbase.com/platform/v2/x402/verify", "ES256"), "EC SEC1 JWT valid");
const body = await r.text(); ok(!body.includes(secret) && !body.includes("test-key-id") && !body.includes("PRIVATE KEY"), "no secrets in response");
r = await W.fetch(new Request(base + "/"), envC, ctx); ok((await r.json()).facilitator === "cdp", "info page reports cdp facilitator");

// ---- hard rule: no real network ever touched ----
ok(upstream.every((x) => /^https:\/\/query[12]\.finance\.yahoo\.com\/v8\/finance\/chart\/[^/?]+\?range=/.test(x.u)), "all upstream calls went to the Yahoo chart mocks");
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exitCode = fails ? 1 : 0;
