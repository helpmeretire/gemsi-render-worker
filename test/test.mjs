// Usage: node test/test.mjs ./worker.js /path/bazaar-out.json
import { generateKeyPairSync, verify as nverify } from "node:crypto";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const W = (await import(pathToFileURL(resolve(process.argv[2])).href)).default;
const PAY = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const LLAMA = "@cf/meta/llama-3.3-70b-instruct-fp8-fast", QWEN = "@cf/qwen/qwen2.5-coder-32b-instruct", BGE = "@cf/baai/bge-m3";
const CHAT = "/v1/chat/completions", EMB = "/v1/embeddings";
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
// ai.reply: string content (or a function (model, input) -> raw result object); ai.fail: throw on every run
const vec = (seed) => Array.from({ length: 1024 }, (_, i) => Math.sin(seed + i) / 10);
const ai = { calls: [], reply: null, fail: false, usage: { prompt_tokens: 123, completion_tokens: 45, total_tokens: 168 } };
const AI = {
  run: async (model, input) => {
    ai.calls.push({ model, input });
    if (ai.fail) throw new Error("model error " + model);
    if (typeof ai.reply === "function") return ai.reply(model, input);
    const rep = ai.reply === null ? "OK." : ai.reply;
    if (model === BGE) return { shape: [input.text.length, 1024], data: input.text.map((_, i) => vec(i)), pooling: "cls" };
    if (model === LLAMA) return { id: "chatcmpl-upstream-123", object: "chat.completion", created: 1700000000, model: LLAMA, choices: [{ index: 0, message: { role: "assistant", content: rep }, finish_reason: "stop" }], usage: { ...ai.usage } };
    return { response: rep, usage: { ...ai.usage } };
  },
};
const reset = () => { calls = []; ai.calls = []; ai.reply = null; ai.fail = false; mode = "good"; };
const env = { PAY_TO: PAY, AI };
const base = "https://llm.example.workers.dev";
const MSGS = [{ role: "system", content: "You are concise." }, { role: "user", content: "What is USDC?" }];
const post = (path, body, extra = {}) => W.fetch(new Request(base + path, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), ...extra, headers: { "Content-Type": "application/json", ...(extra.headers || {}) } }), extra.env || env);

// ---- info / discovery ----
let r = await W.fetch(new Request(base + "/"), env); let j = await r.json();
ok(r.status === 200 && j.service === "NoJunk LLM" && j.facilitator === "payai" && j.configured === true && Object.keys(j.endpoints).join() === `${CHAT},${EMB}` && j.endpoints[CHAT].price.startsWith("$0.005") && j.endpoints[EMB].price.startsWith("$0.001"), "info page lists 2 routes with prices");
ok(j.openai_compatible.base_url === base + "/v1" && /PAYMENT-SIGNATURE/.test(j.openai_compatible.how) && /base_url/.test(j.openai_compatible.how) && j.models.chat["llama-3.3-70b"] === LLAMA && j.models.chat["qwen2.5-coder-32b"] === QWEN && j.models.embeddings["bge-m3"] === BGE, "info explains OpenAI-compatible base_url + x402 header, lists models");
r = await W.fetch(new Request(base + CHAT, { method: "POST" }), { AI }); ok(r.status === 402 && dec(r.headers.get("PAYMENT-REQUIRED")).accepts[0].payTo === "0x6f762720b8515b7091e6aa69e8361f7b9909233f", "default wallet used");
r = await W.fetch(new Request(base + CHAT, { method: "POST", body: "not json" }), env); ok(r.status === 402, "bad input unpaid -> 402 first");
r = await W.fetch(new Request(base + CHAT), env); ok(r.status === 402 && r.headers.get("PAYMENT-REQUIRED"), "GET probe chat without payment -> 402");
r = await W.fetch(new Request(base + EMB), env); ok(r.status === 402 && dec(r.headers.get("PAYMENT-REQUIRED")).accepts[0].amount === "1000", "GET probe embeddings without payment -> 402");
r = await W.fetch(new Request(base + CHAT + "/"), env); ok(r.status === 402, "trailing slash accepted");
r = await W.fetch(new Request(base + "/nope", { method: "POST" }), env); ok(r.status === 404, "unknown path -> 404");
r = await W.fetch(new Request(base + CHAT, { method: "PUT" }), env); ok(r.status === 405, "PUT -> 405");
r = await W.fetch(new Request(base + CHAT, { method: "OPTIONS" }), env); ok(r.status === 200 && r.headers.get("Access-Control-Allow-Headers").includes("PAYMENT-SIGNATURE") && r.headers.get("Access-Control-Allow-Headers").includes("Authorization") && r.headers.get("Access-Control-Allow-Methods").includes("POST"), "OPTIONS CORS");
r = await W.fetch(new Request(base + CHAT, { method: "POST", headers: { "content-length": String(200 * 1024) } }), env); ok(r.status === 413, "oversized content-length -> 413 before 402");
r = await W.fetch(new Request(base + CHAT, { method: "POST" }), { PAY_TO: PAY }); j = await r.json(); ok(r.status === 500 && /AI/.test(j.error), "env.AI missing -> 500 misconfigured");
r = await W.fetch(new Request(base + EMB, { method: "POST" }), { PAY_TO: PAY }); ok(r.status === 500, "env.AI missing (embeddings) -> 500");
r = await W.fetch(new Request(base + CHAT, { method: "POST" }), { PAY_TO: "nope", AI }); ok(r.status === 500, "bad PAY_TO -> 500");

