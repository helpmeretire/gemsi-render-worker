// Usage: node test/test.mjs ./worker.js /path/bazaar-out.json
import { generateKeyPairSync, verify as nverify } from "node:crypto";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const W = (await import(pathToFileURL(resolve(process.argv[2])).href)).default;
const PAY = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const dec = (h) => JSON.parse(Buffer.from(h, "base64").toString());
const day = (n) => new Date(Date.now() - n * 86400000).toISOString();

// ---- fixtures: RDAP in registry format, DoH in Cloudflare dns-json format ----
const rdapDoc = ({ domain, registrar = "GoDaddy.com, LLC", created, expires, updated, status = ["client transfer prohibited"], ns = [] }) => ({
  objectClassName: "domain",
  ldhName: domain.toUpperCase(),
  status,
  entities: [
    { objectClassName: "entity", handle: "146", roles: ["registrar"], vcardArray: ["vcard", [["version", {}, "text", "4.0"], ["fn", {}, "text", registrar]]] },
    { objectClassName: "entity", roles: ["registrant"], vcardArray: ["vcard", [["fn", {}, "text", "REDACTED"]]] },
  ],
  events: [
    { eventAction: "registration", eventDate: created },
    { eventAction: "expiration", eventDate: expires },
    { eventAction: "last changed", eventDate: updated },
    { eventAction: "last update of RDAP database", eventDate: "2026-10-15T12:00:00Z" },
  ],
  nameservers: ns.map((n) => ({ objectClassName: "nameserver", ldhName: n.toUpperCase() })),
});
const TYPE = { A: 1, NS: 2, CNAME: 5, MX: 15, TXT: 16, AAAA: 28 };
const dohDoc = (name, type, answers) => ({ Status: 0, TC: false, RD: true, RA: true, AD: false, CD: false, Question: [{ name, type: TYPE[type] }], Answer: answers.map((data) => ({ name, type: TYPE[type], TTL: 300, data })) });

// Per-domain scenario tables
const SCEN = {
  "example.com": {
    rdap: rdapDoc({ domain: "example.com", registrar: "RESERVED-Internet Assigned Numbers Authority", created: "1995-08-14T04:00:00Z", expires: day(-300), updated: "2026-08-14T07:01:34Z", status: ["client delete prohibited", "client transfer prohibited"], ns: ["a.iana-servers.net", "b.iana-servers.net"] }),
    dns: { A: ["23.192.228.80"], AAAA: ["2600:1406:3a00:21::173e:2e65"], MX: ["10 mail1.example.com.", "5 mail0.example.com."], NS: ["a.iana-servers.net.", "b.iana-servers.net."], TXT: ['"v=spf1 include:_spf.example.com -all"', '"google-site-verification=abc"'], CNAME: [], DMARC: ['"v=DMARC1; p=reject; sp=reject"'] },
    web: { status: 200, headers: { server: "ECAcc (nyd/D123)", "strict-transport-security": "max-age=31536000" }, url: "https://example.com/" },
  },
  "fresh-scam.xyz": {
    rdap: rdapDoc({ domain: "fresh-scam.xyz", registrar: "NameCheap, Inc.", created: day(5), expires: day(-360), updated: day(5), status: ["add period", "client transfer prohibited"], ns: ["dns1.registrar-servers.com", "dns2.registrar-servers.com"] }),
    dns: { A: ["203.0.113.9"], AAAA: [], MX: [], NS: ["dns1.registrar-servers.com.", "dns2.registrar-servers.com."], TXT: [], CNAME: [], DMARC: [] },
    web: { status: 200, headers: {}, url: "https://fresh-scam.xyz/" },
  },
  "parked-lot.com": {
    rdap: rdapDoc({ domain: "parked-lot.com", created: day(900), expires: day(-20), updated: day(10), ns: ["ns1.sedoparking.com", "ns2.sedoparking.com"] }),
    dns: { A: ["91.195.240.19"], AAAA: [], MX: [], NS: ["ns1.sedoparking.com.", "ns2.sedoparking.com."], TXT: [], CNAME: [], DMARC: [] },
    web: { status: 200, headers: { server: "nginx" }, url: "https://parked-lot.com/" },
  },
  "unregistered-zzz.com": { rdap: 404, dns: { A: [], AAAA: [], MX: [], NS: [], TXT: [], CNAME: [], DMARC: [] }, web: "down" },
  "redirects.net": {
    rdap: rdapDoc({ domain: "redirects.net", created: day(2000), expires: day(-500), updated: day(100), ns: ["ns1.cloudflare.com"] }),
    dns: { A: [], AAAA: [], MX: ["0 ."], NS: ["ns1.cloudflare.com."], TXT: ['"v=spf1 -all"'], CNAME: ["www.redirects.net."], DMARC: [] },
    web: { status: 200, headers: {}, url: "https://www.other-site.org/landing", headOnly405: true },
  },
  "rdap-down.io": {
    rdap: "down",
    dns: { A: ["1.2.3.4"], AAAA: [], MX: ["10 mx.rdap-down.io."], NS: ["ns1.rdap-down.io."], TXT: ['"v=spf1 mx -all"'], CNAME: [], DMARC: ['"v=DMARC1; p=none"'] },
    web: { status: 200, headers: {}, url: "https://rdap-down.io/" },
  },
  "dns-down.io": {
    rdap: rdapDoc({ domain: "dns-down.io", created: day(500), expires: day(-500), updated: day(100) }),
    dns: "down",
    web: { status: 200, headers: {}, url: "https://dns-down.io/" },
  },
  "all-down.io": { rdap: "down", dns: "down", web: "down" },
};

