// Usage: node test/test.mjs ./worker.js /path/bazaar-out.json
import { generateKeyPairSync, verify as nverify } from "node:crypto";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const W = (await import(pathToFileURL(resolve(process.argv[2])).href)).default;
const PAY = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const dec = (h) => JSON.parse(Buffer.from(h, "base64").toString());

// ---- fixtures ----
const ARTICLE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Why Bitcoin Fees Spike &amp; What To Do | NoJunk Crypto</title>
<meta name="description" content="A plain-English look at why Bitcoin transaction fees spike and three ways to pay less.">
<meta property="og:title" content="Why Bitcoin Fees Spike &amp; What To Do">
<meta property="og:site_name" content="NoJunk Crypto">
<meta property="article:published_time" content="2026-10-12T09:30:00Z">
<link rel="stylesheet" href="/style.css">
<style>body{font-family:sans-serif} .hidden{display:none}</style>
<script>window.dataLayer=[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());</script>
</head>
<body>
<header class="site-header">
  <a href="/"><img src="/logo.png" alt="NoJunk Crypto"></a>
  <nav><ul><li><a href="/">Home</a></li><li><a href="/coins">Coins</a></li><li><a href="/about">About us</a></li></ul></nav>
</header>
<div id="cookie-banner" role="dialog">We use cookies. <a href="/privacy">Privacy policy</a></div>
<main>
<article>
  <header>
    <h1>Why Bitcoin Fees Spike &amp; What To Do</h1>
    <p class="byline">By <a href="/authors/mick">Mick</a> &middot; <time datetime="2026-10-12T09:30:00Z">October 12, 2026</time></p>
  </header>
  <p>Bitcoin fees are an <strong>auction</strong> for limited block space.   When demand jumps, so do fees &mdash; sometimes
  by 10&times; in an hour.</p>
  <p>You can watch the mempool at <a href="https://mempool.space/">mempool.space</a> or read the
  <a href="/guides/fees">fee guide</a> on this site. Prices like &euro;5 or &#36;20 are common at peaks; see &quot;peak hours&quot;.</p>
  <h2>Three ways to pay less</h2>
  <ul>
    <li>Use <em>SegWit</em> or Taproot addresses</li>
    <li>Batch your payments</li>
    <li>Wait for a quiet weekend<ul><li>Sunday mornings UTC are cheapest</li></ul></li>
  </ul>
  <h2>Typical fee tiers</h2>
  <table>
    <thead><tr><th>Priority</th><th>sat/vB</th></tr></thead>
    <tbody><tr><td>High</td><td>40</td></tr><tr><td>Low</td><td>5</td></tr></tbody>
  </table>
  <pre><code>bitcoin-cli estimatesmartfee 6
{
  "feerate": 0.00012000
}</code></pre>
  <p>Line one<br>Line two after a break.</p>
  <blockquote>Fees are a feature, not a bug.</blockquote>
  <p class="hidden" style="display:none">You should not see this.</p>
  <p>Read <a href="mailto:hi@nojunkcrypto.com">email us</a> or <a href="javascript:void(0)">click</a> or <a href="https://mempool.space/">mempool.space</a> again.</p>
  <aside class="related"><h3>Related</h3><a href="/coins/eth">Ethereum fees</a></aside>
  <footer class="article-footer">Tags: <a href="/tags/fees">fees</a></footer>