// ---- /v1/models (free) ----
r = await W.fetch(new Request(base + "/v1/models"), env); j = await r.json();
ok(r.status === 200 && !r.headers.get("PAYMENT-REQUIRED") && j.object === "list" && j.data.map((m) => m.id).join() === "llama-3.3-70b,qwen2.5-coder-32b,bge-m3" && j.data.every((m) => m.object === "model" && m.owned_by === "nojunk") && j.data[0].pricing_usd_per_call === 0.005 && j.data[1].pricing_usd_per_call === 0.005 && j.data[2].pricing_usd_per_call === 0.001, "/v1/models free, OpenAI-style list with prices");
r = await W.fetch(new Request(base + "/v1/models/bge-m3"), env); j = await r.json(); ok(r.status === 200 && j.id === "bge-m3" && j.dimensions === 1024, "/v1/models/{id}");
r = await W.fetch(new Request(base + "/v1/models/gpt-5"), env); ok(r.status === 404, "/v1/models/unknown -> 404");
r = await W.fetch(new Request(base + "/v1/models", { method: "POST" }), env); ok(r.status === 405, "POST /v1/models -> 405");

// ---- 402 probes: per-route amount + resource url ----
const PRICES = { [CHAT]: "5000", [EMB]: "1000" };
const prs = {}, payloads = {}, hdrs = {};
for (const route of Object.keys(PRICES)) {
  r = await W.fetch(new Request(base + route, { method: "POST" }), env);
  const pr = dec(r.headers.get("PAYMENT-REQUIRED")); prs[route] = pr;
  const a0 = pr.accepts[0];
  ok(r.status === 402 && pr.x402Version === 2 && pr.accepts.length === 1 && a0.scheme === "exact" && a0.amount === PRICES[route] && a0.payTo === PAY && a0.network === "eip155:8453" && a0.asset === "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" && a0.extra.name === "USD Coin" && a0.extra.version === "2" && a0.maxTimeoutSeconds === 300, `${route} 402 requirements (amount ${PRICES[route]})`);
  ok(pr.resource.url === base + route && pr.resource.mimeType === "application/json" && pr.resource.description.startsWith("NoJunk LLM"), `${route} resource url`);
  const bz = pr.extensions.bazaar;
  ok(bz.info.input.type === "http" && bz.info.input.method === "POST" && bz.info.input.bodyType === "json" && bz.info.output.type === "json" && bz.schema.properties.input.required.includes("body") && bz.schema.$schema.includes("2020-12"), `${route} bazaar ext with POST json body`);
  payloads[route] = { x402Version: 2, resource: pr.resource, accepted: pr.accepts[0], payload: { signature: "0x00", authorization: {} }, extensions: pr.extensions };
  hdrs[route] = Buffer.from(JSON.stringify(payloads[route])).toString("base64");
}
ok(Array.isArray(prs[CHAT].extensions.bazaar.info.input.body.messages) && prs[CHAT].extensions.bazaar.info.output.example.object === "chat.completion" && prs[CHAT].extensions.bazaar.schema.properties.input.properties.body.required.join() === "messages", "chat bazaar example + schema");
ok(Array.isArray(prs[EMB].extensions.bazaar.info.input.body.input) && prs[EMB].extensions.bazaar.info.output.example.data[0].object === "embedding" && prs[EMB].extensions.bazaar.schema.properties.input.properties.body.required.join() === "input", "embeddings bazaar example + schema");
writeFileSync(process.argv[3], JSON.stringify(prs[CHAT].extensions.bazaar));
const paid = (route, body, extra = {}) => post(route, body, { ...extra, headers: { "PAYMENT-SIGNATURE": hdrs[route], ...(extra.headers || {}) } });

