// Usage: node test/test.mjs ./worker.js /path/bazaar-out.json
import { generateKeyPairSync, verify as nverify } from "node:crypto";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const W = (await import(pathToFileURL(resolve(process.argv[2])).href)).default;
const PAY = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const SENT = "@cf/huggingface/distilbert-sst-2-int8", GUARD = "@cf/meta/llama-guard-3-8b", RERANK = "@cf/baai/bge-reranker-base", LLM = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const dec = (h) => JSON.parse(Buffer.from(h, "base64").toString());

// ---- facilitator mock (never hits the network) ----
let calls = [], mode = "good", otherFetch = [];
globalThis.fetch = async (u, init) => {
  u = String(u);
  if (!u.startsWith("https://facilitator.payai.network/") && !u.startsWith("https://api.cdp.coinbase.com/")) { otherFetch.push(u); throw new Error("unexpected network call " + u); }
  calls.push({ u, init });
  const op = u.split("/").pop();
  if (mode === "badverify" && op === "verify") return new Response(JSON.stringify({ isValid: false, invalidReason: "insufficient_funds", payer: "0xabc" }), { status: 200 });
  if (mode === "badsettle" && op === "settle") return new Response(JSON.stringify({ success: false, errorReason: "invalid_transaction_state", payer: "0xabc", transaction: "", network: "eip155:8453" }), { status: 400 });
  if (op === "verify") return new Response(JSON.stringify({ isValid: true, payer: "0xabc" }));
  return new Response(JSON.stringify({ success: true, payer: "0xabc", transaction: "0xdeadbeef", network: "eip155:8453" }));
};
const settled = () => calls.length === 2 && calls[0].u.endsWith("/verify") && calls[1].u.endsWith("/settle");
const verifiedOnly = () => calls.length === 1 && calls[0].u.endsWith("/verify");

// ---- Workers AI mock: switch on model name; per-model override or failure ----
const ai = { calls: [], fail: new Set(), reply: {} };
const defaults = {
  [SENT]: (i) => (/bad|worst|crushed|hate/i.test(i.text) ? [{ label: "NEGATIVE", score: 0.9988 }, { label: "POSITIVE", score: 0.0012 }] : [{ label: "POSITIVE", score: 0.9994 }, { label: "NEGATIVE", score: 0.0006 }]),
  [GUARD]: () => ({ response: "safe" }),
  [RERANK]: (i) => ({ response: i.contexts.map((c, id) => ({ id, score: /password/i.test(c.text) ? 0.98 : 0.03 + id / 1000 })) }),
  [LLM]: (i) => ({ response: /language identification/i.test(i.messages[0].content) ? { languages: [{ code: "es", confidence: 0.99 }, { code: "pt", confidence: 0.01 }] } : { entities: [] } }),
};
const AI = {
  run: async (model, input) => {
    ai.calls.push({ model, input });
    if (ai.fail.has(model)) throw new Error("model error " + model);
    const rep = ai.reply[model] || defaults[model];
    if (!rep) throw new Error("unexpected model " + model);
    return typeof rep === "function" ? rep(input, model) : rep;
  },
};
const reset = () => { calls = []; ai.calls = []; ai.fail = new Set(); ai.reply = {}; mode = "good"; };
const env = { PAY_TO: PAY, AI };
const base = "https://moderate.example.workers.dev";
const post = (path, body, extra = {}) => W.fetch(new Request(base + path, { method: "POST", body: JSON.stringify(body), ...extra, headers: { "Content-Type": "application/json", ...(extra.headers || {}) } }), extra.env || env);
const ROUTES = ["/sentiment", "/safety", "/rerank", "/pii", "/language"];
const PRICES = { "/sentiment": "1000", "/safety": "2000", "/rerank": "2000", "/pii": "3000", "/language": "1000" };
const USD = { "/sentiment": "0.001000", "/safety": "0.002000", "/rerank": "0.002000", "/pii": "0.003000", "/language": "0.001000" };
const GOOD = { "/sentiment": { text: "Great service" }, "/safety": { text: "Hello there" }, "/rerank": { query: "q", documents: ["a", "b"] }, "/pii": { text: "Mail me at a@b.co" }, "/language": { text: "Hola amigo" } };

// ---- free routes ----
let r = await W.fetch(new Request(base + "/"), env); let j = await r.json();
ok(r.status === 200 && j.service === "Text Moderation" && j.facilitator === "payai" && j.configured === true && Object.keys(j.endpoints).join() === ROUTES.join() && j.endpoints["/pii"].price.startsWith("$0.003") && j.endpoints["/sentiment"].price.startsWith("$0.001") && j.endpoints["/safety"].price.startsWith("$0.002") && j.endpoints["/rerank"].price.startsWith("$0.002") && j.endpoints["/language"].price.startsWith("$0.001") && j.description.startsWith("Content moderation and text analysis"), "info page lists 5 routes with prices + description");
ok(j.endpoints["/sentiment"].methods.join() === "GET,POST" && j.safety_categories.S14 === "Code Interpreter Abuse" && j.pii_types.regex.includes("credit_card") && j.pii_types.llm.includes("name") && j.limits.max_text_chars === 20000 && j.limits.max_request_bytes === 131072, "info page: methods, categories, pii types, limits");
r = await W.fetch(new Request(base + "/"), { PAY_TO: PAY }); ok(r.status === 200 && (await r.json()).configured === false && ai.calls.length === 0, "info page without AI -> configured false");
reset(); r = await W.fetch(new Request(base + "/health"), env); j = await r.json(); ok(r.status === 200 && j.status === "ok" && j.ai_binding === true && ai.calls.length === 0 && calls.length === 0, "health: ai_binding true, no model call, no facilitator");
reset(); r = await W.fetch(new Request(base + "/health"), { PAY_TO: PAY }); j = await r.json(); ok(r.status === 200 && j.status === "misconfigured" && j.ai_binding === false, "health: ai_binding false when AI missing");
r = await W.fetch(new Request(base + "/sentiment", { method: "POST" }), { AI }); ok(r.status === 402 && dec(r.headers.get("PAYMENT-REQUIRED")).accepts[0].payTo === "0x6f762720b8515b7091e6aa69e8361f7b9909233f", "default wallet used");
r = await W.fetch(new Request(base + "/sentiment", { method: "POST", body: "not json" }), env); ok(r.status === 402, "bad input unpaid -> 402 first");
r = await W.fetch(new Request(base + "/sentiment?text="), env); ok(r.status === 402 && r.headers.get("PAYMENT-REQUIRED") && r.headers.get("Access-Control-Expose-Headers").includes("PAYMENT-REQUIRED"), "GET probe without payment -> 402 + CORS expose");
r = await W.fetch(new Request(base + "/nope", { method: "POST" }), env); ok(r.status === 404, "unknown path -> 404");
r = await W.fetch(new Request(base + "/sentiment", { method: "PUT" }), env); ok(r.status === 405, "PUT -> 405");
r = await W.fetch(new Request(base + "/sentiment", { method: "OPTIONS" }), env); ok(r.status === 200 && r.headers.get("Access-Control-Allow-Headers").includes("PAYMENT-SIGNATURE") && r.headers.get("Access-Control-Allow-Methods").includes("POST") && r.headers.get("Access-Control-Allow-Origin") === "*", "OPTIONS CORS");
reset(); r = await W.fetch(new Request(base + "/sentiment", { method: "POST", headers: { "content-length": String(129 * 1024) } }), env); ok(r.status === 413 && calls.length === 0 && ai.calls.length === 0, "oversized content-length -> 413 before 402");
reset(); r = await W.fetch(new Request(base + "/sentiment", { method: "POST" }), { PAY_TO: PAY }); j = await r.json(); ok(r.status === 500 && /AI/.test(j.error) && calls.length === 0, "env.AI missing -> 500 misconfigured, zero facilitator calls");
reset(); r = await W.fetch(new Request(base + "/pii", { method: "POST" }), { PAY_TO: PAY, AI: {} }); ok(r.status === 500 && calls.length === 0, "env.AI without run() -> 500");
r = await W.fetch(new Request(base + "/sentiment", { method: "POST" }), { PAY_TO: "nope", AI }); ok(r.status === 500, "bad PAY_TO -> 500");