</article>
</main>
<aside class="sidebar"><h3>Newsletter</h3><form><input type="email"><button>Subscribe</button></form></aside>
<footer class="site-footer"><p>&copy; 2026 NoJunk Crypto. <a href="/terms">Terms</a></p></footer>
<script type="application/ld+json">{"@type":"Article","headline":"nope"}</script>
<noscript><img src="https://tracker.example/pixel.gif" alt="tracking pixel"></noscript>
</body>
</html>`;

const SIMPLE_HTML = `<html><head><title>Plain &lt;Page&gt;</title></head><body><div class="content"><h1>Hello</h1><p>World &amp; friends</p><p>Second paragraph with <a href="../x/y.html">relative link</a>.</p></div></body></html>`;

// ---- fetch mock ----
let calls = [], mode = "good", upstream = [], routes = {};
const html = (body, extra = {}) => new Response(body, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", ...extra } });
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
  const r = routes[u];
  if (typeof r === "function") return r(u, init);
  if (r) return r;
  return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/html" } });
};
routes["https://nojunkcrypto.com/blog/bitcoin-fees"] = () => html(ARTICLE_HTML);
routes["https://example.org/dir/page.html"] = () => html(SIMPLE_HTML);
routes["https://example.org/boom"] = () => new Response("Internal Server Error", { status: 500, headers: { "Content-Type": "text/html" } });
routes["https://example.org/gone"] = () => new Response("gone", { status: 404 });
routes["https://example.org/file.pdf"] = () => new Response("%PDF-1.4 binary", { status: 200, headers: { "Content-Type": "application/pdf" } });
routes["https://example.org/img.png"] = () => new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { "Content-Type": "image/png" } });
routes["https://example.org/data.json"] = () => new Response('{"b":[1,2],"a":"x"}', { status: 200, headers: { "Content-Type": "application/json" } });
routes["https://example.org/notes.txt"] = () => new Response("line 1\r\n\r\n\r\n\r\nline 2   \n", { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });
routes["https://example.org/feed.xml"] = () => new Response('<?xml version="1.0"?><rss><channel><title>Feed &amp; Co</title><item><title>One</title></item></channel></rss>', { status: 200, headers: { "Content-Type": "application/rss+xml" } });
routes["https://example.org/redir1"] = () => new Response(null, { status: 301, headers: { Location: "/redir2" } });
routes["https://example.org/redir2"] = () => new Response(null, { status: 302, headers: { Location: "https://example.org/dir/page.html" } });
routes["https://example.org/loop"] = () => new Response(null, { status: 302, headers: { Location: "https://example.org/loop" } });
routes["https://example.org/to-private"] = () => new Response(null, { status: 302, headers: { Location: "http://169.254.169.254/latest/meta-data/" } });
routes["https://example.org/to-local"] = () => new Response(null, { status: 302, headers: { Location: "http://localhost:8080/admin" } });
routes["https://example.org/noloc"] = () => new Response(null, { status: 302 });
routes["https://example.org/hang"] = () => new Promise((_, rej) => setTimeout(() => rej(new TypeError("fetch failed")), 20));
routes["https://example.org/abort"] = (u, init) => new Promise((_, rej) => { init.signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))); });
const BIG = "<html><head><title>Big</title></head><body><p>" + "lorem ipsum dolor sit amet ".repeat(170000) + "</p><p>TAIL-MARKER</p></body></html>"; // ~4.6 MB
routes["https://example.org/big"] = () => html(BIG);
routes["https://example.org/nocontenttype"] = () => new Response(new TextEncoder().encode("<html><head><title>Sniffed</title></head><body><p>Hi</p></body></html>"), { status: 200 }); // bytes body: Node adds no content-type
routes["https://example.org/latin1"] = () => new Response(new Uint8Array([0x3c, 0x70, 0x3e, 0x63, 0x61, 0x66, 0xe9, 0x3c, 0x2f, 0x70, 0x3e]), { status: 200, headers: { "Content-Type": "text/html; charset=iso-8859-1" } });

const env = { PAY_TO: PAY };
const base = "https://webread.example.workers.dev";
const ART = "https://nojunkcrypto.com/blog/bitcoin-fees";

// ---- unpaid ----
let r = await W.fetch(new Request(base + "/"), env); let j = await r.json();
ok(r.status === 200 && j.service === "Web Page Reader" && j.facilitator === "payai" && j.price.includes("$0.002") && j.endpoint.includes("/read?url="), "info page");
r = await W.fetch(new Request(base + "/read?url=" + encodeURIComponent(ART)), {}); ok(r.status === 402 && dec(r.headers.get("PAYMENT-REQUIRED")).accepts[0].payTo === "0x6f762720b8515b7091e6aa69e8361f7b9909233f", "default wallet used");
upstream = []; calls = [];
r = await W.fetch(new Request(base + "/read"), env); ok(r.status === 402 && upstream.length === 0, "missing url unpaid -> 402 first");
r = await W.fetch(new Request(base + "/read?url=ftp://example.org/x"), env); ok(r.status === 402, "bad url unpaid -> 402 first");
r = await W.fetch(new Request(base + "/read?url=" + encodeURIComponent(ART)), env);
ok(r.status === 402 && upstream.length === 0 && calls.length === 0, "unpaid -> 402, nothing fetched");
const pr = dec(r.headers.get("PAYMENT-REQUIRED"));
const a0 = pr.accepts[0];
ok(pr.x402Version === 2 && pr.accepts.length === 1 && a0.scheme === "exact" && a0.amount === "2000" && a0.payTo === PAY && a0.network === "eip155:8453" && a0.asset === "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" && a0.extra.name === "USD Coin" && a0.extra.version === "2", "402 requirements correct (2000, payTo, asset, network)");
ok(pr.resource.url === base + "/read" && pr.resource.mimeType === "application/json" && pr.resource.description === j.description, "resource url + description");
ok(pr.extensions.bazaar.info.input.type === "http" && pr.extensions.bazaar.info.input.queryParams.url && pr.extensions.bazaar.schema.properties.input.required.includes("method") && pr.extensions.bazaar.info.output.example.text, "bazaar ext present");
ok(JSON.stringify(pr) === Buffer.from(r.headers.get("PAYMENT-REQUIRED"), "base64").toString() && (await r.json()).x402Version === 2, "402 body equals header payload");
writeFileSync(process.argv[3], JSON.stringify(pr.extensions.bazaar));
const payload = { x402Version: 2, resource: pr.resource, accepted: pr.accepts[0], payload: { signature: "0x00", authorization: {} }, extensions: pr.extensions };
const hdr = Buffer.from(JSON.stringify(payload)).toString("base64");
const paid = (q, extra = {}) => W.fetch(new Request(base + "/read" + q, { ...extra, headers: { "PAYMENT-SIGNATURE": hdr, ...(extra.headers || {}) } }), env);
const paidUrl = (u, extra) => paid("?url=" + encodeURIComponent(u), extra);

// ---- bad input with payment -> 400, zero facilitator + zero upstream calls ----
const BAD = [
  ["", "missing url"],
  ["not a url", "garbage"],
  ["ftp://example.org/file", "ftp scheme"],
  ["file:///etc/passwd", "file scheme"],
  ["data:text/html,hi", "data scheme"],
  ["javascript:alert(1)", "javascript scheme"],
  ["http://localhost/", "localhost"],
  ["http://localhost:8080/admin", "localhost with port"],
  ["http://foo.localhost/", "*.localhost"],
  ["http://127.0.0.1/", "127.0.0.1"],
  ["http://127.1/", "127.1 shorthand"],
  ["http://2130706433/", "decimal ip 127.0.0.1"],
  ["http://0x7f.0.0.1/", "hex ip"],
  ["http://0.0.0.0/", "0.0.0.0"],
  ["http://10.0.0.5/", "10/8"],
  ["http://172.16.4.4/", "172.16/12"],
  ["http://172.31.255.255/", "172.31"],
  ["http://192.168.1.1/", "192.168/16"],
  ["http://169.254.169.254/latest/meta-data/", "link-local metadata"],
  ["http://100.64.0.1/", "100.64/10 CGNAT"],
  ["http://[::1]/", "ipv6 loopback"],
  ["http://[::]/", "ipv6 unspecified"],
  ["http://[fe80::1]/", "ipv6 link-local"],
  ["http://[fd00::1]/", "ipv6 unique-local"],
  ["http://[::ffff:127.0.0.1]/", "ipv4-mapped loopback"],
  ["http://[::ffff:10.0.0.1]/", "ipv4-mapped private"],
  ["http://metadata.google.internal/computeMetadata/v1/", ".internal"],
  ["http://api.internal/", "bare .internal"],
  ["http://printer.local/", ".local"],
  ["http://intranet/", "single-label host"],
  ["http://user:pass@example.org/", "embedded credentials"],
  ["https://example.org/" + "a".repeat(2100), "url too long"],
];
for (const [u, label] of BAD) {
  calls = []; upstream = [];
  r = await paidUrl(u); j = await r.json();
  ok(r.status === 400 && calls.length === 0 && upstream.length === 0 && /no payment was taken/.test(j.error), `paid + ${label} -> 400, no facilitator/upstream call`);
}
calls = []; upstream = [];
r = await paid("", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: "http://192.168.0.10/" }) }); j = await r.json();
ok(r.status === 400 && calls.length === 0 && upstream.length === 0, "POST private IP -> 400, no calls");
r = await paid("", { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "100000" }, body: "{}" });
ok(r.status === 413 && calls.length === 0 && upstream.length === 0, "oversized POST body -> 413 before payment work");
r = await paid("?url=" + encodeURIComponent(ART), { method: "PUT" }); ok(r.status === 405, "PUT -> 405");

// ---- happy path: realistic article ----
calls = []; upstream = [];
r = await paidUrl(ART); j = await r.json();
ok(r.status === 200, "paid -> 200");
ok(dec(r.headers.get("PAYMENT-RESPONSE")).transaction === "0xdeadbeef" && dec(r.headers.get("PAYMENT-RESPONSE")).success === true && dec(r.headers.get("PAYMENT-RESPONSE")).payer === "0xabc", "PAYMENT-RESPONSE receipt");
ok(calls.length === 2 && calls[0].u === "https://facilitator.payai.network/verify" && calls[1].u.endsWith("/settle"), "verify then settle via payai");
ok(upstream.length === 1 && upstream[0].u === ART, "one upstream fetch of the requested url");
const ua = upstream[0].init.headers["User-Agent"];
ok(ua === "NoJunk Web Read/1.0 (+https://nojunkcrypto.com)" && upstream[0].init.redirect === "manual" && upstream[0].init.signal && /text\/html/.test(upstream[0].init.headers.Accept), "upstream UA, manual redirects, abort signal, accept header");
const sent = JSON.parse(calls[0].init.body); ok(sent.x402Version === 2 && sent.paymentRequirements.payTo === PAY && sent.paymentPayload.accepted.amount === "2000", "facilitator body shape");
ok(j.url === ART && j.final_url === ART && j.status === 200 && j.content_type === "text/html", "url/final_url/status fields");
ok(j.title === "Why Bitcoin Fees Spike & What To Do", "title from og:title with entity decoded: " + j.title);
ok(j.description === "A plain-English look at why Bitcoin transaction fees spike and three ways to pay less.", "description");
ok(j.site_name === "NoJunk Crypto" && j.published === "2026-10-12T09:30:00Z" && j.lang === "en", "site_name, published, lang");
ok(typeof j.text === "string" && j.text.startsWith("Why Bitcoin Fees Spike & What To Do\n\nBy Mick · October 12, 2026\n\nBitcoin fees are an auction for limited block space. When demand jumps, so do fees — sometimes by 10× in an hour.\n\n"), "text starts with article h1 + byline + collapsed paragraph");
ok(j.text.includes("Prices like €5 or $20 are common at peaks; see \"peak hours\".") && j.text.includes("\n\nThree ways to pay less\n\n- Use SegWit or Taproot addresses\n- Batch your payments\n- Wait for a quiet weekend\n  - Sunday mornings UTC are cheapest\n\n"), "text: entities decoded, nested list as dashes");
ok(j.text.includes("Priority | sat/vB\nHigh | 40\nLow | 5"), "text: table as rows");
ok(j.text.includes('bitcoin-cli estimatesmartfee 6\n{\n  "feerate": 0.00012000\n}'), "text: pre whitespace preserved");
ok(j.text.includes("Line one\nLine two after a break.") && j.text.includes("Fees are a feature, not a bug."), "text: br and blockquote");
ok(j.text.includes("Tags: fees"), "text: article footer kept");
for (const bad of ["Home", "About us", "Coins", "We use cookies", "Newsletter", "Subscribe", "© 2026", "dataLayer", "font-family", "nope", "tracking pixel", "You should not see this", "Related", "Ethereum fees", "Terms"]) ok(!j.text.includes(bad), `text excludes boilerplate: ${JSON.stringify(bad)}`);
ok(!/ {2}/.test(j.text.replace(/^ {2}- /gm, "").replace(/\n {2}"feerate"/g, "")) && !/\n{3}/.test(j.text) && !/[ \t]\n/.test(j.text), "text: whitespace collapsed, no triple newlines, no trailing spaces");
ok(j.text.includes("Read email us or click or mempool.space again."), "text: non-http anchors kept as plain text");
ok(j.markdown.startsWith("# Why Bitcoin Fees Spike & What To Do\n\nBy [Mick](https://nojunkcrypto.com/authors/mick) · October 12, 2026\n\nBitcoin fees are an **auction** for limited block space."), "markdown: h1, link, bold");
ok(j.markdown.includes("## Three ways to pay less\n\n- Use *SegWit* or Taproot addresses\n- Batch your payments\n- Wait for a quiet weekend\n  - Sunday mornings UTC are cheapest\n\n## Typical fee tiers\n\n| Priority | sat/vB |\n| --- | --- |\n| High | 40 |\n| Low | 5 |"), "markdown: h2, list, italics, table");
ok(j.markdown.includes("[mempool.space](https://mempool.space/)") && j.markdown.includes("[fee guide](https://nojunkcrypto.com/guides/fees)"), "markdown: absolute + resolved relative links");
ok(j.markdown.includes('```\nbitcoin-cli estimatesmartfee 6\n{\n  "feerate": 0.00012000\n}\n```'), "markdown: fenced code block");
ok(j.markdown.includes("> Fees are a feature, not a bug.") && j.markdown.includes("Line one\nLine two after a break."), "markdown: blockquote and br");
ok(j.markdown.includes("Read email us or click or [mempool.space](https://mempool.space/) again."), "markdown: mailto/javascript links rendered as plain text");
ok(!j.markdown.includes("Home") && !j.markdown.includes("dataLayer") && !j.markdown.includes("/privacy"), "markdown excludes boilerplate");
const hrefs = j.links.map((l) => l.href);
ok(hrefs[0] === "https://nojunkcrypto.com/authors/mick" && hrefs[1] === "https://mempool.space/" && hrefs[2] === "https://nojunkcrypto.com/guides/fees" && hrefs[3] === "https://nojunkcrypto.com/tags/fees", "links: content links first, in order, absolute: " + hrefs.slice(0, 4).join(" "));
ok(j.links.find((l) => l.href === "https://mempool.space/").text === "mempool.space" && j.links.find((l) => l.text === "fee guide"), "links: text captured");
ok(hrefs.filter((h) => h === "https://mempool.space/").length === 1, "links: deduplicated");
ok(hrefs.includes("https://nojunkcrypto.com/coins") && hrefs.includes("https://nojunkcrypto.com/terms") && hrefs.includes("https://nojunkcrypto.com/coins/eth"), "links: rest of page (nav/footer/aside) appended after content links");
ok(!hrefs.some((h) => /^(mailto|javascript):/.test(h)) && hrefs.every((h) => /^https?:\/\//.test(h)) && new Set(hrefs).size === hrefs.length, "links: only absolute http(s), no dupes");
ok(j.word_count > 100 && j.word_count === j.text.split(/\s+/).filter(Boolean).length && j.truncated === false, "word_count matches text, truncated false");
ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(j.fetched_at) && Math.abs(Date.now() - Date.parse(j.fetched_at)) < 5000, "fetched_at is current ISO timestamp");
ok(Object.keys(j).join() === "url,final_url,status,content_type,title,description,site_name,published,lang,text,markdown,links,word_count,truncated,fetched_at", "output key order/complete");

// simple page: title fallback, relative link resolution against directory, no article/main -> body
upstream = [];
r = await paidUrl("https://example.org/dir/page.html"); j = await r.json();
ok(r.status === 200 && j.title === "Plain <Page>" && j.text === "Hello\n\nWorld & friends\n\nSecond paragraph with relative link." && j.markdown === "# Hello\n\nWorld & friends\n\nSecond paragraph with [relative link](https://example.org/x/y.html)." && j.links.length === 1 && j.links[0].href === "https://example.org/x/y.html" && j.description === null && j.published === null, "simple page: <title>, body fallback, relative link resolved");
// POST
upstream = [];
r = await paid("", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: ART }) }); j = await r.json();
ok(r.status === 200 && j.title === "Why Bitcoin Fees Spike & What To Do" && upstream.length === 1, "paid POST works");
// url with fragment normalized
r = await paidUrl(ART + "#section"); j = await r.json(); ok(r.status === 200 && j.url === ART, "fragment stripped from url");

// ---- redirects ----
upstream = []; calls = [];
r = await paidUrl("https://example.org/redir1"); j = await r.json();
ok(r.status === 200 && upstream.map((x) => x.u).join(" ") === "https://example.org/redir1 https://example.org/redir2 https://example.org/dir/page.html" && j.url === "https://example.org/redir1" && j.final_url === "https://example.org/dir/page.html" && j.title === "Plain <Page>" && calls.length === 2, "follows relative + absolute redirects, reports final_url");
upstream = []; calls = [];
r = await paidUrl("https://example.org/loop"); j = await r.json();
ok(r.status === 502 && upstream.length === 6 && calls.length === 1 && !r.headers.get("PAYMENT-RESPONSE") && /redirects/i.test(j.error) && /no payment was taken/.test(j.error), "redirect loop -> 502 after 5 redirects, not settled");
upstream = []; calls = [];
r = await paidUrl("https://example.org/to-private"); j = await r.json();
ok(r.status === 502 && upstream.length === 1 && calls.length === 1 && /cannot be fetched/.test(j.error), "redirect to link-local address -> blocked, 502, not followed, not settled");
upstream = []; calls = [];
r = await paidUrl("https://example.org/to-local"); ok(r.status === 502 && upstream.length === 1 && calls.length === 1, "redirect to localhost -> blocked, not followed");
upstream = []; calls = [];
r = await paidUrl("https://example.org/noloc"); ok(r.status === 502 && calls.length === 1, "3xx without Location -> 502");

// ---- upstream failures: no settle, no charge ----
calls = []; upstream = [];
r = await paidUrl("https://example.org/boom"); j = await r.json();
ok(r.status === 502 && calls.length === 1 && calls[0].u.endsWith("/verify") && !calls.some((c) => c.u.endsWith("/settle")) && !r.headers.get("PAYMENT-RESPONSE") && /HTTP 500/.test(j.error) && /no payment was taken/.test(j.error), "upstream 500 -> 502, not settled");
calls = [];
r = await paidUrl("https://example.org/gone"); j = await r.json();
ok(r.status === 404 && calls.length === 1 && !r.headers.get("PAYMENT-RESPONSE") && /not found/i.test(j.error), "upstream 404 -> 404, not settled");
calls = [];
r = await paidUrl("https://example.org/hang"); j = await r.json();
ok(r.status === 502 && calls.length === 1 && /Could not fetch/.test(j.error), "network error -> 502, not settled");
calls = [];
r = await paidUrl("https://example.org/abort"); j = await r.json();
ok(r.status === 502 && calls.length === 1 && /8 seconds/.test(j.error), "timeout abort -> 502, not settled");
calls = [];
r = await paidUrl("https://example.org/file.pdf"); j = await r.json();
ok(r.status === 415 && calls.length === 1 && !r.headers.get("PAYMENT-RESPONSE") && /application\/pdf/.test(j.error) && /no payment was taken/.test(j.error), "pdf -> 415, not settled");
calls = [];
r = await paidUrl("https://example.org/img.png"); ok(r.status === 415 && calls.length === 1, "image -> 415, not settled");

// ---- payment failures ----
const bad = { ...payload, accepted: { ...payload.accepted, amount: "1" } };
upstream = [];
r = await W.fetch(new Request(base + "/read?url=" + encodeURIComponent(ART), { headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(bad)).toString("base64") } }), env); ok(r.status === 402 && upstream.length === 0, "underpaid accepted -> 402, nothing fetched");
r = await W.fetch(new Request(base + "/read?url=" + encodeURIComponent(ART), { headers: { "PAYMENT-SIGNATURE": "!!!notbase64" } }), env); ok(r.status === 400 && upstream.length === 0, "garbage payment header -> 400");
mode = "badverify"; calls = []; upstream = [];
r = await paidUrl(ART); ok(r.status === 402 && dec(r.headers.get("PAYMENT-REQUIRED")).error === "insufficient_funds" && calls.length === 1 && upstream.length === 0, "verify fail -> 402, page never fetched");
mode = "badsettle"; calls = []; upstream = [];
r = await paidUrl(ART); j = await r.text();
ok(r.status === 402 && j.trim() === "{}" && !j.includes("Bitcoin") && dec(r.headers.get("PAYMENT-RESPONSE")).success === false && dec(r.headers.get("PAYMENT-RESPONSE")).errorReason === "invalid_transaction_state" && calls.length === 2 && upstream.length === 1, "settle fail -> 402, empty body, no data leaked");
mode = "good";

// ---- body cap / truncation ----
calls = []; upstream = [];
r = await paidUrl("https://example.org/big"); j = await r.json();
ok(r.status === 200 && j.truncated === true && j.text.length === 60000 && j.markdown.length <= 60000 && j.title === "Big" && !j.text.includes("TAIL-MARKER") && j.word_count > 60000 / 6 && calls.length === 2, "4.6 MB body -> read capped at 3 MB, text capped at 60k, truncated=true, still charged");

// ---- other content types ----
r = await paidUrl("https://example.org/data.json"); j = await r.json();
ok(r.status === 200 && j.text === '{\n  "b": [\n    1,\n    2\n  ],\n  "a": "x"\n}' && j.markdown.startsWith("```json\n") && j.links.length === 0 && j.title === null && j.content_type === "application/json", "json -> pretty printed");
r = await paidUrl("https://example.org/notes.txt"); j = await r.json();
ok(r.status === 200 && j.text === "line 1\n\nline 2" && j.markdown === "line 1\n\nline 2" && j.word_count === 4, "text/plain -> normalized");
r = await paidUrl("https://example.org/feed.xml"); j = await r.json();
ok(r.status === 200 && j.title === "Feed & Co" && j.text.includes("<rss>") && j.markdown.startsWith("```xml"), "rss+xml accepted");
r = await paidUrl("https://example.org/nocontenttype"); j = await r.json();
ok(r.status === 200 && j.title === "Sniffed" && j.text === "Hi", "missing content-type sniffed as html");
r = await paidUrl("https://example.org/latin1"); j = await r.json();
ok(r.status === 200 && j.text === "café", "charset from content-type honored");