// ---- paying with another route's requirements -> 402 ----
reset(); r = await paid(CHAT, { messages: MSGS }, { headers: { "PAYMENT-SIGNATURE": hdrs[EMB] } });
ok(r.status === 402 && dec(r.headers.get("PAYMENT-REQUIRED")).error === "No matching payment requirements found" && dec(r.headers.get("PAYMENT-REQUIRED")).accepts[0].amount === "5000" && calls.length === 0 && ai.calls.length === 0, "chat paid with embeddings requirements -> 402, nothing called");
reset(); r = await paid(EMB, { input: "hi" }, { headers: { "PAYMENT-SIGNATURE": hdrs[CHAT] } });
ok(r.status === 402 && dec(r.headers.get("PAYMENT-REQUIRED")).accepts[0].amount === "1000" && calls.length === 0 && ai.calls.length === 0, "embeddings paid with chat requirements -> 402, nothing called");
reset(); const under = { ...payloads[CHAT], accepted: { ...payloads[CHAT].accepted, amount: "1" } };
r = await post(CHAT, { messages: MSGS }, { headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(under)).toString("base64") } }); ok(r.status === 402 && calls.length === 0, "underpaid accepted -> 402");
r = await post(CHAT, { messages: MSGS }, { headers: { "PAYMENT-SIGNATURE": "!!!notbase64" } }); ok(r.status === 400 && calls.length === 0 && ai.calls.length === 0, "garbage payment header -> 400");

