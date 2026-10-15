// Usage: node test/test.mjs ./worker.js /path/bazaar-out.json
import { generateKeyPairSync, verify as nverify } from "node:crypto";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const W = (await import(pathToFileURL(resolve(process.argv[2])).href)).default;
const PAY = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const dec = (h) => JSON.parse(Buffer.from(h, "base64").toString());

// ---- fixtures: DuckDuckGo lite markup (table rows; redirector hrefs; one sponsored row; mixed quotes) ----
const rd = (target, n) => `//duckduckgo.com/l/?uddg=${encodeURIComponent(target)}&amp;rut=${"abc".repeat(3)}${n}`;
const row = (n, href, title, snippet, display, extra = "") => `
<tr>
  <td valign="top">${n}.&nbsp;</td>
  <td><a rel="nofollow" href="${href}" class='result-link'${extra}>${title}</a></td>
</tr>
<tr>
  <td>&nbsp;&nbsp;&nbsp;</td>
  <td class='result-snippet'>${snippet}</td>
</tr>
<tr>
  <td>&nbsp;&nbsp;&nbsp;</td>
  <td><span class='link-text'>${display}</span></td>
</tr>
<tr><td>&nbsp;</td></tr>`;
const DDG_HTML = `<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">
<html>
<head>
<meta http-equiv="content-type" content="text/html; charset=utf-8">
<title>cloudflare workers at DuckDuckGo</title>
<link title="DuckDuckGo (Lite)" type="application/opensearchdescription+xml" rel="search" href="//duckduckgo.com/opensearch_lite.xml">
<link rel="stylesheet" href="//duckduckgo.com/l126.css" type="text/css">
</head>
<body>
<form action="/lite/" method="post">
<table border="0" cellpadding="0" cellspacing="0" width="100%">
<tr><td><a href="/lite/"><img src="//duckduckgo.com/assets/logo_homepage.normal.v108.svg" alt="DuckDuckGo" width="90" height="56" border="0"></a></td>
<td><input class="query" type="text" name="q" value="cloudflare workers" autocomplete="off"><input class="submit" type="submit" value="Search"></td></tr>
</table>
<input type="hidden" name="kl" value="us-en">
</form>
<table border="0">
<tr>
  <td valign="top">&nbsp;</td>
  <td><a rel="nofollow" href="//duckduckgo.com/y.js?ad_domain=cloudflare.com&amp;ad_provider=bingv7aa&amp;u3=https%3A%2F%2Fwww.bing.com%2Faclick%3Fld%3Dxyz" class="result-link result-sponsored"><b>Cloudflare</b> Workers - Official Site</a></td>
</tr>
<tr>
  <td>&nbsp;&nbsp;&nbsp;</td>
  <td class="result-snippet">Ad · Deploy serverless code instantly across the globe. Get started free today!</td>
</tr>
<tr>
  <td>&nbsp;&nbsp;&nbsp;</td>
  <td><span class="link-text">www.cloudflare.com</span></td>
</tr>
<tr><td>&nbsp;</td></tr>
${row(1, rd("https://workers.cloudflare.com/", 1), "Cloudflare Workers&reg; | Build &amp; deploy <b>serverless</b> code", "Build serverless applications and deploy instantly across the globe for exceptional performance,\n  reliability, and <b>scale</b>. &quot;Code that runs everywhere.&quot;", "workers.cloudflare.com")}
${row(2, rd("https://developers.cloudflare.com/workers/", 2), "Overview &middot; <b>Cloudflare</b> <b>Workers</b> docs", "A serverless platform for building, deploying, and scaling apps across Cloudflare&#39;s global network &#8212; with a single command.", "developers.cloudflare.com/workers")}
${row(3, "https://en.wikipedia.org/wiki/Cloudflare#Workers", "Cloudflare - Wikipedia", "Cloudflare, Inc. is an American company that provides content delivery network services &amp; more. Workers, a &#x201C;serverless&#x201D; platform, launched in 2017.", "en.wikipedia.org/wiki/Cloudflare")}
${row(4, rd("https://github.com/cloudflare/workers-sdk", 4), "GitHub - cloudflare/workers-sdk: &#9889; Wrangler", "&#9889; The Cloudflare Developer Platform SDK: Wrangler CLI, Miniflare and more.", "github.com/cloudflare/workers-sdk")}
${row(5, rd("https://www.youtube.com/watch?v=H7Qe96fqg1M&t=10s", 5), "<i>Cloudflare Workers</i> Tutorial for Beginners", "Learn Cloudflare Workers in 20 minutes: KV, Durable Objects, and deploying with wrangler.", "www.youtube.com/watch?v=H7Qe96fqg1M")}
${row(6, rd("https://blog.cloudflare.com/introducing-cloudflare-workers/", 6), "Introducing Cloudflare Workers: Run JavaScript Service Workers at the Edge", "", "blog.cloudflare.com/introducing-cloudflare-workers")}
${row(7, "//duckduckgo.com/l/?uddg=https%3A%2F%2Fnews.ycombinator.com%2Fitem%3Fid%3D15271755&amp;rut=zzz", "Cloudflare Workers | Hacker News", "Discussion thread   with    lots of     whitespace.", "news.ycombinator.com/item?id=15271755")}
${row(8, rd("https://developers.cloudflare.com/workers/platform/pricing/", 8), "Pricing &#124; Cloudflare Workers docs", "Workers Free: 100,000 requests/day. Workers Paid: $5 / month includes 10 million requests.", "developers.cloudflare.com/workers/platform/pricing")}
${row(9, rd("https://workers.cloudflare.com/", 9), "Duplicate of result 1 (same url)", "Dedupe me.", "workers.cloudflare.com")}
${row(10, rd("https://www.npmjs.com/package/wrangler", 10), "wrangler - npm", "Command-line interface for all things Cloudflare Workers.", "www.npmjs.com/package/wrangler")}
${row(11, rd("https://stackoverflow.com/questions/tagged/cloudflare-workers", 11), "Newest 'cloudflare-workers' Questions - Stack Overflow", "Q&amp;A for Cloudflare Workers developers.", "stackoverflow.com/questions/tagged/cloudflare-workers")}
<tr>
  <td>&nbsp;</td>
  <td class="next_form"><form action="/lite/" method="post"><input type="submit" class='navbutton' value="Next Page &gt;"><input type="hidden" name="q" value="cloudflare workers"><input type="hidden" name="s" value="23"></form></td>
</tr>
</table>
<div class="feedback-btn"><a rel="nofollow" href="//duckduckgo.com/feedback.html">Feedback</a></div>
</body>
</html>`;
const NO_RESULTS_HTML = `<html><head><title>zzqqxxyy at DuckDuckGo</title></head><body><form action="/lite/" method="post"><table><tr><td><input class="query" type="text" name="q" value="zzqqxxyy"></td></tr></table></form><table border="0"><tr><td class="result-snippet">No results.</td></tr></table></body></html>`;
const ANOMALY_HTML = `<html><head><title>DuckDuckGo</title></head><body><div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div><p>Please complete the following challenge to confirm this search was made by a human.</p><form action="/lite/" method="post"><input type="hidden" name="q" value="cloudflare workers"></form></body></html>`;

