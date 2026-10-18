// Usage: node test/test.mjs ./worker.js /path/bazaar-out.json   (no network: facilitator, audio URLs and Workers AI are all mocked)
import { generateKeyPairSync, verify as nverify } from "node:crypto";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const W = (await import(pathToFileURL(resolve(process.argv[2])).href)).default;
const PAY = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const WHISPER = "@cf/openai/whisper-large-v3-turbo", AURA = "@cf/deepgram/aura-1", M2M = "@cf/meta/m2m100-1.2b";
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const dec = (h) => JSON.parse(Buffer.from(h, "base64").toString());

// ---- facilitator + audio-host mock (never hits the network) ----
let calls = [], mode = "good", otherFetch = [], audioFetches = [];
// audioHosts: url -> { status, headers, body (Buffer|string|ReadableStream fn), hang }
const audioHosts = {};
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
  if (audioHosts[u]) {
    audioFetches.push({ u, init });
    const h = audioHosts[u];
    if (h.hang) return new Promise((_, rej) => { init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))); });
    const body = typeof h.body === "function" ? h.body() : h.body;
    return new Response(body, { status: h.status || 200, headers: h.headers || {} });
  }
  otherFetch.push(u); throw new Error("unexpected network call " + u);
};

// ---- Workers AI mock ----
// ai.reply[model]: value or function(input) returned; ai.fail: Set of models that throw
const MP3 = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(996, 7)]); // 1000 bytes starting with an MP3 frame sync
const WHISPER_OUT = { transcription_info: { language: "en", language_probability: 0.98, duration: 6.4, duration_after_vad: 6.1 }, text: " Welcome back to the show. Today we talk about agents. ", word_count: 10, segments: [{ start: 0, end: 2.1, text: " Welcome back to the show.", temperature: 0, avg_logprob: -0.2 }, { start: 2.1, end: 6.4, text: " Today we talk about agents. ", temperature: 0, avg_logprob: -0.3 }], vtt: "WEBVTT..." };
const ai = { calls: [], reply: {}, fail: new Set() };
const AI = {
  run: async (model, input) => {
    ai.calls.push({ model, input });
    if (ai.fail.has(model)) throw new Error("model error " + model);
    let rep = ai.reply[model];
    if (typeof rep === "function") rep = rep(input);
    if (rep !== undefined) return rep;
    if (model === WHISPER) return JSON.parse(JSON.stringify(WHISPER_OUT));
    if (model === AURA) return new Blob([MP3]).stream(); // ReadableStream, like the live binding
    if (model === M2M) return { translated_text: "La reunión se ha trasladado al jueves.", usage: { prompt_tokens: 12, completion_tokens: 11 } };
    throw new Error("unknown model " + model);
  },
};
const reset = () => { calls = []; ai.calls = []; ai.reply = {}; ai.fail = new Set(); mode = "good"; audioFetches = []; for (const k of Object.keys(audioHosts)) delete audioHosts[k]; };
const env = { PAY_TO: PAY, AI };
const base = "https://speech.example.workers.dev";
const TEXT = "The meeting has been moved to Thursday at 3 pm.";
const post = (path, body, extra = {}) => W.fetch(new Request(base + path, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), ...extra, headers: { "Content-Type": "application/json", ...(extra.headers || {}) } }), extra.env || env);
const b64 = (buf) => Buffer.from(buf).toString("base64");
const AUDIO_URL = "https://cdn.example.com/clip.mp3";
const serveAudio = (u = AUDIO_URL, opts = {}) => { audioHosts[u] = { status: 200, headers: { "content-type": "audio/mpeg", ...(opts.headers || {}) }, body: MP3, ...opts }; };

// ---- info / discovery ----
let r = await W.fetch(new Request(base + "/"), env); let j = await r.json();
ok(r.status === 200 && j.service === "NoJunk Speech" && j.facilitator === "payai" && j.configured === true && Object.keys(j.endpoints).join() === "/transcribe,/speak,/translate" && j.endpoints["/transcribe"].price.startsWith("$0.02 ") && j.endpoints["/speak"].price.startsWith("$0.01 ") && j.endpoints["/translate"].price.startsWith("$0.002 ") && j.limits.translate.languages.length === 100, "info page lists 3 routes with prices + 100 languages");
r = await W.fetch(new Request(base + "/transcribe", { method: "POST" }), { AI }); ok(r.status === 402 && dec(r.headers.get("PAYMENT-REQUIRED")).accepts[0].payTo === "0x6f762720b8515b7091e6aa69e8361f7b9909233f", "default wallet used");
r = await W.fetch(new Request(base + "/speak", { method: "POST", body: "not json" }), env); ok(r.status === 402, "bad input unpaid -> 402 first");
for (const route of ["/transcribe", "/speak", "/translate"]) { r = await W.fetch(new Request(base + route), env); ok(r.status === 402 && r.headers.get("PAYMENT-REQUIRED") && dec(r.headers.get("PAYMENT-REQUIRED")).resource.url === base + route, `GET ${route} probe without payment -> 402`); }
r = await W.fetch(new Request(base + "/nope", { method: "POST" }), env); ok(r.status === 404, "unknown path -> 404");
r = await W.fetch(new Request(base + "/speak", { method: "PUT" }), env); ok(r.status === 405, "PUT -> 405");
r = await W.fetch(new Request(base + "/speak", { method: "OPTIONS" }), env); ok(r.status === 200 && r.headers.get("Access-Control-Allow-Headers").includes("PAYMENT-SIGNATURE") && r.headers.get("Access-Control-Allow-Methods").includes("POST") && r.headers.get("Access-Control-Expose-Headers").includes("X-Audio-Bytes"), "OPTIONS CORS");
r = await W.fetch(new Request(base + "/speak", { method: "POST", headers: { "content-length": String(65 * 1024) } }), env); ok(r.status === 413, "speak oversized content-length (65 KB) -> 413 before 402");
r = await W.fetch(new Request(base + "/translate", { method: "POST", headers: { "content-length": String(65 * 1024) } }), env); ok(r.status === 413, "translate oversized content-length -> 413 before 402");
r = await W.fetch(new Request(base + "/transcribe", { method: "POST", headers: { "content-length": String(29 * 1024 * 1024) } }), env); ok(r.status === 413, "transcribe content-length 29 MB -> 413 before 402");
r = await W.fetch(new Request(base + "/transcribe", { method: "POST", headers: { "content-length": String(27 * 1024 * 1024) } }), env); ok(r.status === 402, "transcribe content-length 27 MB -> allowed (402 probe)");
r = await W.fetch(new Request(base + "/speak", { method: "POST" }), { PAY_TO: PAY }); j = await r.json(); ok(r.status === 500 && /AI/.test(j.error), "env.AI missing -> 500 misconfigured");
r = await W.fetch(new Request(base + "/speak", { method: "POST" }), { PAY_TO: "nope", AI }); ok(r.status === 500, "bad PAY_TO -> 500");

