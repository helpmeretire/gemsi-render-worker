// Usage: node test/test.mjs ./worker.js /path/bazaar-out.json
import { generateKeyPairSync, verify as nverify } from "node:crypto";
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const W = (await import(pathToFileURL(resolve(process.argv[2])).href)).default;
const PAY = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const FLUX = "@cf/black-forest-labs/flux-1-schnell", LLAVA = "@cf/llava-hf/llava-1.5-7b-hf", UFORM = "@cf/unum/uform-gen2-qwen-500m";
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const dec = (h) => JSON.parse(Buffer.from(h, "base64").toString());

// ---- a small real PNG (2x2 RGBA) built from scratch ----
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, "ascii"), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const raw = Buffer.from([0, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 0, 128]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
const PNG_B64 = PNG.toString("base64");
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 7)]);

// ---- fetch mock: facilitator + registered image URLs, never hits the network ----
let calls = [], mode = "good", otherFetch = [], imgFetches = [];
const images = {}; // url -> () => Response
globalThis.fetch = async (u, init) => {
  u = String(u);
  if (images[u]) { imgFetches.push({ u, init }); return images[u](init); }
  if (!u.startsWith("https://facilitator.payai.network/") && !u.startsWith("https://api.cdp.coinbase.com/")) { otherFetch.push(u); throw new Error("unexpected network call " + u); }
  calls.push({ u, init });
  const op = u.split("/").pop();
  if (mode === "badverify" && op === "verify") return new Response(JSON.stringify({ isValid: false, invalidReason: "insufficient_funds", payer: "0xabc" }), { status: 200 });
  if (mode === "badsettle" && op === "settle") return new Response(JSON.stringify({ success: false, errorReason: "invalid_transaction_state", payer: "0xabc", transaction: "", network: "eip155:8453" }), { status: 400 });
  if (op === "verify") return new Response(JSON.stringify({ isValid: true, payer: "0xabc" }));
  return new Response(JSON.stringify({ success: true, payer: "0xabc", transaction: "0xdeadbeef", network: "eip155:8453" }));
};

// ---- Workers AI mock ----
// ai.image: base64 returned by flux; ai.describe: queue of strings for describe models; ai.fail: Set of models that throw
const ai = { calls: [], image: PNG_B64, describe: [], fail: new Set(), rawFlux: null };
const AI = {
  run: async (model, input) => {
    ai.calls.push({ model, input });
    if (ai.fail.has(model)) throw new Error("model error " + model);
    if (model === FLUX) return ai.rawFlux ? ai.rawFlux(input) : { image: ai.image, usage: {} };
    let rep = ai.describe.length ? ai.describe.shift() : "A picture.";
    if (typeof rep === "function") rep = rep(input, model);
    return { description: rep };
  },
};
const reset = () => { calls = []; imgFetches = []; ai.calls = []; ai.describe = []; ai.fail = new Set(); ai.image = PNG_B64; ai.rawFlux = null; mode = "good"; };
const env = { PAY_TO: PAY, AI };
const base = "https://image.example.workers.dev";
const PROMPT = "A cozy cabin in a snowy pine forest at dusk, warm light in the windows";
const post = (path, body, extra = {}) => W.fetch(new Request(base + path, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), ...extra, headers: { "Content-Type": "application/json", ...(extra.headers || {}) } }), extra.env || env);

// ---- info / discovery ----
let r = await W.fetch(new Request(base + "/"), env); let j = await r.json();
ok(r.status === 200 && j.service === "NoJunk Image" && j.facilitator === "payai" && j.configured === true && Object.keys(j.endpoints).join() === "/generate,/describe" && j.endpoints["/generate"].price.startsWith("$0.01 ") && j.endpoints["/describe"].price.startsWith("$0.005 ") && j.models.generate === FLUX && j.models.describe === LLAVA, "info page lists 2 routes with prices + models");
r = await W.fetch(new Request(base + "/generate", { method: "POST" }), { AI }); ok(r.status === 402 && dec(r.headers.get("PAYMENT-REQUIRED")).accepts[0].payTo === "0x6f762720b8515b7091e6aa69e8361f7b9909233f", "default wallet used");
r = await W.fetch(new Request(base + "/generate", { method: "POST", body: "not json" }), env); ok(r.status === 402, "bad input unpaid -> 402 first");
r = await W.fetch(new Request(base + "/generate"), env); ok(r.status === 402 && r.headers.get("PAYMENT-REQUIRED"), "GET probe /generate without payment -> 402");
r = await W.fetch(new Request(base + "/describe"), env); ok(r.status === 402 && r.headers.get("PAYMENT-REQUIRED"), "GET probe /describe without payment -> 402");
r = await W.fetch(new Request(base + "/nope", { method: "POST" }), env); ok(r.status === 404, "unknown path -> 404");
r = await W.fetch(new Request(base + "/generate", { method: "PUT" }), env); ok(r.status === 405, "PUT -> 405");
r = await W.fetch(new Request(base + "/generate", { method: "OPTIONS" }), env); ok(r.status === 200 && r.headers.get("Access-Control-Allow-Headers").includes("PAYMENT-SIGNATURE") && r.headers.get("Access-Control-Allow-Methods").includes("POST") && r.headers.get("Access-Control-Expose-Headers").includes("X-Image-Bytes"), "OPTIONS CORS");
r = await W.fetch(new Request(base + "/generate", { method: "POST", headers: { "content-length": String(8 * 1024 + 1) } }), env); ok(r.status === 413 && !r.headers.get("PAYMENT-REQUIRED"), "generate: content-length 8193 -> 413 before 402");
r = await W.fetch(new Request(base + "/generate", { method: "POST", headers: { "content-length": String(8 * 1024) } }), env); ok(r.status === 402, "generate: content-length 8192 -> allowed (402 probe)");
r = await W.fetch(new Request(base + "/describe", { method: "POST", headers: { "content-length": String(14 * 1024 * 1024 + 1) } }), env); ok(r.status === 413, "describe: content-length 14 MB + 1 -> 413 before 402");
r = await W.fetch(new Request(base + "/describe", { method: "POST", headers: { "content-length": String(9000) } }), env); ok(r.status === 402, "describe: 9 KB body allowed (bigger cap than generate)");
r = await W.fetch(new Request(base + "/generate", { method: "POST" }), { PAY_TO: PAY }); j = await r.json(); ok(r.status === 500 && /AI/.test(j.error), "env.AI missing -> 500 misconfigured");
r = await W.fetch(new Request(base + "/generate", { method: "POST" }), { PAY_TO: "nope", AI }); ok(r.status === 500, "bad PAY_TO -> 500");