// ---- cache mock (Cloudflare caches.default) ----
const cacheMap = new Map(); let cachePuts = 0, cacheHits = 0;
const keyOf = (k) => (typeof k === "string" ? k : k.url);
globalThis.caches = { default: {
  async match(k) { const v = cacheMap.get(keyOf(k)); if (v) { cacheHits++; return new Response(v, { status: 200, headers: { "Content-Type": "text/html" } }); } return undefined; },
  async put(k, res) { cachePuts++; cacheMap.set(keyOf(k), await res.text()); },
} };

// ---- fetch mock ----
let calls = [], mode = "good", upstream = [];
const html = (body, status = 200) => new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
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
  if (!u.startsWith("https://lite.duckduckgo.com/lite/?")) return new Response("Not Found", { status: 404 });
  const q = new URL(u).searchParams.get("q");
  if (q === "boom") return html("<html><body>Internal Server Error</body></html>", 500);
  if (q === "ratelimited") return html("<html><body>Too Many Requests</body></html>", 429);
  if (q === "neterr") throw new TypeError("fetch failed");
  if (q === "hang") return new Promise((_, rej) => { init.signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))); });
  if (q === "anomaly") return html(ANOMALY_HTML);
  if (q === "zzqqxxyy") return html(NO_RESULTS_HTML);
  if (q === "blank") return html("");
  return html(DDG_HTML);
};

const env = { PAY_TO: PAY };
const base = "https://search.example.workers.dev";
const ctx = { waitUntil(p) { ctx.pending.push(p); }, pending: [] };
const flush = async () => { await Promise.all(ctx.pending); ctx.pending = []; };