// ---- 402 probes: per-route amount + resource url + bazaar ----
const prs = {}, payloads = {}, hdrs = {};
for (const route of ROUTES) {
  r = await W.fetch(new Request(base + route, { method: "POST" }), env);
  const pr = dec(r.headers.get("PAYMENT-REQUIRED")); prs[route] = pr;
  const a0 = pr.accepts[0];
  ok(r.status === 402 && pr.x402Version === 2 && pr.accepts.length === 1 && a0.scheme === "exact" && a0.amount === PRICES[route] && a0.payTo === PAY && a0.network === "eip155:8453" && a0.asset === "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" && a0.extra.name === "USD Coin" && a0.extra.version === "2" && a0.maxTimeoutSeconds === 300, `${route} 402 requirements (amount ${PRICES[route]})`);
  ok(pr.resource.url === base + route && pr.resource.mimeType === "application/json" && pr.resource.description.includes(route.slice(1)) && pr.error === "PAYMENT-SIGNATURE header is required", `${route} resource url + error`);
  const bz = pr.extensions.bazaar;
  ok(bz.info.input.type === "http" && bz.info.input.method === "POST" && bz.info.input.bodyType === "json" && typeof bz.info.input.body === "object" && bz.info.output.type === "json" && bz.schema.properties.input.required.includes("body") && bz.schema.properties.input.properties.body.type === "object", `${route} bazaar ext with POST json body`);
  ok(!JSON.stringify(pr).includes("TEXT START") && !JSON.stringify(pr).includes("untrusted"), `${route} 402 does not leak prompt`);
  ok(JSON.stringify(dec(r.headers.get("PAYMENT-REQUIRED"))) === JSON.stringify(await r.json()), `${route} header and body carry the same PAYMENT-REQUIRED`);
  payloads[route] = { x402Version: 2, resource: pr.resource, accepted: pr.accepts[0], payload: { signature: "0x00", authorization: {} }, extensions: pr.extensions };
  hdrs[route] = Buffer.from(JSON.stringify(payloads[route])).toString("base64");
}
ok(prs["/rerank"].extensions.bazaar.info.input.body.documents.length === 3 && prs["/pii"].extensions.bazaar.info.output.example.redacted.includes("[EMAIL]") && prs["/safety"].extensions.bazaar.info.output.example.categories[0].code === "S2" && prs["/language"].extensions.bazaar.info.output.example.code === "es" && prs["/sentiment"].extensions.bazaar.info.output.example.results.length === 2, "bazaar examples are route specific");
writeFileSync(process.argv[3], JSON.stringify(prs["/sentiment"].extensions.bazaar));
const paid = (route, body, extra = {}) => post(route, body, { ...extra, headers: { "PAYMENT-SIGNATURE": hdrs[route], ...(extra.headers || {}) } });
const paidGet = (route, qs, extra = {}) => W.fetch(new Request(base + route + "?" + qs, { headers: { "PAYMENT-SIGNATURE": hdrs[route], ...(extra.headers || {}) } }), extra.env || env);

// ---- paying with another route's requirements -> 402, nothing called ----
for (let i = 0; i < ROUTES.length; i++) {
  const route = ROUTES[i], other = ROUTES[(i + 1) % ROUTES.length];
  reset();
  r = await post(route, GOOD[route], { headers: { "PAYMENT-SIGNATURE": hdrs[other] } });
  const pr = dec(r.headers.get("PAYMENT-REQUIRED"));
  ok(r.status === 402 && pr.error === "No matching payment requirements found" && pr.accepts[0].amount === PRICES[route] && pr.resource.url === base + route && calls.length === 0 && ai.calls.length === 0, `${route} paid with ${other} requirements -> 402 (re-advertises ${PRICES[route]}), nothing called`);
}
reset(); r = await post("/rerank", GOOD["/rerank"], { headers: { "PAYMENT-SIGNATURE": hdrs["/safety"] } }); ok(r.status === 402 && calls.length === 0 && ai.calls.length === 0, "same-price pair: /rerank paid with /safety payment (both 2000) -> 402 via resource url");
reset(); r = await post("/language", GOOD["/language"], { headers: { "PAYMENT-SIGNATURE": hdrs["/sentiment"] } }); ok(r.status === 402 && calls.length === 0, "same-price pair: /language paid with /sentiment payment (both 1000) -> 402");
reset(); const noRes = { ...payloads["/rerank"] }; delete noRes.resource;
r = await post("/rerank", GOOD["/rerank"], { headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(noRes)).toString("base64") } }); ok(r.status === 200 && settled(), "payload without resource but matching requirements is accepted");
reset(); const otherHost = { ...payloads["/rerank"], resource: { ...payloads["/rerank"].resource, url: "https://custom.nojunkcrypto.com/rerank/" } };
r = await post("/rerank", GOOD["/rerank"], { headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(otherHost)).toString("base64") } }); ok(r.status === 200 && settled(), "resource url on another host but same path is accepted");
reset(); const under = { ...payloads["/pii"], accepted: { ...payloads["/pii"].accepted, amount: "1" } };
r = await post("/pii", GOOD["/pii"], { headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(under)).toString("base64") } }); ok(r.status === 402 && calls.length === 0 && ai.calls.length === 0, "underpaid accepted -> 402");
reset(); const otherWallet = { ...payloads["/pii"], accepted: { ...payloads["/pii"].accepted, payTo: "0x0000000000000000000000000000000000000001" } };
r = await post("/pii", GOOD["/pii"], { headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(otherWallet)).toString("base64") } }); ok(r.status === 402 && calls.length === 0, "wrong payTo -> 402");
reset(); const v1 = { ...payloads["/pii"], x402Version: 1 };
r = await post("/pii", GOOD["/pii"], { headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(v1)).toString("base64") } }); ok(r.status === 402 && calls.length === 0, "x402Version 1 -> 402");
reset(); r = await post("/sentiment", GOOD["/sentiment"], { headers: { "PAYMENT-SIGNATURE": "!!!notbase64" } }); ok(r.status === 400 && calls.length === 0 && ai.calls.length === 0, "garbage payment header -> 400");
reset(); r = await post("/sentiment", GOOD["/sentiment"], { headers: { "X-PAYMENT": hdrs["/sentiment"] } }); ok(r.status === 200 && settled(), "legacy X-PAYMENT header accepted");

