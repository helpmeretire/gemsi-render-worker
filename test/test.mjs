// Usage: node test/test.mjs ./worker.js /path/bazaar-out.json
// No network: the facilitator is mocked. The QR encoder is checked against known vectors (ISO 18004 / thonky
// "HELLO WORLD" 1-M), independent re-implementations of the format-information BCH code, the mask penalty rules,
// the capacity formula and a PNG parser.
import { generateKeyPairSync, verify as nverify } from "node:crypto";
import { inflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const mod = await import(pathToFileURL(resolve(process.argv[2])).href);
const W = mod.default, QR = mod.qr;
const PAY = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const dec = (h) => JSON.parse(Buffer.from(h, "base64").toString());

// ---- fetch mock: facilitator only, never hits the network ----
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
const reset = () => { calls = []; mode = "good"; };
const env = { PAY_TO: PAY };
const base = "https://qr.example.workers.dev";
const TEXT = "https://nojunkcrypto.com/x402"; // 29 bytes: version 2 at L, 3 at M/Q, 4 at H
const post = (path, body, extra = {}) => W.fetch(new Request(base + path, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), ...extra, headers: { "Content-Type": "application/json", ...(extra.headers || {}) } }), extra.env || env);
const get = (path, extra = {}) => W.fetch(new Request(base + path, { method: "GET", headers: extra.headers || {} }), extra.env || env);

// ---- info / discovery ----
let r = await W.fetch(new Request(base + "/"), env); let j = await r.json();
ok(r.status === 200 && j.service === "QR Code Generator" && j.facilitator === "payai" && j.configured === true && Object.keys(j.endpoints).join() === "/qr,/qr/batch" && j.endpoints["/qr"].price.startsWith("$0.001 ") && j.endpoints["/qr/batch"].price.startsWith("$0.005 ") && j.sample === base + "/sample.svg", "info page lists 2 routes with prices + sample link");
r = await W.fetch(new Request(base + "/qr", { method: "POST" }), {}); ok(r.status === 402 && dec(r.headers.get("PAYMENT-REQUIRED")).accepts[0].payTo === "0x6f762720b8515b7091e6aa69e8361f7b9909233f", "default wallet used");
r = await W.fetch(new Request(base + "/qr", { method: "POST", body: "not json" }), env); ok(r.status === 402, "bad input unpaid -> 402 first");
r = await get("/qr"); ok(r.status === 402 && r.headers.get("PAYMENT-REQUIRED"), "GET probe /qr without payment -> 402");
r = await get("/qr?text=hello&format=png"); ok(r.status === 402 && r.headers.get("PAYMENT-REQUIRED"), "GET probe /qr with query but no payment -> 402");
r = await get("/qr/batch"); ok(r.status === 402 && r.headers.get("PAYMENT-REQUIRED"), "GET probe /qr/batch without payment -> 402");
r = await get("/qr/batch/"); ok(r.status === 402, "trailing slash normalized");
r = await W.fetch(new Request(base + "/nope", { method: "POST" }), env); ok(r.status === 404, "unknown path -> 404");
r = await W.fetch(new Request(base + "/qr", { method: "PUT" }), env); ok(r.status === 405, "PUT -> 405");
r = await W.fetch(new Request(base + "/qr", { method: "OPTIONS" }), env); ok(r.status === 200 && r.headers.get("Access-Control-Allow-Headers").includes("PAYMENT-SIGNATURE") && r.headers.get("Access-Control-Allow-Methods").includes("POST") && r.headers.get("Access-Control-Allow-Methods").includes("GET") && r.headers.get("Access-Control-Expose-Headers").includes("X-QR-Version") && r.headers.get("Access-Control-Expose-Headers").includes("X-QR-Modules"), "OPTIONS CORS");
r = await W.fetch(new Request(base + "/qr", { method: "POST", headers: { "content-length": String(64 * 1024 + 1) } }), env); ok(r.status === 413 && !r.headers.get("PAYMENT-REQUIRED"), "content-length 64 KB + 1 -> 413 before 402");
r = await W.fetch(new Request(base + "/qr", { method: "POST", headers: { "content-length": String(64 * 1024) } }), env); ok(r.status === 402, "content-length 64 KB -> allowed (402 probe)");
r = await get("/qr?text=" + "a".repeat(64 * 1024 + 10)); ok(r.status === 413, "GET url longer than 64 KB -> 413");
r = await W.fetch(new Request(base + "/qr", { method: "POST" }), { PAY_TO: "nope" }); ok(r.status === 500, "bad PAY_TO -> 500");

// ---- free sample ----
r = await get("/sample.svg"); let t = await r.text();
ok(r.status === 200 && r.headers.get("Content-Type").startsWith("image/svg+xml") && t.startsWith("<svg") && t.endsWith("</svg>") && r.headers.get("X-QR-Version") === "2" && r.headers.get("X-QR-Modules") === "25" && r.headers.get("Cache-Control").includes("public"), "free GET /sample.svg returns the nojunkcrypto.com QR as SVG (version 2, 25 modules), cached");
r = await W.fetch(new Request(base + "/sample.svg", { method: "POST" }), env); ok(r.status === 405, "POST /sample.svg -> 405");

// ---- 402 probes: per-route amount + resource url ----
const PRICES = { "/qr": "1000", "/qr/batch": "5000" };
const MIMES = { "/qr": "image/svg+xml", "/qr/batch": "application/json" };
const prs = {}, payloads = {}, hdrs = {};
for (const route of Object.keys(PRICES)) {
  r = await W.fetch(new Request(base + route, { method: "POST" }), env);
  const pr = dec(r.headers.get("PAYMENT-REQUIRED")); prs[route] = pr;
  const a0 = pr.accepts[0];
  ok(r.status === 402 && pr.x402Version === 2 && pr.accepts.length === 1 && a0.scheme === "exact" && a0.amount === PRICES[route] && a0.payTo === PAY && a0.network === "eip155:8453" && a0.asset === "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" && a0.extra.name === "USD Coin" && a0.extra.version === "2" && a0.maxTimeoutSeconds === 300, `${route} 402 requirements (amount ${PRICES[route]})`);
  ok(pr.resource.url === base + route && pr.resource.mimeType === MIMES[route] && pr.resource.description.includes("QR") && pr.error === "PAYMENT-SIGNATURE header is required", `${route} resource url + mime ${MIMES[route]}`);
  const bz = pr.extensions.bazaar;
  ok(bz.info.input.type === "http" && bz.info.input.method === "POST" && bz.info.input.bodyType === "json" && bz.info.output.type === "json" && bz.schema.properties.input.required.includes("body") && bz.schema.$schema.includes("2020-12"), `${route} bazaar ext with POST json body`);
  ok(JSON.parse(await r.text()).x402Version === 2, `${route} 402 body is the same JSON`);
  payloads[route] = { x402Version: 2, resource: pr.resource, accepted: pr.accepts[0], payload: { signature: "0x00", authorization: {} }, extensions: pr.extensions };
  hdrs[route] = Buffer.from(JSON.stringify(payloads[route])).toString("base64");
}
{
  const bz = prs["/qr"].extensions.bazaar, ex = bz.info.output.example;
  ok(typeof bz.info.input.body.text === "string" && bz.info.input.body.format === "json" && Array.isArray(ex.matrix) && ex.matrix.length === ex.modules && ex.modules === 17 + 4 * ex.version && ex.svg.startsWith("<svg") && bz.schema.properties.input.properties.body.required.includes("text"), "qr bazaar example: text in, matrix + svg json out");
  const bb = prs["/qr/batch"].extensions.bazaar;
  ok(Array.isArray(bb.info.input.body.items) && bb.info.input.body.items.length === 2 && bb.info.output.example.count === 2 && bb.info.output.example.items[0].matrix.length === bb.info.output.example.items[0].modules && bb.schema.properties.input.properties.body.required.includes("items"), "batch bazaar example: items in, per-item matrix out");
}
writeFileSync(process.argv[3], JSON.stringify(prs["/qr"].extensions.bazaar));
const paid = (route, body, extra = {}) => post(route, body, { ...extra, headers: { "PAYMENT-SIGNATURE": hdrs[route], ...(extra.headers || {}) } });
const paidGet = (route, query, extra = {}) => get(route + "?" + query, { ...extra, headers: { "PAYMENT-SIGNATURE": hdrs[route], ...(extra.headers || {}) } });

