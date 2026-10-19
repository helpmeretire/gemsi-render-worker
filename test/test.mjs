// Usage: node test/test.mjs ./worker.js /path/bazaar-out.json
import { generateKeyPairSync, verify as nverify } from "node:crypto";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const W = (await import(pathToFileURL(resolve(process.argv[2])).href)).default;
const PAY = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const dec = (h) => JSON.parse(Buffer.from(h, "base64").toString());

// ---- DNS fixtures in Cloudflare's application/dns-json format ----
const dnsOk = (name, type, answers) => ({ Status: 0, TC: false, RD: true, RA: true, AD: false, CD: false, Question: [{ name, type }], Answer: answers });
const nx = (name, type) => ({ Status: 3, TC: false, RD: true, RA: true, AD: false, CD: false, Question: [{ name, type }], Authority: [{ name: "com.", type: 6, TTL: 900, data: "a.gtld-servers.net. nstld.verisign-grs.com. 1 1800 900 604800 86400" }] });
const noData = (name, type) => ({ Status: 0, TC: false, RD: true, RA: true, AD: false, CD: false, Question: [{ name, type }] });
const ZONES = {
  "gmail.com": { MX: [[5, "gmail-smtp-in.l.google.com."], [10, "alt1.gmail-smtp-in.l.google.com."], [20, "alt2.gmail-smtp-in.l.google.com."], [30, "alt3.gmail-smtp-in.l.google.com."], [40, "alt4.gmail-smtp-in.l.google.com."], [50, "alt5.gmail-smtp-in.l.google.com."]], A: ["142.250.1.1"] },
  "mailinator.com": { MX: [[10, "mail2.mailinator.com."], [10, "mail.mailinator.com."]], A: ["104.26.1.1"] },
  "acme-corp.com": { MX: [[10, "aspmx.l.google.com."]], A: ["203.0.113.5"] },
  "aonly.example": { MX: null, A: ["198.51.100.7"] },
  "v6only.example": { MX: null, A: null, AAAA: ["2001:db8::1"] },
  "dead.example": { MX: null, A: null, AAAA: null },
  "nullmx.example": { MX: [[0, "."]], A: ["203.0.113.9"] },
};
let calls = [], mode = "good", dohCalls = [];
globalThis.fetch = async (u, init) => {
  u = String(u);
  if (u.startsWith("https://cloudflare-dns.com/dns-query")) {
    dohCalls.push({ u, init });
    if (mode === "dohdown") return new Response("upstream error", { status: 503 });
    if (mode === "dohhang") return new Promise((_, rej) => { init.signal.addEventListener("abort", () => rej(new DOMException("The operation was aborted", "AbortError"))); });
    if (mode === "dohservfail") return Response.json({ Status: 2, Question: [] });
    const p = new URL(u).searchParams; const name = p.get("name"), type = p.get("type");
    const z = ZONES[name];
    if (!z) return Response.json(nx(name + ".", 15));
    const T = { MX: 15, A: 1, AAAA: 28 }[type];
    const recs = z[type];
    if (!recs) return Response.json(noData(name + ".", T));
    return Response.json(dnsOk(name + ".", T, recs.map((r) => ({ name: name + ".", type: T, TTL: 300, data: Array.isArray(r) ? `${r[0]} ${r[1]}` : r }))));
  }
  calls.push({ u, init });
  const op = u.split("/").pop();
  if (mode === "badverify" && op === "verify") return new Response(JSON.stringify({ isValid: false, invalidReason: "insufficient_funds", payer: "0xabc" }), { status: 200 });
  if (mode === "badsettle" && op === "settle") return new Response(JSON.stringify({ success: false, errorReason: "invalid_transaction_state", payer: "0xabc", transaction: "", network: "eip155:8453" }), { status: 400 });
  if (op === "verify") return new Response(JSON.stringify({ isValid: true, payer: "0xabc" }));
  return new Response(JSON.stringify({ success: true, payer: "0xabc", transaction: "0xdeadbeef", network: "eip155:8453" }));
};
const env = { PAY_TO: PAY };
const base = "https://emailcheck.example.workers.dev";