// ---- 402 probes: per-route amount + resource url ----
const PRICES = { "/transcribe": "20000", "/speak": "10000", "/translate": "2000" };
const prs = {}, payloads = {}, hdrs = {};
for (const route of Object.keys(PRICES)) {
  r = await W.fetch(new Request(base + route, { method: "POST" }), env);
  const pr = dec(r.headers.get("PAYMENT-REQUIRED")); prs[route] = pr;
  const a0 = pr.accepts[0];
  ok(r.status === 402 && pr.x402Version === 2 && pr.accepts.length === 1 && a0.scheme === "exact" && a0.amount === PRICES[route] && a0.payTo === PAY && a0.network === "eip155:8453" && a0.asset === "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" && a0.extra.name === "USD Coin" && a0.extra.version === "2" && a0.maxTimeoutSeconds === 300, `${route} 402 requirements (amount ${PRICES[route]})`);
  ok(pr.resource.url === base + route && pr.resource.mimeType === "application/json" && pr.resource.description.includes(route.slice(1)), `${route} resource url`);
  const bz = pr.extensions.bazaar;
  ok(bz.info.input.type === "http" && bz.info.input.method === "POST" && bz.info.input.bodyType === "json" && typeof bz.info.input.body === "object" && bz.info.output.type === "json" && typeof bz.info.output.example === "object" && bz.schema.properties.input.required.includes("body"), `${route} bazaar ext with POST json body`);
  payloads[route] = { x402Version: 2, resource: pr.resource, accepted: pr.accepts[0], payload: { signature: "0x00", authorization: {} }, extensions: pr.extensions };
  hdrs[route] = Buffer.from(JSON.stringify(payloads[route])).toString("base64");
}
ok(prs["/transcribe"].extensions.bazaar.info.input.body.audio_url.startsWith("https://") && prs["/speak"].extensions.bazaar.info.input.body.text && prs["/speak"].extensions.bazaar.info.output.example.content_type === "audio/mpeg" && prs["/translate"].extensions.bazaar.info.input.body.target_lang === "es" && prs["/translate"].extensions.bazaar.info.output.example.translated_text.length > 0 && prs["/translate"].extensions.bazaar.schema.properties.input.properties.body.required.join() === "text,target_lang", "bazaar examples are route specific");
writeFileSync(process.argv[3], JSON.stringify(prs["/translate"].extensions.bazaar));
const paid = (route, body, extra = {}) => post(route, body, { ...extra, headers: { "PAYMENT-SIGNATURE": hdrs[route], ...(extra.headers || {}) } });

// ---- paying with another route's requirements -> 402 ----
for (const [route, other] of [["/transcribe", "/speak"], ["/speak", "/translate"], ["/translate", "/transcribe"]]) {
  reset(); serveAudio();
  r = await post(route, { audio_url: AUDIO_URL, text: TEXT, target_lang: "es" }, { headers: { "PAYMENT-SIGNATURE": hdrs[other] } });
  ok(r.status === 402 && dec(r.headers.get("PAYMENT-REQUIRED")).error === "No matching payment requirements found" && dec(r.headers.get("PAYMENT-REQUIRED")).accepts[0].amount === PRICES[route] && calls.length === 0 && ai.calls.length === 0 && audioFetches.length === 0, `${route} paid with ${other} requirements -> 402 (own amount), nothing called`);
}
reset(); const under = { ...payloads["/transcribe"], accepted: { ...payloads["/transcribe"].accepted, amount: "2000" } };
r = await post("/transcribe", { audio_base64: b64(MP3) }, { headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(under)).toString("base64") } }); ok(r.status === 402 && calls.length === 0 && ai.calls.length === 0, "underpaid transcribe (2000 for a 20000 route) -> 402");
r = await post("/speak", { text: TEXT }, { headers: { "PAYMENT-SIGNATURE": "!!!notbase64" } }); ok(r.status === 400 && calls.length === 0 && ai.calls.length === 0, "garbage payment header -> 400");

