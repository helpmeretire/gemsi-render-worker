// Usage: node test/test.mjs ./worker.js /path/bazaar-out.json
import { generateKeyPairSync, verify as nverify } from "node:crypto";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const W = (await import(pathToFileURL(resolve(process.argv[2])).href)).default;
const PAY = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const PRIMARY = "@cf/meta/llama-3.3-70b-instruct-fp8-fast", FALLBACK = "@cf/qwen/qwen2.5-coder-32b-instruct";
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

// ---- Workers AI mock ----
// ai.replies: queue of strings (or functions of the input) returned in order; ai.fail: "primary" | "both" | null
const ai = { calls: [], replies: [], fail: null, usage: { prompt_tokens: 123, completion_tokens: 45 } };
const AI = {
  run: async (model, input) => {
    ai.calls.push({ model, input });
    if (ai.fail === "both" || (ai.fail === "primary" && model === PRIMARY)) throw new Error("model error " + model);
    let rep = ai.replies.length ? ai.replies.shift() : "OK.";
    if (typeof rep === "function") rep = rep(input, model);
    if (model === PRIMARY) return { choices: [{ message: { role: "assistant", content: rep } }], usage: { ...ai.usage } };
    return { response: rep, usage: { ...ai.usage } };
  },
};
const reset = () => { calls = []; ai.calls = []; ai.replies = []; ai.fail = null; mode = "good"; };
const env = { PAY_TO: PAY, AI };
const base = "https://aitext.example.workers.dev";
const TEXT = "Acme Corp reported third-quarter revenue of $4.2 billion on Tuesday, up 12% from a year earlier, and raised its full-year outlook. CEO Jane Doe said demand for its cloud products remained strong, while hardware sales fell 3%. Shares rose 5% in after-hours trading.";
const post = (path, body, extra = {}) => W.fetch(new Request(base + path, { method: "POST", body: JSON.stringify(body), ...extra, headers: { "Content-Type": "application/json", ...(extra.headers || {}) } }), extra.env || env);

// ---- info / discovery ----
let r = await W.fetch(new Request(base + "/"), env); let j = await r.json();
ok(r.status === 200 && j.service === "NoJunk AI Text" && j.facilitator === "payai" && j.configured === true && Object.keys(j.endpoints).join() === "/summarize,/extract,/classify" && j.endpoints["/classify"].price.startsWith("$0.002") && j.endpoints["/summarize"].price.startsWith("$0.005"), "info page lists 3 routes with prices");
r = await W.fetch(new Request(base + "/summarize", { method: "POST" }), { AI }); ok(r.status === 402 && dec(r.headers.get("PAYMENT-REQUIRED")).accepts[0].payTo === "0x6f762720b8515b7091e6aa69e8361f7b9909233f", "default wallet used");
r = await W.fetch(new Request(base + "/summarize", { method: "POST", body: "not json" }), env); ok(r.status === 402, "bad input unpaid -> 402 first");
r = await W.fetch(new Request(base + "/summarize"), env); ok(r.status === 402 && r.headers.get("PAYMENT-REQUIRED"), "GET probe without payment -> 402");
r = await W.fetch(new Request(base + "/nope", { method: "POST" }), env); ok(r.status === 404, "unknown path -> 404");
r = await W.fetch(new Request(base + "/summarize", { method: "PUT" }), env); ok(r.status === 405, "PUT -> 405");
r = await W.fetch(new Request(base + "/summarize", { method: "OPTIONS" }), env); ok(r.status === 200 && r.headers.get("Access-Control-Allow-Headers").includes("PAYMENT-SIGNATURE") && r.headers.get("Access-Control-Allow-Methods").includes("POST"), "OPTIONS CORS");
r = await W.fetch(new Request(base + "/summarize", { method: "POST", headers: { "content-length": String(300 * 1024) } }), env); ok(r.status === 413, "oversized content-length -> 413 before 402");
r = await W.fetch(new Request(base + "/summarize", { method: "POST" }), { PAY_TO: PAY }); j = await r.json(); ok(r.status === 500 && /AI/.test(j.error), "env.AI missing -> 500 misconfigured");
r = await W.fetch(new Request(base + "/summarize", { method: "POST" }), { PAY_TO: "nope", AI }); ok(r.status === 500, "bad PAY_TO -> 500");