// ---- 402 probes: per-route amount + resource url ----
const PRICES = { "/generate": "10000", "/describe": "5000" };
const MIMES = { "/generate": "image/png", "/describe": "application/json" };
const prs = {}, payloads = {}, hdrs = {};
for (const route of Object.keys(PRICES)) {
  r = await W.fetch(new Request(base + route, { method: "POST" }), env);
  const pr = dec(r.headers.get("PAYMENT-REQUIRED")); prs[route] = pr;
  const a0 = pr.accepts[0];
  ok(r.status === 402 && pr.x402Version === 2 && pr.accepts.length === 1 && a0.scheme === "exact" && a0.amount === PRICES[route] && a0.payTo === PAY && a0.network === "eip155:8453" && a0.asset === "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" && a0.extra.name === "USD Coin" && a0.extra.version === "2" && a0.maxTimeoutSeconds === 300, `${route} 402 requirements (amount ${PRICES[route]})`);
  ok(pr.resource.url === base + route && pr.resource.mimeType === MIMES[route] && pr.resource.description.includes(route.slice(1)) && pr.error === "PAYMENT-SIGNATURE header is required", `${route} resource url + mime ${MIMES[route]}`);
  const bz = pr.extensions.bazaar;
  ok(bz.info.input.type === "http" && bz.info.input.method === "POST" && bz.info.input.bodyType === "json" && bz.info.output.type === "json" && bz.schema.properties.input.required.includes("body") && bz.schema.$schema.includes("2020-12"), `${route} bazaar ext with POST json body`);
  ok(JSON.parse(await r.text()).x402Version === 2, `${route} 402 body is the same JSON`);
  payloads[route] = { x402Version: 2, resource: pr.resource, accepted: pr.accepts[0], payload: { signature: "0x00", authorization: {} }, extensions: pr.extensions };
  hdrs[route] = Buffer.from(JSON.stringify(payloads[route])).toString("base64");
}
ok(typeof prs["/generate"].extensions.bazaar.info.input.body.prompt === "string" && prs["/generate"].extensions.bazaar.info.input.body.format === "json" && prs["/generate"].extensions.bazaar.info.output.example.image_base64.startsWith("iVBOR") && prs["/generate"].extensions.bazaar.schema.properties.input.properties.body.required.includes("prompt"), "generate bazaar example: prompt in, base64 PNG json out");
ok(prs["/describe"].extensions.bazaar.info.input.body.image_url.startsWith("https://") && typeof prs["/describe"].extensions.bazaar.info.output.example.description === "string" && prs["/describe"].extensions.bazaar.info.output.example.model === LLAVA && Array.isArray(prs["/describe"].extensions.bazaar.schema.properties.input.properties.body.anyOf), "describe bazaar example: image_url in, description out, url-or-base64 schema");
writeFileSync(process.argv[3], JSON.stringify(prs["/generate"].extensions.bazaar));
const paid = (route, body, extra = {}) => post(route, body, { ...extra, headers: { "PAYMENT-SIGNATURE": hdrs[route], ...(extra.headers || {}) } });

// ---- paying with another route's requirements -> 402 ----
for (const [route, other, body] of [["/generate", "/describe", { prompt: PROMPT }], ["/describe", "/generate", { image_base64: PNG_B64 }]]) {
  reset();
  r = await post(route, body, { headers: { "PAYMENT-SIGNATURE": hdrs[other] } });
  ok(r.status === 402 && dec(r.headers.get("PAYMENT-REQUIRED")).error === "No matching payment requirements found" && dec(r.headers.get("PAYMENT-REQUIRED")).accepts[0].amount === PRICES[route] && calls.length === 0 && ai.calls.length === 0, `${route} paid with ${other} requirements -> 402 with own amount, nothing called`);
}
reset(); const under = { ...payloads["/generate"], accepted: { ...payloads["/generate"].accepted, amount: "9999" } };
r = await post("/generate", { prompt: PROMPT }, { headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(under)).toString("base64") } }); ok(r.status === 402 && calls.length === 0 && ai.calls.length === 0, "underpaid accepted -> 402");
r = await post("/generate", { prompt: PROMPT }, { headers: { "PAYMENT-SIGNATURE": "!!!notbase64" } }); ok(r.status === 400 && calls.length === 0 && ai.calls.length === 0, "garbage payment header -> 400");