let calls = [], mode = "good", up = [];
// risk cap check: 40 new + 40 unregistered cannot both happen, so cap is exercised by schema (<=100) only
const jres = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
globalThis.fetch = async (u, init) => {
  u = String(u);
  const U = new URL(u);
  if (U.host === "rdap.org") {
    up.push({ u, init });
    const dom = decodeURIComponent(U.pathname.replace("/domain/", ""));
    const sc = SCEN[dom];
    if (!sc) return jres({ errorCode: 404, title: "Not Found" }, 404);
    if (sc.rdap === "down") throw new TypeError("fetch failed");
    if (sc.rdap === 404) return jres({ errorCode: 404, title: "Not Found" }, 404);
    return jres(sc.rdap);
  }
  if (U.host === "cloudflare-dns.com") {
    up.push({ u, init });
    const name = U.searchParams.get("name"), type = U.searchParams.get("type");
    const dom = name.startsWith("_dmarc.") ? name.slice(7) : name;
    const sc = SCEN[dom];
    if (!sc || sc.dns === "down") return new Response("upstream error", { status: 503 });
    if (!init.headers.Accept.includes("application/dns-json")) return new Response("bad accept", { status: 406 });
    const key = name.startsWith("_dmarc.") ? "DMARC" : type;
    return jres(dohDoc(name, type, sc.dns[key] || []));
  }
  if (U.host !== "facilitator.payai.network" && U.host !== "api.cdp.coinbase.com") {
    // HTTPS probe
    up.push({ u, init });
    const sc = SCEN[U.host];
    if (!sc || sc.web === "down") throw new TypeError("fetch failed: ECONNREFUSED");
    if (sc.web.headOnly405 && init.method === "HEAD") return new Response(null, { status: 405 });
    const r = new Response(init.method === "HEAD" ? null : "<html>body</html>", { status: sc.web.status, headers: sc.web.headers });
    Object.defineProperty(r, "url", { value: sc.web.url });
    return r;
  }
  calls.push({ u, init });
  const op = u.split("/").pop();
  if (mode === "badverify" && op === "verify") return new Response(JSON.stringify({ isValid: false, invalidReason: "insufficient_funds", payer: "0xabc" }), { status: 200 });
  if (mode === "badsettle" && op === "settle") return new Response(JSON.stringify({ success: false, errorReason: "invalid_transaction_state", payer: "0xabc", transaction: "", network: "eip155:8453" }), { status: 400 });
  if (op === "verify") return new Response(JSON.stringify({ isValid: true, payer: "0xabc" }));
  return new Response(JSON.stringify({ success: true, payer: "0xabc", transaction: "0xdeadbeef", network: "eip155:8453" }));
};
const env = { PAY_TO: PAY };
const base = "https://domain.example.workers.dev";

