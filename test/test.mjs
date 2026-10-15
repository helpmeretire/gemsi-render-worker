// Usage: node test/test.mjs ./worker.js /path/bazaar-out.json
import { generateKeyPairSync, verify as nverify } from "node:crypto";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const W = (await import(pathToFileURL(resolve(process.argv[2])).href)).default;
const PAY = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const dec = (h) => JSON.parse(Buffer.from(h, "base64").toString());

// ---- fixtures in ECB's real format ----
const RATES = { USD: "1.0921", JPY: "163.62", CZK: "24.312", DKK: "7.4598", GBP: "0.8663", HUF: "395.10", PLN: "4.2735", RON: "4.9750", SEK: "11.4875", CHF: "0.9410", ISK: "149.30", NOK: "11.7020", TRY: "37.512", AUD: "1.6421", BRL: "6.0125", CAD: "1.5050", CNY: "7.7520", HKD: "8.4910", IDR: "17150.20", ILS: "4.1012", INR: "91.845", KRW: "1480.55", MXN: "20.512", MYR: "4.7110", NZD: "1.8030", PHP: "62.880", SGD: "1.4210", THB: "36.215", ZAR: "19.4810" };
const cubes = (time, scale = 1) => `\t\t<Cube time='${time}'>\n` + Object.entries(RATES).map(([c, r]) => `\t\t\t<Cube currency='${c}' rate='${(Number(r) * scale).toFixed(4)}'/>`).join("\n") + "\n\t\t</Cube>";
const env_ = (body) => `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
\t<gesmes:subject>Reference rates</gesmes:subject>
\t<gesmes:Sender>
\t\t<gesmes:name>European Central Bank</gesmes:name>
\t</gesmes:Sender>
\t<Cube>
${body}
\t</Cube>
</gesmes:Envelope>`;
const DAILY = env_(`\t\t<Cube time='2026-10-14'>\n` + Object.entries(RATES).map(([c, r]) => `\t\t\t<Cube currency='${c}' rate='${r}'/>`).join("\n") + "\n\t\t</Cube>");
// History: build relative to today so the 90-day window test stays valid; find a recent Sunday.
const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
let sun = 3; while (new Date(day(sun) + "T00:00:00Z").getUTCDay() !== 0) sun++;
const SUNDAY = day(sun), FRIDAY = day(sun + 2), MONDAY = day(sun - 1);
const HIST = env_([cubes(MONDAY, 1.01), cubes(FRIDAY, 1.02), cubes(day(sun + 3), 1.03)].join("\n"));

let calls = [], mode = "good", ecbCalls = [];
globalThis.fetch = async (u, init) => {
  u = String(u);
  if (u.startsWith("https://www.ecb.europa.eu/")) {
    ecbCalls.push(u);
    if (mode === "ecbdown") return new Response("Service Unavailable", { status: 503 });
    return new Response(u.endsWith("hist-90d.xml") ? HIST : DAILY, { headers: { "Content-Type": "text/xml" } });
  }
  calls.push({ u, init });
  const op = u.split("/").pop();
  if (mode === "badverify" && op === "verify") return new Response(JSON.stringify({ isValid: false, invalidReason: "insufficient_funds", payer: "0xabc" }), { status: 200 });
  if (mode === "badsettle" && op === "settle") return new Response(JSON.stringify({ success: false, errorReason: "invalid_transaction_state", payer: "0xabc", transaction: "", network: "eip155:8453" }), { status: 400 });
  if (op === "verify") return new Response(JSON.stringify({ isValid: true, payer: "0xabc" }));
  return new Response(JSON.stringify({ success: true, payer: "0xabc", transaction: "0xdeadbeef", network: "eip155:8453" }));
};
const env = { PAY_TO: PAY };
const base = "https://fx.example.workers.dev";
const near = (a, b) => Math.abs(a - b) < 1e-6 * Math.max(1, Math.abs(b));