// ---- bad input with payment -> 400 (no AI, no facilitator) ----
const badCases = [
  ["/generate", {}, "missing prompt"],
  ["/generate", { prompt: "" }, "empty prompt"],
  ["/generate", { prompt: "hi" }, "prompt 2 chars"],
  ["/generate", { prompt: "   a   " }, "prompt whitespace-padded 1 char"],
  ["/generate", { prompt: 42 }, "non-string prompt"],
  ["/generate", { prompt: "x".repeat(1501) }, "prompt 1501 chars"],
  ["/generate", { prompt: PROMPT, steps: 0 }, "steps 0"],
  ["/generate", { prompt: PROMPT, steps: 9 }, "steps 9"],
  ["/generate", { prompt: PROMPT, steps: 2.5 }, "steps fraction"],
  ["/generate", { prompt: PROMPT, steps: "four" }, "steps string"],
  ["/generate", { prompt: PROMPT, seed: 1.5 }, "seed fraction"],
  ["/generate", { prompt: PROMPT, seed: -1 }, "seed negative"],
  ["/generate", { prompt: PROMPT, seed: "abc" }, "seed string"],
  ["/generate", { prompt: PROMPT, seed: true }, "seed boolean"],
  ["/generate", { prompt: PROMPT, format: "jpg" }, "bad format"],
  ["/generate", { prompt: PROMPT, format: 1 }, "non-string format"],
  ["/describe", {}, "missing image"],
  ["/describe", { image_url: "https://a.example.com/x.png", image_base64: PNG_B64 }, "both url and base64"],
  ["/describe", { image_url: 5 }, "non-string url"],
  ["/describe", { image_url: "" }, "empty url"],
  ["/describe", { image_url: "not a url" }, "invalid url"],
  ["/describe", { image_url: "ftp://example.com/x.png" }, "ftp url"],
  ["/describe", { image_url: "file:///etc/passwd" }, "file url"],
  ["/describe", { image_url: "https://user:pw@example.com/x.png" }, "credentials in url"],
  ["/describe", { image_url: "https://example.com/" + "x".repeat(2100) }, "url too long"],
  ["/describe", { image_url: "http://localhost/x.png" }, "localhost"],
  ["/describe", { image_url: "http://foo.localhost/x.png" }, "*.localhost"],
  ["/describe", { image_url: "http://printer.local/x.png" }, "*.local"],
  ["/describe", { image_url: "http://metadata.google.internal/computeMetadata/v1/" }, "gcp metadata host"],
  ["/describe", { image_url: "http://intranet/x.png" }, "dotless host"],
  ["/describe", { image_url: "http://127.0.0.1/x.png" }, "127.0.0.1"],
  ["/describe", { image_url: "http://127.1.2.3:8080/x.png" }, "127/8 with port"],
  ["/describe", { image_url: "http://10.0.0.5/x.png" }, "10/8"],
  ["/describe", { image_url: "http://172.16.0.1/x.png" }, "172.16/12"],
  ["/describe", { image_url: "http://172.31.255.254/x.png" }, "172.31"],
  ["/describe", { image_url: "http://192.168.1.1/x.png" }, "192.168/16"],
  ["/describe", { image_url: "http://169.254.169.254/latest/meta-data/" }, "aws metadata ip"],
  ["/describe", { image_url: "http://100.64.0.1/x.png" }, "cgnat 100.64/10"],
  ["/describe", { image_url: "http://0.0.0.0/x.png" }, "0.0.0.0"],
  ["/describe", { image_url: "http://2130706433/x.png" }, "decimal 127.0.0.1"],
  ["/describe", { image_url: "http://0x7f000001/x.png" }, "hex 127.0.0.1"],
  ["/describe", { image_url: "http://[::1]/x.png" }, "ipv6 loopback"],
  ["/describe", { image_url: "http://[fd12::1]/x.png" }, "ipv6 ULA"],
  ["/describe", { image_url: "http://[fe80::1]/x.png" }, "ipv6 link-local"],
  ["/describe", { image_url: "http://[::ffff:10.0.0.1]/x.png" }, "ipv6-mapped private v4"],
  ["/describe", { image_url: "http://[::ffff:a00:1]/x.png" }, "ipv6-mapped private v4 hex"],
  ["/describe", { image_url: "https://a.example.com/x.png", question: 7 }, "non-string question"],
  ["/describe", { image_url: "https://a.example.com/x.png", question: "q".repeat(501) }, "question too long"],
  ["/describe", { image_base64: 9 }, "non-string base64"],
  ["/describe", { image_base64: "" }, "empty base64"],
  ["/describe", { image_base64: "not*base64!" }, "invalid base64 chars"],
  ["/describe", { image_base64: "abcde" }, "invalid base64 length"],
];
for (const [route, body, label] of badCases) {
  reset(); r = await paid(route, body); j = await r.json();
  ok(r.status === 400 && calls.length === 0 && ai.calls.length === 0 && imgFetches.length === 0 && /no payment was taken/.test(j.error), `paid ${route} + ${label} -> 400, no AI, no facilitator`);
}
reset(); r = await paid("/describe", { image_base64: Buffer.from("just some text, not an image at all").toString("base64") }); j = await r.json();
ok(r.status === 415 && calls.length === 0 && ai.calls.length === 0 && /no payment was taken/.test(j.error), "paid /describe + base64 of non-image -> 415, nothing called");
reset(); r = await post("/generate", "{not json", { headers: { "PAYMENT-SIGNATURE": hdrs["/generate"] } }); ok(r.status === 400 && calls.length === 0 && ai.calls.length === 0, "paid + malformed JSON body -> 400");
reset(); r = await post("/generate", JSON.stringify([1]), { headers: { "PAYMENT-SIGNATURE": hdrs["/generate"] } }); ok(r.status === 400 && calls.length === 0, "paid + array body -> 400");
reset(); r = await W.fetch(new Request(base + "/generate", { headers: { "PAYMENT-SIGNATURE": hdrs["/generate"] } }), env); ok(r.status === 405 && calls.length === 0, "paid GET -> 405, no facilitator call");

// ---- blocked prompts -> 400 "prompt not allowed", no charge ----
const blocked = [
  "a nude child on a beach",
  "sexy teen girl in lingerie",
  "naked little boys playing",
  "loli in a swimsuit",
  "explicit photo of an underage girl",
  "A Toddler, Topless, posing seductively",
  "schoolgirl hentai",
  "my daughter nude",
];
for (const p of blocked) {
  reset(); r = await paid("/generate", { prompt: p }); j = await r.json();
  ok(r.status === 400 && j.error === "prompt not allowed (no payment was taken)" && calls.length === 0 && ai.calls.length === 0, `blocked prompt "${p}" -> 400 prompt not allowed, no charge`);
}
for (const p of ["children playing soccer in a sunny park", "a cat sleeping on a sunny windowsill", "nude color palette for a living room, warm beige tones", "a boy flying a kite", "teenagers at a skate park"]) {
  reset(); r = await paid("/generate", { prompt: p });
  ok(r.status === 200 && ai.calls.length === 1, `benign prompt "${p}" -> allowed`);
}