// ---- bad input with payment -> 400 (no AI, no facilitator) ----
const BIG = "x".repeat(32001);
const badCases = [
  [CHAT, {}, "missing messages"],
  [CHAT, { messages: [] }, "empty messages"],
  [CHAT, { messages: "hello" }, "messages as string"],
  [CHAT, { messages: [{ role: "tool", content: "x" }] }, "bad role tool"],
  [CHAT, { messages: [{ role: "User", content: "x" }] }, "bad role casing"],
  [CHAT, { messages: [{ content: "x" }] }, "missing role"],
  [CHAT, { messages: [{ role: "user" }] }, "missing content"],
  [CHAT, { messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] }, "content parts array"],
  [CHAT, { messages: [{ role: "user", content: "   " }] }, "whitespace-only content"],
  [CHAT, { messages: ["hi"] }, "message not an object"],
  [CHAT, { messages: MSGS, stream: true }, "stream:true"],
  [CHAT, { messages: MSGS, stream: "yes" }, "stream non-boolean"],
  [CHAT, { messages: MSGS, model: "gpt-5" }, "unknown model"],
  [CHAT, { messages: MSGS, model: 7 }, "non-string model"],
  [CHAT, { messages: [{ role: "user", content: BIG }] }, "32,001 chars in one message"],
  [CHAT, { messages: [{ role: "system", content: "s".repeat(16001) }, { role: "user", content: "u".repeat(16000) }] }, "32,001 chars across messages"],
  [CHAT, { messages: MSGS, max_tokens: 0 }, "max_tokens 0"],
  [CHAT, { messages: MSGS, max_tokens: 1025 }, "max_tokens 1025"],
  [CHAT, { messages: MSGS, max_tokens: 2.5 }, "max_tokens fraction"],
  [CHAT, { messages: MSGS, max_tokens: "100" }, "max_tokens string"],
  [CHAT, { messages: MSGS, temperature: -0.1 }, "temperature -0.1"],
  [CHAT, { messages: MSGS, temperature: 2.1 }, "temperature 2.1"],
  [CHAT, { messages: MSGS, top_p: 0 }, "top_p 0"],
  [CHAT, { messages: MSGS, top_p: 1.5 }, "top_p 1.5"],
  [CHAT, { messages: MSGS, response_format: "json" }, "response_format string"],
  [CHAT, { messages: MSGS, response_format: { type: "json_schema" } }, "response_format json_schema"],
  [CHAT, { messages: MSGS, n: 2 }, "n 2"],
  [CHAT, { messages: MSGS, tools: [{ type: "function" }] }, "tools"],
  [CHAT, { messages: Array.from({ length: 201 }, () => ({ role: "user", content: "x" })) }, "201 messages"],
  [EMB, {}, "missing input"],
  [EMB, { input: [] }, "empty input array"],
  [EMB, { input: "" }, "empty string input"],
  [EMB, { input: ["ok", ""] }, "empty string in array"],
  [EMB, { input: ["ok", "  "] }, "whitespace string in array"],
  [EMB, { input: [1, 2, 3] }, "token array input"],
  [EMB, { input: { text: "x" } }, "object input"],
  [EMB, { input: Array.from({ length: 33 }, (_, i) => "s" + i) }, "33 items"],
  [EMB, { input: "y".repeat(8001) }, "8,001-char string"],
  [EMB, { input: ["ok", "y".repeat(8001)] }, "8,001-char item in array"],
  [EMB, { input: "ok", model: "text-embedding-3-small" }, "unknown embedding model"],
  [EMB, { input: "ok", encoding_format: "base64" }, "base64 encoding"],
];
for (const [route, body, label] of badCases) {
  reset(); r = await paid(route, body); j = await r.json();
  ok(r.status === 400 && calls.length === 0 && ai.calls.length === 0 && /no payment was taken/.test(j.error), `paid ${route} + ${label} -> 400, no AI, no facilitator`);
}
reset(); r = await paid(CHAT, { messages: MSGS, model: "gpt-5" }); j = await r.json(); ok(/llama-3\.3-70b/.test(j.error) && /qwen2\.5-coder-32b/.test(j.error), "unknown model error lists allowed names");
reset(); r = await paid(CHAT, { messages: MSGS, stream: true }); j = await r.json(); ok(/streaming is not supported/.test(j.error), "stream:true error text");
reset(); r = await paid(CHAT, "{not json"); ok(r.status === 400 && calls.length === 0 && ai.calls.length === 0, "paid + malformed JSON body -> 400");
reset(); r = await paid(CHAT, "[1]"); ok(r.status === 400 && calls.length === 0, "paid + array body -> 400");
reset(); r = await W.fetch(new Request(base + CHAT, { headers: { "PAYMENT-SIGNATURE": hdrs[CHAT] } }), env); ok(r.status === 405 && calls.length === 0, "paid GET -> 405, no facilitator call");
// 413 before payment work
reset(); r = await paid(CHAT, { messages: [{ role: "user", content: "z".repeat(170 * 1024) }] }); j = await r.json();
ok(r.status === 413 && calls.length === 0 && ai.calls.length === 0 && /no payment was taken/.test(j.error), "paid chat body > 160 KB -> 413 before payment");
reset(); r = await paid(EMB, { input: Array.from({ length: 32 }, () => "z".repeat(6000)) }); ok(r.status === 413 && calls.length === 0 && ai.calls.length === 0, "paid embeddings body > 160 KB -> 413 before payment");
reset(); r = await paid(CHAT, { messages: MSGS }, { headers: { "content-length": String(161 * 1024) } }); ok(r.status === 413 && calls.length === 0, "paid + oversized content-length -> 413");
reset(); r = await paid(CHAT, { messages: [{ role: "user", content: "y".repeat(32000) }] }); j = await r.json(); ok(r.status === 200 && j.object === "chat.completion", "exactly 32,000 chars accepted");