// ---- bad input with payment -> 400 (no AI, no facilitator, no audio fetch) ----
const badCases = [
  ["/transcribe", {}, 400, "missing audio"],
  ["/transcribe", { audio_url: AUDIO_URL, audio_base64: "AAAA" }, 400, "both audio_url and audio_base64"],
  ["/transcribe", { audio_url: 42 }, 400, "non-string audio_url"],
  ["/transcribe", { audio_url: "ftp://cdn.example.com/a.mp3" }, 400, "ftp url"],
  ["/transcribe", { audio_url: "https://user:pw@cdn.example.com/a.mp3" }, 400, "credentials in url"],
  ["/transcribe", { audio_url: "http://127.0.0.1/a.mp3" }, 400, "loopback ip blocked"],
  ["/transcribe", { audio_url: "http://10.1.2.3/a.mp3" }, 400, "private 10/8 blocked"],
  ["/transcribe", { audio_url: "http://192.168.1.5/a.mp3" }, 400, "private 192.168 blocked"],
  ["/transcribe", { audio_url: "http://169.254.169.254/latest/meta-data" }, 400, "link-local metadata ip blocked"],
  ["/transcribe", { audio_url: "http://[::1]/a.mp3" }, 400, "ipv6 loopback blocked"],
  ["/transcribe", { audio_url: "http://[fd00::1]/a.mp3" }, 400, "ipv6 unique-local blocked"],
  ["/transcribe", { audio_url: "http://localhost:8080/a.mp3" }, 400, "localhost blocked"],
  ["/transcribe", { audio_url: "http://internal-host/a.mp3" }, 400, "single-label host blocked"],
  ["/transcribe", { audio_url: "http://files.corp/a.mp3" }, 400, ".corp suffix blocked"],
  ["/transcribe", { audio_url: "https://" + "a".repeat(2100) + ".com/x.mp3" }, 400, "url too long"],
  ["/transcribe", { audio_base64: "" }, 400, "empty base64"],
  ["/transcribe", { audio_base64: "not*base64!" }, 400, "invalid base64"],
  ["/transcribe", { audio_base64: 123 }, 400, "non-string base64"],
  ["/transcribe", { audio_base64: b64(MP3), content_type: 5 }, 400, "non-string content_type"],
  ["/transcribe", { audio_base64: b64(MP3), language: "english" }, 400, "bad language hint"],
  ["/transcribe", { audio_base64: b64(MP3), content_type: "text/html" }, 415, "non-audio content_type -> 415"],
  ["/transcribe", { audio_base64: b64(MP3), content_type: "application/pdf" }, 415, "pdf content_type -> 415"],
  ["/transcribe", { audio_base64: b64("<!DOCTYPE html><html><body>login</body></html>") }, 415, "base64 of an html page -> 415"],
  ["/speak", {}, 400, "missing text"],
  ["/speak", { text: "" }, 400, "empty text"],
  ["/speak", { text: "  \n " }, 400, "whitespace text"],
  ["/speak", { text: 42 }, 400, "non-string text"],
  ["/speak", { text: TEXT, speaker: "darth-vader" }, 400, "unknown speaker"],
  ["/speak", { text: TEXT, format: "wav" }, 400, "unknown format"],
  ["/speak", { text: "x".repeat(401) }, 413, "401 chars -> 413"],
  ["/translate", { text: TEXT }, 400, "missing target_lang"],
  ["/translate", { text: TEXT, target_lang: "xx" }, 400, "unsupported target_lang"],
  ["/translate", { text: TEXT, target_lang: "klingon" }, 400, "bad target_lang shape"],
  ["/translate", { text: TEXT, target_lang: "es", source_lang: "xx" }, 400, "unsupported source_lang"],
  ["/translate", { text: TEXT, target_lang: "en" }, 400, "same lang (default en -> en)"],
  ["/translate", { text: TEXT, target_lang: "ES", source_lang: "es" }, 400, "same lang explicit"],
  ["/translate", { text: "", target_lang: "es" }, 400, "empty text"],
  ["/translate", { text: 7, target_lang: "es" }, 400, "non-string text"],
  ["/translate", { text: "x".repeat(5001), target_lang: "es" }, 413, "5001 chars -> 413"],
];
for (const [route, body, status, label] of badCases) {
  reset(); r = await paid(route, body); j = await r.json();
  ok(r.status === status && calls.length === 0 && ai.calls.length === 0 && audioFetches.length === 0 && /no payment was taken/.test(j.error), `paid ${route} + ${label} -> ${status}, no AI, no facilitator`);
}
reset(); r = await post("/speak", "{not json", { headers: { "PAYMENT-SIGNATURE": hdrs["/speak"] } }); ok(r.status === 400 && calls.length === 0 && ai.calls.length === 0, "paid + malformed JSON body -> 400");
reset(); r = await post("/translate", "[1]", { headers: { "PAYMENT-SIGNATURE": hdrs["/translate"] } }); ok(r.status === 400 && calls.length === 0, "paid + array body -> 400");
reset(); r = await W.fetch(new Request(base + "/speak", { headers: { "PAYMENT-SIGNATURE": hdrs["/speak"] } }), env); ok(r.status === 405 && calls.length === 0, "paid GET -> 405, no facilitator call");
reset(); r = await post("/speak", JSON.stringify({ text: "a".repeat(70 * 1024) }), { headers: { "PAYMENT-SIGNATURE": hdrs["/speak"] } }); ok(r.status === 413 && calls.length === 0 && ai.calls.length === 0, "paid speak 70 KB body without content-length -> 413 before payment");
reset(); r = await paid("/transcribe", { audio_base64: b64(Buffer.alloc(20.5 * 1024 * 1024, 1)) }); j = await r.json(); ok(r.status === 413 && calls.length === 0 && ai.calls.length === 0 && /20971520/.test(j.error), "paid transcribe 20.5 MB decoded base64 -> 413 (audio cap) before payment");
reset(); r = await paid("/transcribe", { audio_base64: b64(Buffer.alloc(22 * 1024 * 1024, 1)) }); j = await r.json(); ok(r.status === 413 && calls.length === 0 && ai.calls.length === 0 && /Request body too large/.test(j.error), "paid transcribe 22 MB base64 (29 MB body, no content-length) -> 413 (body cap) before payment");
reset(); r = await paid("/translate", { text: "y".repeat(5000), target_lang: "fr" }); ok(r.status === 200 && (await r.json()).input_chars === 5000, "exactly 5,000 chars accepted (translate)");
reset(); r = await paid("/speak", { text: "y".repeat(400), format: "json" }); ok(r.status === 200 && (await r.json()).text_chars === 400, "exactly 400 chars accepted (speak)");

