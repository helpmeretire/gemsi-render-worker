// Usage: node test/test.mjs ./worker.js /path/bazaar-out.json
import { generateKeyPairSync, verify as nverify } from "node:crypto";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const W = (await import(pathToFileURL(resolve(process.argv[2])).href)).default;
const PAY = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const dec = (h) => JSON.parse(Buffer.from(h, "base64").toString());
const MB = 1024 * 1024;

// ---- fixtures ----
const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n"), Buffer.alloc(200, 0x20), Buffer.from("%%EOF\n")]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 7)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x10, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(20, 3)]);
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(60, 9)]); // docx/xlsx container
const OLE = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(40, 0)]);
const HTML = Buffer.from("<!DOCTYPE html><html><body><h1>Hello</h1><p>World</p></body></html>");
const TEXT = Buffer.from("just some plain text with nothing special about it");
const CSV = Buffer.from("a,b,c\n1,2,3\n");
const b64 = (b) => b.toString("base64");

// ---- fetch mock: facilitator + registered document URLs, never hits the network ----
let calls = [], mode = "good", otherFetch = [], docFetches = [];
const docs = {}; // url -> (init) => Response
globalThis.fetch = async (u, init) => {
  u = String(u);
  if (docs[u]) { docFetches.push({ u, init }); return docs[u](init); }
  if (!u.startsWith("https://facilitator.payai.network/") && !u.startsWith("https://api.cdp.coinbase.com/")) { otherFetch.push(u); throw new Error("unexpected network call " + u); }
  calls.push({ u, init });
  const op = u.split("/").pop();
  if (mode === "badverify" && op === "verify") return new Response(JSON.stringify({ isValid: false, invalidReason: "insufficient_funds", payer: "0xabc" }), { status: 200 });
  if (mode === "badsettle" && op === "settle") return new Response(JSON.stringify({ success: false, errorReason: "invalid_transaction_state", payer: "0xabc", transaction: "", network: "eip155:8453" }), { status: 400 });
  if (op === "verify") return new Response(JSON.stringify({ isValid: true, payer: "0xabc" }));
  return new Response(JSON.stringify({ success: true, payer: "0xabc", transaction: "0xdeadbeef", network: "eip155:8453" }));
};
const MOCK_FETCH = globalThis.fetch;

// ---- Workers AI mock: toMarkdown ----
// ai.result: function (doc) -> result, or null for the default; ai.throw: make toMarkdown throw
const ai = { calls: [], result: null, throw: false };
const DEFAULT_MD = "# Title\n\nHello world, this is a test document.\n\n## Page 1\n\nFirst page text.\n\n## Page 2\n\nSecond page text.";
const AI = {
  toMarkdown: async (doc) => {
    ai.calls.push(doc);
    if (ai.throw) throw new Error("toMarkdown exploded");
    if (ai.result) return ai.result(doc);
    return { name: doc.name, mimeType: doc.blob.type, format: "markdown", tokens: 42, data: DEFAULT_MD };
  },
  run: async () => { throw new Error("run should not be used"); },
};
const reset = () => { calls = []; docFetches = []; ai.calls = []; ai.result = null; ai.throw = false; mode = "good"; };
const env = { PAY_TO: PAY, AI };
const base = "https://document.example.workers.dev";
const post = (path, body, extra = {}) => W.fetch(new Request(base + path, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), ...extra, headers: { "Content-Type": "application/json", ...(extra.headers || {}) } }), extra.env || env);
const blobBytes = async (doc) => Buffer.from(await doc.blob.arrayBuffer());

// ---- info / discovery ----
let r = await W.fetch(new Request(base + "/"), env); let j = await r.json();
ok(r.status === 200 && j.service === "NoJunk Document" && j.facilitator === "payai" && j.configured === true && Object.keys(j.endpoints).join() === "/convert" && j.endpoints["/convert"].price.startsWith("$0.01 ") && j.endpoints["/convert"].max_request_bytes === 28 * MB && j.supported_types.includes("pdf") && j.supported_types.includes("docx") && j.supported_types.includes("xlsx") && j.limits.max_file_bytes === 20 * MB, "info page lists /convert with price, caps, supported types");
r = await W.fetch(new Request(base + "/convert", { method: "POST" }), { AI }); ok(r.status === 402 && dec(r.headers.get("PAYMENT-REQUIRED")).accepts[0].payTo === "0x6f762720b8515b7091e6aa69e8361f7b9909233f", "default wallet used");
r = await W.fetch(new Request(base + "/convert", { method: "POST", body: "not json" }), env); ok(r.status === 402, "bad input unpaid -> 402 first");
r = await W.fetch(new Request(base + "/convert"), env); ok(r.status === 402 && r.headers.get("PAYMENT-REQUIRED"), "GET probe /convert without payment -> 402");
r = await W.fetch(new Request(base + "/convert/"), env); ok(r.status === 402, "trailing slash probe -> 402");
r = await W.fetch(new Request(base + "/nope", { method: "POST" }), env); ok(r.status === 404, "unknown path -> 404");
r = await W.fetch(new Request(base + "/convert", { method: "PUT" }), env); ok(r.status === 405, "PUT -> 405");
r = await W.fetch(new Request(base + "/convert", { method: "OPTIONS" }), env); ok(r.status === 200 && r.headers.get("Access-Control-Allow-Headers").includes("PAYMENT-SIGNATURE") && r.headers.get("Access-Control-Allow-Methods").includes("POST") && r.headers.get("Access-Control-Expose-Headers").includes("PAYMENT-RESPONSE"), "OPTIONS CORS");
r = await W.fetch(new Request(base + "/convert", { method: "POST", headers: { "content-length": String(28 * MB + 1) } }), env); ok(r.status === 413 && !r.headers.get("PAYMENT-REQUIRED"), "content-length 28 MB + 1 -> 413 before 402");
r = await W.fetch(new Request(base + "/convert", { method: "POST", headers: { "content-length": String(28 * MB) } }), env); ok(r.status === 402, "content-length 28 MB -> allowed (402 probe)");
r = await W.fetch(new Request(base + "/convert", { method: "POST" }), { PAY_TO: PAY }); j = await r.json(); ok(r.status === 500 && /AI/.test(j.error), "env.AI missing -> 500 misconfigured");
r = await W.fetch(new Request(base + "/convert", { method: "POST" }), { PAY_TO: PAY, AI: { run: async () => ({}) } }); ok(r.status === 500, "env.AI without toMarkdown -> 500");
r = await W.fetch(new Request(base + "/convert", { method: "POST" }), { PAY_TO: "nope", AI }); ok(r.status === 500, "bad PAY_TO -> 500");