let r = await W.fetch(new Request(base + "/"), env); let j = await r.json();
ok(r.status === 200 && j.service === "FX Reference Rates" && j.facilitator === "payai" && j.supported_currencies.includes("USD"), "info page");
r = await W.fetch(new Request(base + "/rate?from=USD&to=GBP"), {}); ok(r.status === 402 && dec(r.headers.get("PAYMENT-REQUIRED")).accepts[0].payTo === "0x6f762720b8515b7091e6aa69e8361f7b9909233f", "default wallet used");
r = await W.fetch(new Request(base + "/rate"), env); ok(r.status === 402, "missing params unpaid -> 402 first");
r = await W.fetch(new Request(base + "/rate?from=XXX&to=GBP"), env); ok(r.status === 402, "bad currency unpaid -> 402 first");
r = await W.fetch(new Request(base + "/rate?from=USD&to=GBP"), env);
ok(r.status === 402, "unpaid -> 402");
const pr = dec(r.headers.get("PAYMENT-REQUIRED"));
const a0 = pr.accepts[0];
ok(pr.x402Version === 2 && pr.accepts.length === 1 && a0.scheme === "exact" && a0.amount === "3000" && a0.payTo === PAY && a0.network === "eip155:8453" && a0.asset === "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" && a0.extra.name === "USD Coin", "402 requirements correct (3000, payTo, asset, network)");
ok(pr.resource.url === base + "/rate", "resource url");
ok(pr.extensions.bazaar.info.input.type === "http" && pr.extensions.bazaar.schema.properties.input.required.includes("method"), "bazaar ext present");
writeFileSync(process.argv[3], JSON.stringify(pr.extensions.bazaar));
const payload = { x402Version: 2, resource: pr.resource, accepted: pr.accepts[0], payload: { signature: "0x00", authorization: {} }, extensions: pr.extensions };
const hdr = Buffer.from(JSON.stringify(payload)).toString("base64");
const paid = (q, extra = {}) => W.fetch(new Request(base + "/rate" + q, { ...extra, headers: { "PAYMENT-SIGNATURE": hdr, ...(extra.headers || {}) } }), env);

// bad input with payment -> 400, zero facilitator calls
for (const [q, label] of [["?from=XXX&to=GBP", "unsupported from"], ["?from=USD&to=GBP,ZZZ", "unsupported to"], ["?to=GBP", "missing from"], ["?from=USD", "missing to"], ["?from=USD&to=GBP&amount=abc", "bad amount"], ["?from=USD&to=GBP&date=2026-13-01", "bad date"], ["?from=USD&to=GBP&date=" + day(120), "date older than 90d"], ["?from=USD&to=GBP&date=" + day(-3), "future date"], ["?from=USD&to=" + Object.keys(RATES).join(",") + ",AAA,BBB", "more than 30 targets"]]) {
  calls = []; ecbCalls = [];
  r = await paid(q); j = await r.json();
  ok(r.status === 400 && calls.length === 0 && ecbCalls.length === 0 && /no payment was taken/.test(j.error), `paid + ${label} -> 400, no facilitator call`);
}
calls = []; r = await paid("?from=XYZ&to=GBP"); j = await r.json();
ok(r.status === 400 && Array.isArray(j.supported) && j.supported.includes("JPY") && j.supported.includes("EUR") && calls.length === 0, "unsupported currency lists supported codes");