let r = await W.fetch(new Request(base + "/"), env); let j = await r.json();
ok(r.status === 200 && j.service === "Domain Intel" && j.facilitator === "payai" && j.endpoint.includes("/domain?domain="), "info page");
r = await W.fetch(new Request(base + "/domain?domain=example.com"), {}); ok(r.status === 402 && dec(r.headers.get("PAYMENT-REQUIRED")).accepts[0].payTo === "0x6f762720b8515b7091e6aa69e8361f7b9909233f", "default wallet used");
up = []; r = await W.fetch(new Request(base + "/domain"), env); ok(r.status === 402 && up.length === 0, "missing params unpaid -> 402 first");
r = await W.fetch(new Request(base + "/domain?domain=127.0.0.1"), env); ok(r.status === 402 && up.length === 0, "bad input unpaid -> 402 first");
r = await W.fetch(new Request(base + "/domain?domain=example.com"), env);
ok(r.status === 402, "unpaid -> 402");
const pr = dec(r.headers.get("PAYMENT-REQUIRED"));
const a0 = pr.accepts[0];
ok(pr.x402Version === 2 && pr.accepts.length === 1 && a0.scheme === "exact" && a0.amount === "3000" && a0.payTo === PAY && a0.network === "eip155:8453" && a0.asset === "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" && a0.extra.name === "USD Coin", "402 requirements correct (3000, payTo, asset, network)");
ok(pr.resource.url === base + "/domain", "resource url");
ok(pr.extensions.bazaar.info.input.type === "http" && pr.extensions.bazaar.info.input.queryParams.domain === "example.com" && pr.extensions.bazaar.schema.properties.input.required.includes("method"), "bazaar ext present");
ok(r.headers.get("Access-Control-Allow-Origin") === "*" && r.headers.get("Access-Control-Expose-Headers").includes("PAYMENT-REQUIRED"), "CORS headers");
writeFileSync(process.argv[3], JSON.stringify(pr.extensions.bazaar));
const payload = { x402Version: 2, resource: pr.resource, accepted: pr.accepts[0], payload: { signature: "0x00", authorization: {} }, extensions: pr.extensions };
const hdr = Buffer.from(JSON.stringify(payload)).toString("base64");
const paid = (q, extra = {}) => W.fetch(new Request(base + "/domain" + q, { ...extra, headers: { "PAYMENT-SIGNATURE": hdr, ...(extra.headers || {}) } }), env);

// bad input with payment -> 400, zero facilitator calls, zero upstream calls
for (const [q, label] of [["", "missing domain"], ["?domain=127.0.0.1", "IPv4 input"], ["?domain=8.8.8.8", "IPv4 input (public)"], ["?domain=http://192.168.1.1/admin", "IPv4 inside URL"], ["?domain=" + encodeURIComponent("[2001:db8::1]"), "IPv6 bracket literal"], ["?domain=" + encodeURIComponent("2001:db8::1"), "IPv6 bare literal"], ["?domain=" + encodeURIComponent("http://[::1]:8080/"), "IPv6 in URL"], ["?domain=localhost", "localhost"], ["?domain=foo.localhost", "*.localhost"], ["?domain=printer.local", ".local"], ["?domain=justaword", "no TLD"], ["?domain=exa_mple.com", "underscore label"], ["?domain=-bad.com", "leading hyphen"], ["?domain=example.123", "numeric TLD"], ["?domain=" + encodeURIComponent("a".repeat(64) + ".com"), "label > 63"], ["?domain=" + encodeURIComponent("ht!tp://%%%"), "garbage"]]) {
  calls = []; up = [];
  r = await paid(q); j = await r.json();
  ok(r.status === 400 && calls.length === 0 && up.length === 0 && /no payment was taken/.test(j.error), `paid + ${label} -> 400, no facilitator/upstream call: ${j.error}`);
}
calls = []; up = []; r = await paid("?domain=10.0.0.1"); j = await r.json(); ok(r.status === 400 && /IP address/.test(j.error), "IP error message names IP address");
// 413 before any payment work
calls = []; up = []; r = await W.fetch(new Request(base + "/domain?domain=" + "a".repeat(5000) + ".com"), env); ok(r.status === 413 && calls.length === 0 && up.length === 0, "huge query -> 413 before 402");
r = await W.fetch(new Request(base + "/domain", { method: "POST", headers: { "content-length": "99999", "Content-Type": "application/json" }, body: "{}" }), env); ok(r.status === 413, "huge body -> 413");