// ---- 402 probe: requirements + bazaar ----
r = await W.fetch(new Request(base + "/convert", { method: "POST" }), env);
const pr = dec(r.headers.get("PAYMENT-REQUIRED"));
const a0 = pr.accepts[0];
ok(r.status === 402 && pr.x402Version === 2 && pr.accepts.length === 1 && a0.scheme === "exact" && a0.amount === "10000" && a0.payTo === PAY && a0.network === "eip155:8453" && a0.asset === "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" && a0.extra.name === "USD Coin" && a0.extra.version === "2" && a0.maxTimeoutSeconds === 300, "402 requirements (amount 10000)");
ok(pr.resource.url === base + "/convert" && pr.resource.mimeType === "application/json" && pr.resource.description.includes("convert") && pr.error === "PAYMENT-SIGNATURE header is required", "resource url + mime");
const bz = pr.extensions.bazaar;
ok(bz.info.input.type === "http" && bz.info.input.method === "POST" && bz.info.input.bodyType === "json" && bz.info.output.type === "json" && bz.schema.properties.input.required.includes("body") && bz.schema.$schema.includes("2020-12"), "bazaar ext with POST json body");
ok(bz.info.input.body.url.startsWith("https://") && typeof bz.info.output.example.markdown === "string" && bz.info.output.example.mime_type === "application/pdf" && Array.isArray(bz.schema.properties.input.properties.body.anyOf) && bz.schema.properties.input.properties.body.properties.file_base64 && bz.schema.properties.input.properties.body.properties.max_chars, "bazaar example: url in, markdown out, url-or-base64 schema");
ok(JSON.parse(await r.text()).x402Version === 2, "402 body is the same JSON");
writeFileSync(process.argv[3], JSON.stringify(bz));
const payload = { x402Version: 2, resource: pr.resource, accepted: pr.accepts[0], payload: { signature: "0x00", authorization: {} }, extensions: pr.extensions };
const HDR = Buffer.from(JSON.stringify(payload)).toString("base64");
const paid = (body, extra = {}) => post("/convert", body, { ...extra, headers: { "PAYMENT-SIGNATURE": HDR, ...(extra.headers || {}) } });

// ---- payment payload mismatches ----
reset(); const under = { ...payload, accepted: { ...payload.accepted, amount: "9999" } };
r = await paid({ file_base64: b64(PDF) }, { headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(under)).toString("base64") } }); ok(r.status === 402 && dec(r.headers.get("PAYMENT-REQUIRED")).error === "No matching payment requirements found" && calls.length === 0 && ai.calls.length === 0, "underpaid accepted -> 402, nothing called");
reset(); r = await paid({ file_base64: b64(PDF) }, { headers: { "PAYMENT-SIGNATURE": "!!!notbase64" } }); ok(r.status === 400 && calls.length === 0 && ai.calls.length === 0, "garbage payment header -> 400");
reset(); r = await paid({ file_base64: b64(PDF) }, { headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify({ ...payload, x402Version: 1 })).toString("base64") } }); ok(r.status === 402 && calls.length === 0, "x402Version 1 -> 402");

// ---- bad input with payment -> 400 (no AI, no facilitator, no fetch) ----
const badCases = [
  [{}, "missing url and file"],
  [{ url: "https://a.example.com/x.pdf", file_base64: b64(PDF) }, "both url and base64"],
  [{ url: 5 }, "non-string url"],
  [{ url: "" }, "empty url"],
  [{ url: "not a url" }, "invalid url"],
  [{ url: "ftp://example.com/x.pdf" }, "ftp url"],
  [{ url: "file:///etc/passwd" }, "file url"],
  [{ url: "https://user:pw@example.com/x.pdf" }, "credentials in url"],
  [{ url: "https://example.com/" + "x".repeat(2100) }, "url too long"],
  [{ url: "http://localhost/x.pdf" }, "localhost"],
  [{ url: "http://foo.localhost/x.pdf" }, "*.localhost"],
  [{ url: "http://printer.local/x.pdf" }, "*.local"],
  [{ url: "http://svc.internal/x.pdf" }, "*.internal"],
  [{ url: "http://metadata.google.internal/computeMetadata/v1/" }, "gcp metadata host"],
  [{ url: "http://intranet/x.pdf" }, "dotless host"],
  [{ url: "http://127.0.0.1/x.pdf" }, "127.0.0.1"],
  [{ url: "http://127.1.2.3:8080/x.pdf" }, "127/8 with port"],
  [{ url: "http://10.0.0.5/x.pdf" }, "10/8"],
  [{ url: "http://172.16.0.1/x.pdf" }, "172.16/12"],
  [{ url: "http://172.31.255.254/x.pdf" }, "172.31"],
  [{ url: "http://192.168.1.1/x.pdf" }, "192.168/16"],
  [{ url: "http://169.254.169.254/latest/meta-data/" }, "aws metadata ip"],
  [{ url: "http://100.64.0.1/x.pdf" }, "cgnat 100.64/10"],
  [{ url: "http://0.0.0.0/x.pdf" }, "0.0.0.0"],
  [{ url: "http://2130706433/x.pdf" }, "decimal 127.0.0.1"],
  [{ url: "http://0x7f000001/x.pdf" }, "hex 127.0.0.1"],
  [{ url: "http://[::1]/x.pdf" }, "ipv6 loopback"],
  [{ url: "http://[fd12::1]/x.pdf" }, "ipv6 ULA"],
  [{ url: "http://[fe80::1]/x.pdf" }, "ipv6 link-local"],
  [{ url: "http://[::ffff:10.0.0.1]/x.pdf" }, "ipv6-mapped private v4"],
  [{ url: "http://[::ffff:a00:1]/x.pdf" }, "ipv6-mapped private v4 hex"],
  [{ url: "https://a.example.com/x.pdf", max_chars: 999 }, "max_chars 999"],
  [{ url: "https://a.example.com/x.pdf", max_chars: 400001 }, "max_chars 400001"],
  [{ url: "https://a.example.com/x.pdf", max_chars: 1.5 }, "max_chars fraction"],
  [{ url: "https://a.example.com/x.pdf", max_chars: "lots" }, "max_chars string"],
  [{ url: "https://a.example.com/x.pdf", max_chars: true }, "max_chars boolean"],
  [{ url: "https://a.example.com/x.pdf", filename: 9 }, "non-string filename"],
  [{ url: "https://a.example.com/x.pdf", filename: "f".repeat(256) }, "filename too long"],
  [{ url: "https://a.example.com/x.pdf", content_type: 9 }, "non-string content_type"],
  [{ url: "https://a.example.com/x.pdf", content_type: "not a mime" }, "invalid content_type"],
  [{ file_base64: 9 }, "non-string base64"],
  [{ file_base64: "" }, "empty base64"],
  [{ file_base64: "not*base64!" }, "invalid base64 chars"],
  [{ file_base64: "abcde" }, "invalid base64 length"],
];
for (const [body, label] of badCases) {
  reset(); r = await paid(body); j = await r.json();
  ok(r.status === 400 && calls.length === 0 && ai.calls.length === 0 && docFetches.length === 0 && /no payment was taken/.test(j.error), `paid + ${label} -> 400, no AI, no facilitator, no fetch`);
}
reset(); r = await post("/convert", "{not json", { headers: { "PAYMENT-SIGNATURE": HDR } }); ok(r.status === 400 && calls.length === 0 && ai.calls.length === 0, "paid + malformed JSON body -> 400");
reset(); r = await post("/convert", JSON.stringify([1]), { headers: { "PAYMENT-SIGNATURE": HDR } }); ok(r.status === 400 && calls.length === 0, "paid + array body -> 400");
reset(); r = await W.fetch(new Request(base + "/convert", { headers: { "PAYMENT-SIGNATURE": HDR } }), env); ok(r.status === 405 && calls.length === 0, "paid GET -> 405, no facilitator call");