// happy path
calls = []; ecbCalls = [];
r = await paid("?from=USD&to=GBP,JPY,EUR&amount=100"); j = await r.json();
ok(r.status === 200, "paid -> 200");
ok(dec(r.headers.get("PAYMENT-RESPONSE")).transaction === "0xdeadbeef" && dec(r.headers.get("PAYMENT-RESPONSE")).success === true, "PAYMENT-RESPONSE receipt");
ok(calls.length === 2 && calls[0].u === "https://facilitator.payai.network/verify" && calls[1].u.endsWith("/settle"), "verify then settle via payai");
ok(ecbCalls.length === 1 && ecbCalls[0] === "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml", "daily ECB file used");
const sent = JSON.parse(calls[0].init.body); ok(sent.x402Version === 2 && sent.paymentRequirements.payTo === PAY && sent.paymentPayload.accepted.amount === "3000", "facilitator body shape");
ok(near(j.rates.GBP, 0.8663 / 1.0921) && near(j.rates.JPY, 163.62 / 1.0921) && near(j.rates.EUR, 1 / 1.0921), "cross rates: USD->GBP = GBP/USD " + j.rates.GBP);
ok(near(j.converted.GBP, 100 * 0.8663 / 1.0921) && j.amount === 100, "converted amounts");
ok(j.from === "USD" && j.to.join() === "GBP,JPY,EUR" && j.date === "2026-10-14" && !("requested_date" in j) && j.source === "European Central Bank euro foreign exchange reference rates" && j.source_url.endsWith("eurofxref-daily.xml") && j.disclaimer.startsWith("These reference rates are for information purposes only") && j.disclaimer.endsWith("not official ECB rates.") && j.note, "output fields");
j = await (await paid("?from=eur&to=usd")).json(); ok(j.rates.USD === 1.0921 && j.converted.USD === 1.0921 && j.amount === 1, "EUR as from, default amount, lowercase codes");
j = await (await paid("?from=GBP&to=GBP")).json(); ok(j.rates.GBP === 1, "same currency -> 1");
// historical
ecbCalls = [];
j = await (await paid(`?from=USD&to=GBP&date=${SUNDAY}`)).json();
ok(j.date === FRIDAY && j.requested_date === SUNDAY && j.note.includes("not an ECB publication day") && j.source_url.endsWith("hist-90d.xml") && ecbCalls[0].endsWith("hist-90d.xml"), `non-publication day ${SUNDAY} -> ${FRIDAY}`);
ok(near(j.rates.GBP, Number((0.8663 * 1.02).toFixed(4)) / Number((1.0921 * 1.02).toFixed(4))), "historical cross rate math");
j = await (await paid(`?from=USD&to=GBP&date=${MONDAY}`)).json(); ok(j.date === MONDAY && j.requested_date === MONDAY && !j.note.includes("not an ECB"), "exact publication day");
// POST
r = await paid("", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: "JPY", to: ["USD", "CHF"], amount: 5000 }) }); j = await r.json();
ok(r.status === 200 && near(j.converted.USD, 5000 * 1.0921 / 163.62) && j.to.join() === "USD,CHF", "paid POST works (to as array)");

// failures
const bad = { ...payload, accepted: { ...payload.accepted, amount: "1" } };
r = await W.fetch(new Request(base + "/rate?from=USD&to=GBP", { headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(bad)).toString("base64") } }), env); ok(r.status === 402, "underpaid accepted -> 402");
mode = "badverify"; calls = []; ecbCalls = []; r = await paid("?from=USD&to=GBP"); ok(r.status === 402 && dec(r.headers.get("PAYMENT-REQUIRED")).error === "insufficient_funds" && calls.length === 1 && ecbCalls.length === 0, "verify fail -> 402");
mode = "badsettle"; r = await paid("?from=USD&to=GBP"); j = await r.text(); ok(r.status === 402 && !j.includes("rates") && !j.includes("0.79") && dec(r.headers.get("PAYMENT-RESPONSE")).success === false, "settle fail -> 402, no data leaked");
mode = "ecbdown"; calls = []; r = await paid("?from=USD&to=GBP"); j = await r.json(); ok(r.status === 502 && calls.length === 1 && calls[0].u.endsWith("/verify") && !calls.some((c) => c.u.endsWith("/settle")) && !r.headers.get("PAYMENT-RESPONSE"), "ECB down -> 502, no settle");
mode = "good";