// happy path: old well-configured domain, low risk
calls = []; up = [];
r = await paid("?domain=example.com"); j = await r.json();
ok(r.status === 200, "paid -> 200");
ok(dec(r.headers.get("PAYMENT-RESPONSE")).transaction === "0xdeadbeef" && dec(r.headers.get("PAYMENT-RESPONSE")).success === true, "PAYMENT-RESPONSE receipt");
ok(calls.length === 2 && calls[0].u === "https://facilitator.payai.network/verify" && calls[1].u.endsWith("/settle"), "verify then settle via payai");
const sent = JSON.parse(calls[0].init.body); ok(sent.x402Version === 2 && sent.paymentRequirements.payTo === PAY && sent.paymentPayload.accepted.amount === "3000", "facilitator body shape");
const rdapCalls = up.filter((c) => c.u.startsWith("https://rdap.org/domain/")), dohCalls = up.filter((c) => c.u.startsWith("https://cloudflare-dns.com/dns-query?")), webCalls = up.filter((c) => c.u.startsWith("https://example.com/"));
ok(rdapCalls.length === 1 && rdapCalls[0].u === "https://rdap.org/domain/example.com" && rdapCalls[0].init.redirect === "follow", "one RDAP call via rdap.org, follows redirects");
const types = dohCalls.map((c) => new URL(c.u).searchParams.get("name") + "/" + new URL(c.u).searchParams.get("type")).sort();
ok(types.join() === ["_dmarc.example.com/TXT", "example.com/A", "example.com/AAAA", "example.com/CNAME", "example.com/MX", "example.com/NS", "example.com/TXT"].join(), "DoH queries: A, AAAA, MX, NS, TXT, CNAME, _dmarc TXT: " + types.join(" "));
ok(dohCalls.every((c) => c.init.headers.Accept === "application/dns-json" && c.init.signal), "DoH accept header + abort signal");
ok(webCalls.length === 1 && webCalls[0].init.method === "HEAD" && webCalls[0].init.redirect === "follow", "HTTPS probe uses HEAD first");
ok(up.every((c) => c.init.signal && c.init.headers["User-Agent"] === "NoJunk Domain Intel/1.0 (+https://nojunkcrypto.com)"), "all upstream calls have timeout signal + UA");
ok(j.domain === "example.com" && j.registered === true && j.registrar === "RESERVED-Internet Assigned Numbers Authority" && j.created === "1995-08-14T04:00:00.000Z" && j.updated === "2026-08-14T07:01:34.000Z" && typeof j.expires === "string" && j.status.join() === "client delete prohibited,client transfer prohibited" && j.nameservers.join() === "a.iana-servers.net,b.iana-servers.net", "RDAP fields parsed");
ok(j.age_days > 11000 && j.age_days < 12000, "age_days computed: " + j.age_days);
ok(j.dns.a.join() === "23.192.228.80" && j.dns.aaaa.join() === "2600:1406:3a00:21::173e:2e65" && j.dns.mx.length === 2 && j.dns.mx[0].host === "mail0.example.com" && j.dns.mx[0].priority === 5 && j.dns.ns.join() === "a.iana-servers.net,b.iana-servers.net" && j.dns.txt_count === 2 && j.dns.spf === true && j.dns.spf_record === "v=spf1 include:_spf.example.com -all" && j.dns.dmarc === true && j.dns.dmarc_record.startsWith("v=DMARC1") && j.dns.cname === null, "DNS fields parsed (mx sorted, spf, dmarc)");
ok(j.web.reachable === true && j.web.status === 200 && j.web.server === "ECAcc (nyd/D123)" && j.web.redirects_to === null && j.web.hsts === true, "web probe fields");
ok(Array.isArray(j.flags) && j.flags.length === 0 && j.risk_score === 0, "old well-configured domain: no flags, risk 0");
ok(/^\d{4}-\d{2}-\d{2}T/.test(j.checked_at) && j.disclaimer && j.sources.rdap === "https://rdap.org/domain/example.com", "checked_at + sources");

// URL input -> hostname extracted, uppercase + trailing dot normalized
up = []; r = await paid("?domain=" + encodeURIComponent("https://User:pw@EXAMPLE.COM.:8443/some/path?x=1#frag")); j = await r.json();
ok(r.status === 200 && j.domain === "example.com" && up.some((c) => c.u === "https://rdap.org/domain/example.com"), "URL input extracts hostname (userinfo, port, path stripped, lowercased)");
j = await (await paid("?domain=" + encodeURIComponent("example.com/path/only"))).json(); ok(j.domain === "example.com", "schemeless URL with path extracts hostname");
j = await (await paid("?domain=www.example.com")).json(); ok(r.status === 200 && j.domain === "www.example.com", "subdomain kept as given");
// POST
r = await paid("", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ domain: "https://example.com/" }) }); j = await r.json();
ok(r.status === 200 && j.domain === "example.com" && j.registered === true, "paid POST works (JSON body, URL)");