// ---- paying with another route's requirements -> 402 ----
for (const [route, other, body] of [["/qr", "/qr/batch", { text: TEXT }], ["/qr/batch", "/qr", { items: [{ text: TEXT }] }]]) {
  reset();
  r = await post(route, body, { headers: { "PAYMENT-SIGNATURE": hdrs[other] } });
  ok(r.status === 402 && dec(r.headers.get("PAYMENT-REQUIRED")).error === "No matching payment requirements found" && dec(r.headers.get("PAYMENT-REQUIRED")).accepts[0].amount === PRICES[route] && calls.length === 0, `${route} paid with ${other} requirements -> 402 with own amount, no facilitator call`);
}
reset(); const under = { ...payloads["/qr"], accepted: { ...payloads["/qr"].accepted, amount: "999" } };
r = await post("/qr", { text: TEXT }, { headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(under)).toString("base64") } }); ok(r.status === 402 && calls.length === 0, "underpaid accepted -> 402");
r = await post("/qr", { text: TEXT }, { headers: { "PAYMENT-SIGNATURE": "!!!notbase64" } }); ok(r.status === 400 && calls.length === 0, "garbage payment header -> 400");

// ---- bad input with payment -> 400 (zero facilitator calls) ----
const badCases = [
  ["/qr", {}, "missing text"],
  ["/qr", { text: "" }, "empty text"],
  ["/qr", { text: 42 }, "non-string text"],
  ["/qr", { text: null }, "null text"],
  ["/qr", { text: "x".repeat(1501) }, "text 1501 chars"],
  ["/qr", { text: "é".repeat(1501) }, "text 1501 code points"],
  ["/qr", { text: "x".repeat(1500), ecc: "H" }, "1500 bytes do not fit version 40 at H"],
  ["/qr", { text: "日本語".repeat(500), ecc: "L" }, "1500 CJK chars (4500 UTF-8 bytes) do not fit version 40 at L"],
  ["/qr", { text: TEXT, format: "jpg" }, "bad format"],
  ["/qr", { text: TEXT, format: 1 }, "non-string format"],
  ["/qr", { text: TEXT, size: 127 }, "size 127"],
  ["/qr", { text: TEXT, size: 2049 }, "size 2049"],
  ["/qr", { text: TEXT, size: 300.5 }, "size fraction"],
  ["/qr", { text: TEXT, size: "big" }, "size string"],
  ["/qr", { text: TEXT, size: true }, "size boolean"],
  ["/qr", { text: TEXT, margin: -1 }, "margin -1"],
  ["/qr", { text: TEXT, margin: 9 }, "margin 9"],
  ["/qr", { text: TEXT, margin: 1.5 }, "margin fraction"],
  ["/qr", { text: TEXT, ecc: "X" }, "ecc X"],
  ["/qr", { text: TEXT, ecc: "" }, "ecc empty"],
  ["/qr", { text: TEXT, ecc: 2 }, "ecc number"],
  ["/qr", { text: TEXT, dark: "black" }, "dark named color"],
  ["/qr", { text: TEXT, dark: "#12345" }, "dark 5 hex digits"],
  ["/qr", { text: TEXT, dark: "#GGGGGG" }, "dark non-hex"],
  ["/qr", { text: TEXT, light: "rgb(0,0,0)" }, "light rgb()"],
  ["/qr", { text: TEXT, light: 0xffffff }, "light number"],
  ["/qr", { text: TEXT, dark: "#000000", light: "#000" }, "dark equals light"],
  ["/qr", { text: "x".repeat(1200), format: "png", size: 128 }, "png size 128 smaller than the module count"],
  ["/qr/batch", {}, "missing items"],
  ["/qr/batch", { items: [] }, "empty items"],
  ["/qr/batch", { items: "abc" }, "items string"],
  ["/qr/batch", { items: { text: "a" } }, "items object"],
  ["/qr/batch", { items: Array.from({ length: 26 }, (_, i) => ({ text: "item " + i })) }, "26 items"],
  ["/qr/batch", { items: [{ text: "ok" }, { text: "" }] }, "second item empty"],
  ["/qr/batch", { items: [{ text: "ok" }, {}] }, "second item missing text"],
  ["/qr/batch", { items: [{ text: "ok" }, "str"] }, "item not an object"],
  ["/qr/batch", { items: [{ text: "ok", label: 5 }] }, "label not a string"],
  ["/qr/batch", { items: [{ text: "x".repeat(1501) }] }, "item text too long"],
  ["/qr/batch", { items: [{ text: "x".repeat(1500) }], ecc: "H" }, "item does not fit at H"],
  ["/qr/batch", { items: [{ text: "ok" }], format: "png" }, "batch png format"],
  ["/qr/batch", { items: [{ text: "ok" }], size: 10 }, "batch bad size"],
  ["/qr/batch", { items: [{ text: "ok" }], dark: "#zzz" }, "batch bad color"],
];
for (const [route, body, label] of badCases) {
  reset(); r = await paid(route, body); j = await r.json();
  ok(r.status === 400 && calls.length === 0 && /no payment was taken/.test(j.error), `paid ${route} + ${label} -> 400, no facilitator`);
}
reset(); r = await paid("/qr", { text: "x".repeat(1500), ecc: "H" }); j = await r.json(); ok(/does not fit/.test(j.error) && /ECC H/.test(j.error) && /1273/.test(j.error), "does-not-fit error names the ecc and the version-40 capacity");
reset(); r = await post("/qr", "{not json", { headers: { "PAYMENT-SIGNATURE": hdrs["/qr"] } }); ok(r.status === 400 && calls.length === 0, "paid + malformed JSON body -> 400");
reset(); r = await post("/qr", JSON.stringify([1]), { headers: { "PAYMENT-SIGNATURE": hdrs["/qr"] } }); ok(r.status === 400 && calls.length === 0, "paid + array body -> 400");
reset(); r = await paidGet("/qr", "format=svg"); j = await r.json(); ok(r.status === 400 && calls.length === 0 && /text/.test(j.error), "paid GET without text -> 400");
reset(); r = await paidGet("/qr", "text=hi&size=abc"); ok(r.status === 400 && calls.length === 0, "paid GET bad size -> 400");
reset(); r = await paidGet("/qr/batch", "items=notjson"); ok(r.status === 400 && calls.length === 0, "paid GET batch with unparsable items -> 400");

// ---- 413 with payment: oversized body without content-length ----
reset(); r = await W.fetch(new Request(base + "/qr", { method: "POST", body: JSON.stringify({ text: TEXT, padding: "p".repeat(64 * 1024) }), headers: { "PAYMENT-SIGNATURE": hdrs["/qr"] } }), env); j = await r.json();
ok(r.status === 413 && calls.length === 0 && /no payment was taken/.test(j.error), "paid /qr + 64 KB+ body (no content-length) -> 413 before payment");
reset(); r = await paid("/qr", { text: "x".repeat(1500), ecc: "L", format: "json" }); j = await r.json(); ok(r.status === 200 && j.version === 28 && j.mode === "byte", "exactly 1500-char byte text accepted at L (version 28)");

