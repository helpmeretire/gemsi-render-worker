// ---------- params & validation (nothing here touches the network) ----------
const isStr = (v) => typeof v === "string";
const present = (v) => v !== undefined && v !== null && !(isStr(v) && v.trim() === "");
const fail = (msg) => ({ error: `${msg} (no payment was taken)` });
const r4 = (x) => (Number.isFinite(x) ? Number(x.toFixed(4)) : null);
const numOrNull = (v) => { const n = typeof v === "number" ? v : isStr(v) && v.trim() ? Number(v) : NaN; return Number.isFinite(n) ? n : null; };
const strOrNull = (v) => (isStr(v) && v.trim() ? v.trim() : null);
const isoFromUnix = (s) => (Number.isFinite(s) ? new Date(s * 1000).toISOString() : null);

// Merges query-string params with a POST JSON body (body wins). Returns { params } or { error } or { error, status: 413 }.
async function readParams(request, url) {
  const p = Object.fromEntries(url.searchParams);
  if (request.method === "POST") {
    let text = "";
    try { text = await request.clone().text(); } catch { return { error: "Request body could not be read" }; }
    if (text.length > MAX_REQUEST_BYTES) return { error: `Request body too large (max ${MAX_REQUEST_BYTES} bytes)`, status: 413 };
    if (text.trim()) {
      let b;
      try { b = JSON.parse(text); } catch { return { error: "Request body must be a JSON object" }; }
      if (!b || typeof b !== "object" || Array.isArray(b)) return { error: "Request body must be a JSON object" };
      Object.assign(p, b);
    }
  }
  return { params: p };
}

const SYMBOL_HELP = "1-12 characters of A-Z 0-9 . ^ = - e.g. AAPL, BRK-B, ^GSPC, BTC-USD, EURUSD=X, GC=F";
function checkSymbol(v, label = "symbol") {
  if (!present(v)) return { error: `Missing required parameter: ${label} (${SYMBOL_HELP})` };
  if (!isStr(v)) return { error: `${label} must be a string` };
  const s = v.trim().toUpperCase();
  if (!SYMBOL_RE.test(s)) return { error: `Invalid ${label} "${v.trim().slice(0, 20)}": use ${SYMBOL_HELP}` };
  return { symbol: s };
}
function checkSymbols(v) {
  if (!present(v) || (Array.isArray(v) && v.length === 0)) return { error: `Missing required parameter: symbols (comma-separated list or JSON array of 1-${MAX_SYMBOLS} symbols, ${SYMBOL_HELP})` };
  let list;
  if (Array.isArray(v)) list = v;
  else if (isStr(v)) list = v.split(",");
  else return { error: "symbols must be a comma-separated string or a JSON array of strings" };
  const out = [];
  for (const item of list) {
    if (!isStr(item)) return { error: "symbols must contain only strings" };
    if (!item.trim()) continue;
    const c = checkSymbol(item, "symbols entry"); if (c.error) return c;
    if (!out.includes(c.symbol)) out.push(c.symbol);
  }
  if (!out.length) return { error: `Missing required parameter: symbols (1-${MAX_SYMBOLS} symbols)` };
  if (out.length > MAX_SYMBOLS) return { error: `Too many symbols: ${out.length} (max ${MAX_SYMBOLS} per call)` };
  return { symbols: out };
}
function checkRangeInterval(rangeV, intervalV) {
  let range = DEFAULT_RANGE, interval = DEFAULT_INTERVAL;
  if (present(rangeV)) {
    if (!isStr(rangeV) || !RANGES.includes(rangeV.trim().toLowerCase())) return { error: `range must be one of ${RANGES.join(", ")}` };
    range = rangeV.trim().toLowerCase();
  }
  if (present(intervalV)) {
    if (!isStr(intervalV) || !INTERVALS.includes(intervalV.trim().toLowerCase())) return { error: `interval must be one of ${INTERVALS.join(", ")}` };
    interval = intervalV.trim().toLowerCase();
  }
  if (interval === "1m" && !MINUTE_RANGES.includes(range)) return { error: `interval 1m is only available for range ${MINUTE_RANGES.join(" or ")} (Yahoo keeps 7 days of 1-minute bars)` };
  if (INTRADAY.includes(interval) && !INTRADAY_RANGES.includes(range)) return { error: `intraday intervals (${INTRADAY.join(", ")}) are only available for range ${INTRADAY_RANGES.join(", ")} (60 days max); use 1d, 1wk or 1mo bars for longer ranges` };
  return { range, interval };
}

function validateQuote(p) {
  const s = checkSymbol(p.symbol); if (s.error) return fail(s.error);
  return { symbol: s.symbol };
}
function validateQuotes(p) {
  const s = checkSymbols(p.symbols !== undefined ? p.symbols : p.symbol); if (s.error) return fail(s.error);
  return { symbols: s.symbols };
}
function validateHistory(p) {
  const s = checkSymbol(p.symbol); if (s.error) return fail(s.error);
  const ri = checkRangeInterval(p.range, p.interval); if (ri.error) return fail(ri.error);
  return { symbol: s.symbol, range: ri.range, interval: ri.interval };
}
const VALIDATORS = { quote: validateQuote, quotes: validateQuotes, history: validateHistory, stats: validateQuote };