// 5-day-old domain, no MX / SPF / DMARC -> high risk
r = await paid("?domain=fresh-scam.xyz"); j = await r.json();
ok(r.status === 200 && j.age_days === 5 && j.registrar === "NameCheap, Inc.", "5-day-old domain parsed, age_days=5");
ok(j.flags.includes("registered_under_30_days") && j.flags.includes("no_mx") && j.flags.includes("no_spf") && j.flags.includes("no_dmarc") && !j.flags.includes("not_reachable") && !j.flags.includes("parked_nameservers"), "new domain flags: " + j.flags.join());
ok(j.risk_score === 70 && j.dns.mx.length === 0 && j.dns.spf === false && j.dns.dmarc === false && j.dns.txt_count === 0, "risk 70 (40 new + 10 mx + 10 spf + 10 dmarc)");

// parked nameservers + expires soon
r = await paid("?domain=parked-lot.com"); j = await r.json();
ok(r.status === 200 && j.flags.includes("parked_nameservers") && j.flags.includes("expires_under_30_days") && !j.flags.includes("registered_under_30_days"), "parked nameservers + expires soon flagged: " + j.flags.join());
ok(j.risk_score === 65, "risk 65 (25 parked + 10 expiring + 30 mail)");

// rdap 404 -> registered:false, unreachable
up = []; r = await paid("?domain=unregistered-zzz.com"); j = await r.json();
ok(r.status === 200 && j.registered === false && j.registrar === null && j.created === null && j.age_days === null && j.nameservers.length === 0, "rdap 404 -> registered:false, null fields");
ok(j.flags.includes("not_registered") && j.flags.includes("not_reachable") && j.web.reachable === false && j.web.status === null, "unregistered: not_registered + not_reachable flags: " + j.flags.join());
ok(j.risk_score === 85, "risk 85 (40 unregistered + 30 mail + 15 unreachable)");
ok(up.filter((c) => c.u.startsWith("https://unregistered-zzz.com/")).length === 2, "probe falls back to GET after HEAD failure");

// redirect target, CNAME, null MX, HEAD 405 -> GET fallback
up = []; r = await paid("?domain=redirects.net"); j = await r.json();
ok(r.status === 200 && j.web.redirects_to === "www.other-site.org" && j.web.reachable === true && j.dns.cname === "www.redirects.net", "redirects_to final host + cname");
const rn = up.filter((c) => c.u.startsWith("https://redirects.net/")); ok(rn.length === 2 && rn[0].init.method === "HEAD" && rn[1].init.method === "GET", "HEAD 405 -> GET fallback");
ok(j.dns.mx.length === 0 && j.flags.includes("no_mx") && j.flags.includes("no_dmarc") && !j.flags.includes("no_spf"), "null MX treated as no mail; spf present");

// partial failures: rdap down but dns ok -> 200 with null registration; dns down but rdap ok -> 200 with dns null
calls = []; r = await paid("?domain=rdap-down.io"); j = await r.json();
ok(r.status === 200 && j.registered === null && j.registrar === null && j.age_days === null && j.flags.includes("rdap_unavailable") && j.dns.a.join() === "1.2.3.4" && calls.length === 2, "RDAP down, DNS ok -> 200 partial, settled");
ok(!j.flags.includes("registered_under_30_days") && j.risk_score === 0, "unknown registration adds no risk");
calls = []; r = await paid("?domain=dns-down.io"); j = await r.json();
ok(r.status === 200 && j.dns === null && j.registered === true && j.flags.includes("dns_unavailable") && !j.flags.includes("no_mx") && calls.length === 2, "DNS down, RDAP ok -> 200 partial, settled");

// both upstreams down -> 502, verify called, no settle
calls = []; r = await paid("?domain=all-down.io"); j = await r.json();
ok(r.status === 502 && calls.length === 1 && calls[0].u.endsWith("/verify") && !calls.some((c) => c.u.endsWith("/settle")) && !r.headers.get("PAYMENT-RESPONSE") && /no payment was taken/.test(j.error), "RDAP + DNS both down -> 502, no settle");