// ---- parser robustness (direct through the worker) ----
const edge = (body) => { routes["https://example.org/edge"] = () => html(body); return paidUrl("https://example.org/edge").then((x) => x.json()); };
j = await edge("<p>Unclosed <b>bold <i>and italic<p>Next para<ul><li>one<li>two</ul>");
ok(j.text === "Unclosed bold and italic\n\nNext para\n\n- one\n- two" && j.markdown.includes("**bold *and italic***") && j.markdown.includes("- one\n- two"), "unclosed tags / implied p and li ends");
j = await edge('<div><script>if (a < b && c > d) { document.write("<p>x</p>"); }</script><p title="a > b" data-x=\'q"q\'>ok &#8217;quote&#146; &unknown; &lt;tag&gt; &#x1F600;</p></div>');
ok(j.text === "ok ’quote’ &unknown; <tag> \u{1F600}", "script with angle brackets, attr quotes, numeric/hex/cp1252/unknown entities: " + JSON.stringify(j.text));
j = await edge("<!-- c --><body><![CDATA[ raw ]]><h3>H</h3><p>a<br/>b<br />c</p><hr><ol start=\"3\"><li>x</li><li>y</li></ol><dl><dt>Term</dt><dd>Def</dd></dl><p><img src=\"a.png\" alt=\"An image\"></p></body>");
ok(j.text === "raw\n\nH\n\na\nb\nc\n\n3. x\n4. y\n\nTerm\n  Def\n\nAn image" && j.markdown.includes("### H") && j.markdown.includes("---") && j.markdown.includes("3. x\n4. y") && j.markdown.includes("![An image](https://example.org/a.png)"), "comments/cdata/br variants/ol start/dl/img alt: " + JSON.stringify(j.text));
j = await edge('<head><base href="https://cdn.example.net/root/"></head><body><main><p><a href="x">link</a></p></main></body>');
ok(j.links[0].href === "https://cdn.example.net/root/x" && j.markdown === "[link](https://cdn.example.net/root/x)", "<base href> honored");
j = await edge("<body><article><p>short</p></article><main><p>" + "main content ".repeat(40) + "</p></main></body>");
ok(j.text.startsWith("main content") && !j.text.includes("short"), "tiny <article> loses to richer <main>");
j = await edge("<body><div role=\"main\"><p>Real</p></div><div aria-hidden=\"true\">ghost</div><div hidden>ghost2</div><nav>n</nav></body>");
ok(j.text === "Real", "role=main preferred; aria-hidden/hidden/nav dropped");
j = await edge("<body>" + Array.from({ length: 80 }, (_, i) => `<a href="/p/${i}">Page ${i}</a> `).join("") + "</body>");
ok(j.links.length === 50 && j.links[0].text === "Page 0" && j.links[49].href === "https://example.org/p/49", "links capped at 50");
j = await edge("<body><table><tr><td>a|b</td><td></td><td>c</td></tr><tr><td colspan=2>d</td></tr></table></body>");
ok(j.text === "a|b | | c\nd" && j.markdown.includes("| a\\|b | | c |\n| d |"), "table cells with pipes/empties: " + JSON.stringify(j.text));
j = await edge("<body><ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li><li>d</li></ul></body>");
ok(j.text === "- a\n  - b\n    - c\n- d" && j.markdown === "- a\n  - b\n    - c\n- d", "three-level nested list indentation: " + JSON.stringify(j.text));
j = await edge("<body><p>Only text, no structure, <code>inline code</code> and <strong> spaced bold </strong>here.</p></body>");
ok(j.text === "Only text, no structure, inline code and spaced bold here." && j.markdown === "Only text, no structure, `inline code` and **spaced bold** here.", "inline code + whitespace around bold");
j = await edge("<html><head><meta http-equiv=\"content-language\" content=\"fr\"><meta name=\"date\" content=\"2024-01-02\"></head><body><h1>Titre</h1></body></html>");
ok(j.title === "Titre" && j.lang === "fr" && j.published === "2024-01-02", "title from h1 fallback, lang from http-equiv, published from meta date");
j = await edge("<body><article><header><h1>In-article header kept</h1></header><p>body</p><footer>article footer kept</footer></article></body>");
ok(j.text === "In-article header kept\n\nbody\n\narticle footer kept", "header/footer inside article kept");
j = await edge("");
ok(j.text === "" && j.markdown === "" && j.word_count === 0 && j.title === null && j.links.length === 0, "empty body -> empty fields, still 200");