// ---- chat happy path (llama shape -> normalized, fresh id) ----
reset(); ai.reply = "USDC is a dollar stablecoin.";
r = await paid(CHAT, { messages: MSGS }); j = await r.json();
ok(r.status === 200, "chat paid -> 200");
ok(dec(r.headers.get("PAYMENT-RESPONSE")).transaction === "0xdeadbeef" && dec(r.headers.get("PAYMENT-RESPONSE")).success === true, "PAYMENT-RESPONSE receipt");
ok(calls.length === 2 && calls[0].u === "https://facilitator.payai.network/verify" && calls[1].u.endsWith("/settle"), "verify then settle via payai");
const sent = JSON.parse(calls[0].init.body); ok(sent.x402Version === 2 && sent.paymentRequirements.payTo === PAY && sent.paymentRequirements.amount === "5000" && sent.paymentPayload.accepted.amount === "5000", "facilitator body uses chat requirements");
ok(/^chatcmpl-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(j.id) && j.id !== "chatcmpl-upstream-123", "fresh chatcmpl-<uuid> id (upstream id not passed through)");
ok(j.object === "chat.completion" && Number.isInteger(j.created) && Math.abs(j.created - Date.now() / 1000) < 5 && j.model === "llama-3.3-70b", "object/created/model (requested name, not CF id)");
ok(j.choices.length === 1 && j.choices[0].index === 0 && j.choices[0].message.role === "assistant" && j.choices[0].message.content === "USDC is a dollar stablecoin." && j.choices[0].finish_reason === "stop", "choices normalized");
ok(j.usage.prompt_tokens === 123 && j.usage.completion_tokens === 45 && j.usage.total_tokens === 168, "usage passthrough");
ok(Object.keys(j).join() === "id,object,created,model,choices,usage", "chat keys exact (OpenAI shape)");
ok(ai.calls.length === 1 && ai.calls[0].model === LLAMA && ai.calls[0].input.max_tokens === 512 && ai.calls[0].input.temperature === 0.7 && !("top_p" in ai.calls[0].input) && !("response_format" in ai.calls[0].input) && JSON.stringify(ai.calls[0].input.messages) === JSON.stringify(MSGS), "model call: llama, defaults max_tokens 512 / temp 0.7, messages passed verbatim, no extras");
ok(!JSON.stringify(j).includes(LLAMA), "response does not leak the Cloudflare model id");
// order check: AI ran after verify and before settle
reset(); let order = []; const origRun = AI.run;
AI.run = async (m, i) => { order.push("ai"); return origRun(m, i); };
const origFetch = globalThis.fetch; globalThis.fetch = async (u, init) => { order.push(String(u).split("/").pop()); return origFetch(u, init); };
r = await paid(CHAT, { messages: MSGS }); ok(r.status === 200 && order.join() === "verify,ai,settle", "order: verify -> model -> settle");
AI.run = origRun; globalThis.fetch = origFetch;
// options passthrough + aliases
reset(); ai.reply = '{"a":1}';
r = await paid(CHAT, { model: "gpt-4o-mini", messages: MSGS, max_tokens: 1024, temperature: 0, top_p: 0.9, response_format: { type: "json_object" }, stream: false }); j = await r.json();
ok(r.status === 200 && j.model === "llama-3.3-70b" && ai.calls[0].model === LLAMA && ai.calls[0].input.max_tokens === 1024 && ai.calls[0].input.temperature === 0 && ai.calls[0].input.top_p === 0.9 && ai.calls[0].input.response_format.type === "json_object" && j.choices[0].message.content === '{"a":1}', "gpt-4o-mini alias -> llama; max_tokens/temperature/top_p/response_format passed; stream:false ok");
for (const alias of ["default", "", "LLAMA-3.3-70B"]) { reset(); r = await paid(CHAT, { model: alias, messages: MSGS }); ok(r.status === 200 && ai.calls[0].model === LLAMA && (await r.json()).model === "llama-3.3-70b", `model alias ${JSON.stringify(alias)} -> llama`); }
reset(); r = await paid(CHAT, { messages: MSGS, response_format: { type: "text" }, max_completion_tokens: 7 }); ok(r.status === 200 && !("response_format" in ai.calls[0].input) && ai.calls[0].input.max_tokens === 7, "response_format text dropped; max_completion_tokens accepted");
// llama finish_reason length passthrough; missing usage approximated
reset(); ai.reply = (m) => ({ choices: [{ message: { role: "assistant", content: "cut off" }, finish_reason: "length" }] });
r = await paid(CHAT, { messages: MSGS }); j = await r.json(); ok(r.status === 200 && j.choices[0].finish_reason === "length" && j.usage.prompt_tokens === Math.ceil(MSGS.reduce((a, m) => a + m.content.length, 0) / 4) && j.usage.completion_tokens === 2 && j.usage.total_tokens === j.usage.prompt_tokens + 2, "finish_reason length kept; missing usage approximated from chars");
// qwen shape normalized
reset(); ai.reply = "def add(a, b):\n    return a + b";
r = await paid(CHAT, { model: "qwen2.5-coder-32b", messages: [{ role: "user", content: "write add" }] }); j = await r.json();
ok(r.status === 200 && ai.calls[0].model === QWEN && j.model === "qwen2.5-coder-32b" && j.object === "chat.completion" && j.choices[0].message.content.startsWith("def add") && j.choices[0].finish_reason === "stop" && j.usage.total_tokens === 168 && /^chatcmpl-/.test(j.id), "qwen {response, usage} normalized to chat.completion");
ok(calls.length === 2 && JSON.parse(calls[1].init.body).paymentRequirements.amount === "5000", "qwen call settled at 5000");
// empty content -> 502 no settle
reset(); ai.reply = "   \n";
r = await paid(CHAT, { messages: MSGS }); j = await r.json(); ok(r.status === 502 && calls.length === 1 && !r.headers.get("PAYMENT-RESPONSE") && /empty/.test(j.error) && /no payment taken/.test(j.error), "empty content -> 502, not settled");
reset(); ai.reply = () => ({ choices: [] });
r = await paid(CHAT, { messages: MSGS }); ok(r.status === 502 && calls.length === 1, "no choices -> 502, not settled");
reset(); ai.reply = () => ({ result: { response: "nested" } });
r = await paid(CHAT, { messages: MSGS }); j = await r.json(); ok(r.status === 200 && j.choices[0].message.content === "nested", "nested {result:{response}} shape tolerated");
// model failure -> 502 no settle (no fallback model: the caller chose the model)
reset(); ai.fail = true;
r = await paid(CHAT, { messages: MSGS }); j = await r.json();
ok(r.status === 502 && j.error === "AI model temporarily unavailable, no payment taken" && ai.calls.length === 1 && calls.length === 1 && calls[0].u.endsWith("/verify") && !r.headers.get("PAYMENT-RESPONSE"), "model throws -> 502, no settle, no fallback");
reset(); mode = "badverify"; r = await paid(CHAT, { messages: MSGS });
ok(r.status === 402 && dec(r.headers.get("PAYMENT-REQUIRED")).error === "insufficient_funds" && dec(r.headers.get("PAYMENT-REQUIRED")).accepts[0].amount === "5000" && calls.length === 1 && ai.calls.length === 0, "chat verify fail -> 402 (route amount), no AI call");
reset(); mode = "badsettle"; ai.reply = "Secret completion text."; r = await paid(CHAT, { messages: MSGS }); let t = await r.text();
ok(r.status === 402 && t.trim() === "{}" && !t.includes("Secret") && dec(r.headers.get("PAYMENT-RESPONSE")).success === false && dec(r.headers.get("PAYMENT-RESPONSE")).errorReason === "invalid_transaction_state", "chat settle fail -> 402 empty body, no data leaked");
reset(); globalThis.fetch = async () => { throw new Error("boom"); }; r = await paid(CHAT, { messages: MSGS }); ok(r.status === 500 && ai.calls.length === 0, "facilitator unreachable -> 500, no AI call"); globalThis.fetch = origFetch;