// caches.default guard: works with a stub cache, hits cache on second call
const store = new Map();
globalThis.caches = { default: { match: async (k) => (store.has(k) ? new Response(store.get(k)) : undefined), put: async (k, res) => { store.set(k, await res.text()); } } };
ecbCalls = []; await paid("?from=USD&to=GBP"); await new Promise((s) => setTimeout(s, 10)); await paid("?from=USD&to=GBP");
ok(ecbCalls.length === 1 && store.size === 1, "upstream cached via caches.default");
delete globalThis.caches;

// openapi + POST probe
r = await W.fetch(new Request(base + "/openapi.json"), env); const o = await r.json();
const g = o.paths["/rate"].get, p = o.paths["/rate"].post;
ok(r.status === 200 && o.openapi === "3.1.0" && o.info.title === "FX Reference Rates" && o.info["x-guidance"].includes("$0.003") && g["x-payment-info"].price.amount === "0.003000" && p["x-payment-info"].protocols[0].x402 && p.requestBody.content["application/json"].schema.required.join() === "from,to" && g.parameters.map((x) => x.name).join() === "from,to,amount,date" && g.responses["402"] && p.responses["402"], "openapi.json valid");
r = await W.fetch(new Request(base + "/rate", { method: "POST" }), env); ok(r.status === 402 && r.headers.get("PAYMENT-REQUIRED"), "POST probe without payment -> 402");
r = await W.fetch(new Request(base + "/nope"), env); ok(r.status === 404, "unknown path -> 404");

// CDP Ed25519
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const jwk = privateKey.export({ format: "jwk" });
const secret = Buffer.concat([Buffer.from(jwk.d, "base64url"), Buffer.from(jwk.x, "base64url")]).toString("base64");
const envC = { PAY_TO: PAY, CDP_API_KEY_ID: "test-key-id", CDP_API_KEY_SECRET: secret };
calls = [];
r = await W.fetch(new Request(base + "/rate?from=USD&to=GBP", { headers: { "PAYMENT-SIGNATURE": hdr } }), envC);
ok(r.status === 200 && calls[0].u === "https://api.cdp.coinbase.com/platform/v2/x402/verify", "cdp facilitator used");
const checkJwt = (tok, pub, uri, alg) => { const [h, pl, s] = tok.split("."); const H = JSON.parse(Buffer.from(h, "base64url")), P = JSON.parse(Buffer.from(pl, "base64url"));
  const sigOk = alg === "EdDSA" ? nverify(null, Buffer.from(h + "." + pl), pub, Buffer.from(s, "base64url")) : nverify("sha256", Buffer.from(h + "." + pl), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
  return sigOk && H.alg === alg && H.kid === "test-key-id" && H.nonce.length === 32 && P.iss === "cdp" && P.sub === "test-key-id" && P.uris[0] === uri && P.exp - P.nbf === 120; };
ok(checkJwt(calls[0].init.headers.Authorization.slice(7), publicKey, "POST api.cdp.coinbase.com/platform/v2/x402/verify", "EdDSA"), "Ed25519 JWT valid (verify)");
ok(checkJwt(calls[1].init.headers.Authorization.slice(7), publicKey, "POST api.cdp.coinbase.com/platform/v2/x402/settle", "EdDSA"), "Ed25519 JWT valid (settle)");
const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pem = ec.privateKey.export({ type: "sec1", format: "pem" });
calls = [];
r = await W.fetch(new Request(base + "/rate?from=USD&to=GBP", { headers: { "PAYMENT-SIGNATURE": hdr } }), { ...envC, CDP_API_KEY_SECRET: pem.replace(/\n/g, "\\n") });
ok(r.status === 200 && checkJwt(calls[0].init.headers.Authorization.slice(7), ec.publicKey, "POST api.cdp.coinbase.com/platform/v2/x402/verify", "ES256"), "EC SEC1 JWT valid");
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exitCode = fails ? 1 : 0;