let r = await W.fetch(new Request(base + "/"), env); let j = await r.json();
ok(r.status === 200 && j.service === "Email Check" && j.facilitator === "payai" && /0\.001/.test(j.price), "info page");
r = await W.fetch(new Request(base + "/verify?email=a@b.co"), {}); ok(r.status === 402 && dec(r.headers.get("PAYMENT-REQUIRED")).accepts[0].payTo === "0x6f762720b8515b7091e6aa69e8361f7b9909233f", "default wallet used");
r = await W.fetch(new Request(base + "/verify"), env); ok(r.status === 402, "missing params unpaid -> 402 first");
r = await W.fetch(new Request(base + "/verify?email=not-an-email"), env); ok(r.status === 402, "bad email unpaid -> 402 first");
r = await W.fetch(new Request(base + "/verify?email=john@gmail.com"), env);
ok(r.status === 402, "unpaid -> 402 probe");
const pr = dec(r.headers.get("PAYMENT-REQUIRED"));
const a0 = pr.accepts[0];
ok(pr.x402Version === 2 && pr.accepts.length === 1 && a0.scheme === "exact" && a0.amount === "1000" && a0.payTo === PAY && a0.network === "eip155:8453" && a0.asset === "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" && a0.extra.name === "USD Coin", "402 requirements correct (1000, payTo, asset, network)");
ok(pr.resource.url === base + "/verify", "resource url");
ok(pr.extensions.bazaar.info.input.type === "http" && pr.extensions.bazaar.schema.properties.input.required.includes("method") && pr.extensions.bazaar.info.output.example.results[0].risk === "low", "bazaar ext present");
ok(JSON.parse(await r.text()).error === "PAYMENT-SIGNATURE header is required", "402 body carries error");
writeFileSync(process.argv[3], JSON.stringify(pr.extensions.bazaar));
const payload = { x402Version: 2, resource: pr.resource, accepted: pr.accepts[0], payload: { signature: "0x00", authorization: {} }, extensions: pr.extensions };
const hdr = Buffer.from(JSON.stringify(payload)).toString("base64");
const paid = (q, extra = {}) => W.fetch(new Request(base + "/verify" + q, { ...extra, headers: { "PAYMENT-SIGNATURE": hdr, ...(extra.headers || {}) } }), env);
const post = (body) => paid("", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// bad input with payment -> 400, zero facilitator calls, zero DNS calls
const many = Array.from({ length: 21 }, (_, i) => `user${i}@gmail.com`);
for (const [fn, label] of [
  [() => paid(""), "missing email"],
  [() => paid("?email="), "empty email"],
  [() => paid("?emails=" + many.join(",")), "21 emails via GET"],
  [() => post({ emails: many }), "21 emails via POST"],
  [() => post({ email: 42 }), "email not a string"],
  [() => post({ emails: ["a@b.co", 7] }), "emails item not a string"],
  [() => post({ emails: ["a@b.co", "  "] }), "emails item blank"],
  [() => post({ emails: {} }), "emails is an object"],
  [() => paid("?email=" + "a".repeat(330) + "@x.com"), "email over 320 chars"],
]) {
  calls = []; dohCalls = [];
  r = await fn(); j = await r.json().catch(() => ({}));
  ok(r.status === 400 && calls.length === 0 && dohCalls.length === 0 && /no payment was taken/.test(j.error), `paid + ${label} -> 400, no facilitator or DNS call`);
}
// oversized body -> 413 before any payment work
calls = []; dohCalls = [];
r = await post({ emails: ["a@b.co"], pad: "z".repeat(20000) }); j = await r.json();
ok(r.status === 413 && calls.length === 0 && dohCalls.length === 0 && /no payment was taken/.test(j.error), "oversized POST -> 413, no calls");
r = await W.fetch(new Request(base + "/verify?email=a@b.co", { headers: { "PAYMENT-SIGNATURE": "!!!not-base64!!!" } }), env); ok(r.status === 400, "garbage payment header -> 400");

// happy path: a good gmail address (with dots and +tag -> normalized)
calls = []; dohCalls = [];
r = await paid("?email=John.Doe%2Bnews@gmail.com"); j = await r.json();
ok(r.status === 200, "paid -> 200");
ok(dec(r.headers.get("PAYMENT-RESPONSE")).transaction === "0xdeadbeef" && dec(r.headers.get("PAYMENT-RESPONSE")).success === true, "PAYMENT-RESPONSE receipt");
ok(calls.length === 2 && calls[0].u === "https://facilitator.payai.network/verify" && calls[1].u.endsWith("/settle"), "verify then settle via payai");
const sent = JSON.parse(calls[0].init.body); ok(sent.x402Version === 2 && sent.paymentRequirements.payTo === PAY && sent.paymentPayload.accepted.amount === "1000", "facilitator body shape");
ok(dohCalls.length === 1 && dohCalls[0].u === "https://cloudflare-dns.com/dns-query?name=gmail.com&type=MX" && dohCalls[0].init.headers.accept === "application/dns-json" && dohCalls[0].init.headers["User-Agent"] === "NoJunk Email Check/1.0 (+https://nojunkcrypto.com)" && dohCalls[0].init.signal, "DoH MX query shape (accept header, UA, abort signal)");
let e = j.results[0];
ok(j.count === 1 && j.results.length === 1 && e.email === "John.Doe+news@gmail.com" && e.normalized_email === "johndoe@gmail.com" && e.valid_syntax === true && e.domain === "gmail.com", "gmail: fields, normalized (dots + plus removed)");
ok(e.has_mx === true && e.mx_hosts.length === 5 && e.mx_hosts[0] === "gmail-smtp-in.l.google.com" && e.mx_hosts[1] === "alt1.gmail-smtp-in.l.google.com" && !e.mx_hosts.some((h) => h.endsWith(".")), "gmail: MX hosts sorted by priority, capped at 5, trailing dot stripped");
ok(e.disposable === false && e.role === false && e.free_provider === true && e.suggestion === null && e.risk === "low" && e.reasons.join() === "free_provider", "gmail: low risk, free_provider flag");
ok(Object.keys(e).join() === "email,normalized_email,valid_syntax,domain,has_mx,mx_hosts,disposable,role,free_provider,suggestion,risk,reasons", "result has exactly the specified fields");

// disposable address
j = await (await paid("?email=throwaway@mailinator.com")).json(); e = j.results[0];
ok(e.disposable === true && e.risk === "high" && e.reasons.includes("disposable_domain") && e.has_mx === true && e.free_provider === false, "disposable domain -> high risk");

// typo suggestion
dohCalls = [];
j = await (await paid("?email=Jane@gmial.com")).json(); e = j.results[0];
ok(e.suggestion === "jane@gmail.com" && e.has_mx === false && e.reasons.includes("domain_not_found") && e.reasons.includes("possible_typo") && e.risk === "high", "gmial.com -> suggestion jane@gmail.com, NXDOMAIN high risk");
ok(dohCalls.length === 1 && dohCalls[0].u.includes("name=gmial.com&type=MX"), "NXDOMAIN stops after the MX query (no A/AAAA lookups)");
j = await (await paid("?email=bob@hotmal.com")).json(); ok(j.results[0].suggestion === "bob@hotmail.com", "hotmal.com -> hotmail.com");
j = await (await paid("?email=bob@yaho.com")).json(); ok(j.results[0].suggestion === "bob@yahoo.com", "yaho.com -> yahoo.com");
j = await (await paid("?email=bob@outlok.com")).json(); ok(j.results[0].suggestion === "bob@outlook.com", "outlok.com -> outlook.com");
j = await (await paid("?email=bob@acme-corp.com")).json(); ok(j.results[0].suggestion === null && j.results[0].risk === "low" && j.results[0].free_provider === false && j.results[0].has_mx === true, "real business domain: no suggestion, low risk");
j = await (await paid("?email=bob@mail.com")).json(); ok(j.results[0].suggestion === null && j.results[0].free_provider === true, "mail.com is a real provider, not a typo of gmail.com");

// role address
j = await (await paid("?email=Support@acme-corp.com")).json(); e = j.results[0];
ok(e.role === true && e.risk === "medium" && e.reasons.join() === "role_address" && e.normalized_email === "support@acme-corp.com", "support@ -> role, medium risk");
for (const [l, want] of [["admin", true], ["info", true], ["noreply", true], ["no-reply", true], ["NoReply-Billing", true], ["postmaster", true], ["abuse", true], ["webmaster", true], ["billing", true], ["hello", true], ["sales", true], ["jsmith", false], ["mick", false]]) {
  j = await (await paid(`?email=${l}@acme-corp.com`)).json();
  ok(j.results[0].role === want, `role detection ${l}@ -> ${want}`);
}

// no MX but A record
dohCalls = [];
j = await (await paid("?email=someone@aonly.example")).json(); e = j.results[0];
ok(e.has_mx === false && e.mx_hosts.length === 0 && e.risk === "medium" && e.reasons.join() === "no_mx_fallback_a", "no MX + A record -> has_mx false, medium risk, fallback reason");
ok(dohCalls.length === 2 && dohCalls[0].u.includes("type=MX") && dohCalls[1].u.includes("type=A") && !dohCalls[1].u.includes("AAAA"), "A fallback queried after MX");
dohCalls = [];
j = await (await paid("?email=someone@v6only.example")).json(); e = j.results[0];
ok(e.has_mx === false && e.risk === "medium" && e.reasons.join() === "no_mx_fallback_aaaa" && dohCalls.length === 3, "no MX, no A, AAAA -> fallback aaaa after 3 queries");
j = await (await paid("?email=someone@dead.example")).json(); e = j.results[0];
ok(e.has_mx === false && e.risk === "high" && e.reasons.join() === "no_mx_or_address_records", "no MX/A/AAAA -> high risk");
j = await (await paid("?email=someone@nullmx.example")).json(); e = j.results[0];
ok(e.has_mx === false && e.mx_hosts.length === 0 && e.risk === "high" && e.reasons.join() === "null_mx_domain_refuses_mail", "null MX (RFC 7505) -> high risk");

// syntax: invalid addresses are results, not errors
calls = []; dohCalls = [];
r = await post({ emails: ["not-an-email", "a@@b.com", "a@localhost", "a b@gmail.com", ".dot@gmail.com", "dot.@gmail.com", "a..b@gmail.com", "a@gmail..com", "a@-bad.com", "a@gmail.c0m", "\"quoted name\"@gmail.com", "o'brien@gmail.com", "x@gmail.com."] }); j = await r.json();
ok(r.status === 200 && j.count === 13, "batch of syntax cases -> 200");
const bad = j.results.filter((x) => !x.valid_syntax).map((x) => x.email);
ok(bad.join("|") === ["not-an-email", "a@@b.com", "a@localhost", "a b@gmail.com", ".dot@gmail.com", "dot.@gmail.com", "a..b@gmail.com", "a@gmail..com", "a@-bad.com", "a@gmail.c0m", "x@gmail.com."].join("|"), "invalid syntax cases flagged: " + bad.join(", "));
ok(j.results.filter((x) => x.valid_syntax).map((x) => x.email).join("|") === "\"quoted name\"@gmail.com|o'brien@gmail.com", "quoted-string and apostrophe local parts accepted");
e = j.results[0]; ok(e.valid_syntax === false && e.risk === "high" && e.reasons.join() === "invalid_syntax" && e.normalized_email === null && e.domain === null && e.has_mx === false && e.suggestion === null, "invalid syntax -> high risk, null normalized/domain");
ok(dohCalls.length === 1 && dohCalls[0].u.includes("name=gmail.com"), "only syntactically valid domains resolved, each domain once");
ok(calls.length === 2, "batch still settles once");

// batch of 3 (POST emails array), mixed outcomes, same single payment
calls = []; dohCalls = [];
r = await post({ emails: ["Good.User@gmail.com", "temp@mailinator.com", "info@gmial.com"] }); j = await r.json();
ok(r.status === 200 && j.count === 3 && j.results.length === 3, "batch of 3 -> 200 with 3 results");
ok(j.results[0].email === "Good.User@gmail.com" && j.results[0].risk === "low" && j.results[1].disposable === true && j.results[1].risk === "high" && j.results[2].suggestion === "info@gmail.com" && j.results[2].role === true, "batch order preserved, per-result flags correct");
ok(calls.length === 2 && JSON.parse(calls[1].init.body).paymentPayload.accepted.amount === "1000", "batch of 3 charged once at 1000");
ok(dohCalls.length === 3, "batch: one MX lookup per unique domain (gmial NXDOMAIN, no fallback)");
// GET comma-separated emails + email combined
j = await (await paid("?email=a@gmail.com&emails=b@gmail.com,c@acme-corp.com")).json();
ok(j.count === 3 && j.results.map((x) => x.email).join() === "a@gmail.com,b@gmail.com,c@acme-corp.com", "GET email + emails csv combined");
r = await post({ emails: Array.from({ length: 20 }, (_, i) => `u${i}@gmail.com`) }); j = await r.json(); ok(r.status === 200 && j.count === 20, "exactly 20 emails accepted");
// normalization details
j = await (await post({ emails: ["Mick+promo@Outlook.com", "x.y@googlemail.com", "Jane.Doe+x@acme-corp.com", "A.B@yahoo.com"] })).json();
ok(j.results[0].normalized_email === "mick@outlook.com" && j.results[1].normalized_email === "xy@gmail.com" && j.results[2].normalized_email === "jane.doe+x@acme-corp.com" && j.results[3].normalized_email === "a.b@yahoo.com", "normalization: outlook plus stripped, googlemail -> gmail, business domain untouched, yahoo dots kept");

// failures
const under = { ...payload, accepted: { ...payload.accepted, amount: "1" } };
r = await W.fetch(new Request(base + "/verify?email=a@gmail.com", { headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(under)).toString("base64") } }), env); ok(r.status === 402, "underpaid accepted -> 402");
mode = "badverify"; calls = []; dohCalls = []; r = await paid("?email=a@gmail.com"); ok(r.status === 402 && dec(r.headers.get("PAYMENT-REQUIRED")).error === "insufficient_funds" && calls.length === 1 && dohCalls.length === 0, "verify fail -> 402, no DNS work");
mode = "badsettle"; r = await paid("?email=a@gmail.com"); j = await r.text(); ok(r.status === 402 && j.trim() === "{}" && !j.includes("gmail") && dec(r.headers.get("PAYMENT-RESPONSE")).success === false, "settle fail -> 402 empty body, no data leaked");
mode = "dohdown"; calls = []; r = await paid("?email=a@gmail.com"); j = await r.json(); ok(r.status === 502 && calls.length === 1 && calls[0].u.endsWith("/verify") && !calls.some((c) => c.u.endsWith("/settle")) && !r.headers.get("PAYMENT-RESPONSE") && /no payment was taken/.test(j.error), "DoH 503 -> 502, no settle");
mode = "dohservfail"; calls = []; r = await paid("?email=a@gmail.com"); ok(r.status === 502 && calls.length === 1, "DoH SERVFAIL -> 502, no settle");
mode = "dohdown"; calls = []; r = await post({ emails: ["a@gmail.com", "b@acme-corp.com"] }); ok(r.status === 502 && calls.length === 1, "batch with DoH down -> 502, not settled");
mode = "dohhang"; calls = [];
{
  const realST = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...a) => realST(fn, ms >= 5000 ? 20 : ms, ...a); // fast-forward the 5s DoH timeout
  r = await paid("?email=a@gmail.com"); j = await r.json();
  globalThis.setTimeout = realST;
  ok(r.status === 502 && calls.length === 1 && /abort/i.test(j.detail) && !r.headers.get("PAYMENT-RESPONSE"), "DoH timeout (abort) -> 502, no settle");
}
mode = "good";