// ---- unpaid ----
let r = await W.fetch(new Request(base + "/"), env, ctx); let j = await r.json();
ok(r.status === 200 && j.service === "NoJunk Web Search" && j.facilitator === "payai" && j.price.includes("$0.002") && j.endpoint.includes("/search?q=") && j.health.endsWith("/health/search"), "info page");
r = await W.fetch(new Request(base + "/search?q=test"), {}, ctx); ok(r.status === 402 && dec(r.headers.get("PAYMENT-REQUIRED")).accepts[0].payTo === "0x6f762720b8515b7091e6aa69e8361f7b9909233f", "default wallet used");
upstream = []; calls = [];
r = await W.fetch(new Request(base + "/search"), env, ctx); ok(r.status === 402 && upstream.length === 0, "missing q unpaid -> 402 first");
r = await W.fetch(new Request(base + "/search?q=&count=99"), env, ctx); ok(r.status === 402, "bad input unpaid -> 402 first");
r = await W.fetch(new Request(base + "/search?q=cloudflare+workers"), env, ctx);
ok(r.status === 402 && upstream.length === 0 && calls.length === 0, "unpaid -> 402, nothing fetched");
const pr = dec(r.headers.get("PAYMENT-REQUIRED"));
const a0 = pr.accepts[0];
ok(pr.x402Version === 2 && pr.accepts.length === 1 && a0.scheme === "exact" && a0.amount === "2000" && a0.payTo === PAY && a0.network === "eip155:8453" && a0.asset === "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" && a0.extra.name === "USD Coin" && a0.extra.version === "2" && a0.maxTimeoutSeconds === 300, "402 requirements correct (2000, payTo, asset, network)");
ok(pr.resource.url === base + "/search" && pr.resource.mimeType === "application/json" && pr.resource.description === j.description, "resource url + description");
ok(pr.extensions.bazaar.info.input.type === "http" && pr.extensions.bazaar.info.input.queryParams.q && pr.extensions.bazaar.schema.properties.input.required.includes("method") && pr.extensions.bazaar.info.output.example.results.length > 0 && pr.extensions.bazaar.info.output.example.source === "DuckDuckGo", "bazaar ext present");
ok(JSON.stringify(pr) === Buffer.from(r.headers.get("PAYMENT-REQUIRED"), "base64").toString() && (await r.json()).x402Version === 2, "402 body equals header payload");
writeFileSync(process.argv[3], JSON.stringify(pr.extensions.bazaar));
const payload = { x402Version: 2, resource: pr.resource, accepted: pr.accepts[0], payload: { signature: "0x00", authorization: {} }, extensions: pr.extensions };
const hdr = Buffer.from(JSON.stringify(payload)).toString("base64");
const paid = (qs, extra = {}) => W.fetch(new Request(base + "/search" + qs, { ...extra, headers: { "PAYMENT-SIGNATURE": hdr, ...(extra.headers || {}) } }), env, ctx);
const paidQ = (q, more = "", extra) => paid("?q=" + encodeURIComponent(q) + more, extra);
const paidPost = (body, extra = {}) => paid("", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), ...extra });

// ---- bad input with payment -> 400, zero facilitator + zero upstream calls ----
const BAD = [
  ["?q=", "empty q"],
  ["?q=%20%20%20", "whitespace-only q"],
  ["?count=5", "missing q"],
  ["?q=" + "a".repeat(401), "q 401 chars"],
  ["?q=test&count=0", "count 0"],
  ["?q=test&count=11", "count 11"],
  ["?q=test&count=-1", "count -1"],
  ["?q=test&count=abc", "count non-numeric"],
  ["?q=test&count=2.5", "count fractional"],
  ["?q=test&region=usa", "region malformed"],
  ["?q=test&region=us-en;drop", "region with junk"],
  ["?q=test&safe=very", "safe unknown"],
];
for (const [qs, label] of BAD) {
  calls = []; upstream = [];
  r = await paid(qs); j = await r.json();
  ok(r.status === 400 && calls.length === 0 && upstream.length === 0 && /no payment was taken/.test(j.error), `paid + ${label} -> 400, no facilitator/upstream call`);
}
calls = []; upstream = [];
r = await paidPost({ q: "", count: 3 }); ok(r.status === 400 && calls.length === 0 && upstream.length === 0, "POST empty q -> 400, no calls");
r = await paidPost({ q: "x", count: 11 }); ok(r.status === 400 && calls.length === 0 && upstream.length === 0, "POST count 11 -> 400, no calls");
r = await paidPost({ q: "x", count: 0 }); ok(r.status === 400 && calls.length === 0 && upstream.length === 0, "POST count 0 -> 400, no calls");
r = await paidPost({ q: "a".repeat(401) }); ok(r.status === 400 && calls.length === 0 && upstream.length === 0, "POST q 401 chars -> 400, no calls");
r = await paid("", { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "100000" }, body: "{}" });
ok(r.status === 413 && calls.length === 0 && upstream.length === 0, "oversized POST body -> 413 before payment work");
r = await paidQ("test", "", { method: "PUT" }); ok(r.status === 405, "PUT -> 405");
r = await paid("?q=" + "a".repeat(400)); ok(r.status === 200, "q of exactly 400 chars accepted");