// ---- 402 probes: per-route amount + resource url ----
const PRICES = { "/summarize": "5000", "/extract": "5000", "/classify": "2000" };
const prs = {}, payloads = {}, hdrs = {};
for (const route of Object.keys(PRICES)) {
  r = await W.fetch(new Request(base + route, { method: "POST" }), env);
  const pr = dec(r.headers.get("PAYMENT-REQUIRED")); prs[route] = pr;
  const a0 = pr.accepts[0];
  ok(r.status === 402 && pr.x402Version === 2 && pr.accepts.length === 1 && a0.scheme === "exact" && a0.amount === PRICES[route] && a0.payTo === PAY && a0.network === "eip155:8453" && a0.asset === "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" && a0.extra.name === "USD Coin" && a0.maxTimeoutSeconds === 300, `${route} 402 requirements (amount ${PRICES[route]})`);
  ok(pr.resource.url === base + route && pr.resource.mimeType === "application/json" && pr.resource.description.includes(route.slice(1)), `${route} resource url`);
  const bz = pr.extensions.bazaar;
  ok(bz.info.input.type === "http" && bz.info.input.method === "POST" && bz.info.input.bodyType === "json" && typeof bz.info.input.body.text === "string" && bz.info.output.type === "json" && bz.schema.properties.input.required.includes("body") && bz.schema.properties.input.properties.body.required.includes("text"), `${route} bazaar ext with POST json body`);
  ok(!JSON.stringify(pr).includes("TEXT START") && !JSON.stringify(pr).includes("untrusted"), `${route} 402 does not leak prompt`);
  payloads[route] = { x402Version: 2, resource: pr.resource, accepted: pr.accepts[0], payload: { signature: "0x00", authorization: {} }, extensions: pr.extensions };
  hdrs[route] = Buffer.from(JSON.stringify(payloads[route])).toString("base64");
}
ok(prs["/extract"].extensions.bazaar.info.input.body.fields && prs["/classify"].extensions.bazaar.info.input.body.labels.length >= 2 && prs["/classify"].extensions.bazaar.info.output.example.label === "earnings" && prs["/extract"].extensions.bazaar.info.output.example.data.headquarters === null, "bazaar examples are route specific");
writeFileSync(process.argv[3], JSON.stringify(prs["/summarize"].extensions.bazaar));
const paid = (route, body, extra = {}) => post(route, body, { ...extra, headers: { "PAYMENT-SIGNATURE": hdrs[route], ...(extra.headers || {}) } });

// ---- paying with another route's requirements -> 402 ----
for (const [route, other] of [["/summarize", "/classify"], ["/classify", "/extract"], ["/extract", "/classify"]]) {
  reset();
  r = await post(route, { text: TEXT, fields: ["a"], labels: ["x", "y"] }, { headers: { "PAYMENT-SIGNATURE": hdrs[other] } });
  ok(r.status === 402 && dec(r.headers.get("PAYMENT-REQUIRED")).error === "No matching payment requirements found" && calls.length === 0 && ai.calls.length === 0, `${route} paid with ${other} requirements -> 402, nothing called`);
}
reset(); const under = { ...payloads["/summarize"], accepted: { ...payloads["/summarize"].accepted, amount: "1" } };
r = await post("/summarize", { text: TEXT }, { headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(under)).toString("base64") } }); ok(r.status === 402 && calls.length === 0, "underpaid accepted -> 402");
r = await post("/summarize", { text: TEXT }, { headers: { "PAYMENT-SIGNATURE": "!!!notbase64" } }); ok(r.status === 400 && calls.length === 0 && ai.calls.length === 0, "garbage payment header -> 400");