// ---- 413 / 415 before payment (base64 path) ----
{
  const big = Buffer.alloc(20 * MB + 1, 0x20); PDF.copy(big, 0);
  reset(); r = await paid({ file_base64: b64(big) }); j = await r.json();
  ok(r.status === 413 && calls.length === 0 && ai.calls.length === 0 && /20971520/.test(j.error), "paid + base64 of 20 MB + 1 file -> 413 before payment");
  reset(); r = await W.fetch(new Request(base + "/convert", { method: "POST", body: JSON.stringify({ file_base64: b64(PDF), padding: "p".repeat(28 * MB) }), headers: { "PAYMENT-SIGNATURE": HDR } }), env); j = await r.json();
  ok(r.status === 413 && calls.length === 0 && ai.calls.length === 0 && /no payment was taken/.test(j.error), "paid + 28 MB+ body without content-length -> 413 before payment");
}
reset(); r = await paid({ file_base64: b64(TEXT) }); j = await r.json();
ok(r.status === 415 && calls.length === 0 && ai.calls.length === 0 && /unsupported file type/.test(j.error) && /no payment was taken/.test(j.error), "paid + base64 of unidentifiable bytes without filename -> 415, nothing called");
reset(); r = await paid({ file_base64: b64(ZIP) }); j = await r.json(); ok(r.status === 415 && calls.length === 0 && /ZIP container/.test(j.error), "paid + zip bytes without filename -> 415 (type unknown)");
reset(); r = await paid({ file_base64: b64(ZIP), filename: "archive.zip" }); ok(r.status === 415 && calls.length === 0, "paid + zip bytes named .zip -> 415");
reset(); r = await paid({ file_base64: b64(TEXT), filename: "program.exe" }); ok(r.status === 415 && calls.length === 0, "paid + .exe -> 415");
reset(); r = await paid({ file_base64: b64(TEXT), filename: "slides.pptx" }); ok(r.status === 415 && calls.length === 0, "paid + .pptx (not supported by toMarkdown) -> 415");
reset(); r = await paid({ file_base64: b64(TEXT), content_type: "application/octet-stream" }); ok(r.status === 415 && calls.length === 0, "paid + octet-stream without extension -> 415");