// ---- happy path: realistic DDG lite page ----
cacheMap.clear(); cachePuts = 0; cacheHits = 0; calls = []; upstream = [];
r = await paidQ("cloudflare workers"); j = await r.json(); await flush();
ok(r.status === 200, "paid -> 200");
ok(dec(r.headers.get("PAYMENT-RESPONSE")).transaction === "0xdeadbeef" && dec(r.headers.get("PAYMENT-RESPONSE")).success === true && dec(r.headers.get("PAYMENT-RESPONSE")).payer === "0xabc", "PAYMENT-RESPONSE receipt");
ok(calls.length === 2 && calls[0].u === "https://facilitator.payai.network/verify" && calls[1].u.endsWith("/settle"), "verify then settle via payai");
ok(upstream.length === 1 && upstream[0].u === "https://lite.duckduckgo.com/lite/?q=cloudflare+workers&kp=-1", "one upstream fetch of DDG lite with q and kp=-1 (moderate), no kl: " + (upstream[0] && upstream[0].u));
const h = upstream[0].init.headers;
ok(h["user-agent"] === "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36" && h.accept === "text/html" && h["accept-language"] === "en-US,en;q=0.9" && upstream[0].init.signal, "upstream browser UA, accept, accept-language, abort signal");
const sent = JSON.parse(calls[0].init.body); ok(sent.x402Version === 2 && sent.paymentRequirements.payTo === PAY && sent.paymentPayload.accepted.amount === "2000", "facilitator body shape");
ok(Object.keys(j).join() === "query,region,safe,count,results,source,fetched_at", "output key order/complete");
ok(j.query === "cloudflare workers" && j.region === null && j.safe === "moderate" && j.source === "DuckDuckGo", "query/region/safe/source fields");
ok(j.count === 10 && j.results.length === 10, "default count 10 -> 10 results (11 organic rows minus 1 duplicate = 10)");
ok(j.results.map((x) => x.rank).join() === "1,2,3,4,5,6,7,8,9,10", "rank sequence 1..10");
ok(j.results.every((x) => Object.keys(x).join() === "rank,title,url,domain,snippet"), "result key shape");
ok(!j.results.some((x) => /Official Site/.test(x.title) || /bing\.com|y\.js|duckduckgo\.com/.test(x.url) || /^Ad /.test(x.snippet)), "sponsored row skipped");
ok(j.results[0].title === "Cloudflare Workers® | Build & deploy serverless code", "title: entities decoded, nested <b> stripped: " + j.results[0].title);
ok(j.results[0].url === "https://workers.cloudflare.com/" && j.results[0].domain === "workers.cloudflare.com", "uddg redirect decoded to real url + domain");
ok(j.results[0].snippet === 'Build serverless applications and deploy instantly across the globe for exceptional performance, reliability, and scale. "Code that runs everywhere."', "snippet: whitespace collapsed, nested tags stripped, entities decoded: " + j.results[0].snippet);
ok(j.results[1].title === "Overview · Cloudflare Workers docs" && j.results[1].snippet.includes("Cloudflare's global network — with a single command."), "numeric entities (&#39; &#8212;) decoded");
ok(j.results[2].url === "https://en.wikipedia.org/wiki/Cloudflare#Workers" && j.results[2].domain === "en.wikipedia.org" && j.results[2].snippet.includes("a “serverless” platform"), "direct https href kept (with fragment), hex entities decoded");
ok(j.results[3].title === "GitHub - cloudflare/workers-sdk: ⚡ Wrangler" && j.results[3].domain === "github.com", "astral/symbol entity decoded");
ok(j.results[4].url === "https://www.youtube.com/watch?v=H7Qe96fqg1M&t=10s" && j.results[4].domain === "youtube.com" && j.results[4].title === "Cloudflare Workers Tutorial for Beginners", "query string preserved through uddg, www. stripped from domain, <i> stripped");
ok(j.results[5].snippet === "" && j.results[5].domain === "blog.cloudflare.com", "empty snippet -> empty string");
ok(j.results[6].url === "https://news.ycombinator.com/item?id=15271755" && j.results[6].snippet === "Discussion thread with lots of whitespace.", "double-quoted redirector + whitespace collapse");
ok(j.results[7].title === "Pricing | Cloudflare Workers docs" && j.results[7].url === "https://developers.cloudflare.com/workers/platform/pricing/", "decimal entity &#124; decoded");
ok(j.results[8].url === "https://www.npmjs.com/package/wrangler" && j.results[8].domain === "npmjs.com" && !j.results.some((x) => /Duplicate/.test(x.title)), "duplicate url removed, later results shift up");
ok(j.results[9].title === "Newest 'cloudflare-workers' Questions - Stack Overflow" && j.results[9].snippet === "Q&A for Cloudflare Workers developers.", "last result present, &amp; decoded");
ok(j.results.every((x) => /^https:\/\//.test(x.url) && x.title && x.domain && !/[<>]/.test(x.title + x.snippet) && !/&(amp|lt|gt|quot|#\d+);/.test(x.title + x.snippet)), "all results: absolute https urls, no tags, no raw entities");
ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(j.fetched_at) && Math.abs(Date.now() - Date.parse(j.fetched_at)) < 5000, "fetched_at is current ISO timestamp");
ok(cachePuts === 1 && cacheMap.has("https://lite.duckduckgo.com/lite/?q=cloudflare+workers&kp=-1") && cacheHits === 0, "upstream HTML stored in caches.default keyed by DDG URL");

// cache hit: same query again -> no upstream fetch, still verify+settle
calls = []; upstream = [];
r = await paidQ("cloudflare workers"); j = await r.json(); await flush();
ok(r.status === 200 && upstream.length === 0 && cacheHits === 1 && cachePuts === 1 && calls.length === 2 && j.results.length === 10 && j.results[0].url === "https://workers.cloudflare.com/", "cache hit: no upstream fetch, served from cache, still settled");
// different count with same query is still a cache hit (count applied after parsing)
calls = []; upstream = [];
r = await paidQ("cloudflare workers", "&count=3"); j = await r.json();
ok(r.status === 200 && upstream.length === 0 && cacheHits === 2 && j.count === 3 && j.results.length === 3 && j.results.map((x) => x.rank).join() === "1,2,3" && j.results[2].domain === "en.wikipedia.org", "count=3 respected (sliced after parse), cache key independent of count");
r = await paidQ("cloudflare workers", "&count=1"); j = await r.json();
ok(r.status === 200 && j.count === 1 && j.results.length === 1 && j.results[0].rank === 1, "count=1");
// region / safe change the upstream URL (and the cache key)
calls = []; upstream = [];
r = await paidQ("cloudflare workers", "&region=uk-en&safe=strict"); j = await r.json(); await flush();
ok(r.status === 200 && upstream.length === 1 && upstream[0].u === "https://lite.duckduckgo.com/lite/?q=cloudflare+workers&kl=uk-en&kp=1" && j.region === "uk-en" && j.safe === "strict", "region + safe=strict -> kl=uk-en&kp=1 in upstream URL: " + (upstream[0] && upstream[0].u));
upstream = [];
r = await paidQ("cloudflare workers", "&safe=off"); j = await r.json(); await flush();
ok(r.status === 200 && upstream.length === 1 && upstream[0].u.endsWith("&kp=-2") && j.safe === "off", "safe=off -> kp=-2");
upstream = [];
r = await paidQ("cloudflare workers", "&region=US-EN&safe=Moderate"); j = await r.json(); await flush();
ok(r.status === 200 && upstream[0].u === "https://lite.duckduckgo.com/lite/?q=cloudflare+workers&kl=us-en&kp=-1" && j.region === "us-en" && j.safe === "moderate", "region/safe case-normalized");
upstream = [];
r = await paidQ("cloudflare workers", "&region=wt-wt"); ok(r.status === 200 && upstream[0].u.includes("kl=wt-wt"), "wt-wt region accepted");
// POST
upstream = []; calls = [];
r = await paidPost({ q: "  cloudflare   workers ", count: 2, region: "de-de", safe: "off" }); j = await r.json(); await flush();
ok(r.status === 200 && j.query === "cloudflare workers" && j.count === 2 && j.results.length === 2 && j.region === "de-de" && j.safe === "off" && upstream.length === 1 && upstream[0].u === "https://lite.duckduckgo.com/lite/?q=cloudflare+workers&kl=de-de&kp=-2" && calls.length === 2, "paid POST: whitespace-normalized q, numeric count, region/safe in URL");
r = await paidPost({ q: "cloudflare workers", count: "4" }); j = await r.json();
ok(r.status === 200 && j.count === 4, "POST count as string accepted");
// query with special characters is encoded
upstream = [];
r = await paidQ('site:example.com "hello world" & more?'); j = await r.json(); await flush();
ok(r.status === 200 && new URL(upstream[0].u).searchParams.get("q") === 'site:example.com "hello world" & more?' && j.query === 'site:example.com "hello world" & more?', "special characters round-trip through upstream URL encoding");

// ---- upstream failures: no settle, no charge ----
for (const [q, label, re] of [["boom", "upstream 500", /HTTP 500/], ["ratelimited", "upstream 429", /HTTP 429/], ["neterr", "network error", /Could not reach/], ["hang", "timeout abort", /8 seconds/]]) {
  calls = []; upstream = [];
  r = await paidQ(q); j = await r.json();
  ok(r.status === 502 && calls.length === 1 && calls[0].u.endsWith("/verify") && !r.headers.get("PAYMENT-RESPONSE") && re.test(j.error) && /no payment was taken/.test(j.error) && upstream.length === 1, `${label} -> 502, not settled: ${j.error}`);
}
calls = []; upstream = []; cachePuts = 0;
r = await paidQ("anomaly"); j = await r.json(); await flush();
ok(r.status === 502 && calls.length === 1 && !r.headers.get("PAYMENT-RESPONSE") && /challenge/i.test(j.error) && /no payment was taken/i.test(j.error) && cachePuts === 0, "anomaly/CAPTCHA page -> 502, not settled, not cached");
calls = []; upstream = [];
r = await paidQ("zzqqxxyy"); j = await r.json(); await flush();
ok(r.status === 404 && calls.length === 1 && !r.headers.get("PAYMENT-RESPONSE") && /no results/i.test(j.error) && /no payment was taken/i.test(j.error) && j.query === "zzqqxxyy" && cachePuts === 0, "zero results -> 404, not settled, not cached");
calls = [];
r = await paidQ("blank"); j = await r.json();
ok(r.status === 404 && calls.length === 1 && !r.headers.get("PAYMENT-RESPONSE"), "empty 200 body -> 404 no results, not settled");

// ---- payment failures ----
const bad = { ...payload, accepted: { ...payload.accepted, amount: "1" } };
upstream = [];
r = await W.fetch(new Request(base + "/search?q=cloudflare+workers", { headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(bad)).toString("base64") } }), env, ctx); ok(r.status === 402 && upstream.length === 0, "underpaid accepted -> 402, nothing fetched");
r = await W.fetch(new Request(base + "/search?q=cloudflare+workers", { headers: { "PAYMENT-SIGNATURE": "!!!notbase64" } }), env, ctx); ok(r.status === 400 && upstream.length === 0, "garbage payment header -> 400");
mode = "badverify"; calls = []; upstream = [];
r = await paidQ("fresh query one"); ok(r.status === 402 && dec(r.headers.get("PAYMENT-REQUIRED")).error === "insufficient_funds" && calls.length === 1 && upstream.length === 0, "verify fail -> 402, upstream never fetched");
mode = "badsettle"; calls = []; upstream = [];
r = await paidQ("fresh query two"); j = await r.text(); await flush();
ok(r.status === 402 && j.trim() === "{}" && !j.includes("cloudflare") && dec(r.headers.get("PAYMENT-RESPONSE")).success === false && dec(r.headers.get("PAYMENT-RESPONSE")).errorReason === "invalid_transaction_state" && calls.length === 2 && upstream.length === 1, "settle fail -> 402, empty body, no data leaked");
mode = "good";