// ---------- upstream fetch (Yahoo chart endpoint) + cache ----------
function cacheStore() {
  try { return typeof caches !== "undefined" && caches && caches.default ? caches.default : null; } catch { return null; }
}
function cachePut(key, data, ttl, ctx) {
  const cache = cacheStore();
  if (!cache) return;
  const res = new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${ttl}` } });
  const p = Promise.resolve().then(() => cache.put(key, res)).catch(() => {});
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(p);
  return p;
}
const chartUrl = (host, symbol, range, interval) => `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false&events=div,splits`;
const ttlFor = (interval) => (interval === "1m" ? CACHE_TTL_1M_S : INTRADAY.includes(interval) ? CACHE_TTL_INTRADAY_S : CACHE_TTL_DAILY_S);

// One attempt against one host. Returns { kind: "ok", result } | { kind: "notfound", reason } | { kind: "fail", reason }.
async function attempt(u) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    let res;
    try {
      res = await fetch(u, { method: "GET", redirect: "follow", signal: ctrl.signal, headers: { "user-agent": UPSTREAM_UA, accept: "application/json" } });
    } catch (e) {
      if (ctrl.signal.aborted) return { kind: "fail", reason: `did not respond within ${TIMEOUT_MS / 1000} seconds` };
      return { kind: "fail", reason: `unreachable: ${String(e && e.message ? e.message : e).slice(0, 120)}` };
    }
    let text;
    try { text = await res.text(); } catch { return { kind: "fail", reason: ctrl.signal.aborted ? `did not finish within ${TIMEOUT_MS / 1000} seconds` : "response could not be read" }; }
    let data = null;
    try { data = JSON.parse(text); } catch {}
    const chart = data && typeof data === "object" ? data.chart : null;
    if (chart && chart.error) return { kind: "notfound", reason: strOrNull(chart.error.description) || strOrNull(chart.error.code) || "no data" };
    if (res.status === 404) return { kind: "notfound", reason: "no data found, symbol may be delisted or unknown" };
    if (res.status < 200 || res.status >= 300) return { kind: "fail", reason: `HTTP ${res.status}` };
    if (!chart) return { kind: "fail", reason: "unreadable response" };
    const result = Array.isArray(chart.result) ? chart.result[0] : null;
    if (!result || typeof result !== "object" || !result.meta || typeof result.meta !== "object") return { kind: "notfound", reason: "no data returned for this symbol" };
    return { kind: "ok", result };
  } finally {
    clearTimeout(timer);
  }
}

// Fetches one chart. Returns { status: 200, result } or { status: 404 | 502, body } (non-200 means do not settle).
// query1 is tried first; on a transport/server failure query2 is tried. A not-found answer is final (no fallback).
async function fetchChart(symbol, range, interval, ctx, noCache) {
  const key = chartUrl(YAHOO_HOSTS[0], symbol, range, interval);
  const cache = noCache ? null : cacheStore();
  if (cache) {
    try { const hit = await cache.match(key); if (hit) return { status: 200, result: await hit.json(), cached: true }; } catch {}
  }
  const reasons = [];
  for (const host of YAHOO_HOSTS) {
    const a = await attempt(chartUrl(host, symbol, range, interval));
    if (a.kind === "ok") {
      if (!noCache) { const p = cachePut(key, a.result, ttlFor(interval), ctx); if (p && !(ctx && typeof ctx.waitUntil === "function")) await p; }
      return { status: 200, result: a.result, cached: false };
    }
    if (a.kind === "notfound") return { status: 404, body: { error: `Symbol ${symbol} not found: ${a.reason}; no payment was taken`, symbol } };
    reasons.push(`${host.split(".")[0]}: ${a.reason}`);
  }
  return { status: 502, body: { error: `${SOURCE} failed (${reasons.join("; ")}): data source temporarily unavailable, no payment taken`, symbol } };
}

// ---------- normalization ----------
function quoteFromMeta(symbol, meta) {
  const price = numOrNull(meta.regularMarketPrice);
  if (price === null) return null;
  const prev = numOrNull(meta.previousClose) !== null ? numOrNull(meta.previousClose) : numOrNull(meta.chartPreviousClose);
  const change = prev !== null ? price - prev : null;
  return {
    symbol,
    name: strOrNull(meta.longName) || strOrNull(meta.shortName) || symbol,
    shortName: strOrNull(meta.shortName),
    price: r4(price),
    change: change === null ? null : r4(change),
    changePercent: change === null || !prev ? null : r4((change / prev) * 100),
    previousClose: prev === null ? null : r4(prev),
    dayHigh: r4(numOrNull(meta.regularMarketDayHigh)),
    dayLow: r4(numOrNull(meta.regularMarketDayLow)),
    volume: numOrNull(meta.regularMarketVolume),
    fiftyTwoWeekHigh: r4(numOrNull(meta.fiftyTwoWeekHigh)),
    fiftyTwoWeekLow: r4(numOrNull(meta.fiftyTwoWeekLow)),
    currency: strOrNull(meta.currency),
    exchange: strOrNull(meta.exchangeName),
    exchangeName: strOrNull(meta.fullExchangeName),
    instrumentType: strOrNull(meta.instrumentType),
    marketState: strOrNull(meta.marketState),
    asOf: isoFromUnix(numOrNull(meta.regularMarketTime)),
  };
}

// Yahoo arrays -> clean candles; a bar is dropped when any of o/h/l/c is missing.
function candlesFrom(result) {
  const ts = Array.isArray(result.timestamp) ? result.timestamp : [];
  const q = result.indicators && Array.isArray(result.indicators.quote) && result.indicators.quote[0] ? result.indicators.quote[0] : {};
  const adj = result.indicators && Array.isArray(result.indicators.adjclose) && result.indicators.adjclose[0] ? result.indicators.adjclose[0].adjclose : null;
  const at = (arr, i) => (Array.isArray(arr) ? numOrNull(arr[i]) : null);
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const t = numOrNull(ts[i]), o = at(q.open, i), h = at(q.high, i), l = at(q.low, i), c = at(q.close, i);
    if (t === null || o === null || h === null || l === null || c === null) continue;
    const a = at(adj, i);
    out.push({ t: isoFromUnix(t), ts: t, o: r4(o), h: r4(h), l: r4(l), c: r4(c), v: at(q.volume, i), adj: r4(a === null ? c : a) });
  }
  return out;
}
function eventsFrom(result) {
  const ev = result.events && typeof result.events === "object" ? result.events : {};
  const list = (obj) => (obj && typeof obj === "object" ? Object.values(obj) : []);
  const dividends = list(ev.dividends).map((d) => ({ date: isoFromUnix(numOrNull(d.date)), amount: numOrNull(d.amount) })).filter((d) => d.date && d.amount !== null).sort((a, b) => (a.date < b.date ? -1 : 1));
  const splits = list(ev.splits).map((s) => ({ date: isoFromUnix(numOrNull(s.date)), numerator: numOrNull(s.numerator), denominator: numOrNull(s.denominator), ratio: strOrNull(s.splitRatio) || (numOrNull(s.numerator) !== null && numOrNull(s.denominator) !== null ? `${s.numerator}:${s.denominator}` : null) })).filter((s) => s.date).sort((a, b) => (a.date < b.date ? -1 : 1));
  return { dividends, splits };
}
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

function summarize(candles) {
  if (!candles.length) return null;
  const first = candles[0].c, last = candles[candles.length - 1].c;
  const vols = candles.map((c) => c.v).filter((v) => v !== null);
  return {
    from: candles[0].t, to: candles[candles.length - 1].t, bars: candles.length,
    first: r4(first), last: r4(last),
    changePercent: first ? r4(((last - first) / first) * 100) : null,
    high: r4(Math.max(...candles.map((c) => c.h))), low: r4(Math.min(...candles.map((c) => c.l))),
    avgVolume: vols.length ? Math.round(mean(vols)) : null,
  };
}

// ---------- stats math (pure) ----------
function sma(closes, n) { return closes.length >= n ? mean(closes.slice(-n)) : null; }
// Wilder RSI: first averages are simple means of the first `period` changes, then exponentially smoothed.
function rsi(closes, period) {
  if (closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) gain += d; else loss -= d; }
  gain /= period; loss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + (d > 0 ? d : 0)) / period;
    loss = (loss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (loss === 0) return 100;
  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}
function annualizedVolatility(closes) {
  const lr = [];
  for (let i = 1; i < closes.length; i++) if (closes[i] > 0 && closes[i - 1] > 0) lr.push(Math.log(closes[i] / closes[i - 1]));
  if (lr.length < 2) return null;
  const m = mean(lr);
  const variance = lr.reduce((a, x) => a + (x - m) * (x - m), 0) / (lr.length - 1);
  return Math.sqrt(variance) * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100;
}
function maxDrawdown(closes) {
  if (!closes.length) return null;
  let peak = closes[0], mdd = 0;
  for (const c of closes) { if (c > peak) peak = c; const dd = (c / peak - 1) * 100; if (dd < mdd) mdd = dd; }
  return mdd;
}
// Return over a lookback window: the first bar at or after (last bar - days) must exist within RETURN_TOLERANCE_DAYS of the target.
function returnOver(candles, days) {
  const last = candles[candles.length - 1];
  const target = last.ts - days * 86400;
  const idx = candles.findIndex((c) => c.ts >= target);
  if (idx < 0 || idx === candles.length - 1) return null;
  if (candles[idx].ts - target > RETURN_TOLERANCE_DAYS * 86400) return null;
  const base = candles[idx].c;
  return base ? ((last.c - base) / base) * 100 : null;
}
function computeStats(candles, price) {
  const closes = candles.map((c) => c.c);
  const returns = {};
  for (const [k, days] of Object.entries(RETURN_WINDOWS)) returns[k] = r4(returnOver(candles, days));
  const smas = {};
  for (const n of SMA_PERIODS) { const v = sma(closes, n); smas[`sma${n}`] = { value: r4(v), priceAbove: v === null ? null : price > v }; }
  const vols = candles.slice(-AVG_VOLUME_DAYS).map((c) => c.v).filter((v) => v !== null);
  return {
    returns,
    volatilityAnnualizedPct: r4(annualizedVolatility(closes)),
    maxDrawdownPct: r4(maxDrawdown(closes)),
    sma: smas,
    rsi14: r4(rsi(closes, RSI_PERIOD)),
    avgVolume30d: vols.length ? Math.round(mean(vols)) : null,
  };
}

// ---------- route logic: each returns { status, body } (status !== 200 means do not settle) ----------
async function getQuote(symbol, ctx, noCache) {
  const f = await fetchChart(symbol, QUOTE_RANGE, QUOTE_INTERVAL, ctx, noCache);
  if (f.status !== 200) return f;
  const q = quoteFromMeta(symbol, f.result.meta);
  if (!q) return { status: 404, body: { error: `Symbol ${symbol} not found: no price data; no payment was taken`, symbol } };
  return { status: 200, quote: q };
}
async function doQuote(p, ctx) {
  const g = await getQuote(p.symbol, ctx);
  if (g.status !== 200) return g;
  return { status: 200, body: { ...g.quote, source: SOURCE, notice: NOTICE, fetched_at: new Date().toISOString() } };
}
async function doQuotes(p, ctx) {
  const results = await Promise.all(p.symbols.map(async (symbol) => {
    const g = await getQuote(symbol, ctx);
    if (g.status === 200) return { symbol, ok: true, ...g.quote };
    return { symbol, ok: false, error: g.status === 404 ? "not found" : "unavailable", status: g.status };
  }));
  const okCount = results.filter((r) => r.ok).length;
  if (!okCount) {
    const anyDown = results.some((r) => r.status === 502);
    return { status: anyDown ? 502 : 404, body: { error: anyDown ? `${SOURCE} is temporarily unavailable; no payment was taken` : `None of the symbols were found: ${p.symbols.join(", ")}; no payment was taken`, symbols: p.symbols } };
  }
  return { status: 200, body: { count: results.length, found: okCount, results: results.map(({ status, ...r }) => r), source: SOURCE, notice: NOTICE, fetched_at: new Date().toISOString() } };
}
async function doHistory(p, ctx) {
  const f = await fetchChart(p.symbol, p.range, p.interval, ctx);
  if (f.status !== 200) return f;
  const candles = candlesFrom(f.result);
  if (!candles.length) return { status: 404, body: { error: `No ${p.interval} bars for ${p.symbol} over ${p.range}; no payment was taken`, symbol: p.symbol } };
  const meta = quoteFromMeta(p.symbol, f.result.meta) || { symbol: p.symbol, name: strOrNull(f.result.meta.longName) || strOrNull(f.result.meta.shortName) || p.symbol, currency: strOrNull(f.result.meta.currency), exchange: strOrNull(f.result.meta.exchangeName) };
  const { dividends, splits } = eventsFrom(f.result);
  return {
    status: 200,
    body: {
      symbol: p.symbol, range: p.range, interval: p.interval,
      currency: meta.currency, exchange: meta.exchange, name: meta.name, timezone: strOrNull(f.result.meta.exchangeTimezoneName),
      count: candles.length,
      candles: candles.map(({ ts, ...c }) => c),
      dividends, splits,
      summary: summarize(candles),
      meta, source: SOURCE, notice: NOTICE, fetched_at: new Date().toISOString(),
    },
  };
}
async function doStats(p, ctx) {
  const f = await fetchChart(p.symbol, STATS_RANGE, STATS_INTERVAL, ctx);
  if (f.status !== 200) return f;
  const candles = candlesFrom(f.result);
  if (candles.length < 2) return { status: 404, body: { error: `Not enough daily history for ${p.symbol} to compute statistics; no payment was taken`, symbol: p.symbol } };
  const meta = f.result.meta;
  const last = candles[candles.length - 1];
  const price = numOrNull(meta.regularMarketPrice) !== null ? numOrNull(meta.regularMarketPrice) : last.c;
  const hi = numOrNull(meta.fiftyTwoWeekHigh) !== null ? numOrNull(meta.fiftyTwoWeekHigh) : Math.max(...candles.map((c) => c.h));
  const lo = numOrNull(meta.fiftyTwoWeekLow) !== null ? numOrNull(meta.fiftyTwoWeekLow) : Math.min(...candles.map((c) => c.l));
  const stats = computeStats(candles, price);
  return {
    status: 200,
    body: {
      symbol: p.symbol,
      name: strOrNull(meta.longName) || strOrNull(meta.shortName) || p.symbol,
      currency: strOrNull(meta.currency), exchange: strOrNull(meta.exchangeName),
      price: r4(price), asOf: isoFromUnix(numOrNull(meta.regularMarketTime)),
      lastClose: last.c, lastCloseDate: last.t, bars: candles.length, from: candles[0].t,
      returns: stats.returns,
      volatilityAnnualizedPct: stats.volatilityAnnualizedPct,
      maxDrawdownPct: stats.maxDrawdownPct,
      sma: stats.sma,
      rsi14: stats.rsi14,
      fiftyTwoWeek: { high: r4(hi), low: r4(lo), distanceFromHighPct: hi ? r4((price / hi - 1) * 100) : null, distanceFromLowPct: lo ? r4((price / lo - 1) * 100) : null },
      avgVolume30d: stats.avgVolume30d,
      source: SOURCE, notice: NOTICE, fetched_at: new Date().toISOString(),
    },
  };
}
const HANDLERS = { quote: doQuote, quotes: doQuotes, history: doHistory, stats: doStats };

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
// A payment signed for one route carries that route's resource URL and is rejected on another
// (the per-route amount already differs for most pairs; /history and /stats share a price, so this check matters there).
function resourceMatches(payload, route) {
  const res = payload && payload.resource;
  if (!res || !isStr(res.url)) return true; // tolerate clients that omit resource; requirements still must match
  try { return (new URL(res.url).pathname.replace(/\/+$/, "") || "/") === route; } catch { return false; }
}

const EXAMPLE_QUOTE = { symbol: "AAPL", name: "Apple Inc.", shortName: "Apple Inc.", price: 247.77, change: 2.31, changePercent: 0.9411, previousClose: 245.46, dayHigh: 249.12, dayLow: 245.9, volume: 48213400, fiftyTwoWeekHigh: 260.1, fiftyTwoWeekLow: 169.21, currency: "USD", exchange: "NMS", exchangeName: "NasdaqGS", instrumentType: "EQUITY", marketState: "REGULAR", asOf: "2026-10-14T19:59:58.000Z" };
const EXAMPLE_CANDLE = { t: "2026-10-14T13:30:00.000Z", o: 246.1, h: 249.12, l: 245.9, c: 247.77, v: 48213400, adj: 247.77 };
const EXAMPLES = {
  "/quote": { input: { symbol: "AAPL" }, output: { ...EXAMPLE_QUOTE, source: SOURCE, notice: NOTICE, fetched_at: "2026-10-14T20:00:00.000Z" } },
  "/quotes": {
    input: { symbols: "AAPL,MSFT,BTC-USD" },
    output: { count: 3, found: 3, results: [{ symbol: "AAPL", ok: true, ...EXAMPLE_QUOTE }, { symbol: "MSFT", ok: true, ...EXAMPLE_QUOTE, symbol: "MSFT", name: "Microsoft Corporation", shortName: "Microsoft Corporation", price: 512.3, change: -1.2, changePercent: -0.2337, previousClose: 513.5, dayHigh: 515.0, dayLow: 509.8, volume: 18400200, fiftyTwoWeekHigh: 555.45, fiftyTwoWeekLow: 344.79 }, { symbol: "BTC-USD", ok: true, ...EXAMPLE_QUOTE, symbol: "BTC-USD", name: "Bitcoin USD", shortName: "Bitcoin USD", price: 111250.5, change: 1890.25, changePercent: 1.7286, previousClose: 109360.25, dayHigh: 112400, dayLow: 108900, volume: 51234567890, fiftyTwoWeekHigh: 126198.07, fiftyTwoWeekLow: 74436.68, exchange: "CCC", exchangeName: "CCC", instrumentType: "CRYPTOCURRENCY" }], source: SOURCE, notice: NOTICE, fetched_at: "2026-10-14T20:00:00.000Z" },
  },
  "/history": {
    input: { symbol: "AAPL", range: "1mo", interval: "1d" },
    output: { symbol: "AAPL", range: "1mo", interval: "1d", currency: "USD", exchange: "NMS", name: "Apple Inc.", timezone: "America/New_York", count: 22, candles: [{ ...EXAMPLE_CANDLE, t: "2026-09-15T13:30:00.000Z", o: 236.2, h: 238.9, l: 235.1, c: 238.15, v: 41200000, adj: 238.15 }, EXAMPLE_CANDLE], dividends: [{ date: "2026-08-11T13:30:00.000Z", amount: 0.26 }], splits: [], summary: { from: "2026-09-15T13:30:00.000Z", to: "2026-10-14T13:30:00.000Z", bars: 22, first: 238.15, last: 247.77, changePercent: 4.0394, high: 249.12, low: 235.1, avgVolume: 45100000 }, meta: EXAMPLE_QUOTE, source: SOURCE, notice: NOTICE, fetched_at: "2026-10-14T20:00:00.000Z" },
  },
  "/stats": {
    input: { symbol: "AAPL" },
    output: {
      symbol: "AAPL", name: "Apple Inc.", currency: "USD", exchange: "NMS", price: 247.77, asOf: "2026-10-14T19:59:58.000Z", lastClose: 247.77, lastCloseDate: "2026-10-14T13:30:00.000Z", bars: 251, from: "2025-10-14T13:30:00.000Z",
      returns: { "1w": 1.2345, "1m": 4.0394, "3m": 12.1, "6m": 25.3, "1y": 8.75 },
      volatilityAnnualizedPct: 27.84, maxDrawdownPct: -33.42,
      sma: { sma20: { value: 244.1, priceAbove: true }, sma50: { value: 236.7, priceAbove: true }, sma200: { value: 221.3, priceAbove: true } },
      rsi14: 61.2,
      fiftyTwoWeek: { high: 260.1, low: 169.21, distanceFromHighPct: -4.7405, distanceFromLowPct: 46.4275 },
      avgVolume30d: 45100000,
      source: SOURCE, notice: NOTICE, fetched_at: "2026-10-14T20:00:00.000Z",
    },
  },
};
const SYMBOL_DESC = `Ticker symbol, ${SYMBOL_HELP}`;
const QUERY_PROPS = {
  "/quote": { symbol: { type: "string", minLength: 1, maxLength: 12, description: SYMBOL_DESC } },
  "/quotes": { symbols: { type: "string", description: `Comma-separated list of 1-${MAX_SYMBOLS} symbols, e.g. AAPL,MSFT,BTC-USD` } },
  "/history": {
    symbol: { type: "string", minLength: 1, maxLength: 12, description: SYMBOL_DESC },
    range: { type: "string", description: `One of ${RANGES.join(", ")} (default ${DEFAULT_RANGE})` },
    interval: { type: "string", description: `One of ${INTERVALS.join(", ")} (default ${DEFAULT_INTERVAL}); 1m only with range 1d/5d, other intraday only with range up to 1mo` },
  },
  "/stats": { symbol: { type: "string", minLength: 1, maxLength: 12, description: SYMBOL_DESC } },
};
const REQUIRED_QUERY = { "/quote": ["symbol"], "/quotes": ["symbols"], "/history": ["symbol"], "/stats": ["symbol"] };
const ROUTE_DESCRIPTIONS = {
  "/quote": "One symbol -> latest price, change, previous close, day high/low, volume, 52-week high/low, currency, exchange, name, market state.",
  "/quotes": `Up to ${MAX_SYMBOLS} symbols in one call -> the same quote fields per symbol, fetched in parallel; unknown symbols come back as {ok: false, error: "not found"}.`,
  "/history": "One symbol -> OHLCV candles for a range (1d to max) and interval (1m to 1mo), adjusted close, dividends, splits and a summary (first, last, change %, high, low, average volume).",
  "/stats": "One symbol -> statistics computed from one year of daily bars: 1w/1m/3m/6m/1y returns, annualized volatility, max drawdown, SMA 20/50/200 with price-above flags, RSI 14, 52-week high/low distance, 30-day average volume.",
};

function paymentRequired(env, url, route, error) {
  return {
    x402Version: 2,
    error,
    resource: { url: `${url.origin}${route}`, description: `${SERVICE} ${ROUTES[route].name}: ${ROUTE_DESCRIPTIONS[route]}`, mimeType: "application/json" },
    accepts: [requirements(env, route)],
    extensions: {
      bazaar: {
        info: {
          input: { type: "http", method: "GET", queryParams: EXAMPLES[route].input },
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
                method: { type: "string", enum: ["GET", "HEAD", "DELETE"] },
                queryParams: { type: "object", properties: QUERY_PROPS[route], required: REQUIRED_QUERY[route] },
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
function send402(env, url, route, error) {
  const pr = paymentRequired(env, url, route, error);
  return json(pr, 402, { "PAYMENT-REQUIRED": b64e(pr) });
}

function openapi(origin) {
  const nullable = (t, extra = {}) => ({ type: [t, "null"], ...extra });
  const symbolParam = { type: "string", pattern: "^[A-Za-z0-9.^=-]{1,12}$", description: `${SYMBOL_DESC} (case-insensitive)` };
  const quoteProps = {
    symbol: { type: "string" }, name: { type: "string", description: "Long name, falling back to short name" }, shortName: nullable("string"),
    price: { type: "number", description: "Latest regular-session price" }, change: nullable("number", { description: "price - previousClose" }), changePercent: nullable("number", { description: "Percent change vs previous close" }),
    previousClose: nullable("number"), dayHigh: nullable("number"), dayLow: nullable("number"), volume: nullable("number"),
    fiftyTwoWeekHigh: nullable("number"), fiftyTwoWeekLow: nullable("number"),
    currency: nullable("string", { description: "ISO 4217 code, e.g. USD" }), exchange: nullable("string", { description: "Exchange code, e.g. NMS, NYQ, CCC" }), exchangeName: nullable("string"),
    instrumentType: nullable("string", { description: "EQUITY, ETF, INDEX, CRYPTOCURRENCY, CURRENCY, FUTURE, MUTUALFUND" }), marketState: nullable("string", { description: "PRE, REGULAR, POST, CLOSED" }),
    asOf: nullable("string", { format: "date-time", description: "Time of the latest price (UTC)" }),
  };
  const quoteRequired = ["symbol", "name", "price", "change", "changePercent", "previousClose", "currency", "exchange", "marketState", "asOf"];
  const common = { source: { type: "string" }, notice: { type: "string", description: "Informational-use notice; not investment advice" }, fetched_at: { type: "string", format: "date-time" } };
  const candle = { type: "object", properties: { t: { type: "string", format: "date-time", description: "Bar start (UTC)" }, o: { type: "number" }, h: { type: "number" }, l: { type: "number" }, c: { type: "number" }, v: nullable("number"), adj: { type: "number", description: "Adjusted close (equals c when Yahoo gives no adjustment)" } }, required: ["t", "o", "h", "l", "c", "v", "adj"] };
  const smaEntry = { type: "object", properties: { value: nullable("number"), priceAbove: nullable("boolean") }, required: ["value", "priceAbove"] };
  const params = {
    "/quote": { type: "object", properties: { symbol: symbolParam }, required: ["symbol"] },
    "/quotes": { type: "object", properties: { symbols: { oneOf: [{ type: "string" }, { type: "array", items: symbolParam, minItems: 1, maxItems: MAX_SYMBOLS }], description: `1-${MAX_SYMBOLS} symbols as a comma-separated string or a JSON array` } }, required: ["symbols"] },
    "/history": {
      type: "object",
      properties: {
        symbol: symbolParam,
        range: { type: "string", enum: RANGES, default: DEFAULT_RANGE, description: "How far back to go" },
        interval: { type: "string", enum: INTERVALS, default: DEFAULT_INTERVAL, description: `Bar size. 1m only with range ${MINUTE_RANGES.join("/")}; 5m/15m/1h only with range ${INTRADAY_RANGES.join("/")}` },
      },
      required: ["symbol"],
    },
    "/stats": { type: "object", properties: { symbol: symbolParam }, required: ["symbol"] },
  };
  const outputs = {
    "/quote": { type: "object", properties: { ...quoteProps, ...common }, required: [...quoteRequired, "source", "notice", "fetched_at"] },
    "/quotes": {
      type: "object",
      properties: {
        count: { type: "integer" }, found: { type: "integer", description: "How many symbols returned a quote" },
        results: { type: "array", items: { type: "object", properties: { ...quoteProps, ok: { type: "boolean" }, error: { type: "string", description: "Present when ok is false: not found | unavailable" } }, required: ["symbol", "ok"] }, description: "Same order as requested" },
        ...common,
      },
      required: ["count", "found", "results", "source", "notice", "fetched_at"],
    },
    "/history": {
      type: "object",
      properties: {
        symbol: { type: "string" }, range: { type: "string" }, interval: { type: "string" }, currency: nullable("string"), exchange: nullable("string"), name: { type: "string" }, timezone: nullable("string", { description: "Exchange IANA time zone" }),
        count: { type: "integer" }, candles: { type: "array", items: candle, description: "Oldest first; bars with missing OHLC are dropped" },
        dividends: { type: "array", items: { type: "object", properties: { date: { type: "string", format: "date-time" }, amount: { type: "number" } }, required: ["date", "amount"] } },
        splits: { type: "array", items: { type: "object", properties: { date: { type: "string", format: "date-time" }, numerator: nullable("number"), denominator: nullable("number"), ratio: nullable("string", { description: "e.g. 4:1" }) }, required: ["date"] } },
        summary: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, bars: { type: "integer" }, first: { type: "number", description: "First close" }, last: { type: "number", description: "Last close" }, changePercent: nullable("number"), high: { type: "number" }, low: { type: "number" }, avgVolume: nullable("number") }, required: ["from", "to", "bars", "first", "last", "changePercent", "high", "low", "avgVolume"] },
        meta: { type: "object", properties: quoteProps, description: "Latest quote fields for the symbol" },
        ...common,
      },
      required: ["symbol", "range", "interval", "count", "candles", "dividends", "splits", "summary", "meta", "source", "notice", "fetched_at"],
    },
    "/stats": {
      type: "object",
      properties: {
        symbol: { type: "string" }, name: { type: "string" }, currency: nullable("string"), exchange: nullable("string"),
        price: { type: "number", description: "Latest price used for the price-above-SMA flags and 52-week distances" }, asOf: nullable("string", { format: "date-time" }),
        lastClose: { type: "number" }, lastCloseDate: { type: "string", format: "date-time" }, bars: { type: "integer", description: "Daily bars used" }, from: { type: "string", format: "date-time" },
        returns: { type: "object", properties: Object.fromEntries(Object.keys(RETURN_WINDOWS).map((k) => [k, nullable("number")])), required: Object.keys(RETURN_WINDOWS), description: "Percent change of the close over each calendar window; null when the history does not reach back far enough" },
        volatilityAnnualizedPct: nullable("number", { description: "Sample standard deviation of daily log returns x sqrt(252), in percent" }),
        maxDrawdownPct: nullable("number", { description: "Largest peak-to-trough decline of the close over the period, in percent (negative or 0)" }),
        sma: { type: "object", properties: { sma20: smaEntry, sma50: smaEntry, sma200: smaEntry }, required: ["sma20", "sma50", "sma200"], description: "Simple moving averages of the close; value is null when there are fewer bars than the period" },
        rsi14: nullable("number", { description: "Wilder RSI over 14 daily bars, 0-100" }),
        fiftyTwoWeek: { type: "object", properties: { high: nullable("number"), low: nullable("number"), distanceFromHighPct: nullable("number", { description: "(price / high - 1) x 100, 0 or negative" }), distanceFromLowPct: nullable("number", { description: "(price / low - 1) x 100" }) }, required: ["high", "low", "distanceFromHighPct", "distanceFromLowPct"] },
        avgVolume30d: nullable("number"),
        ...common,
      },
      required: ["symbol", "name", "price", "lastClose", "lastCloseDate", "bars", "returns", "volatilityAnnualizedPct", "maxDrawdownPct", "sma", "rsi14", "fiftyTwoWeek", "avgVolume30d", "source", "notice", "fetched_at"],
    },
  };
  const summaries = {
    "/quote": "Latest quote for one stock, ETF, index, crypto, FX pair or commodity future",
    "/quotes": `Latest quotes for up to ${MAX_SYMBOLS} symbols in one call`,
    "/history": "OHLCV candles with adjusted close, dividends, splits and a summary for a range and interval",
    "/stats": "Computed statistics from one year of daily bars: returns, volatility, drawdown, SMA 20/50/200, RSI 14, 52-week distance",
  };
  const notFound = { "/quote": "Symbol not found or no price data (no charge)", "/quotes": "None of the symbols were found (no charge)", "/history": "Symbol not found or no bars for that range/interval (no charge)", "/stats": "Symbol not found or not enough daily history (no charge)" };
  const op = (route, method) => ({
    operationId: ROUTES[route].name + (method === "post" ? "Post" : ""),
    summary: summaries[route],
    tags: ["Finance", "Stocks", "Market Data", ROUTES[route].name],
    "x-payment-info": { price: { mode: "fixed", currency: "USD", amount: ROUTES[route].usd }, protocols: [{ x402: {} }] },
    ...(method === "post"
      ? { requestBody: { required: true, content: { "application/json": { schema: params[route] } } } }
      : { parameters: Object.entries(params[route].properties).map(([n, sch]) => ({ name: n, in: "query", required: (params[route].required || []).includes(n), schema: { type: "string" }, description: sch.description })) }),
    responses: {
      200: { description: "Result", content: { "application/json": { schema: outputs[route] } } },
      400: { description: "Missing or invalid parameters (no charge)" },
      402: { description: "Payment Required" },
      404: { description: notFound[route] },
      413: { description: "Request body too large (no charge)" },
      502: { description: `Data source unreachable, timed out (${TIMEOUT_MS / 1000} s per attempt) or returned an error (no charge)` },
    },
  });
  return {
    openapi: "3.1.0",
    info: {
      title: SERVICE,
      version: "1.0.0",
      description: DESCRIPTION,
      "x-guidance": `Market data for AI agents, paid per call in USDC on Base via x402; you are only charged when a result is returned (400/404/413/502 are free). GET with query parameters or POST a JSON body. Symbols are Yahoo Finance style, ${SYMBOL_HELP}. /quote {symbol} ($0.001) -> price, change, changePercent, previousClose, dayHigh, dayLow, volume, fiftyTwoWeekHigh/Low, currency, exchange, name, marketState, asOf. /quotes {symbols: comma list or array, 1-${MAX_SYMBOLS}} ($0.003) -> the same fields per symbol in results[], unknown symbols as {ok: false, error: "not found"}. /history {symbol, range?: ${RANGES.join("|")} (default ${DEFAULT_RANGE}), interval?: ${INTERVALS.join("|")} (default ${DEFAULT_INTERVAL})} ($0.002) -> candles [{t, o, h, l, c, v, adj}] oldest first plus dividends, splits and summary {first, last, changePercent, high, low, avgVolume}; 1m bars only for range 1d/5d, other intraday bars only up to 1mo. /stats {symbol} ($0.002) -> from one year of daily bars: returns {1w, 1m, 3m, 6m, 1y} in percent, volatilityAnnualizedPct (stdev of daily log returns x sqrt(252)), maxDrawdownPct, sma {sma20, sma50, sma200: {value, priceAbove}}, rsi14, fiftyTwoWeek {high, low, distanceFromHighPct, distanceFromLowPct}, avgVolume30d. Data comes from Yahoo Finance's public chart endpoint; exchange quotes may be delayed. Every response carries a notice field: informational use only, not investment advice. Best for: checking a price before acting, pulling candles for your own analysis, quick technical screens (RSI, moving averages, drawdown, volatility) without an API key.`,
    },
    servers: [{ url: origin }],
    paths: Object.fromEntries(Object.keys(ROUTES).map((r) => [r, { get: op(r, "get"), post: op(r, "post") }])),
  };
}