// ---- SVG happy path ----
reset(); r = await paid("/qr", { text: TEXT }); t = await r.text();
ok(r.status === 200 && r.headers.get("Content-Type").startsWith("image/svg+xml"), "qr paid (default format) -> 200 image/svg+xml");
ok(dec(r.headers.get("PAYMENT-RESPONSE")).transaction === "0xdeadbeef" && dec(r.headers.get("PAYMENT-RESPONSE")).success === true, "PAYMENT-RESPONSE receipt on svg response");
ok(r.headers.get("X-QR-Version") === "3" && r.headers.get("X-QR-Modules") === "29" && r.headers.get("Access-Control-Expose-Headers").includes("X-QR-Version") && r.headers.get("Access-Control-Allow-Origin") === "*" && r.headers.get("Cache-Control") === "no-store", "svg headers: X-QR-Version 3, X-QR-Modules 29, CORS, no-store");
ok(calls.length === 2 && calls[0].u === "https://facilitator.payai.network/verify" && calls[1].u.endsWith("/settle"), "verify then settle via payai");
let sent = JSON.parse(calls[0].init.body); ok(sent.x402Version === 2 && sent.paymentRequirements.payTo === PAY && sent.paymentRequirements.amount === "1000" && sent.paymentPayload.accepted.amount === "1000", "facilitator body uses qr requirements (1000)");
// well-formed SVG: single root, balanced tags, expected attributes, one path with only M/h/v/z commands
const svgOk = (s, size, total, dark, light) => {
  if (!s.startsWith('<svg xmlns="http://www.w3.org/2000/svg"') || !s.endsWith("</svg>")) return "root";
  if ((s.match(/<svg/g) || []).length !== 1 || (s.match(/<\/svg>/g) || []).length !== 1) return "root count";
  if (!s.includes(`width="${size}"`) || !s.includes(`height="${size}"`) || !s.includes(`viewBox="0 0 ${total} ${total}"`) || !s.includes('shape-rendering="crispEdges"')) return "attrs";
  if (!new RegExp(`<rect width="${total}" height="${total}" fill="${light}"/>`).test(s)) return "rect";
  const path = /<path d="([^"]*)" fill="([^"]+)"\/>/.exec(s);
  if (!path || path[2] !== dark) return "path";
  if (!/^(M\d+ \d+h\d+v1h-\d+z)+$/.test(path[1])) return "path commands";
  const open = (s.match(/<[a-z]+/g) || []).length, selfClose = (s.match(/\/>/g) || []).length, close = (s.match(/<\/[a-z]+>/g) || []).length;
  if (open !== selfClose + close) return "balance";
  if (/[<>&]/.test(s.replace(/<[^>]+>/g, ""))) return "stray chars";
  return "";
};
ok(svgOk(t, 512, 29 + 8, "#000000", "#FFFFFF") === "", "svg is well-formed: width/height 512, viewBox 37 modules, crispEdges, light rect, one dark path (" + svgOk(t, 512, 37, "#000000", "#FFFFFF") + ")");
// the path's dark area equals the dark module count of the json matrix
reset(); r = await paid("/qr", { text: TEXT, format: "json" }); j = await r.json();
{
  const darkModules = j.matrix.join("").split("1").length - 1;
  const area = [...j.svg.matchAll(/h(\d+)v1/g)].reduce((n, m) => n + Number(m[1]), 0);
  ok(area === darkModules && darkModules > 0, `svg path covers exactly the ${darkModules} dark modules of the matrix`);
  ok(j.svg === t, "json.svg equals the svg route output for the same input");
}
// options applied to svg
reset(); r = await paid("/qr", { text: TEXT, size: 1000, margin: 0, dark: "#1a2B3c", light: "fff" }); t = await r.text();
ok(r.status === 200 && svgOk(t, 1000, 29, "#1A2B3C", "#FFFFFF") === "", "svg honours size 1000, margin 0, 6-digit and 3-digit colors (normalized upper-case) (" + svgOk(t, 1000, 29, "#1A2B3C", "#FFFFFF") + ")");
reset(); r = await paid("/qr", { text: TEXT, margin: 8, size: "256" }); t = await r.text(); ok(r.status === 200 && t.includes('viewBox="0 0 45 45"') && t.includes('width="256"'), "margin 8 widens the viewBox to 45 modules; numeric-string size accepted");
// order: verify -> settle only (no upstream)
reset(); r = await paid("/qr", { text: TEXT }); ok(r.status === 200 && calls.map((c) => c.u.split("/").pop()).join() === "verify,settle" && otherFetch.length === 0, "order: verify -> encode -> settle, no other network calls");

// ---- GET with payment ----
reset(); r = await paidGet("/qr", "text=" + encodeURIComponent(TEXT) + "&format=json&ecc=q&size=300&margin=2&dark=%23ff0000"); j = await r.json();
ok(r.status === 200 && j.ecc === "Q" && j.version === 3 && j.svg.includes('fill="#FF0000"') && j.svg.includes('width="300"') && j.svg.includes('viewBox="0 0 33 33"') && calls.length === 2, "paid GET /qr with query params -> 200 json (ecc q -> Q, version 3, margin 2, colors/size applied)");
reset(); r = await paidGet("/qr", "text=12345"); t = await r.text(); ok(r.status === 200 && r.headers.get("Content-Type").startsWith("image/svg+xml") && r.headers.get("X-QR-Version") === "1", "paid GET /qr default format -> svg");

// ---- JSON format ----
reset(); r = await paid("/qr", { text: TEXT, format: "JSON" }); j = await r.json();
ok(r.status === 200 && r.headers.get("Content-Type") === "application/json" && r.headers.get("X-QR-Version") === "3" && r.headers.get("X-QR-Modules") === "29" && dec(r.headers.get("PAYMENT-RESPONSE")).success === true, "format json -> 200 application/json with X-QR-* and receipt");
ok(Object.keys(j).join() === "version,ecc,modules,mask,mode,matrix,svg" && j.version === 3 && j.ecc === "M" && j.modules === 29 && j.mode === "byte" && j.mask >= 0 && j.mask <= 7, "json keys: version, ecc, modules, mask, mode, matrix, svg");
ok(Array.isArray(j.matrix) && j.matrix.length === 29 && j.matrix.every((row) => typeof row === "string" && row.length === 29 && /^[01]+$/.test(row)), "json matrix: 29 rows of 29 '0'/'1' chars");

// ---- PNG format: parse the PNG we produced ----
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function parsePng(buf) {
  if (!buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) throw new Error("bad signature");
  const chunks = []; let p = 8;
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.subarray(p + 4, p + 8).toString("ascii"), data = buf.subarray(p + 8, p + 8 + len), crc = buf.readUInt32BE(p + 8 + len);
    if (crc32(buf.subarray(p + 4, p + 8 + len)) !== crc) throw new Error("bad crc on " + type);
    chunks.push({ type, data }); p += 12 + len;
  }
  if (p !== buf.length) throw new Error("trailing bytes");
  const ihdr = chunks[0];
  if (ihdr.type !== "IHDR" || chunks[chunks.length - 1].type !== "IEND") throw new Error("chunk order");
  const width = ihdr.data.readUInt32BE(0), height = ihdr.data.readUInt32BE(4), depth = ihdr.data[8], color = ihdr.data[9];
  if (ihdr.data[10] !== 0 || ihdr.data[11] !== 0 || ihdr.data[12] !== 0) throw new Error("compression/filter/interlace");
  const plte = chunks.find((c) => c.type === "PLTE");
  const idat = Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data));
  const raw = inflateSync(idat); // verifies zlib header + Adler-32
  const rowBytes = depth === 1 ? Math.ceil(width / 8) : width * 3;
  if (raw.length !== height * (rowBytes + 1)) throw new Error("raw length " + raw.length);
  const pixel = (x, y) => {
    if (raw[y * (rowBytes + 1)] !== 0) throw new Error("filter type");
    if (depth === 1) { const idx = (raw[y * (rowBytes + 1) + 1 + (x >> 3)] >> (7 - (x & 7))) & 1; return [plte.data[idx * 3], plte.data[idx * 3 + 1], plte.data[idx * 3 + 2]]; }
    const o = y * (rowBytes + 1) + 1 + x * 3; return [raw[o], raw[o + 1], raw[o + 2]];
  };
  return { width, height, depth, color, chunks: chunks.map((c) => c.type), palette: plte ? [...plte.data] : null, pixel };
}
const hexRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
// Compares every pixel with the expected module (integer scale, centred; outside -> light).
function pngMatchesMatrix(png, matrix, margin, dark, light) {
  const n = matrix.length, total = n + 2 * margin, scale = Math.floor(png.width / total), offset = Math.floor((png.width - scale * total) / 2);
  const D = hexRgb(dark), L = hexRgb(light);
  let darkPixels = 0;
  for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
    const mx = Math.floor((x - offset) / scale) - margin, my = Math.floor((y - offset) / scale) - margin;
    const inside = x >= offset && y >= offset && mx >= 0 && my >= 0 && mx < n && my < n;
    const want = inside && matrix[my][mx] === "1" ? D : L;
    const got = png.pixel(x, y);
    if (got[0] !== want[0] || got[1] !== want[1] || got[2] !== want[2]) return `pixel (${x},${y}) got ${got} want ${want}`;
    if (want === D) darkPixels++;
  }
  const darkModules = matrix.join("").split("1").length - 1;
  if (darkPixels !== darkModules * scale * scale) return `dark pixel count ${darkPixels} != ${darkModules}*${scale}^2`;
  return "";
}
reset(); r = await paid("/qr", { text: TEXT, format: "png" });
let bytes = Buffer.from(await r.arrayBuffer());
ok(r.status === 200 && r.headers.get("Content-Type") === "image/png" && r.headers.get("Content-Length") === String(bytes.length) && r.headers.get("X-QR-Version") === "3" && r.headers.get("X-QR-Modules") === "29" && dec(r.headers.get("PAYMENT-RESPONSE")).transaction === "0xdeadbeef", "png paid -> 200 image/png with Content-Length, X-QR-* and receipt");
let png = parsePng(bytes);
ok(png.width === 512 && png.height === 512 && png.depth === 1 && png.color === 3 && png.chunks.join() === "IHDR,PLTE,IDAT,IEND" && png.palette.join() === "255,255,255,0,0,0", "png parsed: signature, all chunk CRCs valid, IHDR 512x512 1-bit palette, PLTE light then dark, IDAT inflates");
{ const err = pngMatchesMatrix(png, j.matrix, 4, "#000000", "#FFFFFF"); ok(err === "", "png pixels match the json matrix module for module (13 px/module, centred, margin 4) " + err); }
reset(); r = await paid("/qr", { text: TEXT, format: "png", size: 2048, margin: 0, dark: "#102030", light: "#F0E0D0" }); bytes = Buffer.from(await r.arrayBuffer()); png = parsePng(bytes);
ok(r.status === 200 && png.width === 2048 && png.height === 2048 && png.palette.join() === "240,224,208,16,32,48" && bytes.length > 65535 * 2, "png 2048 px, margin 0, custom colors: multi-block stored deflate parses, palette carries the colors");
{ const err = pngMatchesMatrix(png, j.matrix, 0, "#102030", "#F0E0D0"); ok(err === "", "png 2048 px pixels match the matrix (70 px/module) " + err); }
reset(); r = await paid("/qr", { text: "12345", format: "png", size: 128, margin: 1 }); bytes = Buffer.from(await r.arrayBuffer()); png = parsePng(bytes);
reset(); r = await paid("/qr", { text: "12345", format: "json" }); j = await r.json();
{ const err = pngMatchesMatrix(png, j.matrix, 1, "#000000", "#FFFFFF"); ok(png.width === 128 && err === "", "png 128 px version 1 margin 1 (5 px/module, centred with a light border) matches the matrix " + err); }
reset(); r = await paid("/qr", { text: "x".repeat(1200), format: "json", ecc: "H" }); j = await r.json();
reset(); r = await paid("/qr", { text: "x".repeat(1200), format: "png", ecc: "H", size: j.modules, margin: 0 }); bytes = Buffer.from(await r.arrayBuffer()); png = parsePng(bytes);
{ const err = pngMatchesMatrix(png, j.matrix, 0, "#000000", "#FFFFFF"); ok(r.status === 200 && j.version === 39 && png.width === 173 && r.headers.get("X-QR-Modules") === "173" && err === "", "png at exactly one pixel per module (version 39, 173 px) accepted and matches " + err); }
reset(); r = await paid("/qr", { text: "x".repeat(1200), format: "png", ecc: "H", size: j.modules - 1, margin: 0 }); ok(r.status === 400 && calls.length === 0, "png one pixel short of the module count -> 400");