// caches.default guard: works with a stub cache, hits cache on second call
const store = new Map();
globalThis.caches = { default: { match: async (k) => (store.has(k) ? new Response(store.get(k)) : undefined), put: async (k, res) => { store.set(k, await res.text()); } } };
dohCalls = []; await paid("?email=a@acme-corp.com"); await new Promise((s) => setTimeout(s, 10)); j = await (await paid("?email=b@acme-corp.com")).json();
ok(dohCalls.length === 1 && store.size === 1 && j.results[0].has_mx === true, "DoH answers cached via caches.default");
delete globalThis.caches;

// openapi + POST probe
r = await W.fetch(new Request(base + "/openapi.json"), env); const o = await r.json();
const g = o.paths["/verify"].get, p = o.paths["/verify"].post;
ok(r.status === 200 && o.openapi === "3.1.0" && o.info.title === "Email Check" && o.info["x-guidance"].includes("$0.001") && g["x-payment-info"].price.amount === "0.001000" && g["x-payment-info"].price.mode === "fixed" && p["x-payment-info"].protocols[0].x402 && p.requestBody.content["application/json"].schema.properties.emails.maxItems === 20 && g.parameters.map((x) => x.name).join() === "email,emails" && g.responses["402"] && p.responses["402"] && g.responses["502"], "openapi.json valid");
r = await W.fetch(new Request(base + "/verify", { method: "POST" }), env); ok(r.status === 402 && r.headers.get("PAYMENT-REQUIRED"), "POST probe without payment -> 402");
r = await W.fetch(new Request(base + "/nope"), env); ok(r.status === 404, "unknown path -> 404");
r = await W.fetch(new Request(base + "/verify", { method: "PUT" }), env); ok(r.status === 405, "PUT -> 405");
r = await W.fetch(new Request(base + "/verify", { method: "OPTIONS" }), env); ok(r.status === 200 && r.headers.get("Access-Control-Allow-Headers").includes("PAYMENT-SIGNATURE"), "CORS preflight");
r = await W.fetch(new Request(base + "/verify?email=a@gmail.com"), env); ok(r.headers.get("Access-Control-Expose-Headers").includes("PAYMENT-REQUIRED") && r.headers.get("Access-Control-Allow-Origin") === "*", "CORS headers on responses");
const src = (await import("node:fs")).readFileSync(resolve(process.argv[2]), "utf8");
ok(!/console\.(log|error|warn)/.test(src), "worker never logs");