// ---- base64 happy paths: type detection ----
reset(); r = await paid({ file_base64: b64(PDF) }); j = await r.json();
ok(r.status === 200 && j.name === "document.pdf" && j.mime_type === "application/pdf" && j.bytes === PDF.length && j.markdown === DEFAULT_MD && j.truncated === false && j.total_chars === DEFAULT_MD.length && j.tokens === 42 && j.word_count === 18 && j.pages_hint === 2 && j.source_url === null && /^\d{4}-\d{2}-\d{2}T/.test(j.converted_at), "pdf magic bytes -> 200 with full shape (pages_hint from '## Page' headings)");
ok(Object.keys(j).join() === "name,mime_type,bytes,markdown,truncated,total_chars,tokens,word_count,pages_hint,source_url,converted_at", "output keys exact");
ok(ai.calls.length === 1 && ai.calls[0].name === "document.pdf" && ai.calls[0].blob instanceof Blob && ai.calls[0].blob.type === "application/pdf" && (await blobBytes(ai.calls[0])).equals(PDF) && Object.keys(ai.calls[0]).join() === "name,blob", "toMarkdown called with {name, blob} carrying the exact bytes and MIME");
ok(dec(r.headers.get("PAYMENT-RESPONSE")).transaction === "0xdeadbeef" && dec(r.headers.get("PAYMENT-RESPONSE")).success === true && calls.length === 2 && calls[0].u === "https://facilitator.payai.network/verify" && calls[1].u.endsWith("/settle") && JSON.parse(calls[1].init.body).paymentRequirements.amount === "10000", "verify then settle at 10000, receipt header");
ok(docFetches.length === 0, "base64 path makes no fetch");
reset(); r = await paid({ file_base64: b64(PDF), filename: "Quarterly Report.PDF" }); j = await r.json(); ok(r.status === 200 && j.name === "Quarterly Report.pdf" && ai.calls[0].name === "Quarterly Report.pdf", "filename kept, extension normalized to lower-case");
reset(); r = await paid({ file_base64: b64(PDF), filename: "misnamed.docx" }); j = await r.json(); ok(r.status === 200 && j.name === "misnamed.pdf" && j.mime_type === "application/pdf" && ai.calls[0].blob.type === "application/pdf", "pdf magic beats wrong extension");
reset(); r = await paid({ file_base64: "data:application/pdf;base64," + b64(PDF).slice(0, 30) + "\n" + b64(PDF).slice(30) }); j = await r.json(); ok(r.status === 200 && j.bytes === PDF.length && (await blobBytes(ai.calls[0])).equals(PDF), "data: prefix + whitespace in base64 accepted");
reset(); r = await paid({ file_base64: PDF.toString("base64url") }); ok(r.status === 200 && (await blobBytes(ai.calls[0])).equals(PDF), "url-safe base64 accepted");
reset(); r = await paid({ file_base64: b64(PNG) }); j = await r.json(); ok(r.status === 200 && j.name === "document.png" && j.mime_type === "image/png" && ai.calls[0].blob.type === "image/png", "png magic -> image/png");
reset(); r = await paid({ file_base64: b64(JPEG), filename: "scan" }); j = await r.json(); ok(r.status === 200 && j.name === "scan.jpeg" && j.mime_type === "image/jpeg", "jpeg magic, extension added to filename");
reset(); r = await paid({ file_base64: b64(WEBP) }); j = await r.json(); ok(r.status === 200 && j.mime_type === "image/webp", "webp magic");
reset(); r = await paid({ file_base64: b64(ZIP), filename: "report.docx" }); j = await r.json(); ok(r.status === 200 && j.name === "report.docx" && j.mime_type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" && ai.calls[0].blob.type === j.mime_type, "docx via extension on zip bytes");
reset(); r = await paid({ file_base64: b64(ZIP), filename: "/uploads/2026/data.XLSX" }); j = await r.json(); ok(r.status === 200 && j.name === "data.xlsx" && j.mime_type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx via path-like filename");
reset(); r = await paid({ file_base64: b64(ZIP), filename: "macros.xlsm" }); j = await r.json(); ok(r.status === 200 && j.mime_type === "application/vnd.ms-excel.sheet.macroenabled.12", "xlsm via extension");
reset(); r = await paid({ file_base64: b64(ZIP), content_type: "application/vnd.oasis.opendocument.text" }); j = await r.json(); ok(r.status === 200 && j.name === "document.odt", "odt via content_type on zip bytes");
reset(); r = await paid({ file_base64: b64(ZIP), filename: "sheet.numbers" }); j = await r.json(); ok(r.status === 200 && j.mime_type === "application/vnd.apple.numbers", "apple numbers via extension");
reset(); r = await paid({ file_base64: b64(OLE), filename: "old.xls" }); j = await r.json(); ok(r.status === 200 && j.mime_type === "application/vnd.ms-excel" && j.name === "old.xls", "legacy xls via OLE magic");
reset(); r = await paid({ file_base64: b64(OLE) }); j = await r.json(); ok(r.status === 200 && j.name === "document.xls", "OLE magic without filename -> xls");
reset(); r = await paid({ file_base64: b64(CSV), filename: "rows.csv" }); j = await r.json(); ok(r.status === 200 && j.mime_type === "text/csv" && ai.calls[0].blob.type === "text/csv", "csv via extension");
reset(); r = await paid({ file_base64: b64(TEXT), filename: "notes.txt" }); j = await r.json(); ok(r.status === 200 && j.mime_type === "text/plain" && ai.calls.length === 1, "plain text still passed through toMarkdown");
reset(); r = await paid({ file_base64: b64(TEXT), content_type: "text/markdown; charset=utf-8" }); j = await r.json(); ok(r.status === 200 && j.name === "document.md" && j.mime_type === "text/markdown", "markdown via content_type with params");
reset(); r = await paid({ file_base64: b64(HTML) }); j = await r.json(); ok(r.status === 200 && j.name === "document.html" && j.mime_type === "text/html" && ai.calls.length === 1, "html sniffed from <!DOCTYPE html> without filename, passed through toMarkdown");
reset(); r = await paid({ file_base64: b64(Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>')) }); j = await r.json(); ok(r.status === 200 && j.mime_type === "image/svg+xml", "svg sniffed from xml prolog");
reset(); r = await paid({ file_base64: b64(Buffer.from('<?xml version="1.0"?><root/>')) }); j = await r.json(); ok(r.status === 200 && j.mime_type === "application/xml", "xml sniffed");
reset(); r = await paid({ file_base64: b64(TEXT), filename: "weird name\u0001.txt" }); j = await r.json(); ok(r.status === 200 && j.name === "weird name.txt", "control chars stripped from filename");

// ---- toMarkdown result handling ----
reset(); ai.result = (d) => ({ name: d.name, mimeType: "application/pdf", format: "error", tokens: 0, data: "Failed to parse PDF: encrypted" }); r = await paid({ file_base64: b64(PDF) }); j = await r.json();
ok(r.status === 422 && /could not convert/.test(j.error) && /encrypted/.test(j.error) && /no payment taken/.test(j.error) && ai.calls.length === 1 && calls.length === 1 && calls[0].u.endsWith("/verify") && !r.headers.get("PAYMENT-RESPONSE"), "toMarkdown format error -> 422, verified but not settled");
reset(); ai.throw = true; r = await paid({ file_base64: b64(PDF) }); j = await r.json();
ok(r.status === 502 && /no payment taken/.test(j.error) && ai.calls.length === 1 && calls.length === 1 && !r.headers.get("PAYMENT-RESPONSE"), "toMarkdown throws -> 502, not settled");
reset(); ai.result = () => null; r = await paid({ file_base64: b64(PDF) }); ok(r.status === 502 && calls.length === 1, "toMarkdown returns null -> 502 no settle");
reset(); ai.result = () => ({ format: "markdown" }); r = await paid({ file_base64: b64(PDF) }); ok(r.status === 502 && calls.length === 1, "toMarkdown returns no data string -> 502 no settle");
reset(); ai.result = (d) => [{ name: d.name, mimeType: "application/pdf", format: "markdown", tokens: 3, data: "array result" }]; r = await paid({ file_base64: b64(PDF) }); j = await r.json(); ok(r.status === 200 && j.markdown === "array result" && j.tokens === 3, "array-shaped toMarkdown result accepted");
reset(); ai.result = (d) => ({ name: d.name, mimeType: "application/pdf", format: "markdown", data: "no tokens field" }); r = await paid({ file_base64: b64(PDF) }); j = await r.json(); ok(r.status === 200 && j.tokens === null && j.word_count === 3, "missing tokens -> null");
reset(); ai.result = (d) => ({ name: d.name, mimeType: "text/plain", format: "markdown", tokens: 1, data: "page one\fpage two\fpage three" }); r = await paid({ file_base64: b64(PDF) }); j = await r.json(); ok(r.status === 200 && j.pages_hint === 2 && j.word_count === 6, "pages_hint from form feeds when no Page headings");
reset(); ai.result = (d) => ({ name: d.name, mimeType: "text/plain", format: "markdown", tokens: 1, data: "no page markers here at all" }); r = await paid({ file_base64: b64(PDF) }); j = await r.json(); ok(r.status === 200 && j.pages_hint === null && j.word_count === 6, "pages_hint null without markers");
reset(); ai.result = (d) => ({ name: d.name, mimeType: "text/plain", format: "markdown", tokens: 1, data: "line one\r\nline two\rline three" }); r = await paid({ file_base64: b64(PDF) }); j = await r.json(); ok(r.status === 200 && j.markdown === "line one\nline two\nline three", "CRLF normalized");
reset(); ai.result = (d) => ({ name: d.name, mimeType: "text/plain", format: "markdown", tokens: 1, data: "Don't count e-mail or 3.14 twice; café résumé 中文 字" }); r = await paid({ file_base64: b64(PDF) }); j = await r.json(); ok(r.status === 200 && j.word_count === 10, "word_count handles apostrophes, hyphens, decimals and unicode");
reset(); ai.result = (d) => ({ name: d.name, mimeType: "text/plain", format: "markdown", tokens: 0, data: "" }); r = await paid({ file_base64: b64(PDF) }); j = await r.json(); ok(r.status === 200 && j.markdown === "" && j.word_count === 0 && j.total_chars === 0 && calls.length === 2, "empty markdown (blank doc) is still a valid result");
// truncation
{
  const big = "word ".repeat(100000); // 500,000 chars
  reset(); ai.result = (d) => ({ name: d.name, mimeType: "application/pdf", format: "markdown", tokens: 100000, data: big }); r = await paid({ file_base64: b64(PDF) }); j = await r.json();
  ok(r.status === 200 && j.markdown.length === 400000 && j.truncated === true && j.total_chars === 500000 && j.word_count === 100000 && j.markdown === big.slice(0, 400000), "500k chars truncated at 400k with truncated=true, word_count of full text");
  reset(); ai.result = (d) => ({ name: d.name, mimeType: "application/pdf", format: "markdown", tokens: 1, data: big }); r = await paid({ file_base64: b64(PDF), max_chars: 1000 }); j = await r.json();
  ok(r.status === 200 && j.markdown.length === 1000 && j.truncated === true && j.total_chars === 500000, "max_chars 1000 caps output");
  reset(); ai.result = (d) => ({ name: d.name, mimeType: "application/pdf", format: "markdown", tokens: 1, data: big }); r = await paid({ file_base64: b64(PDF), max_chars: "2500" }); j = await r.json(); ok(r.status === 200 && j.markdown.length === 2500 && j.truncated === true, "numeric string max_chars accepted");
  reset(); ai.result = (d) => ({ name: d.name, mimeType: "application/pdf", format: "markdown", tokens: 1, data: "x".repeat(400000) }); r = await paid({ file_base64: b64(PDF) }); j = await r.json(); ok(r.status === 200 && j.markdown.length === 400000 && j.truncated === false, "exactly 400k not truncated");
  reset(); r = await paid({ file_base64: b64(PDF), max_chars: 400000 }); j = await r.json(); ok(r.status === 200 && j.truncated === false && j.markdown === DEFAULT_MD, "max_chars 400000 accepted, short doc untouched");
}
// payment failures
reset(); mode = "badverify"; r = await paid({ file_base64: b64(PDF) });
ok(r.status === 402 && dec(r.headers.get("PAYMENT-REQUIRED")).error === "insufficient_funds" && dec(r.headers.get("PAYMENT-REQUIRED")).accepts[0].amount === "10000" && calls.length === 1 && ai.calls.length === 0 && docFetches.length === 0, "verify fail -> 402, no convert");
reset(); mode = "badsettle"; r = await paid({ file_base64: b64(PDF) }); let t = await r.text();
ok(r.status === 402 && t.trim() === "{}" && r.headers.get("Content-Type") === "application/json" && !t.includes("Hello") && dec(r.headers.get("PAYMENT-RESPONSE")).success === false && dec(r.headers.get("PAYMENT-RESPONSE")).errorReason === "invalid_transaction_state", "settle fail -> 402 empty body, no markdown leaked");
reset(); globalThis.fetch = async () => { throw new Error("boom"); };
r = await paid({ file_base64: b64(PDF) }); ok(r.status === 500 && ai.calls.length === 0, "facilitator unreachable -> 500, no convert");
globalThis.fetch = MOCK_FETCH;

// ---- convert via url ----
const DOC = "https://cdn.example.com/paper.pdf";
docs[DOC] = () => new Response(PDF, { status: 200, headers: { "content-type": "application/pdf", "content-length": String(PDF.length) } });
reset(); r = await paid({ url: DOC }); j = await r.json();
ok(r.status === 200 && j.name === "paper.pdf" && j.mime_type === "application/pdf" && j.bytes === PDF.length && j.markdown === DEFAULT_MD && j.source_url === DOC && j.truncated === false, "convert url -> 200 with source_url and filename from path");
ok(docFetches.length === 1 && docFetches[0].u === DOC && docFetches[0].init.redirect === "manual" && docFetches[0].init.headers["User-Agent"] === "NoJunk Document/1.0 (+https://nojunkcrypto.com)" && docFetches[0].init.signal && typeof docFetches[0].init.signal.aborted === "boolean" && docFetches[0].init.method === "GET" && /application\/pdf/.test(docFetches[0].init.headers.Accept), "document fetched once with manual redirects, identifying UA, Accept, abort signal");
ok((await blobBytes(ai.calls[0])).equals(PDF) && ai.calls[0].name === "paper.pdf" && calls.length === 2, "fetched bytes fed to toMarkdown, settled");
// order: verify -> fetch -> convert -> settle
{
  reset(); const order = []; const origTM = AI.toMarkdown;
  AI.toMarkdown = async (d) => { order.push("convert"); return origTM(d); };
  const f0 = globalThis.fetch; globalThis.fetch = async (u, init) => { const s = String(u); order.push(docs[s] ? "doc" : s.split("/").pop()); return f0(u, init); };
  r = await paid({ url: DOC }); ok(r.status === 200 && order.join() === "verify,doc,convert,settle", "url order: verify -> fetch -> convert -> settle");
  AI.toMarkdown = origTM; globalThis.fetch = f0;
}
// type from URL path when content-type is generic
docs["https://cdn.example.com/files/Budget%202026.xlsx?dl=1"] = () => new Response(ZIP, { status: 200, headers: { "content-type": "application/octet-stream" } });
reset(); r = await paid({ url: "https://cdn.example.com/files/Budget%202026.xlsx?dl=1" }); j = await r.json(); ok(r.status === 200 && j.name === "Budget 2026.xlsx" && j.mime_type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" && ai.calls[0].blob.type === j.mime_type, "xlsx from url path (decoded, query ignored) over octet-stream content-type");
// type from content-type when path has no extension
docs["https://cdn.example.com/download/123"] = () => new Response(ZIP, { status: 200, headers: { "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" } });
reset(); r = await paid({ url: "https://cdn.example.com/download/123" }); j = await r.json(); ok(r.status === 200 && j.name === "123.docx" && j.mime_type.endsWith("wordprocessingml.document"), "docx from content-type header when path has no extension");
docs["https://cdn.example.com/dl"] = () => new Response(PDF, { status: 200, headers: { "content-type": "application/octet-stream" } });
reset(); r = await paid({ url: "https://cdn.example.com/dl" }); j = await r.json(); ok(r.status === 200 && j.name === "dl.pdf" && j.mime_type === "application/pdf", "pdf magic wins over octet-stream and missing extension");
docs["https://cdn.example.com/"] = () => new Response(HTML, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
reset(); r = await paid({ url: "https://cdn.example.com/" }); j = await r.json(); ok(r.status === 200 && j.name === "document.html" && j.mime_type === "text/html" && ai.calls.length === 1, "html page at site root -> document.html passed through toMarkdown");
docs["https://cdn.example.com/article"] = () => new Response(HTML, { status: 200, headers: { "content-type": "application/octet-stream" } });
reset(); r = await paid({ url: "https://cdn.example.com/article" }); j = await r.json(); ok(r.status === 200 && j.name === "article.html", "html sniffed when url has no extension and generic content-type");
docs["https://cdn.example.com/readme"] = () => new Response(TEXT, { status: 200, headers: { "content-type": "text/plain" } });
reset(); r = await paid({ url: "https://cdn.example.com/readme" }); j = await r.json(); ok(r.status === 200 && j.name === "readme.txt" && j.mime_type === "text/plain", "plain text url passed through toMarkdown");
// caller-supplied filename / content_type override url hints
docs["https://cdn.example.com/blob"] = () => new Response(ZIP, { status: 200, headers: { "content-type": "application/octet-stream" } });
reset(); r = await paid({ url: "https://cdn.example.com/blob", filename: "deck.xlsm" }); j = await r.json(); ok(r.status === 200 && j.name === "deck.xlsm", "caller filename resolves zip type for a url");
reset(); r = await paid({ url: "https://cdn.example.com/blob", content_type: "application/vnd.oasis.opendocument.spreadsheet" }); j = await r.json(); ok(r.status === 200 && j.name === "blob.ods", "caller content_type resolves zip type for a url");
// unsupported content -> 415 after verify, no convert, no settle
docs["https://cdn.example.com/blob.bin"] = () => new Response(TEXT, { status: 200, headers: { "content-type": "application/octet-stream" } });
reset(); r = await paid({ url: "https://cdn.example.com/blob.bin" }); j = await r.json();
ok(r.status === 415 && /unsupported file type/.test(j.error) && /no payment taken/.test(j.error) && ai.calls.length === 0 && calls.length === 1 && !r.headers.get("PAYMENT-RESPONSE"), "url serving unidentifiable bytes -> 415, no convert, not settled");
docs["https://cdn.example.com/archive.zip"] = () => new Response(ZIP, { status: 200, headers: { "content-type": "application/zip" } });
reset(); r = await paid({ url: "https://cdn.example.com/archive.zip" }); j = await r.json(); ok(r.status === 415 && /ZIP container/.test(j.error) && ai.calls.length === 0 && calls.length === 1, "url serving a plain zip -> 415");
docs["https://cdn.example.com/video.mp4"] = () => new Response(Buffer.alloc(100, 5), { status: 200, headers: { "content-type": "video/mp4" } });
reset(); r = await paid({ url: "https://cdn.example.com/video.mp4" }); ok(r.status === 415 && ai.calls.length === 0 && calls.length === 1, "url serving video -> 415");
// streamed body without content-length
docs["https://cdn.example.com/stream.pdf"] = () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(PDF.subarray(0, 10))); c.enqueue(new Uint8Array(PDF.subarray(10))); c.close(); } }), { status: 200, headers: { "content-type": "application/pdf" } });
reset(); r = await paid({ url: "https://cdn.example.com/stream.pdf" }); j = await r.json(); ok(r.status === 200 && j.bytes === PDF.length && (await blobBytes(ai.calls[0])).equals(PDF), "streamed document without content-length assembled correctly");
// size caps
docs["https://cdn.example.com/huge-declared.pdf"] = () => new Response(PDF, { status: 200, headers: { "content-type": "application/pdf", "content-length": String(20 * MB + 1) } });
reset(); r = await paid({ url: "https://cdn.example.com/huge-declared.pdf" }); j = await r.json();
ok(r.status === 413 && /20971520/.test(j.error) && ai.calls.length === 0 && calls.length === 1 && !r.headers.get("PAYMENT-RESPONSE"), "url with content-length > 20 MB -> 413 before download, not settled");
{
  const big = new Uint8Array(20 * MB + 1); big.set(PDF, 0);
  docs["https://cdn.example.com/huge-stream.pdf"] = () => new Response(new ReadableStream({ start(c) { for (let i = 0; i < big.length; i += MB) c.enqueue(big.subarray(i, i + MB)); c.close(); } }), { status: 200, headers: { "content-type": "application/pdf" } });
  reset(); r = await paid({ url: "https://cdn.example.com/huge-stream.pdf" }); j = await r.json();
  ok(r.status === 413 && ai.calls.length === 0 && calls.length === 1, "url streaming > 20 MB without content-length -> 413, not settled");
  docs["https://cdn.example.com/exact.pdf"] = () => new Response(big.subarray(0, 20 * MB), { status: 200, headers: { "content-type": "application/pdf" } });
  reset(); r = await paid({ url: "https://cdn.example.com/exact.pdf" }); j = await r.json(); ok(r.status === 200 && j.bytes === 20 * MB && ai.calls[0].blob.size === 20 * MB, "exactly 20 MB document accepted");
}
// fetch failures -> 502
docs["https://cdn.example.com/404.pdf"] = () => new Response("nope", { status: 404, headers: { "content-type": "application/pdf" } });
reset(); r = await paid({ url: "https://cdn.example.com/404.pdf" }); j = await r.json(); ok(r.status === 502 && /HTTP 404/.test(j.error) && /no payment taken/.test(j.error) && ai.calls.length === 0 && calls.length === 1 && !r.headers.get("PAYMENT-RESPONSE"), "url 404 -> 502, no convert, not settled");
docs["https://cdn.example.com/500.pdf"] = () => new Response("err", { status: 500 });
reset(); r = await paid({ url: "https://cdn.example.com/500.pdf" }); ok(r.status === 502 && calls.length === 1, "url 500 -> 502");
docs["https://cdn.example.com/boom.pdf"] = () => { throw new Error("ECONNRESET"); };
reset(); r = await paid({ url: "https://cdn.example.com/boom.pdf" }); j = await r.json(); ok(r.status === 502 && /no payment taken/.test(j.error) && ai.calls.length === 0 && calls.length === 1, "url network error -> 502, not settled");
docs["https://cdn.example.com/abort.pdf"] = () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; };
reset(); r = await paid({ url: "https://cdn.example.com/abort.pdf" }); ok(r.status === 502 && calls.length === 1, "url timeout (AbortError) -> 502 not settled");
docs["https://cdn.example.com/empty.pdf"] = () => new Response(new Uint8Array(0), { status: 200, headers: { "content-type": "application/pdf" } });
reset(); r = await paid({ url: "https://cdn.example.com/empty.pdf" }); ok(r.status === 502 && ai.calls.length === 0 && calls.length === 1, "url empty body -> 502");
// redirects
docs["https://cdn.example.com/r1.pdf"] = () => new Response(null, { status: 302, headers: { location: "/paper.pdf" } });
reset(); r = await paid({ url: "https://cdn.example.com/r1.pdf" }); j = await r.json(); ok(r.status === 200 && docFetches.length === 2 && docFetches[1].u === DOC && j.name === "paper.pdf" && j.source_url === "https://cdn.example.com/r1.pdf", "relative redirect followed; name from final url, source_url is the requested url");
docs["https://cdn.example.com/go"] = () => new Response(null, { status: 302, headers: { location: "https://files.example.org/final/report.docx" } });
docs["https://files.example.org/final/report.docx"] = () => new Response(ZIP, { status: 200, headers: { "content-type": "application/octet-stream" } });
reset(); r = await paid({ url: "https://cdn.example.com/go" }); j = await r.json(); ok(r.status === 200 && j.name === "report.docx" && docFetches.length === 2, "cross-host redirect followed, type from the final url's extension");
docs["https://cdn.example.com/evil.pdf"] = () => new Response(null, { status: 301, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
reset(); r = await paid({ url: "https://cdn.example.com/evil.pdf" }); j = await r.json(); ok(r.status === 502 && /blocked/.test(j.error) && docFetches.length === 1 && ai.calls.length === 0 && calls.length === 1 && otherFetch.length === 0, "redirect to private IP blocked -> 502, metadata host never fetched");
docs["https://cdn.example.com/evil6.pdf"] = () => new Response(null, { status: 307, headers: { location: "http://[::1]:8080/x" } });
reset(); r = await paid({ url: "https://cdn.example.com/evil6.pdf" }); ok(r.status === 502 && docFetches.length === 1 && otherFetch.length === 0, "redirect to ipv6 loopback blocked");
docs["https://cdn.example.com/evil-local.pdf"] = () => new Response(null, { status: 302, headers: { location: "http://localhost:8787/x.pdf" } });
reset(); r = await paid({ url: "https://cdn.example.com/evil-local.pdf" }); ok(r.status === 502 && docFetches.length === 1 && otherFetch.length === 0, "redirect to localhost blocked");
docs["https://cdn.example.com/evil-ftp.pdf"] = () => new Response(null, { status: 302, headers: { location: "ftp://cdn.example.com/x.pdf" } });
reset(); r = await paid({ url: "https://cdn.example.com/evil-ftp.pdf" }); ok(r.status === 502 && docFetches.length === 1 && otherFetch.length === 0, "redirect to ftp blocked");
docs["https://cdn.example.com/loop.pdf"] = () => new Response(null, { status: 302, headers: { location: "https://cdn.example.com/loop.pdf" } });
reset(); r = await paid({ url: "https://cdn.example.com/loop.pdf" }); j = await r.json(); ok(r.status === 502 && /too many/.test(j.error) && docFetches.length === 4 && ai.calls.length === 0 && calls.length === 1, "redirect loop stops after 3 hops -> 502");
docs["https://cdn.example.com/h1"] = () => new Response(null, { status: 302, headers: { location: "/h2" } });
docs["https://cdn.example.com/h2"] = () => new Response(null, { status: 302, headers: { location: "/h3" } });
docs["https://cdn.example.com/h3"] = () => new Response(null, { status: 302, headers: { location: "/paper.pdf" } });
reset(); r = await paid({ url: "https://cdn.example.com/h1" }); ok(r.status === 200 && docFetches.length === 4, "exactly 3 redirects allowed");
docs["https://cdn.example.com/noloc.pdf"] = () => new Response(null, { status: 302 });
reset(); r = await paid({ url: "https://cdn.example.com/noloc.pdf" }); ok(r.status === 502 && calls.length === 1, "redirect without location -> 502");
docs["http://93.184.216.34/x.pdf"] = docs[DOC];
reset(); r = await paid({ url: "http://93.184.216.34/x.pdf" }); j = await r.json(); ok(r.status === 200 && j.name === "x.pdf", "public IPv4 literal allowed");
docs["https://cdn.example.com/paper.pdf?v=2#frag"] = docs[DOC];
reset(); r = await paid({ url: " https://CDN.example.com/paper.pdf?v=2#frag " }); ok(r.status === 200 && docFetches[0].u === "https://cdn.example.com/paper.pdf?v=2#frag", "url trimmed and normalized");
// url path: converter outcomes and payment outcomes
reset(); ai.result = (d) => ({ name: d.name, mimeType: "application/pdf", format: "error", tokens: 0, data: "corrupt" }); r = await paid({ url: DOC }); j = await r.json(); ok(r.status === 422 && docFetches.length === 1 && calls.length === 1 && !r.headers.get("PAYMENT-RESPONSE"), "url: toMarkdown error -> 422 not settled");
reset(); ai.throw = true; r = await paid({ url: DOC }); ok(r.status === 502 && calls.length === 1, "url: toMarkdown throws -> 502 not settled");
reset(); mode = "badsettle"; r = await paid({ url: DOC }); t = await r.text(); ok(r.status === 402 && t.trim() === "{}" && !t.includes("Hello"), "url: settle fail -> 402 empty body");
reset(); mode = "badverify"; r = await paid({ url: DOC }); ok(r.status === 402 && docFetches.length === 0 && ai.calls.length === 0 && calls.length === 1, "url: verify fail -> no fetch, no convert");
reset(); r = await paid({ url: DOC, max_chars: 1000 }); j = await r.json(); ok(r.status === 200 && j.truncated === false && j.markdown === DEFAULT_MD, "url + max_chars larger than doc -> untouched");

// ---- openapi ----
reset(); r = await W.fetch(new Request(base + "/openapi.json"), env); const o = await r.json();
ok(r.status === 200 && o.openapi === "3.1.0" && o.info.title === "NoJunk Document" && typeof o.info["x-guidance"] === "string" && o.info["x-guidance"].includes("$0.01") && /PDF/.test(o.info["x-guidance"]) && /Office|Word|Excel/.test(o.info["x-guidance"]) && /image/i.test(o.info["x-guidance"]) && /url/.test(o.info["x-guidance"]) && o.servers[0].url === base, "openapi header + x-guidance (PDFs/Office/images by url for a cent)");
ok(Object.keys(o.paths).join() === "/convert" && Object.keys(o.paths["/convert"]).join() === "post", "openapi paths: 1 POST route");
const p = o.paths["/convert"].post;
ok(p["x-payment-info"].price.amount === "0.010000" && p["x-payment-info"].price.mode === "fixed" && p["x-payment-info"].price.currency === "USD" && p["x-payment-info"].protocols[0].x402 && p.responses["402"] && p.responses["200"] && p.responses["400"] && p.responses["413"] && p.responses["415"] && p.responses["422"] && p.responses["502"] && p.requestBody.required === true && p.operationId === "convertDocument", "openapi /convert x-payment-info 0.010000 + 402/413/415/422/502");
const rq = p.requestBody.content["application/json"].schema;
ok(rq.oneOf.length === 2 && rq.properties.url && rq.properties.file_base64 && rq.properties.filename && rq.properties.content_type && rq.properties.max_chars.minimum === 1000 && rq.properties.max_chars.maximum === 400000, "openapi request schema: url-or-base64, filename, content_type, max_chars 1000-400000");
ok(p.responses["200"].headers["PAYMENT-RESPONSE"] && p.responses["200"].content["application/json"].schema.required.join() === "name,mime_type,bytes,markdown,truncated,total_chars,tokens,word_count,pages_hint,source_url,converted_at", "openapi 200 schema lists all output fields");
r = await W.fetch(new Request(base + "/.well-known/openapi.json"), env); ok(r.status === 200, "well-known openapi alias");
ok(!JSON.stringify(o).includes("CDP_API_KEY") && !JSON.stringify(j).includes("CDP"), "no secrets in openapi or responses");

// ---- CDP facilitator path (Ed25519 + EC keys) ----
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const jwk = privateKey.export({ format: "jwk" });
const secret = Buffer.concat([Buffer.from(jwk.d, "base64url"), Buffer.from(jwk.x, "base64url")]).toString("base64");
const envC = { PAY_TO: PAY, AI, CDP_API_KEY_ID: "test-key-id", CDP_API_KEY_SECRET: secret };
reset(); r = await paid({ file_base64: b64(PDF) }, { env: envC }); j = await r.json();
ok(r.status === 200 && calls[0].u === "https://api.cdp.coinbase.com/platform/v2/x402/verify" && calls[1].u.endsWith("/settle") && j.markdown === DEFAULT_MD, "cdp facilitator used");
const checkJwt = (tok, pub, uri, alg) => { const [h, pl, s] = tok.split("."); const H = JSON.parse(Buffer.from(h, "base64url")), P = JSON.parse(Buffer.from(pl, "base64url"));
  const sigOk = alg === "EdDSA" ? nverify(null, Buffer.from(h + "." + pl), pub, Buffer.from(s, "base64url")) : nverify("sha256", Buffer.from(h + "." + pl), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
  return sigOk && H.alg === alg && H.kid === "test-key-id" && H.nonce.length === 32 && P.iss === "cdp" && P.sub === "test-key-id" && P.uris[0] === uri && P.exp - P.nbf === 120; };
ok(checkJwt(calls[0].init.headers.Authorization.slice(7), publicKey, "POST api.cdp.coinbase.com/platform/v2/x402/verify", "EdDSA"), "Ed25519 JWT valid (verify)");
ok(checkJwt(calls[1].init.headers.Authorization.slice(7), publicKey, "POST api.cdp.coinbase.com/platform/v2/x402/settle", "EdDSA"), "Ed25519 JWT valid (settle)");
const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pem = ec.privateKey.export({ type: "sec1", format: "pem" });
reset(); r = await paid({ url: DOC }, { env: { ...envC, CDP_API_KEY_SECRET: pem.replace(/\n/g, "\\n") } });
ok(r.status === 200 && checkJwt(calls[0].init.headers.Authorization.slice(7), ec.publicKey, "POST api.cdp.coinbase.com/platform/v2/x402/verify", "ES256"), "EC SEC1 JWT valid");
const pk8 = ec.privateKey.export({ type: "pkcs8", format: "pem" });
reset(); r = await paid({ file_base64: b64(PDF) }, { env: { ...envC, CDP_API_KEY_SECRET: pk8 } });
ok(r.status === 200 && checkJwt(calls[0].init.headers.Authorization.slice(7), ec.publicKey, "POST api.cdp.coinbase.com/platform/v2/x402/verify", "ES256"), "EC PKCS#8 JWT valid");
r = await W.fetch(new Request(base + "/"), envC); ok((await r.json()).facilitator === "cdp", "info page reports cdp");

ok(otherFetch.length === 0, "no network calls outside the mocks");
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exitCode = fails ? 1 : 0;