// ---- 413 with payment: oversized bodies without content-length ----
reset(); r = await W.fetch(new Request(base + "/generate", { method: "POST", body: JSON.stringify({ prompt: "x".repeat(1400), padding: "p".repeat(8 * 1024) }), headers: { "PAYMENT-SIGNATURE": hdrs["/generate"] } }), env); j = await r.json();
ok(r.status === 413 && calls.length === 0 && ai.calls.length === 0 && /no payment was taken/.test(j.error), "paid /generate + 9 KB body (no content-length) -> 413 before payment");
reset(); r = await paid("/generate", { prompt: "x".repeat(1500) }); ok(r.status === 200 && ai.calls[0].input.prompt.length === 1500, "exactly 1500-char prompt accepted");
{
  const big = Buffer.alloc(10 * 1024 * 1024 + 1, 0); PNG.copy(big, 0);
  reset(); r = await paid("/describe", { image_base64: big.toString("base64") }); j = await r.json();
  ok(r.status === 413 && calls.length === 0 && ai.calls.length === 0 && /10485760/.test(j.error), "paid /describe + base64 of 10 MB + 1 image -> 413 before payment");
}

// ---- generate happy path: PNG bytes round-trip ----
reset(); r = await paid("/generate", { prompt: PROMPT });
ok(r.status === 200 && r.headers.get("Content-Type") === "image/png", "generate paid -> 200 image/png");
let bytes = Buffer.from(await r.arrayBuffer());
ok(bytes.length === PNG.length && bytes.equals(PNG), `png body is the exact decoded image (${PNG.length} bytes)`);
ok(r.headers.get("X-Image-Bytes") === String(PNG.length) && r.headers.get("Content-Length") === String(PNG.length) && !r.headers.get("X-Seed") && r.headers.get("X-Model") === FLUX && r.headers.get("Access-Control-Expose-Headers").includes("PAYMENT-RESPONSE") && r.headers.get("Access-Control-Allow-Origin") === "*", "png headers: X-Image-Bytes, no X-Seed when not given, CORS");
ok(dec(r.headers.get("PAYMENT-RESPONSE")).transaction === "0xdeadbeef" && dec(r.headers.get("PAYMENT-RESPONSE")).success === true, "PAYMENT-RESPONSE receipt on png response");
ok(calls.length === 2 && calls[0].u === "https://facilitator.payai.network/verify" && calls[1].u.endsWith("/settle"), "verify then settle via payai");
let sent = JSON.parse(calls[0].init.body); ok(sent.x402Version === 2 && sent.paymentRequirements.payTo === PAY && sent.paymentRequirements.amount === "10000" && sent.paymentPayload.accepted.amount === "10000", "facilitator body uses generate requirements (10000)");
ok(ai.calls.length === 1 && ai.calls[0].model === FLUX && ai.calls[0].input.prompt === PROMPT && ai.calls[0].input.steps === 4 && !("seed" in ai.calls[0].input) && Object.keys(ai.calls[0].input).join() === "prompt,steps", "flux called with prompt + default steps 4, no seed key");
// seed + steps + whitespace cleanup
reset(); r = await paid("/generate", { prompt: "  a   red\n\nball  ", steps: 8, seed: 12345 });
ok(r.status === 200 && !r.headers.get("X-Seed") && !("seed" in ai.calls[0].input) && Object.keys(ai.calls[0].input).join() === "prompt,steps" && ai.calls[0].input.steps === 8 && ai.calls[0].input.prompt === "a red ball", "legacy seed accepted but NOT sent to flux (schema is prompt+steps only), steps passed, prompt whitespace collapsed");
reset(); r = await paid("/generate", { prompt: PROMPT, steps: "1", seed: 0 }); ok(r.status === 200 && ai.calls[0].input.steps === 1 && !("seed" in ai.calls[0].input) && !r.headers.get("X-Seed"), "numeric string steps + seed 0 accepted, seed not forwarded");
// data: prefix / whitespace in model output still decodes
reset(); ai.image = "data:image/png;base64," + PNG_B64.slice(0, 20) + "\n" + PNG_B64.slice(20);
r = await paid("/generate", { prompt: PROMPT }); bytes = Buffer.from(await r.arrayBuffer()); ok(r.status === 200 && bytes.equals(PNG), "model base64 with data: prefix + newline still decodes to the same bytes");
// big image: chunked decode (> 64 KiB base64)
{
  const big = Buffer.concat([PNG, Buffer.alloc(300 * 1024, 0xab)]);
  reset(); ai.image = big.toString("base64"); r = await paid("/generate", { prompt: PROMPT }); bytes = Buffer.from(await r.arrayBuffer());
  ok(r.status === 200 && bytes.length === big.length && bytes.equals(big) && r.headers.get("X-Image-Bytes") === String(big.length), "300 KB image decoded in chunks byte-for-byte");
}
// order: verify -> model -> settle
reset(); let order = []; const origRun = AI.run;
AI.run = async (m, i) => { order.push("ai"); return origRun(m, i); };
const origFetch = globalThis.fetch; globalThis.fetch = async (u, init) => { const s = String(u); order.push(images[s] ? "img" : s.split("/").pop()); return origFetch(u, init); };
r = await paid("/generate", { prompt: PROMPT }); ok(r.status === 200 && order.join() === "verify,ai,settle", "generate order: verify -> model -> settle");
AI.run = origRun; globalThis.fetch = origFetch;