// ---- bad input with payment -> 400 (no AI, no facilitator) ----
const LONG = "x".repeat(24001);
const badCases = [
  ["/summarize", {}, "missing text"],
  ["/summarize", { text: "" }, "empty text"],
  ["/summarize", { text: "   \n " }, "whitespace-only text"],
  ["/summarize", { text: 42 }, "non-string text"],
  ["/summarize", { text: TEXT, style: "haiku" }, "bad style"],
  ["/summarize", { text: TEXT, max_sentences: 0 }, "max_sentences 0"],
  ["/summarize", { text: TEXT, max_sentences: 11 }, "max_sentences 11"],
  ["/summarize", { text: TEXT, max_sentences: 2.5 }, "max_sentences fraction"],
  ["/summarize", { text: TEXT, language: "x{}" }, "bad language"],
  ["/extract", { text: TEXT }, "missing fields"],
  ["/extract", { text: TEXT, fields: [] }, "empty fields"],
  ["/extract", { text: TEXT, fields: Array.from({ length: 21 }, (_, i) => "f" + i) }, "21 fields"],
  ["/extract", { text: TEXT, fields: ["a", "A"] }, "duplicate fields"],
  ["/extract", { text: TEXT, fields: ["a", 5] }, "non-string field"],
  ["/extract", { text: TEXT, fields: { a: 7 } }, "non-string field description"],
  ["/extract", { text: TEXT, fields: "company" }, "fields as string"],
  ["/extract", { text: TEXT, fields: ["a"], instructions: 9 }, "non-string instructions"],
  ["/extract", { text: "", fields: ["a"] }, "empty text (extract)"],
  ["/classify", { text: TEXT }, "missing labels"],
  ["/classify", { text: TEXT, labels: ["only"] }, "1 label"],
  ["/classify", { text: TEXT, labels: Array.from({ length: 21 }, (_, i) => "l" + i) }, "21 labels"],
  ["/classify", { text: TEXT, labels: ["a", "a"] }, "duplicate labels"],
  ["/classify", { text: TEXT, labels: ["a", ""] }, "empty label"],
  ["/classify", { text: TEXT, labels: ["a", "b"], multi: "yes" }, "non-boolean multi"],
  ["/classify", { text: "", labels: ["a", "b"] }, "empty text (classify)"],
];
for (const [route, body, label] of badCases) {
  reset(); r = await paid(route, body); j = await r.json();
  ok(r.status === 400 && calls.length === 0 && ai.calls.length === 0 && /no payment was taken/.test(j.error), `paid ${route} + ${label} -> 400, no AI, no facilitator`);
}
reset(); r = await W.fetch(new Request(base + "/summarize", { method: "POST", body: "{not json", headers: { "PAYMENT-SIGNATURE": hdrs["/summarize"] } }), env); ok(r.status === 400 && calls.length === 0 && ai.calls.length === 0, "paid + malformed JSON body -> 400");
reset(); r = await W.fetch(new Request(base + "/summarize", { method: "POST", body: JSON.stringify([1]), headers: { "PAYMENT-SIGNATURE": hdrs["/summarize"] } }), env); ok(r.status === 400 && calls.length === 0, "paid + array body -> 400");
reset(); r = await W.fetch(new Request(base + "/summarize", { headers: { "PAYMENT-SIGNATURE": hdrs["/summarize"] } }), env); ok(r.status === 405 && calls.length === 0, "paid GET -> 405, no facilitator call");
for (const [route, body] of [["/summarize", { text: LONG }], ["/extract", { text: LONG, fields: ["a"] }], ["/classify", { text: LONG, labels: ["a", "b"] }]]) {
  reset(); r = await paid(route, body); j = await r.json();
  ok(r.status === 413 && calls.length === 0 && ai.calls.length === 0 && /24000/.test(j.error), `paid ${route} + 24,001 chars -> 413 before payment`);
}
reset(); ai.replies = ["Fine."]; r = await paid("/summarize", { text: "y".repeat(24000) }); ok(r.status === 200 && (await r.json()).input_chars === 24000, "exactly 24,000 chars accepted");