// ---- batch ----
reset(); r = await paid("/qr/batch", { items: [{ text: TEXT, label: "home" }, { text: "12345678", label: " nums " }, { text: "HELLO WORLD" }] }); j = await r.json();
ok(r.status === 200 && r.headers.get("Content-Type") === "application/json" && r.headers.get("X-QR-Count") === "3" && dec(r.headers.get("PAYMENT-RESPONSE")).success === true && calls.length === 2 && JSON.parse(calls[1].init.body).paymentRequirements.amount === "5000", "batch paid -> 200 json, X-QR-Count 3, settled at 5000");
ok(Object.keys(j).join() === "count,ecc,format,items" && j.count === 3 && j.ecc === "M" && j.format === "svg" && j.items.length === 3, "batch shape: count, ecc, format, items");
ok(j.items.every((it) => Object.keys(it).join() === "label,text,version,modules,svg") && j.items[0].label === "home" && j.items[1].label === "nums" && j.items[2].label === null && j.items[0].text === TEXT && j.items[0].version === 3 && j.items[1].version === 1 && j.items[2].version === 1, "batch items: label (trimmed / null), text, version, modules, svg");
ok(j.items.every((it) => svgOk(it.svg, 512, it.modules + 8, "#000000", "#FFFFFF") === "" && it.modules === 17 + 4 * it.version), "batch svgs are well-formed with the right viewBox");
reset(); r = await paid("/qr/batch", { items: [{ text: "A" }, { text: "B" }], format: "json", ecc: "h" }); j = await r.json();
ok(r.status === 200 && j.format === "json" && j.ecc === "H" && j.items.every((it) => Object.keys(it).join() === "label,text,version,modules,matrix" && it.matrix.length === 21 && it.matrix.every((row) => /^[01]{21}$/.test(row))), "batch json format: matrix per item, ecc applied");
reset(); r = await paid("/qr/batch", { items: Array.from({ length: 25 }, (_, i) => ({ text: `https://nojunkcrypto.com/item/${i}`, label: `item ${i}` })) }); j = await r.json();
ok(r.status === 200 && j.count === 25 && j.items[24].label === "item 24" && j.items[24].svg.startsWith("<svg"), "batch of exactly 25 items accepted");
reset(); r = await paidGet("/qr/batch", "items=" + encodeURIComponent(JSON.stringify([{ text: "one", label: "1" }, { text: "two" }])) + "&format=json"); j = await r.json();
ok(r.status === 200 && j.count === 2 && j.items[0].label === "1" && j.items[1].matrix.length === 21, "paid GET batch with items JSON param");
reset(); r = await paidGet("/qr/batch", "text=one&text=two&label=first"); j = await r.json();
ok(r.status === 200 && j.count === 2 && j.items[0].label === "first" && j.items[1].label === null && j.items[1].text === "two", "paid GET batch with repeated text= and label= params");