// ---- generate json format ----
reset(); r = await paid("/generate", { prompt: PROMPT, format: "JSON", seed: 7, steps: 2 }); j = await r.json();
ok(r.status === 200 && r.headers.get("Content-Type") === "application/json", "format json -> 200 application/json");
ok(j.image_base64 === PNG_B64 && Buffer.from(j.image_base64, "base64").equals(PNG) && j.content_type === "image/png" && j.bytes === PNG.length && j.prompt_chars === PROMPT.length && j.steps === 2 && j.seed === null && j.model === FLUX && /^\d{4}-\d{2}-\d{2}T/.test(j.generated_at), "json fields: image_base64 round-trips, bytes, prompt_chars, steps, seed, model, generated_at");
ok(Object.keys(j).join() === "image_base64,content_type,bytes,prompt_chars,steps,seed,model,generated_at", "json keys exact");
ok(dec(r.headers.get("PAYMENT-RESPONSE")).success === true && r.headers.get("X-Image-Bytes") === String(PNG.length) && !r.headers.get("X-Seed"), "json response carries PAYMENT-RESPONSE + X-Image-Bytes, no X-Seed");
reset(); r = await paid("/generate", { prompt: PROMPT, format: "json" }); j = await r.json(); ok(r.status === 200 && j.seed === null && !r.headers.get("X-Seed"), "json seed null when not given");
reset(); r = await paid("/generate", { prompt: PROMPT, format: "png" }); ok(r.status === 200 && r.headers.get("Content-Type") === "image/png", "explicit format png");

// ---- generate failure modes ----
reset(); ai.fail.add(FLUX); r = await paid("/generate", { prompt: PROMPT }); j = await r.json();
ok(r.status === 502 && j.error === "AI model temporarily unavailable, no payment taken" && ai.calls.length === 1 && calls.length === 1 && calls[0].u.endsWith("/verify") && !r.headers.get("PAYMENT-RESPONSE"), "flux throws -> 502, verified but not settled");
reset(); ai.rawFlux = () => ({ image: "" }); r = await paid("/generate", { prompt: PROMPT }); ok(r.status === 502 && calls.length === 1, "flux returns empty image -> 502 no settle");
reset(); ai.rawFlux = () => ({ image: "@@@not base64" }); r = await paid("/generate", { prompt: PROMPT }); ok(r.status === 502 && calls.length === 1, "flux returns undecodable base64 -> 502 no settle");
reset(); ai.rawFlux = () => ({ image: Buffer.from("hello world, definitely not an image").toString("base64") }); r = await paid("/generate", { prompt: PROMPT }); ok(r.status === 502 && calls.length === 1, "flux returns non-image bytes -> 502 no settle");
reset(); ai.rawFlux = () => ({ nope: 1 }); r = await paid("/generate", { prompt: PROMPT }); ok(r.status === 502 && calls.length === 1, "flux returns no image field -> 502 no settle");
reset(); ai.rawFlux = () => ({ image: JPEG.toString("base64") }); r = await paid("/generate", { prompt: PROMPT }); bytes = Buffer.from(await r.arrayBuffer()); ok(r.status === 200 && r.headers.get("Content-Type") === "image/jpeg" && bytes.equals(JPEG), "flux returning a JPEG is served with the sniffed content type");
reset(); mode = "badverify"; r = await paid("/generate", { prompt: PROMPT });
ok(r.status === 402 && dec(r.headers.get("PAYMENT-REQUIRED")).error === "insufficient_funds" && dec(r.headers.get("PAYMENT-REQUIRED")).accepts[0].amount === "10000" && calls.length === 1 && ai.calls.length === 0, "generate: verify fail -> 402 (route amount), no AI call");
reset(); mode = "badsettle"; r = await paid("/generate", { prompt: PROMPT }); let t = await r.text();
ok(r.status === 402 && t.trim() === "{}" && r.headers.get("Content-Type") === "application/json" && !t.includes("iVBOR") && dec(r.headers.get("PAYMENT-RESPONSE")).success === false && dec(r.headers.get("PAYMENT-RESPONSE")).errorReason === "invalid_transaction_state", "generate: settle fail -> 402 empty body, no image leaked");
reset(); mode = "badsettle"; r = await paid("/generate", { prompt: PROMPT, format: "json" }); t = await r.text(); ok(r.status === 402 && t.trim() === "{}", "generate json: settle fail -> 402 empty body");
reset(); globalThis.fetch = async () => { throw new Error("boom"); }; r = await paid("/generate", { prompt: PROMPT }); ok(r.status === 500 && ai.calls.length === 0, "facilitator unreachable -> 500, no AI call"); globalThis.fetch = origFetch;