// ---- openapi + probes ----
r = await W.fetch(new Request(base + "/openapi.json"), env); const o = await r.json();
const g = o.paths["/read"].get, p = o.paths["/read"].post;
ok(r.status === 200 && o.openapi === "3.1.0" && o.info.title === "Web Page Reader" && /read(ing)? .*page.*cheap/i.test(o.info["x-guidance"]) && o.info["x-guidance"].includes("$0.002") && g["x-payment-info"].price.amount === "0.002000" && g["x-payment-info"].price.mode === "fixed" && p["x-payment-info"].protocols[0].x402 && p.requestBody.content["application/json"].schema.required.join() === "url" && g.parameters.map((x) => x.name).join() === "url" && g.parameters[0].required === true && g.responses["402"] && p.responses["402"] && g.responses["415"] && g.responses["502"] && g.responses["200"].content["application/json"].schema.properties.markdown, "openapi.json valid with x-guidance");
ok(o.servers[0].url === base, "openapi servers url");
r = await W.fetch(new Request(base + "/read", { method: "POST" }), env); ok(r.status === 402 && r.headers.get("PAYMENT-REQUIRED"), "POST probe without payment -> 402");
r = await W.fetch(new Request(base + "/nope"), env); ok(r.status === 404, "unknown path -> 404");
r = await W.fetch(new Request(base + "/read", { method: "OPTIONS" }), env); ok(r.status === 200 && r.headers.get("Access-Control-Allow-Origin") === "*" && /PAYMENT-SIGNATURE/.test(r.headers.get("Access-Control-Allow-Headers")), "CORS preflight");
r = await paidUrl(ART); ok(r.headers.get("Access-Control-Allow-Origin") === "*" && /PAYMENT-RESPONSE/.test(r.headers.get("Access-Control-Expose-Headers")), "CORS headers on paid response");