// ---- transcribe: audio_url ----
reset(); serveAudio();
r = await paid("/transcribe", { audio_url: AUDIO_URL }); j = await r.json();
ok(r.status === 200, "transcribe url paid -> 200");
ok(dec(r.headers.get("PAYMENT-RESPONSE")).transaction === "0xdeadbeef" && dec(r.headers.get("PAYMENT-RESPONSE")).success === true, "PAYMENT-RESPONSE receipt");
ok(calls.length === 2 && calls[0].u === "https://facilitator.payai.network/verify" && calls[1].u.endsWith("/settle") && JSON.parse(calls[1].init.body).paymentRequirements.amount === "20000", "verify then settle at 20000");
ok(audioFetches.length === 1 && audioFetches[0].u === AUDIO_URL && audioFetches[0].init.signal instanceof AbortSignal && audioFetches[0].init.redirect === "manual" && /NoJunk Speech\/1\.0/.test(audioFetches[0].init.headers["User-Agent"]) && /audio\//.test(audioFetches[0].init.headers.Accept), "audio fetched with AbortSignal (timeout), manual redirects, UA, Accept");
ok(ai.calls.length === 1 && ai.calls[0].model === WHISPER && ai.calls[0].input.audio === b64(MP3) && ai.calls[0].input.task === "transcribe" && ai.calls[0].input.vad_filter === true && !("language" in ai.calls[0].input), "whisper called with base64 audio, task transcribe, vad_filter, no language");
ok(j.text === "Welcome back to the show. Today we talk about agents." && j.language === "en" && j.language_probability === 0.98 && j.duration_seconds === 6.4 && j.word_count === 10 && j.segments.length === 2 && j.segments[0].start === 0 && j.segments[0].end === 2.1 && j.segments[0].text === "Welcome back to the show." && Object.keys(j.segments[1]).join() === "start,end,text" && j.audio_bytes === 1000 && j.source === "url" && j.model === WHISPER && /^\d{4}-\d{2}-\d{2}T/.test(j.generated_at), "transcribe output fields (segments trimmed to start,end,text)");
ok(Object.keys(j).join() === "text,language,language_probability,duration_seconds,word_count,segments,audio_bytes,source,model,generated_at", "transcribe keys exact");
ok(!("vtt" in j) && !("duration_after_vad" in j), "raw whisper extras not leaked");
// order: verify -> audio fetch -> model -> settle
reset(); serveAudio(); let order = []; const origRun = AI.run, origFetch = globalThis.fetch;
AI.run = async (m, i) => { order.push("ai"); return origRun(m, i); };
globalThis.fetch = async (u, init) => { order.push(String(u).includes("facilitator") ? String(u).split("/").pop() : "audio"); return origFetch(u, init); };
r = await paid("/transcribe", { audio_url: AUDIO_URL }); ok(r.status === 200 && order.join() === "verify,audio,ai,settle", "order: verify -> download -> model -> settle");
AI.run = origRun; globalThis.fetch = origFetch;
// language hint passed
reset(); serveAudio(); r = await paid("/transcribe", { audio_url: AUDIO_URL, language: "ES" }); ok(r.status === 200 && ai.calls[0].input.language === "es", "language hint lower-cased and passed to whisper");
// content types from URL
for (const ct of ["audio/wav", "audio/mp4; codecs=mp4a", "video/mp4", "application/octet-stream", ""]) {
  reset(); serveAudio(AUDIO_URL, { headers: { "content-type": ct } }); r = await paid("/transcribe", { audio_url: AUDIO_URL }); ok(r.status === 200, `url content-type "${ct}" accepted`);
}
for (const ct of ["text/html; charset=utf-8", "application/pdf", "image/png", "application/json"]) {
  reset(); serveAudio(AUDIO_URL, { headers: { "content-type": ct } }); r = await paid("/transcribe", { audio_url: AUDIO_URL }); j = await r.json();
  ok(r.status === 415 && ai.calls.length === 0 && calls.length === 1 && !r.headers.get("PAYMENT-RESPONSE") && /no payment was taken/.test(j.error), `url content-type "${ct}" -> 415, no AI, not settled`);
}
reset(); serveAudio(AUDIO_URL, { headers: { "content-type": "application/octet-stream" }, body: "<html><body>Please log in</body></html>" }); r = await paid("/transcribe", { audio_url: AUDIO_URL }); ok(r.status === 415 && ai.calls.length === 0 && calls.length === 1, "octet-stream that is actually html -> 415 not settled");
// size cap: declared content-length
reset(); serveAudio(AUDIO_URL, { headers: { "content-length": String(25 * 1024 * 1024) } }); r = await paid("/transcribe", { audio_url: AUDIO_URL }); j = await r.json();
ok(r.status === 413 && ai.calls.length === 0 && calls.length === 1 && /20 MB/.test(j.error), "declared content-length 25 MB -> 413, no AI, not settled");
// size cap: streaming body with no content-length, reader cancelled past 20 MB
reset(); let pulled = 0, cancelled = false;
serveAudio(AUDIO_URL, { body: () => new ReadableStream({ pull(c) { pulled++; if (pulled > 40) { c.close(); return; } c.enqueue(new Uint8Array(1024 * 1024).fill(0xff)); }, cancel() { cancelled = true; } }) });
r = await paid("/transcribe", { audio_url: AUDIO_URL }); ok(r.status === 413 && ai.calls.length === 0 && calls.length === 1 && pulled <= 23 && cancelled, `streamed body > 20 MB -> 413, stream cancelled after ${pulled} MB, not settled`);
// timeout: hung upstream -> aborted -> 502 (shorten the wait by firing the abort ourselves)
reset(); audioHosts[AUDIO_URL] = { hang: true };
{ const realSetTimeout = globalThis.setTimeout; globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, ms === 20000 ? 20 : ms, ...a);
  r = await paid("/transcribe", { audio_url: AUDIO_URL }); j = await r.json(); globalThis.setTimeout = realSetTimeout;
  ok(r.status === 502 && /20 seconds/.test(j.error) && /no payment was taken/.test(j.error) && ai.calls.length === 0 && calls.length === 1, "hung download aborted by the 20 s timer -> 502, no AI, not settled"); }