// ---- describe via base64 ----
reset(); ai.describe = ["  A 2x2 test image with\n red, green,  blue and white pixels.  "];
r = await paid("/describe", { image_base64: PNG_B64 }); j = await r.json();
ok(r.status === 200 && j.description === "A 2x2 test image with red, green, blue and white pixels." && j.question === "Describe this image in detail." && j.image_bytes === PNG.length && j.model === LLAVA && /^\d{4}-\d{2}-\d{2}T/.test(j.generated_at), "describe base64 -> 200 with default question, whitespace normalized");
ok(Object.keys(j).join() === "description,question,image_bytes,model,generated_at", "describe keys exact");
ok(dec(r.headers.get("PAYMENT-RESPONSE")).transaction === "0xdeadbeef" && calls.length === 2 && JSON.parse(calls[1].init.body).paymentRequirements.amount === "5000", "describe settled at 5000 with receipt");
ok(ai.calls.length === 1 && ai.calls[0].model === LLAVA && Array.isArray(ai.calls[0].input.image) && ai.calls[0].input.image.length === PNG.length && Buffer.from(ai.calls[0].input.image).equals(PNG) && ai.calls[0].input.prompt === "Describe this image in detail." && ai.calls[0].input.max_tokens === 512 && Object.keys(ai.calls[0].input).join() === "image,prompt,max_tokens", "llava input: image as byte array (exact bytes), prompt, max_tokens 512");
ok(imgFetches.length === 0, "base64 path makes no image fetch");
reset(); ai.describe = ["Two dice."]; r = await paid("/describe", { image_base64: "data:image/png;base64," + PNG_B64, question: "  What objects   are shown? " }); j = await r.json();
ok(r.status === 200 && j.question === "What objects are shown?" && ai.calls[0].input.prompt === "What objects are shown?" && j.image_bytes === PNG.length, "data: URL prefix accepted, custom question trimmed and passed to the model");
reset(); r = await paid("/describe", { image_base64: PNG.toString("base64url"), question: "" }); j = await r.json(); ok(r.status === 200 && j.question === "Describe this image in detail." && Buffer.from(ai.calls[0].input.image).equals(PNG), "url-safe base64 accepted, empty question -> default");
reset(); r = await paid("/describe", { image_base64: JPEG.toString("base64") }); j = await r.json(); ok(r.status === 200 && j.image_bytes === JPEG.length, "jpeg base64 accepted");
// fallback + failure
reset(); ai.fail.add(LLAVA); ai.describe = ["Fallback caption."]; r = await paid("/describe", { image_base64: PNG_B64 }); j = await r.json();
ok(r.status === 200 && j.model === UFORM && j.description === "Fallback caption." && ai.calls.length === 2 && ai.calls[0].model === LLAVA && ai.calls[1].model === UFORM && Buffer.from(ai.calls[1].input.image).equals(PNG) && ai.calls[1].input.max_tokens === 512 && calls.length === 2, "llava fails -> uform fallback (same input shape) -> 200 with fallback model, settled");
reset(); ai.describe = ["   ", "From uform."]; r = await paid("/describe", { image_base64: PNG_B64 }); j = await r.json(); ok(r.status === 200 && j.model === UFORM && j.description === "From uform." && ai.calls.length === 2, "llava returns empty description -> fallback used");
reset(); ai.fail.add(LLAVA); ai.fail.add(UFORM); r = await paid("/describe", { image_base64: PNG_B64 }); j = await r.json();
ok(r.status === 502 && j.error === "AI model temporarily unavailable, no payment taken" && ai.calls.length === 2 && calls.length === 1 && calls[0].u.endsWith("/verify") && !r.headers.get("PAYMENT-RESPONSE"), "both describe models fail -> 502, no settle");
reset(); mode = "badverify"; r = await paid("/describe", { image_base64: PNG_B64 }); ok(r.status === 402 && ai.calls.length === 0 && imgFetches.length === 0 && dec(r.headers.get("PAYMENT-REQUIRED")).accepts[0].amount === "5000" && dec(r.headers.get("PAYMENT-REQUIRED")).resource.url === base + "/describe", "describe: verify fail -> 402 no AI call");
reset(); mode = "badsettle"; ai.describe = ["Secret caption."]; r = await paid("/describe", { image_base64: PNG_B64 }); t = await r.text(); ok(r.status === 402 && t.trim() === "{}" && !t.includes("Secret") && dec(r.headers.get("PAYMENT-RESPONSE")).success === false, "describe: settle fail -> 402 empty body, no data leaked");