// ---- summarize happy paths ----
reset(); ai.replies = ["Acme Corp's Q3 revenue rose 12% to $4.2 billion and it raised its outlook.\nShares gained 5% after hours."];
r = await paid("/summarize", { text: TEXT }); j = await r.json();
ok(r.status === 200, "summarize paid -> 200");
ok(dec(r.headers.get("PAYMENT-RESPONSE")).transaction === "0xdeadbeef" && dec(r.headers.get("PAYMENT-RESPONSE")).success === true, "PAYMENT-RESPONSE receipt");
ok(calls.length === 2 && calls[0].u === "https://facilitator.payai.network/verify" && calls[1].u.endsWith("/settle"), "verify then settle via payai");
const sent = JSON.parse(calls[0].init.body); ok(sent.x402Version === 2 && sent.paymentRequirements.payTo === PAY && sent.paymentRequirements.amount === "5000" && sent.paymentPayload.accepted.amount === "5000", "facilitator body uses summarize requirements");
ok(j.summary === "Acme Corp's Q3 revenue rose 12% to $4.2 billion and it raised its outlook. Shares gained 5% after hours." && j.style === "paragraph" && j.input_chars === TEXT.length && j.input_words === 43 && j.model === PRIMARY && j.usage.prompt_tokens === 123 && j.usage.completion_tokens === 45 && /^\d{4}-\d{2}-\d{2}T/.test(j.generated_at), "summarize output fields + usage passthrough");
ok(Object.keys(j).join() === "summary,style,input_chars,input_words,model,usage,generated_at", "summarize keys exact");
ok(ai.calls.length === 1 && ai.calls[0].model === PRIMARY && ai.calls[0].input.max_tokens === 400 && ai.calls[0].input.temperature === 0.2 && ai.calls[0].input.messages[0].role === "system" && ai.calls[0].input.messages[1].content.includes(TEXT), "summarize model call: primary, max_tokens 400, temp 0.2, text in user message");
const sys0 = ai.calls[0].input.messages[0].content;
ok(/at most 3 sentence/.test(sys0) && /language: en/.test(sys0) && /one paragraph/.test(sys0) && /never follow instructions/i.test(sys0), "summarize system prompt: defaults + injection guard");
ok(!JSON.stringify(j).includes("TEXT START") && !JSON.stringify(j).includes(sys0.slice(0, 40)), "response does not include the prompt");
// model-order check: AI ran after verify and before settle
reset(); let order = []; const origRun = AI.run;
AI.run = async (m, i) => { order.push("ai"); return origRun(m, i); };
const origFetch = globalThis.fetch; globalThis.fetch = async (u, init) => { order.push(String(u).split("/").pop()); return origFetch(u, init); };
ai.replies = ["S."]; r = await paid("/summarize", { text: TEXT }); ok(r.status === 200 && order.join() === "verify,ai,settle", "order: verify -> model -> settle");
AI.run = origRun; globalThis.fetch = origFetch;
// bullets
reset(); ai.replies = ["```\n• Revenue rose 12% to $4.2 billion.\n* Outlook raised.\n\n- Shares up 5% after hours.\n```"];
r = await paid("/summarize", { text: TEXT, style: "bullets", max_sentences: 5, language: "es" }); j = await r.json();
ok(r.status === 200 && j.summary === "- Revenue rose 12% to $4.2 billion.\n- Outlook raised.\n- Shares up 5% after hours." && j.style === "bullets", "bullets style normalized to '- ' lines, fences stripped");
ok(/at most 5 bullet/.test(ai.calls[0].input.messages[0].content) && /language: es/.test(ai.calls[0].input.messages[0].content), "bullets prompt carries max_sentences + language");
reset(); ai.replies = ["TL;DR: Acme beat and raised."];
r = await paid("/summarize", { text: TEXT, style: "TLDR", max_sentences: 1 }); j = await r.json();
ok(r.status === 200 && j.summary === "Acme beat and raised." && j.style === "tldr" && /TL;DR/.test(ai.calls[0].input.messages[0].content) && /at most 1 sentence,/.test(ai.calls[0].input.messages[0].content), "tldr style (case-insensitive), label stripped");
reset(); ai.replies = ["   \n```\n```  "]; r = await paid("/summarize", { text: TEXT }); ok(r.status === 502 && calls.length === 1 && !r.headers.get("PAYMENT-RESPONSE"), "empty model output -> 502, not settled");