// ---- payment failure modes ----
reset(); mode = "badverify"; r = await paid("/qr", { text: TEXT });
ok(r.status === 402 && dec(r.headers.get("PAYMENT-REQUIRED")).error === "insufficient_funds" && dec(r.headers.get("PAYMENT-REQUIRED")).accepts[0].amount === "1000" && calls.length === 1, "qr: verify fail -> 402 (route amount), no settle");
reset(); mode = "badverify"; r = await paid("/qr/batch", { items: [{ text: TEXT }] }); ok(r.status === 402 && dec(r.headers.get("PAYMENT-REQUIRED")).accepts[0].amount === "5000" && dec(r.headers.get("PAYMENT-REQUIRED")).resource.url === base + "/qr/batch" && calls.length === 1, "batch: verify fail -> 402 with batch requirements");
for (const fmt of ["svg", "png", "json"]) {
  reset(); mode = "badsettle"; r = await paid("/qr", { text: TEXT, format: fmt }); t = await r.text();
  ok(r.status === 402 && t.trim() === "{}" && r.headers.get("Content-Type") === "application/json" && !t.includes("<svg") && !r.headers.get("X-QR-Version") && dec(r.headers.get("PAYMENT-RESPONSE")).success === false && dec(r.headers.get("PAYMENT-RESPONSE")).errorReason === "invalid_transaction_state", `qr ${fmt}: settle fail -> 402 empty body, no code leaked`);
}
reset(); mode = "badsettle"; r = await paid("/qr/batch", { items: [{ text: TEXT }] }); t = await r.text(); ok(r.status === 402 && t.trim() === "{}", "batch: settle fail -> 402 empty body");
reset(); const origFetch = globalThis.fetch; globalThis.fetch = async () => { throw new Error("boom"); }; r = await paid("/qr", { text: TEXT }); ok(r.status === 500, "facilitator unreachable -> 500"); globalThis.fetch = origFetch;
// encoder throwing -> 502 without settle (simulated by sabotaging a table the encoder reads after verify)
{
  reset(); const saved = QR.MASK_FN[0]; QR.MASK_FN[0] = () => { throw new Error("simulated encoder fault"); }; // only reached after verify
  r = await paid("/qr", { text: TEXT }); j = await r.json(); QR.MASK_FN[0] = saved;
  ok(r.status === 502 && /no payment taken/.test(j.error) && calls.length === 1 && calls[0].u.endsWith("/verify") && !r.headers.get("PAYMENT-RESPONSE"), "encoder throws -> 502, verified but not settled");
  reset(); r = await paid("/qr", { text: TEXT }); ok(r.status === 200, "encoder healthy again after the simulated fault");
}

// ---- ECC levels change version; mode selection ----
const versionOf = async (text, ecc) => { reset(); const res = await paid("/qr", { text, format: "json", ...(ecc ? { ecc } : {}) }); const b = await res.json(); return b; };
{
  const L = await versionOf(TEXT, "L"), M = await versionOf(TEXT, "M"), Q = await versionOf(TEXT, "Q"), H = await versionOf(TEXT, "H");
  ok(L.version === 2 && M.version === 3 && Q.version === 3 && H.version === 4 && L.ecc === "L" && H.ecc === "H", `ECC levels change the version for the same 29-byte text: L=${L.version} M=${M.version} Q=${Q.version} H=${H.version}`);
  ok(L.modules === 25 && M.modules === 29 && Q.modules === 29 && H.modules === 33 && [L, M, Q, H].every((b) => b.matrix.length === b.modules), "modules = 17 + 4*version for each level");
  const big = await versionOf("x".repeat(500), "L"), bigH = await versionOf("x".repeat(500), "H");
  ok(big.version === 15 && bigH.version === 24, `500 bytes: version ${big.version} at L vs ${bigH.version} at H`);
  const def = await versionOf(TEXT); ok(def.ecc === "M" && def.version === 3, "default ecc is M");
}
{
  const num = await versionOf("123456789012345678901234567890"), alnum = await versionOf("ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789 $%*", "L"), lower = await versionOf("abcdefghijklmnopqrstuvwxyz 0123456789 $%*", "L");
  ok(num.mode === "numeric" && num.version === 1, "30 digits -> numeric mode, fits version 1-M (byte mode would need version 3)");
  ok(alnum.mode === "alphanumeric" && alnum.version === 2 && lower.mode === "byte" && lower.version === 3, "41 upper-case alphanumeric chars pick alphanumeric mode (version 2-L); the same text lower-case is byte mode (version 3-L)");
  const utf = await versionOf("café ✓ 日本", "M"); ok(utf.mode === "byte" && utf.version === 2, "UTF-8 text is byte mode (16 bytes -> version 2-M)");
  const sp = await versionOf("HELLO WORLD:/.", "L"); ok(sp.mode === "alphanumeric", "space and :/. stay alphanumeric");
  const lf = await versionOf("HELLO\nWORLD", "L"); ok(lf.mode === "byte", "newline forces byte mode");
}
ok(QR.analyzeText("12345").mode === "numeric" && QR.analyzeText("1234A").mode === "alphanumeric" && QR.analyzeText("a").mode === "byte" && QR.analyzeText("é").count === 2, "analyzeText: mode detection and UTF-8 byte count");