// ---- bad input with payment -> 400 (no AI, no facilitator) ----
const LONG = "x".repeat(20001);
const badCases = [
  ["/sentiment", {}, "missing text"],
  ["/sentiment", { text: "" }, "empty text"],
  ["/sentiment", { text: "   \n " }, "whitespace-only text"],
  ["/sentiment", { text: 42 }, "non-string text"],
  ["/sentiment", { text: LONG }, "text 20,001 chars (400 not 413)"],
  ["/sentiment", { texts: [] }, "empty texts"],
  ["/sentiment", { texts: "a,b" }, "texts as string"],
  ["/sentiment", { texts: Array.from({ length: 51 }, (_, i) => "t" + i) }, "51 texts"],
  ["/sentiment", { texts: ["ok", 5] }, "non-string item in texts"],
  ["/sentiment", { texts: ["ok", ""] }, "empty item in texts"],
  ["/sentiment", { texts: ["ok", LONG] }, "one long item in texts"],
  ["/safety", {}, "missing text/messages"],
  ["/safety", { text: LONG }, "safety text too long"],
  ["/safety", { messages: [] }, "empty messages"],
  ["/safety", { messages: "hi" }, "messages as string"],
  ["/safety", { messages: Array.from({ length: 21 }, () => ({ role: "user", content: "x" })) }, "21 messages"],
  ["/safety", { messages: [{ role: "system", content: "x" }] }, "bad role"],
  ["/safety", { messages: [{ role: "user" }] }, "missing content"],
  ["/safety", { messages: [{ role: "user", content: "" }] }, "empty content"],
  ["/safety", { messages: ["hi"] }, "message not an object"],
  ["/safety", { messages: [{ role: "user", content: "y".repeat(15000) }, { role: "assistant", content: "z".repeat(6000) }] }, "messages combined > 20,000"],
  ["/rerank", { documents: ["a"] }, "missing query"],
  ["/rerank", { query: "", documents: ["a"] }, "empty query"],
  ["/rerank", { query: "q".repeat(2001), documents: ["a"] }, "query 2,001 chars"],
  ["/rerank", { query: "q" }, "missing documents"],
  ["/rerank", { query: "q", documents: [] }, "empty documents"],
  ["/rerank", { query: "q", documents: "a" }, "documents as string"],
  ["/rerank", { query: "q", documents: Array.from({ length: 101 }, (_, i) => "d" + i) }, "101 documents"],
  ["/rerank", { query: "q", documents: ["a", 7] }, "non-string document"],
  ["/rerank", { query: "q", documents: [{ id: "x" }] }, "document object without text"],
  ["/rerank", { query: "q", documents: [{ id: {}, text: "a" }] }, "document id not string/number"],
  ["/rerank", { query: "q", documents: [{ id: "", text: "a" }] }, "empty document id"],
  ["/rerank", { query: "q", documents: [LONG] }, "document too long"],
  ["/rerank", { query: "q", documents: ["a"], top_k: 0 }, "top_k 0"],
  ["/rerank", { query: "q", documents: ["a"], top_k: 101 }, "top_k 101"],
  ["/rerank", { query: "q", documents: ["a"], top_k: 1.5 }, "top_k fraction"],
  ["/pii", {}, "missing text (pii)"],
  ["/pii", { text: "" }, "empty text (pii)"],
  ["/pii", { text: LONG }, "pii text too long"],
  ["/pii", { text: "a@b.co", redact: "yes" }, "non-boolean redact"],
  ["/pii", { text: "a@b.co", types: [] }, "empty types"],
  ["/pii", { text: "a@b.co", types: "email" }, "types as string"],
  ["/pii", { text: "a@b.co", types: ["email", "dna"] }, "unknown type"],
  ["/language", {}, "missing text (language)"],
  ["/language", { text: "" }, "empty text (language)"],
  ["/language", { text: LONG }, "language text too long"],
  ["/language", { texts: Array.from({ length: 51 }, () => "hola") }, "51 texts (language)"],
];
for (const [route, body, label] of badCases) {
  reset(); r = await paid(route, body); j = await r.json();
  ok(r.status === 400 && calls.length === 0 && ai.calls.length === 0 && /no payment was taken/.test(j.error), `paid ${route} + ${label} -> 400, no AI, no facilitator`);
}
reset(); r = await W.fetch(new Request(base + "/sentiment", { method: "POST", body: "{not json", headers: { "PAYMENT-SIGNATURE": hdrs["/sentiment"] } }), env); ok(r.status === 400 && calls.length === 0 && ai.calls.length === 0, "paid + malformed JSON body -> 400");
reset(); r = await W.fetch(new Request(base + "/sentiment", { method: "POST", body: JSON.stringify([1]), headers: { "PAYMENT-SIGNATURE": hdrs["/sentiment"] } }), env); ok(r.status === 400 && calls.length === 0, "paid + array body -> 400");
reset(); r = await W.fetch(new Request(base + "/sentiment", { method: "POST", body: "x".repeat(130 * 1024), headers: { "PAYMENT-SIGNATURE": hdrs["/sentiment"] } }), env); j = await r.json(); ok(r.status === 413 && calls.length === 0 && ai.calls.length === 0 && /131072/.test(j.error), "paid + 130KB body without content-length -> 413 before payment");
reset(); r = await paid("/sentiment", { text: "y".repeat(20000) }); ok(r.status === 200 && (await r.json()).results[0].chars === 20000 && settled(), "exactly 20,000 chars accepted");
reset(); r = await paidGet("/sentiment", "text=" + encodeURIComponent("I love it")); j = await r.json(); ok(r.status === 200 && j.label === "positive" && settled() && ai.calls[0].input.text === "I love it", "paid GET with query params -> 200");