// ---- embeddings ----
reset(); r = await paid(EMB, { input: ["Pay-per-call APIs", "USDC on Base"] }); j = await r.json();
ok(r.status === 200 && j.object === "list" && j.model === "bge-m3" && j.data.length === 2 && j.data[0].object === "embedding" && j.data[0].index === 0 && j.data[1].index === 1 && j.data[0].embedding.length === 1024 && j.data[1].embedding.length === 1024 && j.data[0].embedding[0] !== j.data[1].embedding[0] && Object.keys(j).join() === "object,data,model,usage", "embeddings success: OpenAI list shape, 1024-dim vectors in order");
ok(j.usage.prompt_tokens === Math.ceil(("Pay-per-call APIs".length + "USDC on Base".length) / 4) && j.usage.total_tokens === j.usage.prompt_tokens, "embeddings usage approx chars/4");
ok(ai.calls.length === 1 && ai.calls[0].model === BGE && JSON.stringify(ai.calls[0].input) === JSON.stringify({ text: ["Pay-per-call APIs", "USDC on Base"] }), "embeddings model call: bge-m3 with {text: [...]}");
ok(calls.length === 2 && JSON.parse(calls[1].init.body).paymentRequirements.amount === "1000" && dec(r.headers.get("PAYMENT-RESPONSE")).success === true, "embeddings settled at 1000");
reset(); r = await paid(EMB, { input: "single string", model: "BGE-M3" }); j = await r.json(); ok(r.status === 200 && j.data.length === 1 && ai.calls[0].input.text.join() === "single string", "single string input wrapped into array; model case-insensitive");
reset(); r = await paid(EMB, { input: Array.from({ length: 32 }, (_, i) => "item " + i), encoding_format: "float" }); j = await r.json(); ok(r.status === 200 && j.data.length === 32 && j.data[31].index === 31, "32 items accepted");
reset(); ai.reply = (m, i) => ({ shape: [1, 1024], data: [vec(1)], pooling: "cls" });
r = await paid(EMB, { input: ["a", "b"] }); j = await r.json(); ok(r.status === 502 && calls.length === 1 && !r.headers.get("PAYMENT-RESPONSE") && /number of embeddings/.test(j.error) && /no payment taken/.test(j.error), "mismatched vector count -> 502, not settled");
reset(); ai.reply = () => ({ data: [["x", 1]] }); r = await paid(EMB, { input: "a" }); ok(r.status === 502 && calls.length === 1, "malformed vector -> 502, not settled");
reset(); ai.reply = () => ({ nope: true }); r = await paid(EMB, { input: "a" }); ok(r.status === 502 && calls.length === 1, "no data field -> 502, not settled");
reset(); ai.fail = true; r = await paid(EMB, { input: "a" }); j = await r.json(); ok(r.status === 502 && j.error === "AI model temporarily unavailable, no payment taken" && calls.length === 1, "embeddings model throws -> 502 no settle");
reset(); mode = "badverify"; r = await paid(EMB, { input: "a" }); ok(r.status === 402 && ai.calls.length === 0 && dec(r.headers.get("PAYMENT-REQUIRED")).resource.url === base + EMB && dec(r.headers.get("PAYMENT-REQUIRED")).accepts[0].amount === "1000", "embeddings verify fail -> 402 no AI call");
reset(); mode = "badsettle"; r = await paid(EMB, { input: "a" }); t = await r.text(); ok(r.status === 402 && t.trim() === "{}" && dec(r.headers.get("PAYMENT-RESPONSE")).success === false, "embeddings settle fail -> 402 empty body");