// upstream errors
reset(); serveAudio(AUDIO_URL, { status: 404 }); r = await paid("/transcribe", { audio_url: AUDIO_URL }); ok(r.status === 404 && ai.calls.length === 0 && calls.length === 1, "audio 404 -> 404 not settled");
reset(); serveAudio(AUDIO_URL, { status: 500 }); r = await paid("/transcribe", { audio_url: AUDIO_URL }); ok(r.status === 502 && ai.calls.length === 0 && calls.length === 1, "audio 500 -> 502 not settled");
reset(); serveAudio(AUDIO_URL, { body: new Uint8Array(0) }); r = await paid("/transcribe", { audio_url: AUDIO_URL }); ok(r.status === 502 && ai.calls.length === 0, "empty audio body -> 502");
reset(); delete audioHosts[AUDIO_URL]; r = await paid("/transcribe", { audio_url: "https://down.example.com/x.mp3" }); j = await r.json(); ok(r.status === 502 && /no payment was taken/.test(j.error) && ai.calls.length === 0 && calls.length === 1, "network failure -> 502 not settled"); otherFetch = [];
// redirects
reset(); audioHosts[AUDIO_URL] = { status: 302, headers: { location: "/final.mp3" }, body: "" }; serveAudio("https://cdn.example.com/final.mp3");
r = await paid("/transcribe", { audio_url: AUDIO_URL }); ok(r.status === 200 && audioFetches.length === 2 && audioFetches[1].u === "https://cdn.example.com/final.mp3", "relative redirect followed");
reset(); audioHosts[AUDIO_URL] = { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" }, body: "" };
r = await paid("/transcribe", { audio_url: AUDIO_URL }); j = await r.json(); ok(r.status === 502 && audioFetches.length === 1 && /cannot be fetched/.test(j.error) && ai.calls.length === 0 && calls.length === 1, "redirect to metadata ip blocked -> 502 not settled");
reset(); for (let i = 0; i < 5; i++) audioHosts[`https://cdn.example.com/r${i}.mp3`] = { status: 301, headers: { location: `https://cdn.example.com/r${i + 1}.mp3` }, body: "" };
r = await paid("/transcribe", { audio_url: "https://cdn.example.com/r0.mp3" }); ok(r.status === 502 && audioFetches.length === 4, "more than 3 redirects -> 502");
// model failures
reset(); serveAudio(); ai.fail.add(WHISPER); r = await paid("/transcribe", { audio_url: AUDIO_URL }); j = await r.json();
ok(r.status === 502 && j.error === "AI model temporarily unavailable, no payment taken" && calls.length === 1 && !r.headers.get("PAYMENT-RESPONSE"), "whisper throws -> 502, no settle");
reset(); serveAudio(); ai.reply[WHISPER] = { segments: [] }; r = await paid("/transcribe", { audio_url: AUDIO_URL }); ok(r.status === 502 && calls.length === 1, "whisper returns no text -> 502, no settle");
reset(); serveAudio(); ai.reply[WHISPER] = { text: "Hi there.", transcription_info: {} }; r = await paid("/transcribe", { audio_url: AUDIO_URL, language: "en" }); j = await r.json();
ok(r.status === 200 && j.text === "Hi there." && j.language === "en" && j.language_probability === null && j.duration_seconds === null && j.word_count === 2 && j.segments.length === 0, "sparse whisper result normalized (nulls, computed word_count, hint as language)");
reset(); serveAudio(); mode = "badverify"; r = await paid("/transcribe", { audio_url: AUDIO_URL });
ok(r.status === 402 && dec(r.headers.get("PAYMENT-REQUIRED")).error === "insufficient_funds" && dec(r.headers.get("PAYMENT-REQUIRED")).accepts[0].amount === "20000" && calls.length === 1 && ai.calls.length === 0 && audioFetches.length === 0, "transcribe verify fail -> 402, no download, no AI");
reset(); serveAudio(); mode = "badsettle"; r = await paid("/transcribe", { audio_url: AUDIO_URL }); let t = await r.text();
ok(r.status === 402 && t.trim() === "{}" && !t.includes("Welcome") && dec(r.headers.get("PAYMENT-RESPONSE")).success === false, "transcribe settle fail -> 402 empty body, transcript not leaked");
reset(); globalThis.fetch = async () => { throw new Error("boom"); }; r = await paid("/transcribe", { audio_base64: b64(MP3) }); ok(r.status === 500 && ai.calls.length === 0, "facilitator unreachable -> 500, no AI"); globalThis.fetch = origFetch;

// ---- transcribe: base64 path ----
reset(); r = await paid("/transcribe", { audio_base64: b64(MP3), content_type: "audio/mpeg" }); j = await r.json();
ok(r.status === 200 && audioFetches.length === 0 && ai.calls[0].input.audio === b64(MP3) && j.source === "base64" && j.audio_bytes === 1000 && j.text.startsWith("Welcome"), "base64 input: no fetch, bytes passed to whisper, settled");
reset(); r = await paid("/transcribe", { audio_base64: "data:audio/wav;base64," + b64(MP3) }); ok(r.status === 200 && ai.calls[0].input.audio === b64(MP3), "data: URI accepted");
reset(); r = await paid("/transcribe", { audio_base64: b64(MP3).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") }); ok(r.status === 200 && ai.calls[0].input.audio === b64(MP3), "base64url without padding normalized");
// chunked base64 encoding of a 1 MB buffer (would overflow the call stack with String.fromCharCode(...bytes))
reset(); const big = Buffer.alloc(1024 * 1024); for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 255;
r = await paid("/transcribe", { audio_base64: b64(big) }); j = await r.json();
ok(r.status === 200 && ai.calls[0].input.audio.length === b64(big).length && ai.calls[0].input.audio === b64(big) && j.audio_bytes === 1048576, "1 MB buffer base64-encoded in chunks, byte-exact round trip");
reset(); serveAudio(AUDIO_URL, { body: big }); r = await paid("/transcribe", { audio_url: AUDIO_URL }); ok(r.status === 200 && ai.calls[0].input.audio === b64(big), "1 MB streamed download re-assembled and encoded byte-exact");

// ---- speak ----
reset(); r = await paid("/speak", { text: TEXT });
ok(r.status === 200 && r.headers.get("Content-Type") === "audio/mpeg" && r.headers.get("X-Audio-Bytes") === "1000" && r.headers.get("X-Text-Chars") === String(TEXT.length) && r.headers.get("Content-Length") === "1000", "speak mp3: audio/mpeg, X-Audio-Bytes, X-Text-Chars");
ok(dec(r.headers.get("PAYMENT-RESPONSE")).transaction === "0xdeadbeef" && r.headers.get("Access-Control-Expose-Headers").includes("PAYMENT-RESPONSE") && r.headers.get("Access-Control-Expose-Headers").includes("X-Audio-Bytes") && r.headers.get("Access-Control-Allow-Origin") === "*", "speak mp3: PAYMENT-RESPONSE header + CORS expose");
let buf = Buffer.from(await r.arrayBuffer()); ok(buf.length === 1000 && buf[0] === 0xff && buf[1] === 0xfb && buf.equals(MP3), "speak mp3: body is the exact MP3 bytes (ReadableStream result)");
ok(ai.calls.length === 1 && ai.calls[0].model === AURA && ai.calls[0].input.text === TEXT && ai.calls[0].input.speaker === "asteria" && Object.keys(ai.calls[0].input).join() === "text,speaker", "aura called with text + default speaker");
ok(calls.length === 2 && JSON.parse(calls[1].init.body).paymentRequirements.amount === "10000", "speak settled at 10000");
reset(); order = []; AI.run = async (m, i) => { order.push("ai"); return origRun(m, i); }; globalThis.fetch = async (u, init) => { order.push(String(u).split("/").pop()); return origFetch(u, init); };
r = await paid("/speak", { text: TEXT }); ok(r.status === 200 && order.join() === "verify,ai,settle", "speak order: verify -> generate -> settle -> audio"); AI.run = origRun; globalThis.fetch = origFetch;
// bare (new) voice name passes through unchanged
reset(); r = await paid("/speak", { text: TEXT, speaker: " Zeus " }); ok(r.status === 200 && ai.calls[0].input.speaker === "zeus" && Object.keys(ai.calls[0].input).join() === "text,speaker", "speak: bare voice name accepted and sent as-is (lowercased)");
// base64 object result
reset(); ai.reply[AURA] = { audio: b64(MP3) }; r = await paid("/speak", { text: TEXT, speaker: "Aura-Luna-EN" }); buf = Buffer.from(await r.arrayBuffer());
ok(r.status === 200 && r.headers.get("Content-Type") === "audio/mpeg" && buf.equals(MP3) && ai.calls[0].input.speaker === "luna", "speak: {audio: base64} result handled, speaker normalized");
reset(); ai.reply[AURA] = MP3.buffer.slice(MP3.byteOffset, MP3.byteOffset + MP3.byteLength); r = await paid("/speak", { text: TEXT }); buf = Buffer.from(await r.arrayBuffer()); ok(r.status === 200 && buf.equals(MP3), "speak: ArrayBuffer result handled");
reset(); ai.reply[AURA] = new Uint8Array(MP3); r = await paid("/speak", { text: TEXT }); buf = Buffer.from(await r.arrayBuffer()); ok(r.status === 200 && buf.equals(MP3), "speak: Uint8Array result handled");
reset(); ai.reply[AURA] = new Response(MP3); r = await paid("/speak", { text: TEXT }); buf = Buffer.from(await r.arrayBuffer()); ok(r.status === 200 && buf.equals(MP3), "speak: Response result handled");
// json format
reset(); r = await paid("/speak", { text: TEXT, format: "JSON" }); j = await r.json();
ok(r.status === 200 && r.headers.get("Content-Type") === "application/json" && j.audio_base64 === b64(MP3) && j.content_type === "audio/mpeg" && j.bytes === 1000 && j.text_chars === TEXT.length && j.speaker === "asteria" && j.model === AURA && /^\d{4}-/.test(j.generated_at) && dec(r.headers.get("PAYMENT-RESPONSE")).success === true && r.headers.get("X-Audio-Bytes") === "1000", "speak json: base64 audio + fields + receipt");
ok(Object.keys(j).join() === "audio_base64,content_type,bytes,text_chars,speaker,model,generated_at", "speak json keys exact");
// failures
reset(); ai.fail.add(AURA); r = await paid("/speak", { text: TEXT }); j = await r.json(); ok(r.status === 502 && j.error === "AI model temporarily unavailable, no payment taken" && calls.length === 1 && !r.headers.get("PAYMENT-RESPONSE"), "aura throws -> 502 not settled");
reset(); ai.reply[AURA] = { audio: "" }; r = await paid("/speak", { text: TEXT }); ok(r.status === 502 && calls.length === 1, "aura empty audio -> 502 not settled");
reset(); ai.reply[AURA] = { weird: true }; r = await paid("/speak", { text: TEXT }); ok(r.status === 502 && calls.length === 1, "aura unknown shape -> 502 not settled");
reset(); ai.reply[AURA] = new Blob([new Uint8Array(0)]).stream(); r = await paid("/speak", { text: TEXT }); ok(r.status === 502 && calls.length === 1, "aura empty stream -> 502 not settled");
reset(); mode = "badverify"; r = await paid("/speak", { text: TEXT }); ok(r.status === 402 && ai.calls.length === 0 && dec(r.headers.get("PAYMENT-REQUIRED")).accepts[0].amount === "10000", "speak verify fail -> 402 no AI");
reset(); mode = "badsettle"; r = await paid("/speak", { text: TEXT }); t = await r.text(); ok(r.status === 402 && t.trim() === "{}" && r.headers.get("Content-Type") === "application/json" && dec(r.headers.get("PAYMENT-RESPONSE")).success === false, "speak settle fail -> 402 empty JSON body, no audio sent");
reset(); mode = "badsettle"; r = await paid("/speak", { text: TEXT, format: "json" }); t = await r.text(); ok(r.status === 402 && t.trim() === "{}", "speak json settle fail -> 402 empty body");

// ---- translate ----
reset(); r = await paid("/translate", { text: TEXT, target_lang: "es" }); j = await r.json();
ok(r.status === 200 && j.translated_text === "La reunión se ha trasladado al jueves." && j.source_lang === "en" && j.target_lang === "es" && j.input_chars === TEXT.length && j.model === M2M && /^\d{4}-/.test(j.generated_at) && dec(r.headers.get("PAYMENT-RESPONSE")).success === true, "translate success fields");
ok(Object.keys(j).join() === "translated_text,source_lang,target_lang,input_chars,model,generated_at", "translate keys exact");
ok(ai.calls.length === 1 && ai.calls[0].model === M2M && ai.calls[0].input.text === TEXT && ai.calls[0].input.source_lang === "en" && ai.calls[0].input.target_lang === "es" && Object.keys(ai.calls[0].input).join() === "text,source_lang,target_lang", "m2m100 called with text, source_lang, target_lang");
ok(calls.length === 2 && JSON.parse(calls[1].init.body).paymentRequirements.amount === "2000", "translate settled at 2000");
reset(); ai.reply[M2M] = { translated_text: "  Bonjour  " }; r = await paid("/translate", { text: "Hello", target_lang: "FR", source_lang: " En " }); j = await r.json(); ok(r.status === 200 && j.translated_text === "Bonjour" && j.target_lang === "fr" && j.source_lang === "en" && ai.calls[0].input.target_lang === "fr", "codes normalized, output trimmed");
reset(); ai.reply[M2M] = { translated_text: "Hola" }; r = await paid("/translate", { text: "Hello", target_lang: "en", source_lang: "zh" }); ok(r.status === 200 && ai.calls[0].input.source_lang === "zh" && ai.calls[0].input.target_lang === "en", "non-English source into English");
for (const code of ["ast", "ceb", "ilo", "ff", "ns", "zu", "ja", "ko", "ar", "hi"]) { reset(); r = await paid("/translate", { text: "Hello", target_lang: code }); ok(r.status === 200, `M2M100 code ${code} accepted`); }
for (const code of ["te", "as", "eo", "la", "tlh"]) { reset(); r = await paid("/translate", { text: "Hello", target_lang: code }); ok(r.status === 400 && ai.calls.length === 0 && calls.length === 0, `non-M2M100 code ${code} rejected`); }
reset(); ai.fail.add(M2M); r = await paid("/translate", { text: TEXT, target_lang: "es" }); j = await r.json(); ok(r.status === 502 && j.error === "AI model temporarily unavailable, no payment taken" && calls.length === 1 && !r.headers.get("PAYMENT-RESPONSE"), "m2m100 throws -> 502 not settled");
reset(); ai.reply[M2M] = { translated_text: "   " }; r = await paid("/translate", { text: TEXT, target_lang: "es" }); ok(r.status === 502 && calls.length === 1, "m2m100 empty translation -> 502 not settled");
reset(); ai.reply[M2M] = { usage: {} }; r = await paid("/translate", { text: TEXT, target_lang: "es" }); ok(r.status === 502 && calls.length === 1, "m2m100 missing translated_text -> 502 not settled");
reset(); mode = "badverify"; r = await paid("/translate", { text: TEXT, target_lang: "es" }); ok(r.status === 402 && ai.calls.length === 0 && dec(r.headers.get("PAYMENT-REQUIRED")).resource.url === base + "/translate", "translate verify fail -> 402 no AI");
reset(); mode = "badsettle"; r = await paid("/translate", { text: TEXT, target_lang: "es" }); t = await r.text(); ok(r.status === 402 && t.trim() === "{}" && !t.includes("jueves"), "translate settle fail -> 402 empty body");

// ---- openapi ----
reset(); r = await W.fetch(new Request(base + "/openapi.json"), env); const o = await r.json();
ok(r.status === 200 && o.openapi === "3.1.0" && o.info.title === "NoJunk Speech" && typeof o.info["x-guidance"] === "string" && o.info["x-guidance"].includes("$0.02") && o.info["x-guidance"].includes("$0.01") && o.info["x-guidance"].includes("$0.002") && o.servers[0].url === base, "openapi header + x-guidance");
ok(Object.keys(o.paths).join() === "/transcribe,/speak,/translate" && Object.keys(o.paths["/speak"]).join() === "post", "openapi paths: 3 POST routes");
for (const [route, amt] of [["/transcribe", "0.020000"], ["/speak", "0.010000"], ["/translate", "0.002000"]]) {
  const p = o.paths[route].post;
  ok(p["x-payment-info"].price.amount === amt && p["x-payment-info"].price.mode === "fixed" && p["x-payment-info"].price.currency === "USD" && p["x-payment-info"].protocols[0].x402 && p.responses["402"] && p.responses["200"] && p.responses["502"] && p.responses["413"] && p.requestBody.required === true && p.operationId, `openapi ${route} x-payment-info ${amt} + 402`);
}
ok(o.paths["/speak"].post.responses["200"].content["audio/mpeg"].schema.format === "binary" && o.paths["/speak"].post.responses["200"].headers["X-Audio-Bytes"] && o.paths["/speak"].post.responses["200"].headers["PAYMENT-RESPONSE"] && o.paths["/speak"].post.responses["200"].content["application/json"], "openapi /speak documents binary mp3 response + headers");
ok(o.paths["/translate"].post.requestBody.content["application/json"].schema.properties.target_lang.enum.length === 100 && o.paths["/translate"].post.requestBody.content["application/json"].schema.required.join() === "text,target_lang" && o.paths["/transcribe"].post.requestBody.content["application/json"].schema.oneOf.length === 2 && o.paths["/transcribe"].post.responses["415"] && o.paths["/speak"].post.requestBody.content["application/json"].schema.properties.speaker.enum.includes("aura-asteria-en"), "openapi schemas per route");
r = await W.fetch(new Request(base + "/.well-known/openapi.json"), env); ok(r.status === 200, "well-known openapi alias");

// ---- CDP facilitator path (Ed25519 + EC keys) ----
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const jwk = privateKey.export({ format: "jwk" });
const secret = Buffer.concat([Buffer.from(jwk.d, "base64url"), Buffer.from(jwk.x, "base64url")]).toString("base64");
const envC = { PAY_TO: PAY, AI, CDP_API_KEY_ID: "test-key-id", CDP_API_KEY_SECRET: secret };
reset(); r = await paid("/translate", { text: TEXT, target_lang: "es" }, { env: envC });
ok(r.status === 200 && calls[0].u === "https://api.cdp.coinbase.com/platform/v2/x402/verify" && calls[1].u.endsWith("/settle"), "cdp facilitator used");
const checkJwt = (tok, pub, uri, alg) => { const [h, pl, s] = tok.split("."); const H = JSON.parse(Buffer.from(h, "base64url")), P = JSON.parse(Buffer.from(pl, "base64url"));
  const sigOk = alg === "EdDSA" ? nverify(null, Buffer.from(h + "." + pl), pub, Buffer.from(s, "base64url")) : nverify("sha256", Buffer.from(h + "." + pl), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
  return sigOk && H.alg === alg && H.kid === "test-key-id" && H.nonce.length === 32 && P.iss === "cdp" && P.sub === "test-key-id" && P.uris[0] === uri && P.exp - P.nbf === 120; };
ok(checkJwt(calls[0].init.headers.Authorization.slice(7), publicKey, "POST api.cdp.coinbase.com/platform/v2/x402/verify", "EdDSA"), "Ed25519 JWT valid (verify)");
ok(checkJwt(calls[1].init.headers.Authorization.slice(7), publicKey, "POST api.cdp.coinbase.com/platform/v2/x402/settle", "EdDSA"), "Ed25519 JWT valid (settle)");
const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pem = ec.privateKey.export({ type: "sec1", format: "pem" });
reset(); r = await paid("/speak", { text: TEXT }, { env: { ...envC, CDP_API_KEY_SECRET: pem.replace(/\n/g, "\\n") } });
ok(r.status === 200 && r.headers.get("Content-Type") === "audio/mpeg" && checkJwt(calls[0].init.headers.Authorization.slice(7), ec.publicKey, "POST api.cdp.coinbase.com/platform/v2/x402/verify", "ES256"), "EC SEC1 JWT valid (speak mp3 via cdp)");
r = await W.fetch(new Request(base + "/"), envC); ok((await r.json()).facilitator === "cdp", "info page reports cdp");

ok(otherFetch.length === 0, "no network calls outside the mocks");
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exitCode = fails ? 1 : 0;