// ---- sentiment ----
reset(); r = await paid("/sentiment", { text: "The onboarding was smooth." }); j = await r.json();
ok(r.status === 200 && j.label === "positive" && j.score === 0.9994 && j.polarity === 0.9994 && j.results.length === 1 && j.results[0].index === 0 && j.summary.count === 1 && j.summary.positive === 1 && j.summary.negative === 0 && j.summary.mean_polarity === 0.9994 && j.model === SENT && /^\d{4}-\d{2}-\d{2}T/.test(j.generated_at), "sentiment single text: label/score/polarity + results + summary");
ok(Object.keys(j).join() === "label,score,polarity,results,summary,model,generated_at", "sentiment single keys exact");
ok(dec(r.headers.get("PAYMENT-RESPONSE")).transaction === "0xdeadbeef" && dec(r.headers.get("PAYMENT-RESPONSE")).success === true && dec(r.headers.get("PAYMENT-RESPONSE")).payer === "0xabc", "PAYMENT-RESPONSE receipt");
ok(settled() && calls[0].u === "https://facilitator.payai.network/verify", "verify then settle via payai");
const sent = JSON.parse(calls[0].init.body); ok(sent.x402Version === 2 && sent.paymentRequirements.payTo === PAY && sent.paymentRequirements.amount === "1000" && sent.paymentPayload.accepted.amount === "1000", "facilitator body uses sentiment requirements (1000)");
ok(ai.calls.length === 1 && ai.calls[0].model === SENT && Object.keys(ai.calls[0].input).join() === "text", "sentiment calls distilbert with {text}");
reset(); r = await paid("/sentiment", { texts: ["Great product, love it", "Shipping took three weeks and the box arrived crushed.", "Nice"] }); j = await r.json();
ok(r.status === 200 && !("label" in j) && j.results.length === 3 && j.results.map((x) => x.label).join() === "positive,negative,positive" && j.results[1].polarity === -0.9988 && j.results[1].score === 0.9988 && j.summary.count === 3 && j.summary.positive === 2 && j.summary.negative === 1 && Math.abs(j.summary.mean_polarity - (0.9994 - 0.9988 + 0.9994) / 3) < 0.001 && ai.calls.length === 3 && settled(), "sentiment batch: per-item polarity, aggregate counts, one model call per text");
ok(Object.keys(j).join() === "results,summary,model,generated_at", "sentiment batch keys exact");
reset(); ai.reply[SENT] = () => [{ label: "POSITIVE", score: 0.3 }, { label: "NEGATIVE", score: 0.7 }]; r = await paid("/sentiment", { text: "meh" }); j = await r.json(); ok(r.status === 200 && j.label === "negative" && j.score === 0.7 && j.polarity === -0.7, "sentiment picks the highest-scoring label regardless of order");
reset(); ai.reply[SENT] = () => ({ label: "NEGATIVE", score: 0.6 }); r = await paid("/sentiment", { text: "meh" }); j = await r.json(); ok(r.status === 200 && j.label === "negative" && j.polarity === -0.6, "sentiment accepts a single {label, score} object");
reset(); r = await paidGet("/sentiment", "texts=good%20stuff&texts=the%20worst"); j = await r.json(); ok(r.status === 200 && j.results.length === 2 && j.results[1].label === "negative", "sentiment GET with repeated texts params");
reset(); r = await paidGet("/sentiment", "texts=" + encodeURIComponent(JSON.stringify(["good", "worst"]))); j = await r.json(); ok(r.status === 200 && j.results.length === 2, "sentiment GET with JSON array string");
// order: verify -> model -> settle
reset(); let order = []; const origRun = AI.run;
AI.run = async (m, i) => { order.push("ai"); return origRun(m, i); };
const origFetch = globalThis.fetch; globalThis.fetch = async (u, init) => { order.push(String(u).split("/").pop()); return origFetch(u, init); };
r = await paid("/sentiment", { text: "Fine" }); ok(r.status === 200 && order.join() === "verify,ai,settle", "order: verify -> model -> settle");
AI.run = origRun; globalThis.fetch = origFetch;
// failures
reset(); ai.fail.add(SENT); r = await paid("/sentiment", { text: "Fine" }); j = await r.json();
ok(r.status === 502 && j.error === "AI model temporarily unavailable, no payment taken" && verifiedOnly() && !r.headers.get("PAYMENT-RESPONSE") && ai.calls.length === 1, "sentiment AI fail -> 502, verify only, no settle");
reset(); ai.fail.add(SENT); r = await paid("/sentiment", { texts: ["a", "b", "c"] }); ok(r.status === 502 && verifiedOnly(), "sentiment batch: one item failing -> whole call 502, no settle");
reset(); ai.reply[SENT] = () => [{ label: "NEUTRAL", score: 0.9 }]; r = await paid("/sentiment", { text: "x" }); ok(r.status === 502 && verifiedOnly(), "sentiment unusable label -> 502 no settle");
reset(); ai.reply[SENT] = () => []; r = await paid("/sentiment", { text: "x" }); ok(r.status === 502 && verifiedOnly(), "sentiment empty array -> 502 no settle");
reset(); mode = "badverify"; r = await paid("/sentiment", { text: "x" });
ok(r.status === 402 && dec(r.headers.get("PAYMENT-REQUIRED")).error === "insufficient_funds" && dec(r.headers.get("PAYMENT-REQUIRED")).accepts[0].amount === "1000" && calls.length === 1 && ai.calls.length === 0, "verify fail -> 402 (route amount), no AI call");
reset(); mode = "badsettle"; r = await paid("/sentiment", { text: "Secret happy text" }); let t = await r.text();
ok(r.status === 402 && t.trim() === "{}" && !t.includes("positive") && dec(r.headers.get("PAYMENT-RESPONSE")).success === false && dec(r.headers.get("PAYMENT-RESPONSE")).errorReason === "invalid_transaction_state", "settle fail -> 402 empty body, no data leaked");
reset(); globalThis.fetch = async () => { throw new Error("boom"); }; r = await paid("/sentiment", { text: "x" }); ok(r.status === 500 && ai.calls.length === 0, "facilitator unreachable -> 500, no AI call"); globalThis.fetch = origFetch;

// ---- safety ----
reset(); r = await paid("/safety", { text: "How do I bake bread?" }); j = await r.json();
ok(r.status === 200 && j.safe === true && j.categories.length === 0 && j.raw === "safe" && j.messages === 1 && j.model === GUARD && Object.keys(j).join() === "safe,categories,raw,messages,model,generated_at", "safety: string-shaped 'safe' response");
ok(ai.calls.length === 1 && ai.calls[0].model === GUARD && ai.calls[0].input.messages.length === 1 && ai.calls[0].input.messages[0].role === "user" && ai.calls[0].input.messages[0].content === "How do I bake bread?" && ai.calls[0].input.max_tokens > 0, "safety: text wrapped as a single user message for llama-guard");
ok(settled() && JSON.parse(calls[1].init.body).paymentRequirements.amount === "2000", "safety settled at 2000");
reset(); ai.reply[GUARD] = () => ({ response: "unsafe\nS1,S10" }); r = await paid("/safety", { text: "x" }); j = await r.json();
ok(r.status === 200 && j.safe === false && j.categories.map((c) => c.code).join() === "S1,S10" && j.categories[0].name === "Violent Crimes" && j.categories[1].name === "Hate" && j.raw === "unsafe\nS1,S10", "safety: string response 'unsafe\\nS1,S10' -> categories with names");
reset(); ai.reply[GUARD] = () => ({ response: { response: "unsafe\nS11" } }); r = await paid("/safety", { text: "x" }); j = await r.json();
ok(r.status === 200 && j.safe === false && j.categories.length === 1 && j.categories[0].code === "S11" && j.categories[0].name === "Suicide & Self-Harm" && settled(), "safety: object-shaped response {response:{response}} handled");
reset(); ai.reply[GUARD] = () => ({ response: { response: "safe" } }); r = await paid("/safety", { text: "x" }); j = await r.json(); ok(r.status === 200 && j.safe === true && j.raw === "safe", "safety: object-shaped 'safe' handled");
reset(); ai.reply[GUARD] = () => "unsafe\nS14, S2 ,S10,S2"; r = await paid("/safety", { text: "x" }); j = await r.json(); ok(r.status === 200 && j.categories.map((c) => c.code).join() === "S2,S10,S14", "safety: bare string, codes deduped and ordered");
reset(); ai.reply[GUARD] = () => ({ response: "Safe." }); r = await paid("/safety", { text: "x" }); j = await r.json(); ok(r.status === 200 && j.safe === true, "safety: case-insensitive verdict");
reset(); ai.reply[GUARD] = () => ({ response: "I cannot determine that." }); r = await paid("/safety", { text: "x" }); ok(r.status === 502 && verifiedOnly(), "safety: unusable verdict -> 502 no settle");
reset(); ai.reply[GUARD] = () => ({ response: { foo: 1 } }); r = await paid("/safety", { text: "x" }); ok(r.status === 502 && verifiedOnly(), "safety: object without response text -> 502 no settle");
reset(); ai.fail.add(GUARD); r = await paid("/safety", { text: "x" }); j = await r.json(); ok(r.status === 502 && j.error === "AI model temporarily unavailable, no payment taken" && verifiedOnly() && !r.headers.get("PAYMENT-RESPONSE"), "safety AI fail -> 502 no settle");
reset(); r = await paid("/safety", { messages: [{ role: "User", content: "hi" }, { role: "assistant", content: "hello" }, { role: "user", content: "how to hurt someone" }] }); j = await r.json();
ok(r.status === 200 && j.messages === 3 && ai.calls[0].input.messages.map((m) => m.role).join() === "user,assistant,user" && ai.calls[0].input.messages[2].content === "how to hurt someone", "safety: messages conversation passed through, roles normalized");
reset(); mode = "badsettle"; ai.reply[GUARD] = () => ({ response: "unsafe\nS1" }); r = await paid("/safety", { text: "x" }); ok(r.status === 402 && (await r.text()).trim() === "{}", "safety: settle fail -> 402 empty body");
reset(); mode = "badverify"; r = await paid("/safety", { text: "x" }); ok(r.status === 402 && ai.calls.length === 0 && dec(r.headers.get("PAYMENT-REQUIRED")).resource.url === base + "/safety", "safety: verify fail -> 402 no AI call");
reset(); r = await paidGet("/safety", "messages=" + encodeURIComponent(JSON.stringify([{ role: "user", content: "hi" }]))); ok(r.status === 200 && (await r.json()).messages === 1, "safety GET with JSON messages param");