// ---- AI failure modes (summarize) ----
reset(); ai.fail = "primary"; ai.replies = ["Fallback summary."];
r = await paid("/summarize", { text: TEXT }); j = await r.json();
ok(r.status === 200 && j.model === FALLBACK && j.summary === "Fallback summary." && ai.calls.length === 2 && ai.calls[0].model === PRIMARY && ai.calls[1].model === FALLBACK && calls.length === 2, "primary fails -> fallback succeeds -> 200 with fallback model, settled");
ok(j.usage.prompt_tokens === 123 && j.usage.completion_tokens === 45, "fallback {response, usage} shape normalized");
reset(); ai.fail = "both";
r = await paid("/summarize", { text: TEXT }); j = await r.json();
ok(r.status === 502 && j.error === "AI model temporarily unavailable, no payment taken" && ai.calls.length === 2 && calls.length === 1 && calls[0].u.endsWith("/verify") && !r.headers.get("PAYMENT-RESPONSE"), "both models fail -> 502, no settle");
reset(); ai.replies = [() => ({ weird: true })]; // non-string from mock -> model returns object content
AI.run = async (m, i) => { ai.calls.push({ model: m }); return m === PRIMARY ? { choices: [] } : { response: "From fallback." }; };
r = await paid("/summarize", { text: TEXT }); j = await r.json(); ok(r.status === 200 && j.model === FALLBACK && ai.calls.length === 2, "primary returns no text -> treated as error -> fallback");
AI.run = origRun;
reset(); mode = "badverify"; r = await paid("/summarize", { text: TEXT });
ok(r.status === 402 && dec(r.headers.get("PAYMENT-REQUIRED")).error === "insufficient_funds" && dec(r.headers.get("PAYMENT-REQUIRED")).accepts[0].amount === "5000" && calls.length === 1 && ai.calls.length === 0, "verify fail -> 402 (route amount), no AI call");
reset(); mode = "badsettle"; ai.replies = ["Secret summary text."]; r = await paid("/summarize", { text: TEXT }); const t = await r.text();
ok(r.status === 402 && t.trim() === "{}" && !t.includes("Secret") && dec(r.headers.get("PAYMENT-RESPONSE")).success === false && dec(r.headers.get("PAYMENT-RESPONSE")).errorReason === "invalid_transaction_state", "settle fail -> 402 empty body, no data leaked");
reset(); globalThis.fetch = async () => { throw new Error("boom"); }; r = await paid("/summarize", { text: TEXT }); ok(r.status === 500 && ai.calls.length === 0, "facilitator unreachable -> 500, no AI call"); globalThis.fetch = origFetch;