// ---- CDP facilitator ----
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const jwk = privateKey.export({ format: "jwk" });
const secret = Buffer.concat([Buffer.from(jwk.d, "base64url"), Buffer.from(jwk.x, "base64url")]).toString("base64");
const envC = { PAY_TO: PAY, CDP_API_KEY_ID: "test-key-id", CDP_API_KEY_SECRET: secret };
calls = [];
r = await W.fetch(new Request(base + "/read?url=" + encodeURIComponent(ART), { headers: { "PAYMENT-SIGNATURE": hdr } }), envC);
ok(r.status === 200 && calls[0].u === "https://api.cdp.coinbase.com/platform/v2/x402/verify", "cdp facilitator used");
const checkJwt = (tok, pub, uri, alg) => { const [h, pl, s] = tok.split("."); const H = JSON.parse(Buffer.from(h, "base64url")), P = JSON.parse(Buffer.from(pl, "base64url"));
  const sigOk = alg === "EdDSA" ? nverify(null, Buffer.from(h + "." + pl), pub, Buffer.from(s, "base64url")) : nverify("sha256", Buffer.from(h + "." + pl), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
  return sigOk && H.alg === alg && H.kid === "test-key-id" && H.nonce.length === 32 && P.iss === "cdp" && P.sub === "test-key-id" && P.uris[0] === uri && P.exp - P.nbf === 120; };
ok(checkJwt(calls[0].init.headers.Authorization.slice(7), publicKey, "POST api.cdp.coinbase.com/platform/v2/x402/verify", "EdDSA"), "Ed25519 JWT valid (verify)");
ok(checkJwt(calls[1].init.headers.Authorization.slice(7), publicKey, "POST api.cdp.coinbase.com/platform/v2/x402/settle", "EdDSA"), "Ed25519 JWT valid (settle)");
const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pem = ec.privateKey.export({ type: "sec1", format: "pem" });
calls = [];
r = await W.fetch(new Request(base + "/read?url=" + encodeURIComponent(ART), { headers: { "PAYMENT-SIGNATURE": hdr } }), { ...envC, CDP_API_KEY_SECRET: pem.replace(/\n/g, "\\n") });
ok(r.status === 200 && checkJwt(calls[0].init.headers.Authorization.slice(7), ec.publicKey, "POST api.cdp.coinbase.com/platform/v2/x402/verify", "ES256"), "EC SEC1 JWT valid");
const txt = await r.text(); ok(!txt.includes(secret) && !txt.includes("test-key-id") && !txt.includes("PRIVATE KEY"), "no secrets in response");

// ---- hard rule: no real network ever touched ----
ok(upstream.every((x) => x.u.startsWith("https://example.org/") || x.u.startsWith("https://nojunkcrypto.com/") || x.u.startsWith("http://")) , "all upstream calls went to the mock");
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exitCode = fails ? 1 : 0;