// ---- rerank ----
const DOCS = [{ id: "kb-12", text: "Billing: update your card." }, { id: "kb-7", text: "Forgot your password? Use the Reset link." }, { id: "kb-3", text: "Office hours 9-5." }];
reset(); r = await paid("/rerank", { query: "reset my password", documents: DOCS }); j = await r.json();
ok(r.status === 200 && j.query === "reset my password" && j.results.length === 3 && j.results[0].id === "kb-7" && j.results[0].index === 1 && j.results[0].rank === 1 && j.results[0].score === 0.98 && j.results[0].text === DOCS[1].text && j.results[1].id === "kb-3" && j.results[2].id === "kb-12" && j.count === 3 && j.documents === 3 && j.model === RERANK, "rerank: sorted desc with id/index/score/text");
ok(Object.keys(j).join() === "query,results,count,documents,model,generated_at" && Object.keys(j.results[0]).join() === "rank,id,index,score,text", "rerank keys exact");
ok(ai.calls.length === 1 && ai.calls[0].model === RERANK && ai.calls[0].input.query === "reset my password" && ai.calls[0].input.contexts.length === 3 && ai.calls[0].input.contexts[1].text === DOCS[1].text && Object.keys(ai.calls[0].input.contexts[0]).join() === "text" && ai.calls[0].input.top_k === 3, "rerank calls bge-reranker with {query, contexts:[{text}], top_k}");
ok(settled() && JSON.parse(calls[1].init.body).paymentRequirements.amount === "2000", "rerank settled at 2000");
reset(); r = await paid("/rerank", { query: "password", documents: DOCS.map((d) => d.text), top_k: 2 }); j = await r.json();
ok(r.status === 200 && j.results.length === 2 && j.results[0].id === 1 && j.results[0].index === 1 && j.results[1].id === 2 && j.count === 2 && j.documents === 3 && ai.calls[0].input.top_k === 2, "rerank: plain strings get index ids, top_k honored");
reset(); r = await paid("/rerank", { query: "password", documents: ["a", "b"], top_k: 50 }); j = await r.json(); ok(r.status === 200 && j.results.length === 2 && ai.calls[0].input.top_k === 2, "rerank: top_k above document count clamped");
reset(); r = await paid("/rerank", { query: "q", documents: [{ id: 42, text: "num id" }, { text: "no id" }] }); j = await r.json(); ok(r.status === 200 && j.results.find((x) => x.index === 0).id === 42 && j.results.find((x) => x.index === 1).id === 1, "rerank: numeric id kept, missing id -> index");
reset(); ai.reply[RERANK] = () => ({ response: [{ id: 1, score: 0.5 }] }); r = await paid("/rerank", { query: "q", documents: ["a", "b", "c"] }); j = await r.json(); ok(r.status === 200 && j.results.length === 1 && j.results[0].index === 1 && j.count === 1, "rerank: model returning fewer rows than documents is accepted");
reset(); ai.reply[RERANK] = () => [{ id: 0, score: 0.2 }, { id: 1, score: 0.4 }]; r = await paid("/rerank", { query: "q", documents: ["a", "b"] }); j = await r.json(); ok(r.status === 200 && j.results[0].index === 1, "rerank: bare array response handled");
reset(); ai.reply[RERANK] = () => ({ response: [{ id: 5, score: 0.5 }] }); r = await paid("/rerank", { query: "q", documents: ["a", "b"] }); ok(r.status === 502 && verifiedOnly(), "rerank: out-of-range id -> 502 no settle");
reset(); ai.reply[RERANK] = () => ({ response: [] }); r = await paid("/rerank", { query: "q", documents: ["a"] }); ok(r.status === 502 && verifiedOnly(), "rerank: empty response -> 502 no settle");
reset(); ai.reply[RERANK] = () => ({ response: [{ id: 0, score: "nan?" }] }); r = await paid("/rerank", { query: "q", documents: ["a"] }); ok(r.status === 502 && verifiedOnly(), "rerank: non-numeric score -> 502 no settle");
reset(); ai.fail.add(RERANK); r = await paid("/rerank", { query: "q", documents: ["a"] }); j = await r.json(); ok(r.status === 502 && j.error === "AI model temporarily unavailable, no payment taken" && verifiedOnly() && !r.headers.get("PAYMENT-RESPONSE"), "rerank AI fail -> 502 no settle");
reset(); mode = "badsettle"; r = await paid("/rerank", { query: "q", documents: ["secret doc"] }); t = await r.text(); ok(r.status === 402 && t.trim() === "{}" && !t.includes("secret"), "rerank: settle fail -> 402 empty body");
reset(); r = await paidGet("/rerank", "query=password&documents=" + encodeURIComponent("billing,password reset,hours") + "&top_k=1"); j = await r.json(); ok(r.status === 200 && j.results.length === 1 && j.results[0].text === "password reset" && j.documents === 3, "rerank GET with comma-separated documents + top_k");