// ---- extract ----
reset(); ai.replies = ['```json\n{"data": {"company": "Acme Corp", "revenue": "$4.2 billion", "growth_pct": 12, "ceo": "Jane Doe", "headquarters": null, "profitable": true, "products": ["cloud", "hardware"]}, "confidence": "high", "notes": "HQ not stated."}\n```'];
r = await paid("/extract", { text: TEXT, fields: { company: "Company name", revenue: "Revenue as stated", growth_pct: "YoY growth as number", ceo: "CEO name", headquarters: "HQ city", profitable: "Was it profitable", products: "Product lines" } }); j = await r.json();
ok(r.status === 200 && j.data.company === "Acme Corp" && j.data.growth_pct === 12 && j.data.headquarters === null && j.data.profitable === true && j.data.products.join() === "cloud,hardware" && j.confidence === "high" && j.notes === "HQ not stated." && j.model === PRIMARY && j.usage.completion_tokens === 45, "extract: markdown-fenced JSON parsed, null fields, mixed value types");
ok(Object.keys(j.data).join() === "company,revenue,growth_pct,ceo,headquarters,profitable,products" && Object.keys(j).join() === "data,confidence,notes,model,usage,generated_at", "extract keys exact and in field order");
ok(calls.length === 2 && JSON.parse(calls[1].init.body).paymentRequirements.amount === "5000", "extract settled at 5000");
const esys = ai.calls[0].input.messages[0].content;
ok(/return ONLY a JSON object/.test(esys) && /exactly these keys/.test(esys) && /Use null for anything that is not present/.test(esys) && /Never invent/.test(esys) && esys.includes('"headquarters"') && ai.calls[0].input.max_tokens === 800 && ai.calls[0].input.messages[1].content.includes("HQ city"), "extract system prompt: ONLY JSON, exactly these keys, null, never invent; descriptions passed");
// fields as array, missing + extra keys, model omits wrapper
reset(); ai.replies = ['{"Company": "Acme Corp", "bogus": 1}'];
r = await paid("/extract", { text: TEXT, fields: ["company", "ticker"], instructions: "Ticker as uppercase" }); j = await r.json();
ok(r.status === 200 && j.data.company === "Acme Corp" && j.data.ticker === null && !("bogus" in j.data) && j.confidence === "medium" && j.notes === null && ai.calls[0].input.messages[1].content.includes("Ticker as uppercase"), "extract: array fields, case-insensitive key match, missing -> null, extras dropped, instructions passed");
reset(); ai.replies = ['{"data": {"company": "N/A", "ceo": {"first": "Jane"}}, "confidence": "certain", "notes": ""}'];
r = await paid("/extract", { text: TEXT, fields: ["company", "ceo"] }); j = await r.json();
ok(r.status === 200 && j.data.company === null && j.data.ceo === '{"first":"Jane"}' && j.confidence === "medium" && j.notes === null, "extract: placeholder strings -> null, object coerced to string, bad confidence -> medium");
// invalid JSON: retried once with strict prompt, then 502
reset(); ai.replies = ["Sure! Here is what I found: company is Acme", '{"data": {"company": "Acme Corp"}, "confidence": "medium", "notes": null}'];
r = await paid("/extract", { text: TEXT, fields: ["company"] }); j = await r.json();
ok(r.status === 200 && j.data.company === "Acme Corp" && ai.calls.length === 2 && ai.calls[1].input.messages.length === 4 && /ONLY/.test(ai.calls[1].input.messages[3].content) && ai.calls[1].input.messages[2].role === "assistant", "extract: invalid JSON retried once with strict prompt -> 200");
reset(); ai.replies = ["not json", "still not json"];
r = await paid("/extract", { text: TEXT, fields: ["company"] }); j = await r.json();
ok(r.status === 502 && ai.calls.length === 2 && calls.length === 1 && !r.headers.get("PAYMENT-RESPONSE") && /no payment taken/.test(j.error), "extract: invalid JSON twice -> 502, not settled");
reset(); ai.replies = ['Here you go:\n{"data": {"company": "Acme Corp"}, "confidence": "low", "notes": null}\nHope this helps.'];
r = await paid("/extract", { text: TEXT, fields: ["company"] }); j = await r.json(); ok(r.status === 200 && j.data.company === "Acme Corp" && j.confidence === "low" && ai.calls.length === 1, "extract: JSON embedded in chatter parsed without retry");
reset(); ai.fail = "primary"; ai.replies = ['{"data": {"company": "Acme Corp"}, "confidence": "high", "notes": null}'];
r = await paid("/extract", { text: TEXT, fields: ["company"] }); j = await r.json(); ok(r.status === 200 && j.model === FALLBACK && j.data.company === "Acme Corp", "extract: fallback model used when primary fails");
reset(); ai.fail = "both"; r = await paid("/extract", { text: TEXT, fields: ["company"] }); ok(r.status === 502 && calls.length === 1, "extract: both fail -> 502 no settle");
reset(); mode = "badsettle"; ai.replies = ['{"data": {"company": "Acme Corp"}, "confidence": "high", "notes": null}']; r = await paid("/extract", { text: TEXT, fields: ["company"] }); ok(r.status === 402 && (await r.text()).trim() === "{}", "extract: settle fail -> 402 empty body");
reset(); mode = "badverify"; r = await paid("/extract", { text: TEXT, fields: ["company"] }); ok(r.status === 402 && ai.calls.length === 0 && dec(r.headers.get("PAYMENT-REQUIRED")).resource.url === base + "/extract", "extract: verify fail -> 402 no AI call");