// ===================================================================================================
// CORRECTNESS against known vectors and independent re-implementations
// ===================================================================================================
// Independent helpers (written separately from the worker's code).
const T = {
  // BCH(15,5) format information per ISO 18004 Annex C: generator 10100110111 (0x537), mask 101010000010010 (0x5412)
  formatBits(eccBits, mask) { const data = (eccBits << 3) | mask; let v = data << 10; for (let i = 14; i >= 10; i--) if ((v >> i) & 1) v ^= 0x537 << (i - 10); return ((data << 10) | v) ^ 0x5412; },
  // Decode 15 format bits: returns {ecc, mask} or null when the BCH check fails
  decodeFormat(bits) { let v = bits ^ 0x5412; const data = v >> 10; let rem = v; for (let i = 14; i >= 10; i--) if ((rem >> i) & 1) rem ^= 0x537 << (i - 10); if (rem !== 0) return null; return { ecc: ["M", "L", "H", "Q"][data >> 3], mask: data & 7 }; },
  // Read the first and second copy of the format information from a matrix of "0/1" strings
  readFormat(m) {
    const n = m.length, bit = (x, y) => Number(m[y][x]);
    let a = 0, b = 0;
    const first = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
    const second = [[n - 1, 8], [n - 2, 8], [n - 3, 8], [n - 4, 8], [n - 5, 8], [n - 6, 8], [n - 7, 8], [n - 8, 8], [8, n - 7], [8, n - 6], [8, n - 5], [8, n - 4], [8, n - 3], [8, n - 2], [8, n - 1]];
    first.forEach(([x, y], i) => { a |= bit(x, y) << i; }); second.forEach(([x, y], i) => { b |= bit(x, y) << i; });
    return { first: a, second: b };
  },
  // Mask conditions from ISO 18004 table 10 (i = row, j = column)
  mask: [(i, j) => (i + j) % 2 === 0, (i) => i % 2 === 0, (i, j) => j % 3 === 0, (i, j) => (i + j) % 3 === 0, (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0, (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0, (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0, (i, j) => (((i + j) % 2) + ((i * j) % 3)) % 2 === 0],
  ALIGN: { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38] },
  // Function-module map for versions 1-7 built from the standard's layout rules (not from the worker)
  functionMap(version) {
    const n = 17 + 4 * version, f = Array.from({ length: n }, () => new Array(n).fill(false));
    const fill = (x0, y0, x1, y1) => { for (let y = Math.max(0, y0); y <= Math.min(n - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(n - 1, x1); x++) f[y][x] = true; };
    fill(0, 0, 8, 8); fill(n - 8, 0, n - 1, 8); fill(0, n - 8, 8, n - 1); // finders + separators + format info
    for (let i = 0; i < n; i++) { f[6][i] = true; f[i][6] = true; } // timing
    const pos = T.ALIGN[version];
    for (const cy of pos) for (const cx of pos) { if ((cx === 6 && cy === 6) || (cx === 6 && cy === n - 7) || (cx === n - 7 && cy === 6)) continue; fill(cx - 2, cy - 2, cx + 2, cy + 2); }
    f[n - 8][8] = true; // dark module
    if (version >= 7) { fill(n - 11, 0, n - 9, 5); fill(0, n - 11, 5, n - 9); }
    return f;
  },
  // Penalty rules written out longhand (thonky.com style)
  penalty(rows) {
    const n = rows.length; let p = 0;
    const cols = Array.from({ length: n }, (_, x) => rows.map((r) => r[x]).join(""));
    for (const line of [...rows, ...cols]) {
      for (const m of line.matchAll(/0{5,}|1{5,}/g)) p += 3 + (m[0].length - 5);
      for (let i = 0; i + 11 <= line.length; i++) { const s = line.slice(i, i + 11); if (s === "00001011101" || s === "10111010000") p += 40; }
    }
    for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) { const c = rows[y][x]; if (rows[y][x + 1] === c && rows[y + 1][x] === c && rows[y + 1][x + 1] === c) p += 3; }
    const dark = rows.join("").split("1").length - 1, pct = (dark * 100) / (n * n);
    const lo = Math.floor(pct / 5) * 5, hi = lo + 5;
    p += Math.min(Math.abs(lo - 50) / 5, Math.abs(hi - 50) / 5) * 10;
    return p;
  },
  // GF(256) arithmetic (log/antilog tables, primitive polynomial 285) to recompute EC codewords independently
  gf: (() => { const exp = new Array(512), log = new Array(256); let x = 1; for (let i = 0; i < 255; i++) { exp[i] = x; log[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } for (let i = 255; i < 512; i++) exp[i] = exp[i - 255]; return { mul: (a, b) => (a === 0 || b === 0 ? 0 : exp[log[a] + log[b]]), exp }; })(),
  ecCodewords(data, degree) {
    const g = [1]; for (let i = 0; i < degree; i++) { const ng = new Array(g.length + 1).fill(0); for (let j = 0; j < g.length; j++) { ng[j] ^= g[j]; ng[j + 1] ^= T.gf.mul(g[j], T.gf.exp[i]); } g.splice(0, g.length, ...ng); }
    const msg = [...data, ...new Array(degree).fill(0)];
    for (let i = 0; i < data.length; i++) { const c = msg[i]; if (c !== 0) for (let j = 0; j < g.length; j++) msg[i + j] ^= T.gf.mul(g[j], c); }
    return msg.slice(data.length);
  },
};

// (b) known codewords for "HELLO WORLD" 1-M alphanumeric
{
  const c = QR.encodeQR("HELLO WORLD", "M");
  const data = Array.from(c.data).join(" "), ec = Array.from(c.blocks[0].ec).join(" ");
  ok(c.version === 1 && c.mode === "alphanumeric", "HELLO WORLD at M is version 1 alphanumeric");
  ok(data === "32 91 11 120 209 114 220 77 67 64 236 17 236 17 236 17", "HELLO WORLD 1-M data codewords match the known vector: " + data);
  ok(ec === "196 35 39 119 235 215 231 226 93 23", "HELLO WORLD 1-M EC codewords match the known vector: " + ec);
  ok(T.ecCodewords(Array.from(c.data), 10).join(" ") === ec, "independent GF(256) log-table Reed-Solomon reproduces the EC codewords");
  ok(c.blocks.length === 1 && c.codewords.length === 26 && Array.from(c.codewords).join(" ") === data + " " + ec, "1-M: single block, 26 interleaved codewords = data then EC");
  // generator polynomial degree 10 (coefficients as alpha exponents 0,251,67,46,61,118,70,64,94,32,45)
  const gen = Array.from(QR.rsGenerator(10)).map((v) => T.gf.exp.indexOf(v)); ok(gen.join() === "251,67,46,61,118,70,64,94,32,45", "degree-10 generator polynomial exponents match the standard: " + gen.join());
}
// (a) the standard final matrix for "HELLO WORLD" 1-M: finders, separators, timing, dark module, format info
{
  reset(); r = await paid("/qr", { text: "HELLO WORLD", format: "json" }); const b = await r.json(); const m = b.matrix; const n = m.length;
  ok(n === 21 && b.version === 1 && b.ecc === "M" && b.mode === "alphanumeric", "HELLO WORLD json: 21x21 version 1 M alphanumeric");
  const FINDER = ["1111111", "1000001", "1011101", "1011101", "1011101", "1000001", "1111111"];
  const finderAt = (x0, y0) => FINDER.every((row, dy) => m[y0 + dy].slice(x0, x0 + 7) === row);
  ok(finderAt(0, 0) && finderAt(n - 7, 0) && finderAt(0, n - 7), "three finder patterns in place");
  const sepOk = [...Array(8).keys()].every((i) => m[7][i] === "0" && m[i][7] === "0" && m[7][n - 1 - i] === "0" && m[i][n - 8] === "0" && m[n - 8][i] === "0" && m[n - 1 - i][7] === "0");
  ok(sepOk, "separators around the finders are light");
  let timingOk = true; for (let i = 8; i < n - 8; i++) { if (m[6][i] !== (i % 2 === 0 ? "1" : "0") || m[i][6] !== (i % 2 === 0 ? "1" : "0")) timingOk = false; }
  ok(timingOk, "timing patterns alternate dark/light on row 6 and column 6");
  ok(m[n - 8][8] === "1", "dark module at (8, 4V+9)");
  const fmt = T.readFormat(m); const decoded = T.decodeFormat(fmt.first);
  ok(fmt.first === fmt.second && decoded && decoded.ecc === "M" && decoded.mask === b.mask && fmt.first === T.formatBits(0, b.mask), `format information (both copies) decodes via BCH to ECC M + mask ${b.mask}: ${fmt.first.toString(2).padStart(15, "0")}`);
  // mask 0 is the known lowest-penalty mask for this symbol (thonky.com worked example); format string 111011111000100
  ok(b.mask === 0 && fmt.first === 0b101010000010010, "HELLO WORLD 1-M selects mask 0 -> format string 101010000010010 (M, mask 0)");
  // encoder-side: all 32 format strings match the standard table (Annex C)
  const KNOWN = { "0-0": 0b101010000010010, "0-7": 0b100101010100000, "1-0": 0b111011111000100, "1-7": 0b110100101110110, "2-0": 0b001011010001001, "2-7": 0b000100000111011, "3-0": 0b011010101011111, "3-7": 0b010101111101101 }; // ecc bits 0=M 1=L 2=H 3=Q
  ok(Object.entries(KNOWN).every(([k, v]) => { const [e, mk] = k.split("-").map(Number); return QR.formatBits(e, mk) === v && T.formatBits(e, mk) === v; }), "format information table spot-check (M/L/H/Q, masks 0 and 7) against Annex C values");
  const vbch = (v) => { let rem = v << 12; for (let i = 17; i >= 12; i--) if ((rem >> i) & 1) rem ^= 0x1f25 << (i - 12); return (v << 12) | rem; };
  ok(QR.versionBits(7) === 0x07c94 && QR.versionBits(8) === 0x085bc && QR.versionBits(40) === 0x28c69 && [...Array(34).keys()].every((i) => QR.versionBits(i + 7) === vbch(i + 7)), "version information for 7, 8, 40 matches the Annex D table; all of 7-40 match an independent BCH(18,6) division");
}
// (c) the chosen mask has the lowest penalty, recomputed independently from an unmasked reconstruction
{
  const unmask = (m, mask, fn) => m.map((row, y) => row.split("").map((v, x) => (!fn[y][x] && T.mask[mask](y, x) ? (v === "1" ? "0" : "1") : v)).join(""));
  const remask = (u, mask, fn, fmtBits) => { const m = u.map((row, y) => row.split("").map((v, x) => (!fn[y][x] && T.mask[mask](y, x) ? (v === "1" ? "0" : "1") : v))); const n = m.length; const bits = fmtBits(mask); const first = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]]; const second = [[n - 1, 8], [n - 2, 8], [n - 3, 8], [n - 4, 8], [n - 5, 8], [n - 6, 8], [n - 7, 8], [n - 8, 8], [8, n - 7], [8, n - 6], [8, n - 5], [8, n - 4], [8, n - 3], [8, n - 2], [8, n - 1]]; first.forEach(([x, y], i) => { m[y][x] = String((bits >> i) & 1); }); second.forEach(([x, y], i) => { m[y][x] = String((bits >> i) & 1); }); return m.map((r) => r.join("")); };
  const ECCBITS = { L: 1, M: 0, Q: 3, H: 2 };
  for (const [text, ecc] of [["HELLO WORLD", "M"], [TEXT, "L"], ["WIFI:T:WPA;S:MyNetwork;P:secret123;;", "Q"], ["0123456789".repeat(9), "H"], ["The quick brown fox jumps over the lazy dog 0123456789", "M"]]) {
    reset(); r = await paid("/qr", { text, format: "json", ecc }); const b = await r.json();
    const fn = T.functionMap(b.version);
    const u = unmask(b.matrix, b.mask, fn);
    const scores = [...Array(8).keys()].map((mk) => T.penalty(remask(u, mk, fn, (mask) => T.formatBits(ECCBITS[ecc], mask))));
    const min = Math.min(...scores);
    const c = QR.encodeQR(text, ecc);
    ok(scores[b.mask] === min && b.mask === c.mask, `"${text.slice(0, 20)}" v${b.version}-${ecc}: chosen mask ${b.mask} has the lowest independently computed penalty (${scores.join(",")})`);
    ok(scores.join() === c.penalties.join(), `"${text.slice(0, 20)}": worker penalties equal the independent ones for all 8 masks`);
    ok(remask(u, b.mask, fn, (mask) => T.formatBits(ECCBITS[ecc], mask)).join("\n") === b.matrix.join("\n"), `"${text.slice(0, 20)}": unmask + remask reproduces the matrix (function map consistent)`);
  }
}
// (d) round-trip sanity: 30 random strings x 4 ECC levels
{
  let seed = 20261015; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pools = ["0123456789", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 $%*+-./:", "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,;:!?@#&()[]{}\n-_/éüñ日本語€✓"];
  let all = true, versions = new Set(), failures = [];
  for (let i = 0; i < 30; i++) {
    const pool = Array.from(pools[i % 3]); const len = 1 + Math.floor(rnd() * (i % 3 === 0 ? 1500 : i % 3 === 1 ? 1500 : 1200));
    let text = ""; for (let k = 0; k < len; k++) text += pool[Math.floor(rnd() * pool.length)];
    for (const ecc of ["L", "M", "Q", "H"]) {
      reset(); r = await paid("/qr", { text, format: "json", ecc });
      if (r.status !== 200) { if (r.status === 400 && (await r.json()).error.includes("does not fit")) continue; all = false; failures.push(`${i}-${ecc} status ${r.status}`); continue; }
      const b = await r.json(); versions.add(b.version);
      const n = b.matrix.length; const fmt = T.readFormat(b.matrix); const d = T.decodeFormat(fmt.first);
      const okOne = n === 17 + 4 * b.version && b.modules === n && b.matrix.every((row) => row.length === n && /^[01]+$/.test(row)) && fmt.first === fmt.second && d && d.ecc === ecc && d.mask === b.mask && b.ecc === ecc && r.headers.get("X-QR-Version") === String(b.version) && b.matrix[n - 8][8] === "1";
      if (!okOne) { all = false; failures.push(`${i}-${ecc} v${b.version}`); }
      if (b.version >= 7) { // version information must decode too
        let vb = 0; for (let k = 0; k < 18; k++) vb |= Number(b.matrix[Math.floor(k / 3)][n - 11 + (k % 3)]) << k;
        let vb2 = 0; for (let k = 0; k < 18; k++) vb2 |= Number(b.matrix[n - 11 + (k % 3)][Math.floor(k / 3)]) << k;
        let rem = vb; for (let k = 17; k >= 12; k--) if ((rem >> k) & 1) rem ^= 0x1f25 << (k - 12);
        if (vb !== vb2 || rem !== 0 || vb >> 12 !== b.version) { all = false; failures.push(`${i}-${ecc} version info v${b.version}`); }
      }
    }
  }
  ok(all, `round trip: 30 random strings x 4 ECC levels encode, matrix = 17+4*version, format info BCH-decodes to ecc+mask, version info BCH-decodes (versions seen: ${[...versions].sort((a, b) => a - b).join(",")}) ${failures.join("; ")}`);
  ok(versions.size >= 15 && Math.max(...versions) >= 35, "random round trip covered a wide range of versions including 35+");
}
// capacity tables cross-checked against the ISO raw-module formula and known capacities
{
  const rawModules = (v) => { let r = (16 * v + 128) * v + 64; if (v >= 2) { const a = Math.floor(v / 7) + 2; r -= (25 * a - 10) * a - 55; if (v >= 7) r -= 36; } return r; };
  ok([...Array(40).keys()].every((i) => QR.TOTAL_CODEWORDS[i + 1] === Math.floor(rawModules(i + 1) / 8)), "TOTAL_CODEWORDS table equals floor(raw data modules / 8) for versions 1-40");
  const dataCw = (v, e) => QR.TOTAL_CODEWORDS[v] - QR.EC_CODEWORDS_PER_BLOCK[e][v] * QR.EC_BLOCKS[e][v];
  ok(dataCw(1, 0) === 19 && dataCw(1, 1) === 16 && dataCw(1, 2) === 13 && dataCw(1, 3) === 9 && dataCw(40, 0) === 2956 && dataCw(40, 1) === 2334 && dataCw(40, 2) === 1666 && dataCw(40, 3) === 1276 && dataCw(10, 3) === 122 && dataCw(27, 2) === 808 && dataCw(21, 0) === 932, "data codeword counts match the standard table (v1: 19/16/13/9, v40: 2956/2334/1666/1276, 10-H 122, 27-Q 808, 21-L 932)");
  ok([...Array(40).keys()].every((i) => [0, 1, 2, 3].every((e) => { const v = i + 1, cw = QR.TOTAL_CODEWORDS[v], nb = QR.EC_BLOCKS[e][v], ec = QR.EC_CODEWORDS_PER_BLOCK[e][v]; return nb >= 1 && ec >= 7 && ec <= 30 && Math.floor(cw / nb) - ec >= 9 && (e === 0 || ec * nb > QR.EC_CODEWORDS_PER_BLOCK[e - 1][v] * QR.EC_BLOCKS[e - 1][v]); })), "every version/ECC entry: 7-30 EC codewords per block, at least 9 data codewords per block, higher levels use more EC codewords");
  ok(QR.alignmentPositions(7).join() === "6,22,38" && QR.alignmentPositions(14).join() === "6,26,46,66" && QR.alignmentPositions(32).join() === "6,34,60,86,112,138" && QR.alignmentPositions(40).join() === "6,30,58,86,114,142,170" && QR.alignmentPositions(2).join() === "6,18", "alignment pattern positions match the standard table (v2, 7, 14, 32, 40)");
  // highest version 40 at each level: the biggest text that fits and the first that does not
  const fits = (n, ecc) => { reset(); return paid("/qr", { text: "x".repeat(n), ecc, format: "json" }).then((res) => res.status); };
  const edge = [await fits(1500, "L"), await fits(1273, "H"), await fits(1274, "H")];
  const tryEnc = (n, e) => { try { return QR.encodeQR("x".repeat(n), e).version; } catch { return "throw"; } };
  ok(edge.join() === "200,200,400" && tryEnc(1663, "Q") === 40 && tryEnc(1664, "Q") === "throw" && tryEnc(2953, "L") === 40 && tryEnc(2954, "L") === "throw" && tryEnc(2331, "M") === 40 && tryEnc(2332, "M") === "throw", "capacity edge: 1273 bytes fit at H (1274 do not) via the route; encoder limits 2953 L / 2331 M / 1663 Q bytes at version 40: " + edge.join());
}
// interleaving sanity on a multi-block version: blocks + interleave are consistent with an independent re-interleave
{
  const c = QR.encodeQR("The quick brown fox jumps over the lazy dog. ".repeat(4), "H"); // version 10+ at H -> several blocks
  const nb = c.blocks.length, dataLens = c.blocks.map((b) => b.data.length);
  const expected = [];
  const maxData = Math.max(...dataLens);
  for (let i = 0; i < maxData; i++) for (const b of c.blocks) if (i < b.data.length) expected.push(b.data[i]);
  for (let i = 0; i < c.blocks[0].ec.length; i++) for (const b of c.blocks) expected.push(b.ec[i]);
  const independentEc = c.blocks.every((b) => T.ecCodewords(Array.from(b.data), b.ec.length).join() === Array.from(b.ec).join());
  ok(nb > 1 && Math.max(...dataLens) - Math.min(...dataLens) <= 1 && expected.join() === Array.from(c.codewords).join() && independentEc && c.codewords.length === QR.TOTAL_CODEWORDS[c.version], `version ${c.version}-H: ${nb} blocks (data lens ${[...new Set(dataLens)].join("/")}), EC recomputed independently per block, interleaving order correct`);
}

// ---- openapi ----
reset(); r = await W.fetch(new Request(base + "/openapi.json"), env); const o = await r.json();
ok(r.status === 200 && o.openapi === "3.1.0" && o.info.title === "QR Code Generator" && typeof o.info["x-guidance"] === "string" && o.info["x-guidance"].includes("$0.001") && o.info["x-guidance"].includes("$0.005") && o.info["x-guidance"].includes("image/svg+xml") && o.info["x-guidance"].includes("image/png") && o.servers[0].url === base, "openapi header + x-guidance");
ok(Object.keys(o.paths).join() === "/qr,/qr/batch,/sample.svg" && Object.keys(o.paths["/qr"]).join() === "post,get" && Object.keys(o.paths["/qr/batch"]).join() === "post,get", "openapi paths: 2 paid routes with POST + GET, free sample");
for (const [route, amt] of [["/qr", "0.001000"], ["/qr/batch", "0.005000"]]) {
  for (const method of ["post", "get"]) {
    const p = o.paths[route][method];
    ok(p["x-payment-info"].price.amount === amt && p["x-payment-info"].price.mode === "fixed" && p["x-payment-info"].price.currency === "USD" && p["x-payment-info"].protocols[0].x402 && p.responses["402"] && p.responses["200"] && p.responses["400"] && p.responses["413"] && p.responses["502"] && p.operationId && (method === "get" ? Array.isArray(p.parameters) && p.parameters.length > 0 : p.requestBody.required === true), `openapi ${method.toUpperCase()} ${route} x-payment-info ${amt} + 402`);
  }
}
{
  const g = o.paths["/qr"].post, c200 = g.responses["200"].content;
  ok(c200["image/svg+xml"] && c200["image/png"].schema.format === "binary" && c200["application/json"].schema.required.join() === "version,ecc,modules,mask,mode,matrix,svg" && g.responses["200"].headers["PAYMENT-RESPONSE"] && g.responses["200"].headers["X-QR-Version"] && g.responses["200"].headers["X-QR-Modules"], "openapi /qr documents svg, binary png and json responses + headers");
  const s = g.requestBody.content["application/json"].schema;
  ok(s.required.join() === "text" && s.properties.format.enum.join() === "svg,png,json" && s.properties.size.minimum === 128 && s.properties.size.maximum === 2048 && s.properties.margin.maximum === 8 && s.properties.ecc.enum.join() === "L,M,Q,H" && s.properties.text.maxLength === 1500, "openapi /qr request schema: limits documented");
  const bq = o.paths["/qr/batch"].post.requestBody.content["application/json"].schema;
  ok(bq.required.join() === "items" && bq.properties.items.maxItems === 25 && bq.properties.format.enum.join() === "svg,json" && o.paths["/qr/batch"].post.responses["200"].content["application/json"].schema.required.join() === "count,ecc,format,items", "openapi /qr/batch schema: 25 items max, svg|json, output fields");
  ok(o.paths["/qr"].get.parameters.find((p) => p.name === "text").required === true && o.paths["/qr/batch"].get.parameters.find((p) => p.name === "items").schema.type === "string", "openapi GET parameters: text required, items as JSON string");
}
r = await W.fetch(new Request(base + "/.well-known/openapi.json"), env); ok(r.status === 200, "well-known openapi alias");
ok(!JSON.stringify(o).includes("CDP_API_KEY") && !JSON.stringify(j).includes("CDP"), "no secrets in openapi or responses");

// ---- CDP facilitator path (Ed25519 + EC keys) ----
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const jwk = privateKey.export({ format: "jwk" });
const secret = Buffer.concat([Buffer.from(jwk.d, "base64url"), Buffer.from(jwk.x, "base64url")]).toString("base64");
const envC = { PAY_TO: PAY, CDP_API_KEY_ID: "test-key-id", CDP_API_KEY_SECRET: secret };
reset(); r = await paid("/qr", { text: TEXT }, { env: envC });
ok(r.status === 200 && calls[0].u === "https://api.cdp.coinbase.com/platform/v2/x402/verify" && calls[1].u.endsWith("/settle") && (await r.text()).startsWith("<svg"), "cdp facilitator used");
const checkJwt = (tok, pub, uri, alg) => { const [h, pl, s] = tok.split("."); const H = JSON.parse(Buffer.from(h, "base64url")), P = JSON.parse(Buffer.from(pl, "base64url"));
  const sigOk = alg === "EdDSA" ? nverify(null, Buffer.from(h + "." + pl), pub, Buffer.from(s, "base64url")) : nverify("sha256", Buffer.from(h + "." + pl), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
  return sigOk && H.alg === alg && H.kid === "test-key-id" && H.nonce.length === 32 && P.iss === "cdp" && P.sub === "test-key-id" && P.uris[0] === uri && P.exp - P.nbf === 120; };
ok(checkJwt(calls[0].init.headers.Authorization.slice(7), publicKey, "POST api.cdp.coinbase.com/platform/v2/x402/verify", "EdDSA"), "Ed25519 JWT valid (verify)");
ok(checkJwt(calls[1].init.headers.Authorization.slice(7), publicKey, "POST api.cdp.coinbase.com/platform/v2/x402/settle", "EdDSA"), "Ed25519 JWT valid (settle)");
const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pem = ec.privateKey.export({ type: "sec1", format: "pem" });
reset(); r = await paid("/qr/batch", { items: [{ text: TEXT }] }, { env: { ...envC, CDP_API_KEY_SECRET: pem.replace(/\n/g, "\\n") } });
ok(r.status === 200 && checkJwt(calls[0].init.headers.Authorization.slice(7), ec.publicKey, "POST api.cdp.coinbase.com/platform/v2/x402/verify", "ES256"), "EC SEC1 JWT valid");
r = await W.fetch(new Request(base + "/"), envC); ok((await r.json()).facilitator === "cdp", "info page reports cdp");

ok(otherFetch.length === 0, "no network calls outside the mocks");
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exitCode = fails ? 1 : 0;