// ---- openapi ----
reset(); r = await W.fetch(new Request(base + "/openapi.json"), env); const o = await r.json();
ok(r.status === 200 && o.openapi === "3.1.0" && o.info.title === "NoJunk LLM" && typeof o.info["x-guidance"] === "string" && o.info["x-guidance"].includes("$0.005") && o.info["x-guidance"].includes("$0.001") && o.info["x-guidance"].includes(base + "/v1") && /PAYMENT-SIGNATURE/.test(o.info["x-guidance"]) && o.servers[0].url === base, "openapi header + x-guidance (base_url, header, prices)");
ok(Object.keys(o.paths).join() === `${CHAT},${EMB},/v1/models` && Object.keys(o.paths[CHAT]).join() === "post" && Object.keys(o.paths["/v1/models"]).join() === "get" && !o.paths["/v1/models"].get["x-payment-info"], "openapi paths: 2 paid POST routes + free GET /v1/models");
for (const [route, amt] of [[CHAT, "0.005000"], [EMB, "0.001000"]]) {
  const p = o.paths[route].post;
  ok(p["x-payment-info"].price.amount === amt && p["x-payment-info"].price.mode === "fixed" && p["x-payment-info"].price.currency === "USD" && p["x-payment-info"].protocols[0].x402 && p.responses["402"] && p.responses["200"] && p.responses["400"] && p.responses["413"] && p.responses["502"] && p.requestBody.required === true && p.operationId, `openapi ${route} x-payment-info ${amt} + 402`);
}
const cs = o.paths[CHAT].post.requestBody.content["application/json"].schema, es = o.paths[EMB].post.requestBody.content["application/json"].schema;
ok(cs.required.join() === "messages" && cs.properties.model.enum.join() === "llama-3.3-70b,qwen2.5-coder-32b,gpt-4o-mini" && cs.properties.max_tokens.maximum === 1024 && cs.properties.messages.items.properties.role.enum.join() === "system,user,assistant" && cs.properties.stream.const === false && es.required.join() === "input" && es.properties.input.oneOf.length === 2 && es.properties.input.oneOf[1].maxItems === 32 && o.paths[CHAT].post.responses["200"].content["application/json"].schema.required.includes("choices") && o.paths[EMB].post.responses["200"].content["application/json"].schema.properties.data.items.properties.embedding.minItems === 1024, "openapi schemas per route");
r = await W.fetch(new Request(base + "/.well-known/openapi.json"), env); ok(r.status === 200, "well-known openapi alias");