// ---- pii ----
const PII_TEXT = "Contact Maria Lopez at maria.lopez@example.com or (415) 555-0132. Card 4111 1111 1111 1111, not 1234-5678-9012-3456. SSN 123-45-6789, IP 192.168.1.20, ETH 0x6f762720b8515b7091e6aa69e8361f7b9909233f, BTC bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq, IBAN GB82 WEST 1234 5698 7654 32.";
reset(); ai.reply[LLM] = () => ({ response: { entities: [{ type: "name", value: "Maria Lopez" }] } });
r = await paid("/pii", { text: PII_TEXT, redact: true }); j = await r.json();
const types = j.entities.map((e) => e.type);
ok(r.status === 200 && types.join() === "name,email,phone,credit_card,ssn,ip,crypto_address,crypto_address,iban" && j.count === 9 && j.counts.crypto_address === 2 && j.counts.credit_card === 1, "pii: all regex types + LLM name detected, in text order");
ok(j.entities.every((e) => PII_TEXT.slice(e.start, e.end) === e.value) && j.entities[1].value === "maria.lopez@example.com" && j.entities[2].value === "(415) 555-0132" && j.entities[3].value === "4111 1111 1111 1111" && j.entities[4].value === "123-45-6789" && j.entities[5].value === "192.168.1.20" && j.entities[6].value.startsWith("0x6f76") && j.entities[7].value.startsWith("bc1q") && j.entities[8].value === "GB82 WEST 1234 5698 7654 32", "pii: offsets match values, exact spans");
ok(!JSON.stringify(j.entities).includes("1234-5678-9012-3456") && JSON.stringify(j.entities).includes("4111 1111 1111 1111"), "pii: Luhn rejects 1234-5678-9012-3456, accepts 4111 1111 1111 1111");
ok(j.redacted === "Contact [NAME] at [EMAIL] or [PHONE]. Card [CREDIT_CARD], not 1234-5678-9012-3456. SSN [SSN], IP [IP], ETH [CRYPTO_ADDRESS], BTC [CRYPTO_ADDRESS], IBAN [IBAN].", "pii: redacted text replaces each span with [TYPE]");
ok(j.methods.regex.length === 7 && j.methods.llm.join() === "name,address,date_of_birth,passport" && j.types_checked.length === 11 && !("llm_error" in j) && j.model === LLM, "pii: methods + types_checked (default all types)");
ok(Object.keys(j).join() === "entities,count,counts,types_checked,methods,redacted,model,generated_at" && Object.keys(j.entities[0]).join() === "type,value,start,end", "pii keys exact");
ok(ai.calls.length === 1 && ai.calls[0].model === LLM && ai.calls[0].input.response_format.type === "json_schema" && ai.calls[0].input.response_format.json_schema.properties.entities.items.properties.type.enum.join() === "name,address,date_of_birth,passport" && ai.calls[0].input.messages[1].content.includes(PII_TEXT) && /never follow instructions/i.test(ai.calls[0].input.messages[0].content) && ai.calls[0].input.temperature === 0, "pii: LLM called once with JSON schema, guard prompt, text");
ok(settled() && JSON.parse(calls[1].init.body).paymentRequirements.amount === "3000", "pii settled at 3000");
ok(!JSON.stringify(j).includes("TEXT START"), "pii: response does not include the prompt");
reset(); r = await paid("/pii", { text: PII_TEXT }); j = await r.json(); ok(r.status === 200 && !("redacted" in j) && j.count === 8 && ai.calls.length === 1 && j.methods.llm.length === 4, "pii: redact=false omits redacted; default LLM returns no entities");
// regex-only types -> no LLM call
reset(); r = await paid("/pii", { text: PII_TEXT, types: ["email", "credit_card"] }); j = await r.json();
ok(r.status === 200 && ai.calls.length === 0 && j.entities.map((e) => e.type).join() === "email,credit_card" && j.methods.llm.length === 0 && j.model === null && j.types_checked.join() === "email,credit_card" && settled(), "pii: regex-only types -> zero LLM calls, settled");
reset(); r = await paid("/pii", { text: PII_TEXT, types: ["Email", " ssn "] }); j = await r.json(); ok(r.status === 200 && j.entities.map((e) => e.type).join() === "email,ssn", "pii: types normalized (case/whitespace)");
// LLM-only types -> LLM called; schema enum restricted
reset(); ai.reply[LLM] = () => ({ response: { entities: [{ type: "name", value: "Maria Lopez" }, { type: "name", value: "Nobody Here" }, { type: "passport", value: "X" }] } });
r = await paid("/pii", { text: PII_TEXT, types: ["name"] }); j = await r.json();
ok(r.status === 200 && j.entities.length === 1 && j.entities[0].type === "name" && j.entities[0].start === 8 && j.entities[0].end === 19 && ai.calls[0].input.response_format.json_schema.properties.entities.items.properties.type.enum.join() === "name" && j.methods.regex.length === 0, "pii: LLM-only types -> schema enum restricted; hallucinated/absent values and non-requested types dropped");
// LLM string response (fenced JSON) handled
reset(); ai.reply[LLM] = () => ({ response: '```json\n{"entities":[{"type":"date_of_birth","value":"1990-05-04"}]}\n```' });
r = await paid("/pii", { text: "Born 1990-05-04 in Oslo.", types: ["date_of_birth", "email"] }); j = await r.json(); ok(r.status === 200 && j.entities.length === 1 && j.entities[0].type === "date_of_birth" && j.entities[0].start === 5, "pii: LLM string (fenced JSON) response parsed");
// case-insensitive fallback match + multiple occurrences
reset(); ai.reply[LLM] = () => ({ response: { entities: [{ type: "name", value: "john smith" }] } });
r = await paid("/pii", { text: "John Smith called. Later John Smith left.", types: ["name"] }); j = await r.json(); ok(r.status === 200 && j.entities.length === 2 && j.entities[0].value === "John Smith" && j.entities[1].start === 25, "pii: LLM value matched case-insensitively, every occurrence tagged");
// overlapping-span dedupe: LLM returns a span inside an email; regex phone vs credit card overlap
reset(); ai.reply[LLM] = () => ({ response: { entities: [{ type: "name", value: "maria.lopez" }, { type: "name", value: "Maria" }, { type: "address", value: "Contact Maria Lopez at" }] } });
r = await paid("/pii", { text: "Contact Maria Lopez at maria.lopez@example.com", redact: true }); j = await r.json();
ok(r.status === 200 && j.entities.length === 2 && j.entities[0].type === "address" && j.entities[0].start === 0 && j.entities[0].end === 22 && j.entities[1].type === "email" && j.entities[1].start === 23 && j.redacted === "[ADDRESS] [EMAIL]", "pii: overlapping spans deduped (longest wins; LLM span inside email dropped; Maria inside longer span dropped)");
reset(); r = await paid("/pii", { text: "ref 4111 1111 1111 1111 end", types: ["phone", "credit_card"] }); j = await r.json(); ok(r.status === 200 && j.entities.length === 1 && j.entities[0].type === "credit_card", "pii: regex overlap (phone inside card digits) deduped to credit_card");
reset(); r = await paid("/pii", { text: "ref 1234-5678-9012-3456 end", types: ["phone", "credit_card", "ssn"] }); j = await r.json(); ok(r.status === 200 && j.entities.length === 0, "pii: Luhn-failing number is not reported under any type");
reset(); r = await paid("/pii", { text: "IBAN GB82 WEST 1234 5698 7654 33 is wrong; DE89 3704 0044 0532 0130 00 is right", types: ["iban"] }); j = await r.json(); ok(r.status === 200 && j.entities.length === 1 && j.entities[0].value === "DE89 3704 0044 0532 0130 00", "pii: IBAN mod-97 check rejects bad checksum");
reset(); r = await paid("/pii", { text: "v6 2001:0db8:85a3:0000:0000:8a2e:0370:7334 short fe80::1 ver 1.2.3 big 999.1.1.1", types: ["ip"] }); j = await r.json(); ok(r.status === 200 && j.entities.map((e) => e.value).join("|") === "2001:0db8:85a3:0000:0000:8a2e:0370:7334|fe80::1", "pii: IPv6 full + compressed detected; version strings and out-of-range IPv4 ignored");
reset(); r = await paid("/pii", { text: "Call +1 415 555 0132 or 415.555.0132 or 5551234 or 123-45-6789", types: ["phone"] }); j = await r.json(); ok(r.status === 200 && j.entities.map((e) => e.value).join("|") === "+1 415 555 0132|415.555.0132", "pii: phone formats detected, 7-digit and SSN-shaped numbers not phones");
reset(); r = await paid("/pii", { text: "see 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa and 0xdeadbeef", types: ["crypto_address"] }); j = await r.json(); ok(r.status === 200 && j.entities.length === 1 && j.entities[0].value === "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", "pii: base58 BTC address detected, short 0x hex ignored");
// LLM fails but regex ran -> 200 + llm_error, settled
reset(); ai.fail.add(LLM); r = await paid("/pii", { text: PII_TEXT, redact: true }); j = await r.json();
ok(r.status === 200 && j.llm_error && /name, address, date_of_birth, passport/.test(j.llm_error) && j.entities.length === 8 && !j.entities.some((e) => e.type === "name") && j.methods.llm.length === 0 && j.types_checked.length === 7 && j.model === null && j.redacted.includes("[EMAIL]") && j.redacted.includes("Maria Lopez") && settled() && dec(r.headers.get("PAYMENT-RESPONSE")).success === true, "pii: LLM fails but regex ran -> 200 with llm_error, regex entities, settled");
reset(); ai.reply[LLM] = () => ({ response: "not json at all" }); r = await paid("/pii", { text: PII_TEXT }); j = await r.json(); ok(r.status === 200 && /no JSON/.test(j.llm_error) && j.entities.length === 8 && settled(), "pii: LLM returns garbage -> 200 with llm_error, settled");
reset(); ai.reply[LLM] = () => ({ response: { wrong: [] } }); r = await paid("/pii", { text: PII_TEXT }); j = await r.json(); ok(r.status === 200 && /entities array/.test(j.llm_error) && settled(), "pii: LLM JSON without entities -> llm_error, settled");
// LLM-only types and LLM fails -> nothing real was done -> 502 no settle
reset(); ai.fail.add(LLM); r = await paid("/pii", { text: PII_TEXT, types: ["name", "address"] }); j = await r.json(); ok(r.status === 502 && j.error === "AI model temporarily unavailable, no payment taken" && verifiedOnly() && !r.headers.get("PAYMENT-RESPONSE"), "pii: LLM-only types and LLM fails -> 502 no settle");
reset(); r = await paid("/pii", { text: "nothing personal here", types: ["email"] }); j = await r.json(); ok(r.status === 200 && j.entities.length === 0 && j.count === 0 && settled(), "pii: no entities is a valid paid result");
reset(); mode = "badsettle"; r = await paid("/pii", { text: PII_TEXT, types: ["email"] }); t = await r.text(); ok(r.status === 402 && t.trim() === "{}" && !t.includes("maria"), "pii: settle fail -> 402 empty body");
reset(); mode = "badverify"; r = await paid("/pii", { text: PII_TEXT }); ok(r.status === 402 && ai.calls.length === 0 && dec(r.headers.get("PAYMENT-REQUIRED")).accepts[0].amount === "3000", "pii: verify fail -> 402 no AI call");
reset(); r = await paidGet("/pii", "text=" + encodeURIComponent("mail a@b.co") + "&redact=true&types=email,phone"); j = await r.json(); ok(r.status === 200 && j.redacted === "mail [EMAIL]" && ai.calls.length === 0 && j.types_checked.join() === "email,phone", "pii GET: redact + comma types parsed");
reset(); r = await paidGet("/pii", "text=hi&redact=maybe"); ok(r.status === 400 && calls.length === 0, "pii GET: non-boolean redact -> 400");