// payment failures
const bad = { ...payload, accepted: { ...payload.accepted, amount: "1" } };
up = []; r = await W.fetch(new Request(base + "/domain?domain=example.com", { headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(bad)).toString("base64") } }), env); ok(r.status === 402 && up.length === 0, "underpaid accepted -> 402, no upstream");
mode = "badverify"; calls = []; up = []; r = await paid("?domain=example.com"); ok(r.status === 402 && dec(r.headers.get("PAYMENT-REQUIRED")).error === "insufficient_funds" && calls.length === 1 && up.length === 0, "verify fail -> 402, no upstream calls");
mode = "badsettle"; r = await paid("?domain=example.com"); j = await r.text(); ok(r.status === 402 && j.trim() === "{}" && !j.includes("registrar") && !j.includes("iana") && dec(r.headers.get("PAYMENT-RESPONSE")).success === false, "settle fail -> 402, no data leaked");
mode = "good";

// openapi + POST probe
r = await W.fetch(new Request(base + "/openapi.json"), env); const o = await r.json();
const g = o.paths["/domain"].get, p = o.paths["/domain"].post;
ok(r.status === 200 && o.openapi === "3.1.0" && o.info.title === "Domain Intel" && o.info["x-guidance"].includes("$0.003") && g["x-payment-info"].price.amount === "0.003000" && g["x-payment-info"].price.mode === "fixed" && p["x-payment-info"].protocols[0].x402 && p.requestBody.content["application/json"].schema.required.join() === "domain" && g.parameters.map((x) => x.name).join() === "domain" && g.responses["402"] && p.responses["402"] && g.responses["502"], "openapi.json valid");
r = await W.fetch(new Request(base + "/domain", { method: "POST" }), env); ok(r.status === 402 && r.headers.get("PAYMENT-REQUIRED"), "POST probe without payment -> 402");
r = await W.fetch(new Request(base + "/nope"), env); ok(r.status === 404, "unknown path -> 404");
r = await W.fetch(new Request(base + "/domain", { method: "OPTIONS" }), env); ok(r.status === 200 && r.headers.get("Access-Control-Allow-Headers").includes("PAYMENT-SIGNATURE"), "OPTIONS preflight");
r = await W.fetch(new Request(base + "/domain?domain=example.com", { method: "DELETE" }), env); ok(r.status === 405, "DELETE -> 405");

// CDP Ed25519
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const jwk = privateKey.export({ format: "jwk" });
const secret = Buffer.concat([Buffer.from(jwk.d, "base64url"), Buffer.from(jwk.x, "base64url")]).toString("base64");
const envC = { PAY_TO: PAY, CDP_API_KEY_ID: "test-key-id", CDP_API_KEY_SECRET: secret };
calls = [];
r = await W.fetch(new Request(base + "/domain?domain=example.com", { headers: { "PAYMENT-SIGNATURE": hdr } }), envC);
ok(r.status === 200 && calls[0].u === "https://api.cdp.coinbase.com/platform/v2/x402/verify", "cdp facilitator used");
const checkJwt = (tok, pub, uri, alg) => { const [h, pl, s] = tok.split("."); const H = JSON.parse(Buffer.from(h, "base64url")), P = JSON.parse(Buffer.from(pl, "base64url"));
  const sigOk = alg === "EdDSA" ? nverify(null, Buffer.from(h + "." + pl), pub, Buffer.from(s, "base64url")) : nverify("sha256", Buffer.from(h + "." + pl), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
  return sigOk && H.alg === alg && H.kid === "test-key-id" && H.nonce.length === 32 && P.iss === "cdp" && P.sub === "test-key-id" && P.uris[0] === uri && P.exp - P.nbf === 120; };
ok(checkJwt(calls[0].init.headers.Authorization.slice(7), publicKey, "POST api.cdp.coinbase.com/platform/v2/x402/verify", "EdDSA"), "Ed25519 JWT valid (verify)");
ok(checkJwt(calls[1].init.headers.Authorization.slice(7), publicKey, "POST api.cdp.coinbase.com/platform/v2/x402/settle", "EdDSA"), "Ed25519 JWT valid (settle)");
const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pem = ec.privateKey.export({ type: "sec1", format: "pem" });
calls = [];
r = await W.fetch(new Request(base + "/domain?domain=example.com", { headers: { "PAYMENT-SIGNATURE": hdr } }), { ...envC, CDP_API_KEY_SECRET: pem.replace(/\n/g, "\\n") });
ok(r.status === 200 && checkJwt(calls[0].init.headers.Authorization.slice(7), ec.publicKey, "POST api.cdp.coinbase.com/platform/v2/x402/verify", "ES256"), "EC SEC1 JWT valid");
const built = await import("node:fs").then((fs) => fs.readFileSync(resolve(process.argv[2]), "utf8"));
ok(!built.includes("console."), "worker has no console logging (no secret leakage path)");
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exitCode = fails ? 1 : 0;