// ---- classify ----
const LABELS = ["earnings", "merger", "product launch", "lawsuit", "other"];
reset(); ai.replies = ['{"label": "Earnings", "confidence": "high"}'];
r = await paid("/classify", { text: TEXT, labels: LABELS }); j = await r.json();
ok(r.status === 200 && j.label === "earnings" && j.confidence === "high" && !("labels" in j) && j.model === PRIMARY && j.usage.prompt_tokens === 123 && Object.keys(j).join() === "label,confidence,model,usage,generated_at", "classify: single label, canonical casing from list");
ok(calls.length === 2 && JSON.parse(calls[1].init.body).paymentRequirements.amount === "2000" && ai.calls[0].input.max_tokens === 60 && ai.calls[0].input.messages[0].content.includes('"product launch"') && /exactly one label/.test(ai.calls[0].input.messages[0].content), "classify: settled at 2000, max_tokens 60, labels in prompt");
reset(); ai.replies = ['{"label": "financial results", "confidence": "high"}', '{"label": "stock news", "confidence": "high"}'];
r = await paid("/classify", { text: TEXT, labels: LABELS }); j = await r.json();
ok(r.status === 502 && ai.calls.length === 2 && /character-for-character/.test(ai.calls[1].input.messages[3].content) && calls.length === 1 && !r.headers.get("PAYMENT-RESPONSE") && /label from the given list/.test(j.error), "classify: label not in list twice, no substring match -> 502 no settle");
reset(); ai.replies = ['{"label": "financial", "confidence": "high"}', '{"label": "earnings", "confidence": "medium"}'];
r = await paid("/classify", { text: TEXT, labels: LABELS }); j = await r.json();
ok(r.status === 200 && j.label === "earnings" && j.confidence === "medium" && ai.calls.length === 2 && calls.length === 2, "classify: bad label -> strict retry fixes it -> 200");
reset(); ai.replies = ['{"label": "Quarterly Earnings report", "confidence": "high"}', '{"label": "earnings results", "confidence": "low"}'];
r = await paid("/classify", { text: TEXT, labels: LABELS }); j = await r.json();
ok(r.status === 200 && j.label === "earnings" && j.confidence === "high" && ai.calls.length === 2, "classify: retry still bad -> case-insensitive substring match on first answer");
reset(); ai.replies = ['{"label": "merging companies", "confidence": "high"}', '{"label": "the LAWSUIT one", "confidence": "low"}'];
r = await paid("/classify", { text: TEXT, labels: LABELS }); j = await r.json();
ok(r.status === 200 && j.label === "lawsuit" && j.confidence === "low", "classify: substring match falls through to the retry answer");
reset(); ai.replies = ["```json\n{\"labels\": [\"earnings\", \"Product Launch\", \"earnings\"], \"confidence\": \"medium\"}\n```"];
r = await paid("/classify", { text: TEXT, labels: LABELS, multi: true }); j = await r.json();
ok(r.status === 200 && j.labels.join() === "earnings,product launch" && !("label" in j) && j.confidence === "medium" && Object.keys(j).join() === "labels,confidence,model,usage,generated_at" && /every label that applies/.test(ai.calls[0].input.messages[0].content), "classify multi: fenced JSON, deduped, canonical labels");
reset(); ai.replies = ['{"labels": ["earnings", "rumor"], "confidence": "high"}', '{"labels": ["earnings"], "confidence": "high"}'];
r = await paid("/classify", { text: TEXT, labels: LABELS, multi: true }); j = await r.json(); ok(r.status === 200 && j.labels.join() === "earnings" && ai.calls.length === 2, "classify multi: one bad label -> retry -> 200");
reset(); ai.replies = ['{"labels": [], "confidence": "high"}', '{"labels": [], "confidence": "high"}'];
r = await paid("/classify", { text: TEXT, labels: LABELS, multi: true }); ok(r.status === 502 && calls.length === 1, "classify multi: empty labels twice -> 502 no settle");
reset(); ai.replies = ["earnings", "I think earnings"];
r = await paid("/classify", { text: TEXT, labels: LABELS }); j = await r.json(); ok(r.status === 502 && ai.calls.length === 2 && calls.length === 1, "classify: non-JSON twice -> 502 no settle");
reset(); ai.fail = "primary"; ai.replies = ['{"label": "other", "confidence": "low"}'];
r = await paid("/classify", { text: TEXT, labels: LABELS }); j = await r.json(); ok(r.status === 200 && j.model === FALLBACK && j.label === "other", "classify: fallback model");
reset(); ai.fail = "both"; r = await paid("/classify", { text: TEXT, labels: LABELS }); j = await r.json(); ok(r.status === 502 && j.error === "AI model temporarily unavailable, no payment taken" && calls.length === 1, "classify: both fail -> 502 no settle");
reset(); mode = "badsettle"; ai.replies = ['{"label": "earnings", "confidence": "high"}']; r = await paid("/classify", { text: TEXT, labels: LABELS }); ok(r.status === 402 && (await r.text()).trim() === "{}", "classify: settle fail -> 402 empty body");
reset(); mode = "badverify"; r = await paid("/classify", { text: TEXT, labels: LABELS }); ok(r.status === 402 && ai.calls.length === 0 && dec(r.headers.get("PAYMENT-REQUIRED")).accepts[0].amount === "2000", "classify: verify fail -> 402 no AI call");
reset(); ai.replies = ['{"label": "earnings", "confidence": "high"}']; r = await paid("/classify", { text: TEXT, labels: LABELS, multi: false }); ok(r.status === 200 && (await r.json()).label === "earnings", "classify: explicit multi=false");