// CDP Ed25519
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const jwk = privateKey.export({ format: "jwk" });
const secret = Buffer.concat([Buffer.from(jwk.d, "base64url"), Buffer.from(jwk.x, "base64url")]).toString("base64");
const envC = { PAY_TO: PAY, CDP_API_KEY_ID: "test-key-id", CDP_API_KEY_SECRET: secret };
calls = [];
r = await W.fetch(new Request(base + "/verify?email=a@gmail.com", { headers: { "PAYMENT-SIGNATURE": hdr } }), envC);
ok(r.status === 200 && calls[0].u === "https://api.cdp.coinbase.com/platform/v2/x402/verify", "cdp facilitator used");
const checkJwt = (tok, pub, uri, alg) => { const [h, pl, s] = tok.split("."); const H = JSON.parse(Buffer.from(h, "base64url")), P = JSON.parse(Buffer.from(pl, "base64url"));
  const sigOk = alg === "EdDSA" ? nverify(null, Buffer.from(h + "." + pl), pub, Buffer.from(s, "base64url")) : nverify("sha256", Buffer.from(h + "." + pl), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
  return sigOk && H.alg === alg && H.kid === "test-key-id" && H.nonce.length === 32 && P.iss === "cdp" && P.sub === "test-key-id" && P.uris[0] === uri && P.exp - P.nbf === 120; };
ok(checkJwt(calls[0].init.headers.Authorization.slice(7), publicKey, "POST api.cdp.coinbase.com/platform/v2/x402/verify", "EdDSA"), "Ed25519 JWT valid (verify)");
ok(checkJwt(calls[1].init.headers.Authorization.slice(7), publicKey, "POST api.cdp.coinbase.com/platform/v2/x402/settle", "EdDSA"), "Ed25519 JWT valid (settle)");
const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pem = ec.privateKey.export({ type: "sec1", format: "pem" });
calls = [];
r = await W.fetch(new Request(base + "/verify?email=a@gmail.com", { headers: { "PAYMENT-SIGNATURE": hdr } }), { ...envC, CDP_API_KEY_SECRET: pem.replace(/\n/g, "\\n") });
ok(r.status === 200 && checkJwt(calls[0].init.headers.Authorization.slice(7), ec.publicKey, "POST api.cdp.coinbase.com/platform/v2/x402/verify", "ES256"), "EC SEC1 JWT valid");
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exitCode = fails ? 1 : 0;