// ---- describe via url ----
const IMG = "https://cdn.example.com/photo.png";
images[IMG] = () => new Response(PNG, { status: 200, headers: { "content-type": "image/png", "content-length": String(PNG.length) } });
reset(); ai.describe = ["A tiny test image."]; r = await paid("/describe", { image_url: IMG, question: "What is it?" }); j = await r.json();
ok(r.status === 200 && j.description === "A tiny test image." && j.question === "What is it?" && j.image_bytes === PNG.length && j.model === LLAVA, "describe url -> 200");
ok(imgFetches.length === 1 && imgFetches[0].u === IMG && imgFetches[0].init.redirect === "manual" && imgFetches[0].init.headers["User-Agent"] === "NoJunk Image/1.0 (+https://nojunkcrypto.com)" && imgFetches[0].init.signal && typeof imgFetches[0].init.signal.aborted === "boolean" && imgFetches[0].init.method === "GET", "image fetched once with manual redirects, identifying UA and abort signal");
ok(Buffer.from(ai.calls[0].input.image).equals(PNG) && calls.length === 2, "fetched bytes fed to the model, settled");
reset(); order = []; AI.run = async (m, i) => { order.push("ai"); return origRun(m, i); };
globalThis.fetch = async (u, init) => { const s = String(u); order.push(images[s] ? "img" : s.split("/").pop()); return origFetch(u, init); };
r = await paid("/describe", { image_url: IMG }); ok(r.status === 200 && order.join() === "verify,img,ai,settle", "describe url order: verify -> fetch image -> model -> settle");
AI.run = origRun; globalThis.fetch = origFetch;
// content-type with params, no content-length, streamed body
images["https://cdn.example.com/stream.jpg"] = () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(JPEG.subarray(0, 10))); c.enqueue(new Uint8Array(JPEG.subarray(10))); c.close(); } }), { status: 200, headers: { "content-type": "image/jpeg; charset=binary" } });
reset(); r = await paid("/describe", { image_url: "https://cdn.example.com/stream.jpg" }); j = await r.json(); ok(r.status === 200 && j.image_bytes === JPEG.length && Buffer.from(ai.calls[0].input.image).equals(JPEG), "streamed image without content-length assembled correctly");
// non-image content type -> 415, no AI, no settle
images["https://cdn.example.com/page.html"] = () => new Response("<html>hi</html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
reset(); r = await paid("/describe", { image_url: "https://cdn.example.com/page.html" }); j = await r.json();
ok(r.status === 415 && /text\/html/.test(j.error) && /no payment taken/.test(j.error) && ai.calls.length === 0 && calls.length === 1 && !r.headers.get("PAYMENT-RESPONSE"), "url serving text/html -> 415, no AI, not settled");
images["https://cdn.example.com/noct"] = () => new Response(PNG, { status: 200 });
reset(); r = await paid("/describe", { image_url: "https://cdn.example.com/noct" }); ok(r.status === 415 && ai.calls.length === 0 && calls.length === 1, "url with no content-type -> 415");
// size cap: declared and undeclared
images["https://cdn.example.com/huge-declared.png"] = () => new Response(PNG, { status: 200, headers: { "content-type": "image/png", "content-length": String(10 * 1024 * 1024 + 1) } });
reset(); r = await paid("/describe", { image_url: "https://cdn.example.com/huge-declared.png" }); j = await r.json();
ok(r.status === 413 && /10485760/.test(j.error) && ai.calls.length === 0 && calls.length === 1, "url with content-length > 10 MB -> 413 before download, no AI, not settled");
{
  const big = new Uint8Array(10 * 1024 * 1024 + 1); big.set(PNG, 0);
  images["https://cdn.example.com/huge-stream.png"] = () => new Response(new ReadableStream({ start(c) { for (let i = 0; i < big.length; i += 1024 * 1024) c.enqueue(big.subarray(i, i + 1024 * 1024)); c.close(); } }), { status: 200, headers: { "content-type": "image/png" } });
  reset(); r = await paid("/describe", { image_url: "https://cdn.example.com/huge-stream.png" }); j = await r.json();
  ok(r.status === 413 && ai.calls.length === 0 && calls.length === 1, "url streaming > 10 MB without content-length -> 413, no AI, not settled");
  images["https://cdn.example.com/exact.png"] = () => new Response(big.subarray(0, 10 * 1024 * 1024), { status: 200, headers: { "content-type": "image/png" } });
  reset(); r = await paid("/describe", { image_url: "https://cdn.example.com/exact.png" }); j = await r.json(); ok(r.status === 200 && j.image_bytes === 10 * 1024 * 1024 && ai.calls[0].input.image.length === 10 * 1024 * 1024, "exactly 10 MB image accepted");
}
// fetch failures -> 502
images["https://cdn.example.com/404.png"] = () => new Response("nope", { status: 404, headers: { "content-type": "image/png" } });
reset(); r = await paid("/describe", { image_url: "https://cdn.example.com/404.png" }); j = await r.json(); ok(r.status === 502 && /HTTP 404/.test(j.error) && ai.calls.length === 0 && calls.length === 1, "url 404 -> 502, no AI, not settled");
images["https://cdn.example.com/boom.png"] = () => { throw new Error("ECONNRESET"); };
reset(); r = await paid("/describe", { image_url: "https://cdn.example.com/boom.png" }); j = await r.json(); ok(r.status === 502 && /no payment taken/.test(j.error) && ai.calls.length === 0 && calls.length === 1 && !r.headers.get("PAYMENT-RESPONSE"), "url network error -> 502, no AI, not settled");
images["https://cdn.example.com/abort.png"] = () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; };
reset(); r = await paid("/describe", { image_url: "https://cdn.example.com/abort.png" }); ok(r.status === 502 && calls.length === 1, "url timeout (AbortError) -> 502 not settled");
images["https://cdn.example.com/empty.png"] = () => new Response(new Uint8Array(0), { status: 200, headers: { "content-type": "image/png" } });
reset(); r = await paid("/describe", { image_url: "https://cdn.example.com/empty.png" }); ok(r.status === 502 && ai.calls.length === 0 && calls.length === 1, "url empty body -> 502");
// redirects: public -> followed, private -> blocked, too many -> 502
images["https://cdn.example.com/r1.png"] = () => new Response(null, { status: 302, headers: { location: "/photo.png" } });
images["https://cdn.example.com/photo.png"] = images[IMG];
reset(); r = await paid("/describe", { image_url: "https://cdn.example.com/r1.png" }); j = await r.json(); ok(r.status === 200 && imgFetches.length === 2 && imgFetches[1].u === "https://cdn.example.com/photo.png" && j.image_bytes === PNG.length, "relative redirect to a public url followed");
images["https://cdn.example.com/evil.png"] = () => new Response(null, { status: 301, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
reset(); r = await paid("/describe", { image_url: "https://cdn.example.com/evil.png" }); j = await r.json(); ok(r.status === 502 && /blocked/.test(j.error) && imgFetches.length === 1 && ai.calls.length === 0 && calls.length === 1 && otherFetch.length === 0, "redirect to private IP blocked -> 502, metadata host never fetched");
images["https://cdn.example.com/evil6.png"] = () => new Response(null, { status: 307, headers: { location: "http://[::1]:8080/x" } });
reset(); r = await paid("/describe", { image_url: "https://cdn.example.com/evil6.png" }); ok(r.status === 502 && imgFetches.length === 1 && otherFetch.length === 0, "redirect to ipv6 loopback blocked");
images["https://cdn.example.com/loop.png"] = () => new Response(null, { status: 302, headers: { location: "https://cdn.example.com/loop.png" } });
reset(); r = await paid("/describe", { image_url: "https://cdn.example.com/loop.png" }); j = await r.json(); ok(r.status === 502 && /too many/.test(j.error) && imgFetches.length === 4 && ai.calls.length === 0 && calls.length === 1, "redirect loop stops after 3 hops -> 502");
images["https://cdn.example.com/noloc.png"] = () => new Response(null, { status: 302 });
reset(); r = await paid("/describe", { image_url: "https://cdn.example.com/noloc.png" }); ok(r.status === 502 && calls.length === 1, "redirect without location -> 502");
// public IP literal is allowed
images["http://93.184.216.34/x.png"] = images[IMG];
reset(); r = await paid("/describe", { image_url: "http://93.184.216.34/x.png" }); ok(r.status === 200, "public IPv4 literal allowed");
images["https://cdn.example.com/photo.png?size=large#frag"] = images[IMG];
reset(); r = await paid("/describe", { image_url: " https://CDN.example.com/photo.png?size=large#frag " }); ok(r.status === 200 && imgFetches[0].u === "https://cdn.example.com/photo.png?size=large#frag", "url trimmed and normalized");
reset(); ai.fail.add(LLAVA); ai.describe = ["uform via url"]; r = await paid("/describe", { image_url: IMG }); j = await r.json(); ok(r.status === 200 && j.model === UFORM && imgFetches.length === 1, "url path: fallback model, image fetched once");
reset(); mode = "badsettle"; r = await paid("/describe", { image_url: IMG }); t = await r.text(); ok(r.status === 402 && t.trim() === "{}", "describe url: settle fail -> 402 empty body");
reset(); mode = "badverify"; r = await paid("/describe", { image_url: IMG }); ok(r.status === 402 && imgFetches.length === 0 && ai.calls.length === 0, "describe url: verify fail -> no image fetch, no AI");

// ---- openapi ----
reset(); r = await W.fetch(new Request(base + "/openapi.json"), env); const o = await r.json();
ok(r.status === 200 && o.openapi === "3.1.0" && o.info.title === "NoJunk Image" && typeof o.info["x-guidance"] === "string" && o.info["x-guidance"].includes("$0.01") && o.info["x-guidance"].includes("$0.005") && o.info["x-guidance"].includes("image/png") && o.servers[0].url === base, "openapi header + x-guidance");
ok(Object.keys(o.paths).join() === "/generate,/describe" && Object.keys(o.paths["/generate"]).join() === "post" && Object.keys(o.paths["/describe"]).join() === "post", "openapi paths: 2 POST routes");
for (const [route, amt] of [["/generate", "0.010000"], ["/describe", "0.005000"]]) {
  const p = o.paths[route].post;
  ok(p["x-payment-info"].price.amount === amt && p["x-payment-info"].price.mode === "fixed" && p["x-payment-info"].price.currency === "USD" && p["x-payment-info"].protocols[0].x402 && p.responses["402"] && p.responses["200"] && p.responses["400"] && p.responses["413"] && p.responses["502"] && p.requestBody.required === true && p.operationId, `openapi ${route} x-payment-info ${amt} + 402`);
}
const g = o.paths["/generate"].post;
ok(g.responses["200"].content["image/png"].schema.format === "binary" && g.responses["200"].content["application/json"].schema.required.includes("image_base64") && g.responses["200"].headers["PAYMENT-RESPONSE"] && g.responses["200"].headers["X-Image-Bytes"] && !g.responses["200"].headers["X-Seed"] && g.requestBody.content["application/json"].schema.properties.seed.deprecated === true && g.requestBody.content["application/json"].schema.required.join() === "prompt" && g.requestBody.content["application/json"].schema.properties.format.enum.join() === "png,json" && g.requestBody.content["application/json"].schema.properties.steps.maximum === 8, "openapi /generate documents binary png + json responses, headers, schema");
const d = o.paths["/describe"].post;
ok(d.responses["415"] && d.requestBody.content["application/json"].schema.oneOf.length === 2 && d.requestBody.content["application/json"].schema.properties.image_url && d.requestBody.content["application/json"].schema.properties.image_base64 && d.responses["200"].content["application/json"].schema.required.join() === "description,question,image_bytes,model,generated_at", "openapi /describe schema: url-or-base64, 415, output fields");
r = await W.fetch(new Request(base + "/.well-known/openapi.json"), env); ok(r.status === 200, "well-known openapi alias");
ok(!JSON.stringify(o).includes("CDP_API_KEY") && !JSON.stringify(j).includes("CDP"), "no secrets in openapi or responses");

// ---- CDP facilitator path (Ed25519 + EC keys) ----
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const jwk = privateKey.export({ format: "jwk" });
const secret = Buffer.concat([Buffer.from(jwk.d, "base64url"), Buffer.from(jwk.x, "base64url")]).toString("base64");
const envC = { PAY_TO: PAY, AI, CDP_API_KEY_ID: "test-key-id", CDP_API_KEY_SECRET: secret };
reset(); r = await paid("/generate", { prompt: PROMPT }, { env: envC });
ok(r.status === 200 && calls[0].u === "https://api.cdp.coinbase.com/platform/v2/x402/verify" && calls[1].u.endsWith("/settle") && Buffer.from(await r.arrayBuffer()).equals(PNG), "cdp facilitator used");
const checkJwt = (tok, pub, uri, alg) => { const [h, pl, s] = tok.split("."); const H = JSON.parse(Buffer.from(h, "base64url")), P = JSON.parse(Buffer.from(pl, "base64url"));
  const sigOk = alg === "EdDSA" ? nverify(null, Buffer.from(h + "." + pl), pub, Buffer.from(s, "base64url")) : nverify("sha256", Buffer.from(h + "." + pl), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
  return sigOk && H.alg === alg && H.kid === "test-key-id" && H.nonce.length === 32 && P.iss === "cdp" && P.sub === "test-key-id" && P.uris[0] === uri && P.exp - P.nbf === 120; };
ok(checkJwt(calls[0].init.headers.Authorization.slice(7), publicKey, "POST api.cdp.coinbase.com/platform/v2/x402/verify", "EdDSA"), "Ed25519 JWT valid (verify)");
ok(checkJwt(calls[1].init.headers.Authorization.slice(7), publicKey, "POST api.cdp.coinbase.com/platform/v2/x402/settle", "EdDSA"), "Ed25519 JWT valid (settle)");
const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pem = ec.privateKey.export({ type: "sec1", format: "pem" });
reset(); r = await paid("/describe", { image_base64: PNG_B64 }, { env: { ...envC, CDP_API_KEY_SECRET: pem.replace(/\n/g, "\\n") } });
ok(r.status === 200 && checkJwt(calls[0].init.headers.Authorization.slice(7), ec.publicKey, "POST api.cdp.coinbase.com/platform/v2/x402/verify", "ES256"), "EC SEC1 JWT valid");
r = await W.fetch(new Request(base + "/"), envC); ok((await r.json()).facilitator === "cdp", "info page reports cdp");

ok(otherFetch.length === 0, "no network calls outside the mocks");
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exitCode = fails ? 1 : 0;