// ---- openapi ----
reset(); r = await W.fetch(new Request(base + "/openapi.json"), env); const o = await r.json();
ok(r.status === 200 && o.openapi === "3.1.0" && o.info.title === "NoJunk AI Text" && typeof o.info["x-guidance"] === "string" && o.info["x-guidance"].includes("$0.005") && o.info["x-guidance"].includes("$0.002") && o.servers[0].url === base, "openapi header + x-guidance");
ok(Object.keys(o.paths).join() === "/summarize,/extract,/classify" && Object.keys(o.paths["/summarize"]).join() === "post", "openapi paths: 3 POST routes");
for (const [route, amt] of [["/summarize", "0.005000"], ["/extract", "0.005000"], ["/classify", "0.002000"]]) {
  const p = o.paths[route].post;
  ok(p["x-payment-info"].price.amount === amt && p["x-payment-info"].price.mode === "fixed" && p["x-payment-info"].price.currency === "USD" && p["x-payment-info"].protocols[0].x402 && p.responses["402"] && p.responses["200"] && p.responses["502"] && p.requestBody.required === true && p.requestBody.content["application/json"].schema.required.includes("text") && p.operationId, `openapi ${route} x-payment-info ${amt} + 402`);
}
ok(o.paths["/extract"].post.requestBody.content["application/json"].schema.required.join() === "text,fields" && o.paths["/classify"].post.requestBody.content["application/json"].schema.required.join() === "text,labels" && o.paths["/summarize"].post.requestBody.content["application/json"].schema.properties.style.enum.join() === "paragraph,bullets,tldr" && o.paths["/summarize"].post.responses["200"].content["application/json"].schema.required.includes("summary"), "openapi schemas per route");
r = await W.fetch(new Request(base + "/.well-known/openapi.json"), env); ok(r.status === 200, "well-known openapi alias");

// ---- CDP facilitator path (Ed25519 + EC keys) ----
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const jwk = privateKey.export({ format: "jwk" });
const secret = Buffer.concat([Buffer.from(jwk.d, "base64url"), Buffer.from(jwk.x, "base64url")]).toString("base64");
const envC = { PAY_TO: PAY, AI, CDP_API_KEY_ID: "test-key-id", CDP_API_KEY_SECRET: secret };
reset(); ai.replies = ["S."];
r = await paid("/summarize", { text: TEXT }, { env: envC });
ok(r.status === 200 && calls[0].u === "https://api.cdp.coinbase.com/platform/v2/x402/verify" && calls[1].u.endsWith("/settle"), "cdp facilitator used");
const checkJwt = (tok, pub, uri, alg) => { const [h, pl, s] = tok.split("."); const H = JSON.parse(Buffer.from(h, "base64url")), P = JSON.parse(Buffer.from(pl, "base64url"));
  const sigOk = alg === "EdDSA" ? nverify(null, Buffer.from(h + "." + pl), pub, Buffer.from(s, "base64url")) : nverify("sha256", Buffer.from(h + "." + pl), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
  return sigOk && H.alg === alg && H.kid === "test-key-id" && H.nonce.length === 32 && P.iss === "cdp" && P.sub === "test-key-id" && P.uris[0] === uri && P.exp - P.nbf === 120; };
ok(checkJwt(calls[0].init.headers.Authorization.slice(7), publicKey, "POST api.cdp.coinbase.com/platform/v2/x402/verify", "EdDSA"), "Ed25519 JWT valid (verify)");
ok(checkJwt(calls[1].init.headers.Authorization.slice(7), publicKey, "POST api.cdp.coinbase.com/platform/v2/x402/settle", "EdDSA"), "Ed25519 JWT valid (settle)");
const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pem = ec.privateKey.export({ type: "sec1", format: "pem" });
reset(); ai.replies = ["S."];
r = await paid("/summarize", { text: TEXT }, { env: { ...envC, CDP_API_KEY_SECRET: pem.replace(/\n/g, "\\n") } });
ok(r.status === 200 && checkJwt(calls[0].init.headers.Authorization.slice(7), ec.publicKey, "POST api.cdp.coinbase.com/platform/v2/x402/verify", "ES256"), "EC SEC1 JWT valid");
r = await W.fetch(new Request(base + "/"), envC); ok((await r.json()).facilitator === "cdp", "info page reports cdp");

ok(otherFetch.length === 0, "no network calls outside the facilitator mock");
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exitCode = fails ? 1 : 0;