// ---- parser robustness ----
const parseVia = async (body) => { const q = "edge" + Math.random(); cacheMap.set(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}&kp=-1`, body); const rr = await paidQ(q); return { status: rr.status, j: await rr.json() }; };
let e = await parseVia(`<table><tr><td><a class="result-link" href="https://a.example/x">A</a></td></tr><tr><td class="result-snippet">s1</td></tr><tr><td><A HREF='//duckduckgo.com/l/?uddg=https%3A%2F%2Fb.example%2Fy%3Fz%3D1&rut=1' CLASS="result-link">B</A></td></tr><tr><td class=result-snippet>s2</td></tr></table>`);
ok(e.status === 200 && e.j.results.length === 2 && e.j.results[0].url === "https://a.example/x" && e.j.results[0].snippet === "s1" && e.j.results[1].url === "https://b.example/y?z=1" && e.j.results[1].snippet === "s2", "mixed quote styles, uppercase tags/attrs, unquoted class, unescaped & in href");
e = await parseVia(`<a class="result-link" href="//duckduckgo.com/l/?rut=abc">no uddg</a><a class="result-link" href="javascript:void(0)">js</a><a class="result-link" href="">empty</a><a class="result-link" href="https://ok.example/">   </a><a class="result-link" href="https://ok.example/real">Real</a>`);
ok(e.status === 200 && e.j.results.length === 1 && e.j.results[0].url === "https://ok.example/real" && e.j.results[0].rank === 1, "redirector without uddg, javascript:, empty href and empty title skipped");
e = await parseVia(`<a class="result-link other" href="https://x.example/">X</a>`);
ok(e.status === 200 && e.j.results[0].snippet === "" && e.j.results[0].domain === "x.example", "result without snippet/link-text rows still parsed");
e = await parseVia(`<a class="result-link result-sponsored" href="https://ad.example/">Ad</a><td class="result-snippet">ad text</td>`);
ok(e.status === 404, "only sponsored results -> 404 no results");
e = await parseVia(`<html><body>Unfortunately, bots use DuckDuckGo too. <a href="/">home</a></body></html>`);
ok(e.status === 502, "anomaly text without result-link anchors -> 502");
e = await parseVia(`<html><body><p>Results about robots and challenge coins</p><a class="result-link" href="https://bots.example/">Bots &amp; challenge coins</a></body></html>`);
ok(e.status === 200 && e.j.results[0].title === "Bots & challenge coins", "page with results is never treated as an anomaly even if it mentions bots/challenge");

// ---- /health/search ----
cacheMap.clear(); calls = []; upstream = [];
r = await W.fetch(new Request(base + "/health/search"), env, ctx); j = await r.json(); await flush();
ok(r.status === 200 && Object.keys(j).join() === "status,result_count,ms" && j.status === "ok" && j.result_count === 10 && typeof j.ms === "number" && j.ms >= 0 && !JSON.stringify(j).includes("cloudflare.com"), "health: fixed query, {status,result_count,ms} only, no result data");
ok(upstream.length === 1 && new URL(upstream[0].u).searchParams.get("q") === "cloudflare workers" && calls.length === 0 && !r.headers.get("PAYMENT-RESPONSE"), "health: runs 'cloudflare workers' upstream, free (no facilitator calls)");
r = await W.fetch(new Request(base + "/health/search", { headers: { "PAYMENT-SIGNATURE": hdr } }), env, ctx); ok(r.status === 200 && calls.length === 0, "health ignores payment header, never charges");
const realFetch = globalThis.fetch;
cacheMap.clear();
globalThis.fetch = async (u, init) => (String(u).startsWith("https://lite.duckduckgo.com/") ? html(NO_RESULTS_HTML) : realFetch(u, init));
r = await W.fetch(new Request(base + "/health/search"), env, ctx); j = await r.json();
ok(r.status === 503 && j.status === "degraded" && j.result_count === 0 && Object.keys(j).join() === "status,result_count,ms", "health: markup change / zero results -> 503 degraded, result_count 0");
globalThis.fetch = async (u, init) => (String(u).startsWith("https://lite.duckduckgo.com/") ? html("down", 503) : realFetch(u, init));
r = await W.fetch(new Request(base + "/health/search"), env, ctx); j = await r.json();
ok(r.status === 503 && j.status === "down" && j.result_count === 0, "health: upstream error -> 503 down");
globalThis.fetch = realFetch;
r = await W.fetch(new Request(base + "/health/search", { method: "POST" }), env, ctx); ok(r.status === 405, "health POST -> 405");

// ---- openapi + probes ----
r = await W.fetch(new Request(base + "/openapi.json"), env, ctx); const o = await r.json();
const g = o.paths["/search"].get, p = o.paths["/search"].post;
ok(r.status === 200 && o.openapi === "3.1.0" && o.info.title === "NoJunk Web Search" && /cheap web search/i.test(o.info["x-guidance"]) && /live web/i.test(o.info["x-guidance"]) && /\/read/.test(o.info["x-guidance"]) && o.info["x-guidance"].includes("$0.002") && g["x-payment-info"].price.amount === "0.002000" && g["x-payment-info"].price.mode === "fixed" && g["x-payment-info"].price.currency === "USD" && p["x-payment-info"].protocols[0].x402 && p.requestBody.content["application/json"].schema.required.join() === "q" && g.parameters.map((x) => x.name).join() === "q,count,region,safe" && g.parameters[0].required === true && g.parameters[1].required === false && g.responses["402"] && p.responses["402"] && g.responses["404"] && g.responses["502"] && g.responses["200"].content["application/json"].schema.properties.results.items.properties.snippet, "openapi.json valid with x-guidance, x-payment-info, params, 402");
ok(o.servers[0].url === base, "openapi servers url");
r = await W.fetch(new Request(base + "/.well-known/openapi.json"), env, ctx); ok(r.status === 200 && (await r.json()).openapi === "3.1.0", "well-known openapi alias");
r = await W.fetch(new Request(base + "/search", { method: "POST" }), env, ctx); ok(r.status === 402 && r.headers.get("PAYMENT-REQUIRED"), "POST probe without payment -> 402");
r = await W.fetch(new Request(base + "/nope"), env, ctx); ok(r.status === 404, "unknown path -> 404");
r = await W.fetch(new Request(base + "/search", { method: "OPTIONS" }), env, ctx); ok(r.status === 200 && r.headers.get("Access-Control-Allow-Origin") === "*" && /PAYMENT-SIGNATURE/.test(r.headers.get("Access-Control-Allow-Headers")), "CORS preflight");
r = await paidQ("cloudflare workers"); ok(r.headers.get("Access-Control-Allow-Origin") === "*" && /PAYMENT-RESPONSE/.test(r.headers.get("Access-Control-Expose-Headers")), "CORS headers on paid response");

// ---- no ctx (waitUntil absent) and no caches API: still works ----
const savedCaches = globalThis.caches; delete globalThis.caches; upstream = [];
r = await W.fetch(new Request(base + "/search?q=cloudflare+workers", { headers: { "PAYMENT-SIGNATURE": hdr } }), env); j = await r.json();
ok(r.status === 200 && j.results.length === 10 && upstream.length === 1, "works without caches.default and without ctx");
globalThis.caches = savedCaches;

// ---- CDP facilitator ----
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const jwk = privateKey.export({ format: "jwk" });
const secret = Buffer.concat([Buffer.from(jwk.d, "base64url"), Buffer.from(jwk.x, "base64url")]).toString("base64");
const envC = { PAY_TO: PAY, CDP_API_KEY_ID: "test-key-id", CDP_API_KEY_SECRET: secret };
calls = [];
r = await W.fetch(new Request(base + "/search?q=cloudflare+workers", { headers: { "PAYMENT-SIGNATURE": hdr } }), envC, ctx);
ok(r.status === 200 && calls[0].u === "https://api.cdp.coinbase.com/platform/v2/x402/verify", "cdp facilitator used");
const checkJwt = (tok, pub, uri, alg) => { const [hh, pl, s] = tok.split("."); const H = JSON.parse(Buffer.from(hh, "base64url")), P = JSON.parse(Buffer.from(pl, "base64url"));
  const sigOk = alg === "EdDSA" ? nverify(null, Buffer.from(hh + "." + pl), pub, Buffer.from(s, "base64url")) : nverify("sha256", Buffer.from(hh + "." + pl), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
  return sigOk && H.alg === alg && H.kid === "test-key-id" && H.nonce.length === 32 && P.iss === "cdp" && P.sub === "test-key-id" && P.uris[0] === uri && P.exp - P.nbf === 120; };
ok(checkJwt(calls[0].init.headers.Authorization.slice(7), publicKey, "POST api.cdp.coinbase.com/platform/v2/x402/verify", "EdDSA"), "Ed25519 JWT valid (verify)");
ok(checkJwt(calls[1].init.headers.Authorization.slice(7), publicKey, "POST api.cdp.coinbase.com/platform/v2/x402/settle", "EdDSA"), "Ed25519 JWT valid (settle)");
const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pem = ec.privateKey.export({ type: "sec1", format: "pem" });
calls = [];
r = await W.fetch(new Request(base + "/search?q=cloudflare+workers", { headers: { "PAYMENT-SIGNATURE": hdr } }), { ...envC, CDP_API_KEY_SECRET: pem.replace(/\n/g, "\\n") }, ctx);
ok(r.status === 200 && checkJwt(calls[0].init.headers.Authorization.slice(7), ec.publicKey, "POST api.cdp.coinbase.com/platform/v2/x402/verify", "ES256"), "EC SEC1 JWT valid");
const txt = await r.text(); ok(!txt.includes(secret) && !txt.includes("test-key-id") && !txt.includes("PRIVATE KEY"), "no secrets in response");
r = await W.fetch(new Request(base + "/"), envC, ctx); ok((await r.json()).facilitator === "cdp", "info page reports cdp facilitator");

// ---- hard rule: no real network ever touched ----
ok(upstream.every((x) => x.u.startsWith("https://lite.duckduckgo.com/lite/?")), "all upstream calls went to the DDG mock");
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exitCode = fails ? 1 : 0;