// ---- language ----
reset(); r = await paid("/language", { text: "¿Dónde está la estación?" }); j = await r.json();
ok(r.status === 200 && j.code === "es" && j.name === "Spanish" && j.confidence === 0.99 && j.results.length === 1 && j.results[0].method === "llm" && j.results[0].alternatives[0].code === "pt" && j.results[0].alternatives[0].name === "Portuguese" && j.count === 1 && j.method === "llm" && j.model === LLM && !("llm_error" in j), "language single: code/name/confidence via LLM");
ok(Object.keys(j).join() === "code,name,confidence,results,count,method,model,generated_at", "language single keys exact");
ok(ai.calls.length === 1 && ai.calls[0].model === LLM && ai.calls[0].input.response_format.type === "json_schema" && ai.calls[0].input.response_format.json_schema.properties.languages.items.required.join() === "code,confidence" && ai.calls[0].input.messages[1].content.includes("¿Dónde está la estación?"), "language: LLM called with {languages:[{code, confidence}]} schema");
ok(settled() && JSON.parse(calls[1].init.body).paymentRequirements.amount === "1000", "language settled at 1000");
reset(); ai.reply[LLM] = (i) => ({ response: { languages: [{ code: /bonjour/i.test(i.messages[1].content) ? "FR" : "de", confidence: 0.9 }] } });
r = await paid("/language", { texts: ["Bonjour tout le monde", "Guten Morgen"] }); j = await r.json();
ok(r.status === 200 && !("code" in j) && j.results.map((x) => x.code).join() === "fr,de" && j.results[1].name === "German" && j.count === 2 && j.method === "llm" && ai.calls.length === 2 && settled(), "language batch: one LLM call per text, codes lowercased");
reset(); ai.reply[LLM] = () => ({ response: '{"languages":[{"code":"ja","confidence":0.97}]}' }); r = await paid("/language", { text: "こんにちは" }); j = await r.json(); ok(r.status === 200 && j.code === "ja" && j.name === "Japanese", "language: LLM string JSON response parsed");
reset(); ai.reply[LLM] = () => ({ response: { languages: [{ code: "xx", confidence: 0.9 }] } }); r = await paid("/language", { text: "whatever" }); j = await r.json(); ok(r.status === 200 && j.code === "xx" && j.name === null, "language: unknown code returned with name null");
// LLM fails -> script heuristic, method "script", 200 + settled
reset(); ai.fail.add(LLM);
r = await paid("/language", { texts: ["Привет, как дела?", "こんにちは、元気ですか", "你好，很高兴见到你", "مرحبا بك في المدينة", "नमस्ते दुनिया", "שלום עולם", "Καλημέρα κόσμε", "สวัสดีครับ", "안녕하세요 세계", "The quick brown fox jumps over the lazy dog and it is fine", "El perro corre por la calle y no se detiene en la casa", "1234 !!!"] }); j = await r.json();
ok(r.status === 200 && j.method === "script" && j.llm_error && /script heuristic/.test(j.llm_error) && j.model === null && settled() && dec(r.headers.get("PAYMENT-RESPONSE")).success === true, "language: LLM fails -> 200 with method script + llm_error, settled (not 502)");
ok(j.results.map((x) => x.code).join() === "ru,ja,zh,ar,hi,he,el,th,ko,en,es,und" && j.results.every((x) => x.method === "script") && j.results[0].name === "Russian" && j.results[8].name === "Korean" && j.results[11].name === "Undetermined" && j.results.every((x) => x.confidence >= 0 && x.confidence <= 1), "language: script heuristic covers Cyrillic/Kana/CJK/Arabic/Devanagari/Hebrew/Greek/Thai/Hangul + Latin stopwords + und");
reset(); ai.reply[LLM] = (i) => { if (/Guten/.test(i.messages[1].content)) throw new Error("flaky"); return { response: { languages: [{ code: "en", confidence: 0.95 }] } }; };
r = await paid("/language", { texts: ["Hello there, how are you doing today", "Guten Morgen, wie geht es dir und der Familie"] }); j = await r.json();
ok(r.status === 200 && j.method === "mixed" && j.results[0].method === "llm" && j.results[1].method === "script" && j.results[1].code === "de" && j.llm_error && j.model === LLM && settled(), "language: partial LLM failure -> mixed, per-item method, settled");
reset(); ai.reply[LLM] = () => ({ response: { languages: [] } }); r = await paid("/language", { text: "Ciao a tutti, come state oggi? Il tempo è bello e non piove" }); j = await r.json(); ok(r.status === 200 && j.method === "script" && j.code === "it" && settled(), "language: LLM empty list -> script fallback (Italian stopwords)");
reset(); mode = "badsettle"; r = await paid("/language", { text: "hola" }); ok(r.status === 402 && (await r.text()).trim() === "{}", "language: settle fail -> 402 empty body");
reset(); mode = "badverify"; r = await paid("/language", { text: "hola" }); ok(r.status === 402 && ai.calls.length === 0 && dec(r.headers.get("PAYMENT-REQUIRED")).accepts[0].amount === "1000", "language: verify fail -> 402 no AI call");
reset(); r = await paidGet("/language", "text=" + encodeURIComponent("Hola amigo")); j = await r.json(); ok(r.status === 200 && j.code === "es", "language GET");