// Free operator probe: one quote fetch (cache bypassed), reports only status, price and timing.
async function healthData(ctx) {
  const t0 = Date.now();
  const g = await getQuote(HEALTH_SYMBOL, ctx, true);
  const okUp = g.status === 200;
  return json({ status: okUp ? "ok" : "down", upstream: SOURCE, symbol: HEALTH_SYMBOL, price: okUp ? g.quote.price : null, asOf: okUp ? g.quote.asOf : null, ms: Date.now() - t0 }, okUp ? 200 : 503);
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
        health: `${url.origin}/health/data`,
        price: Object.fromEntries(Object.keys(ROUTES).map((r) => [r, `${ROUTES[r].label} USDC on Base per successful request (x402)`])),
        endpoints: Object.fromEntries(Object.keys(ROUTES).map((r) => [r, { methods: ["GET", "POST"], url: `${url.origin}${r}`, price_usd: ROUTES[r].usd, example: `${url.origin}${r}?${new URLSearchParams(EXAMPLES[r].input)}`, description: ROUTE_DESCRIPTIONS[r] }])),
        params: {
          "/quote": { symbol: `required, ${SYMBOL_HELP}` },
          "/quotes": { symbols: `required, comma list or JSON array, 1-${MAX_SYMBOLS} symbols` },
          "/history": { symbol: "required", range: `${RANGES.join("|")}, default ${DEFAULT_RANGE}`, interval: `${INTERVALS.join("|")}, default ${DEFAULT_INTERVAL}; 1m only for 1d/5d, other intraday only up to 1mo` },
          "/stats": { symbol: "required" },
        },
        source: SOURCE,
        notice: NOTICE,
        limits: { timeout_seconds: TIMEOUT_MS / 1000, max_symbols: MAX_SYMBOLS, max_request_bytes: MAX_REQUEST_BYTES, cache_seconds: { "1m": CACHE_TTL_1M_S, intraday: CACHE_TTL_INTRADAY_S, daily_and_longer: CACHE_TTL_DAILY_S } },
        no_charge_on: ["400 invalid input", "404 symbol not found / no data", "413 request too large", "502 data source unavailable"],
        configured: Boolean(env.PAY_TO),
        facilitator: env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET ? "cdp" : "payai",
      });
    }
    if (url.pathname === "/openapi.json" || url.pathname === "/.well-known/openapi.json") return json(openapi(url.origin));
    if (url.pathname === "/health/data") {
      if (request.method !== "GET") return json({ error: "Use GET" }, 405);
      return healthData(ctx);
    }
    const route = url.pathname.replace(/\/+$/, "") || url.pathname;
    if (!ROUTES[route]) return json({ error: `Not found. Use ${Object.keys(ROUTES).join(", ")}` }, 404);
    if (!env.PAY_TO || !/^0x[0-9a-fA-F]{40}$/.test(env.PAY_TO)) return json({ error: "Service not configured: PAY_TO wallet address missing" }, 500);
    if (request.method !== "GET" && request.method !== "POST") return json({ error: "Use GET or POST" }, 405);
    const len = Number(request.headers.get("content-length"));
    if (Number.isFinite(len) && len > MAX_REQUEST_BYTES) return json({ error: `Request body too large (max ${MAX_REQUEST_BYTES} bytes) (no payment was taken)` }, 413);

    const header = request.headers.get("PAYMENT-SIGNATURE") || request.headers.get("X-PAYMENT");
    if (!header) return send402(env, url, route, "PAYMENT-SIGNATURE header is required");
    const rp = await readParams(request, url);
    if (rp.error) return json(fail(rp.error), rp.status || 400);
    const q = VALIDATORS[ROUTES[route].name](rp.params);
    if (q.error) return json(q, 400);

    let payload;
    try { payload = b64d(header); } catch { return json({ error: "Invalid payment payload" }, 400); }
    const reqs = requirements(env, route);
    if (payload.x402Version !== 2 || !deepEqual(payload.accepted, reqs) || !resourceMatches(payload, route)) return send402(env, url, route, "No matching payment requirements found");

    const fac = facilitator(env);
    const body = { x402Version: 2, paymentPayload: payload, paymentRequirements: reqs };
    let v;
    try { v = await fac.call("verify", body); } catch (e) { return json({ error: "Facilitator unreachable", detail: String(e) }, 500); }
    if (!v.ok || !v.data.isValid) return send402(env, url, route, v.data.invalidReason || v.data.error || `verify failed (${v.status})`);

    let result;
    try { result = await HANDLERS[ROUTES[route].name](q, ctx); } catch { return json({ error: "Data source temporarily unavailable, no payment taken" }, 502); }
    if (result.status !== 200) return json(result.body, result.status);

    let s;
    try { s = await fac.call("settle", body); } catch (e) { return json({ error: "Facilitator unreachable", detail: String(e) }, 500); }
    if (!s.ok || !s.data.success) {
      const failure = { success: false, errorReason: s.data.errorReason || s.data.error || `settle failed (${s.status})`, transaction: "", network: NETWORK, payer: s.data.payer || v.data.payer };
      return json({}, 402, { "PAYMENT-RESPONSE": b64e(failure) });
    }
    const receipt = { success: true, transaction: s.data.transaction, network: s.data.network || NETWORK, payer: s.data.payer || v.data.payer };
    return json(result.body, 200, { "PAYMENT-RESPONSE": b64e(receipt) });
  },
};