// ---- CDP facilitator path (Ed25519 + EC keys) ----
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const jwk = privateKey.export({ format: "jwk" });
const secret = Buffer.concat([Buffer.from(jwk.d, "base64url"), Buffer.from(jwk.x, "base64url")]).toString("base64");
const envC = { PAY_TO: PAY, AI, CDP_API_KEY_ID: "test-key-id", CDP_API_KEY_SECRET: secret };
reset(); r = await paid(CHAT, { messages: MSGS }, { env: envC });
ok(r.status === 200 && calls[0].u === "https://api.cdp.coinbase.com/platform/v2/x402/verify" && calls[1].u.endsWith("/settle"), "cdp facilitator used");
const checkJwt = (tok, pub, uri, alg) => { const [h, pl, s] = tok.split("."); const H = JSON.parse(Buffer.from(h, "base64url")), P = JSON.parse(Buffer.from(pl, "base64url"));
  const sigOk = alg === "EdDSA" ? nverify(null, Buffer.from(h + "." + pl), pub, Buffer.from(s, "base64url")) : nverify("sha256", Buffer.from(h + "." + pl), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
  return sigOk && H.alg === alg && H.kid === "test-key-id" && H.nonce.length === 32 && P.iss === "cdp" && P.sub === "test-key-id" && P.uris[0] === uri && P.exp - P.nbf === 120; };
ok(checkJwt(calls[0].init.headers.Authorization.slice(7), publicKey, "POST api.cdp.coinbase.com/platform/v2/x402/verify", "EdDSA"), "Ed25519 JWT valid (verify)");
ok(checkJwt(calls[1].init.headers.Authorization.slice(7), publicKey, "POST api.cdp.coinbase.com/platform/v2/x402/settle", "EdDSA"), "Ed25519 JWT valid (settle)");
const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pem = ec.privateKey.export({ type: "sec1", format: "pem" });
reset(); r = await paid(EMB, { input: "a" }, { env: { ...envC, CDP_API_KEY_SECRET: pem.replace(/\n/g, "\\n") } });
ok(r.status === 200 && checkJwt(calls[0].init.headers.Authorization.slice(7), ec.publicKey, "POST api.cdp.coinbase.com/platform/v2/x402/verify", "ES256"), "EC SEC1 JWT valid (embeddings via cdp)");
r = await W.fetch(new Request(base + "/"), envC); ok((await r.json()).facilitator === "cdp", "info page reports cdp");

ok(otherFetch.length === 0, "no network calls outside the facilitator mock");
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exitCode = fails ? 1 : 0;