// ---- openapi ----
reset(); r = await W.fetch(new Request(base + "/openapi.json"), env); const o = await r.json();
ok(r.status === 200 && o.openapi === "3.1.0" && o.info.title === "Text Moderation" && o.info.description.startsWith("Content moderation") && typeof o.info["x-guidance"] === "string" && o.info["x-guidance"].includes("$0.001") && o.info["x-guidance"].includes("$0.002") && o.info["x-guidance"].includes("$0.003") && o.info["x-guidance"].includes("llm_error") && o.info["x-guidance"].includes('"script"') && o.servers[0].url === base, "openapi header + x-guidance");
ok(Object.keys(o.paths).join() === ROUTES.join() && ROUTES.every((p) => Object.keys(o.paths[p]).join() === "get,post"), "openapi paths: 5 routes, GET and POST each");
for (const route of ROUTES) {
  for (const m of ["get", "post"]) {
    const p = o.paths[route][m];
    ok(p["x-payment-info"].price.amount === USD[route] && p["x-payment-info"].price.mode === "fixed" && p["x-payment-info"].price.currency === "USD" && p["x-payment-info"].protocols[0].x402 && p.responses["402"] && p.responses["200"] && p.responses["400"] && p.responses["413"] && p.responses["502"] && p.operationId && p.summary && (m === "post" ? p.requestBody.required === true && p.requestBody.content["application/json"].schema.type === "object" : Array.isArray(p.parameters) && p.parameters.length > 0 && p.parameters.every((x) => x.in === "query")), `openapi ${m.toUpperCase()} ${route} x-payment-info ${USD[route]} + 402`);
  }
}
ok(o.paths["/rerank"].post.requestBody.content["application/json"].schema.required.join() === "query,documents" && o.paths["/pii"].post.requestBody.content["application/json"].schema.properties.types.items.enum.length === 11 && o.paths["/safety"].post.responses["200"].content["application/json"].schema.required.includes("safe") && o.paths["/pii"].post.responses["200"].content["application/json"].schema.properties.llm_error && o.paths["/language"].post.responses["200"].content["application/json"].schema.properties.method.enum.join() === "llm,script,mixed", "openapi schemas per route");
const opIds = ROUTES.flatMap((p) => [o.paths[p].get.operationId, o.paths[p].post.operationId]); ok(new Set(opIds).size === 10, "openapi operationIds unique");
r = await W.fetch(new Request(base + "/.well-known/openapi.json"), env); ok(r.status === 200, "well-known openapi alias");

// ---- CDP facilitator path (Ed25519 + EC keys) ----
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const jwk = privateKey.export({ format: "jwk" });
const secret = Buffer.concat([Buffer.from(jwk.d, "base64url"), Buffer.from(jwk.x, "base64url")]).toString("base64");
const envC = { PAY_TO: PAY, AI, CDP_API_KEY_ID: "test-key-id", CDP_API_KEY_SECRET: secret };
reset(); r = await paid("/sentiment", { text: "Fine" }, { env: envC });
ok(r.status === 200 && calls[0].u === "https://api.cdp.coinbase.com/platform/v2/x402/verify" && calls[1].u.endsWith("/settle"), "cdp facilitator used");
const checkJwt = (tok, pub, uri, alg) => { const [h, pl, s] = tok.split("."); const H = JSON.parse(Buffer.from(h, "base64url")), P = JSON.parse(Buffer.from(pl, "base64url"));
  const sigOk = alg === "EdDSA" ? nverify(null, Buffer.from(h + "." + pl), pub, Buffer.from(s, "base64url")) : nverify("sha256", Buffer.from(h + "." + pl), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
  return sigOk && H.alg === alg && H.kid === "test-key-id" && H.nonce.length === 32 && P.iss === "cdp" && P.sub === "test-key-id" && P.uris[0] === uri && P.exp - P.nbf === 120; };
ok(checkJwt(calls[0].init.headers.Authorization.slice(7), publicKey, "POST api.cdp.coinbase.com/platform/v2/x402/verify", "EdDSA"), "Ed25519 JWT valid (verify)");
ok(checkJwt(calls[1].init.headers.Authorization.slice(7), publicKey, "POST api.cdp.coinbase.com/platform/v2/x402/settle", "EdDSA"), "Ed25519 JWT valid (settle)");
const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pem = ec.privateKey.export({ type: "sec1", format: "pem" });
reset(); r = await paid("/sentiment", { text: "Fine" }, { env: { ...envC, CDP_API_KEY_SECRET: pem.replace(/\n/g, "\\n") } });
ok(r.status === 200 && checkJwt(calls[0].init.headers.Authorization.slice(7), ec.publicKey, "POST api.cdp.coinbase.com/platform/v2/x402/verify", "ES256"), "EC SEC1 JWT valid");
r = await W.fetch(new Request(base + "/"), envC); ok((await r.json()).facilitator === "cdp", "info page reports cdp");
ok(!JSON.stringify(await (await W.fetch(new Request(base + "/"), envC)).json()).includes(secret), "info page never returns the CDP secret");

ok(otherFetch.length === 0, "no network calls outside the facilitator mock");
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exitCode = fails ? 1 : 0;
