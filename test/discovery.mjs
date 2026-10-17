// /sample caching, /.well-known/x402, /llms.txt and 402 metadata. Usage: node test/discovery.mjs ./worker.js
const W = (await import(process.argv[2])).default;
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
let calls = 0;
globalThis.fetch = async () => { calls++; return new Response("blocked", { status: 403 }); }; // SEC down
const B = "https://sec-company-snapshot.mick8511.workers.dev";
const get = (p) => W.fetch(new Request(B + p), {});
let r = await get("/sample");
ok(r.status === 502, "/sample returns 502 when SEC is down");
const c1 = calls; for (let i = 0; i < 20; i++) await get("/sample");
ok(calls === c1, `failed sample is remembered: 20 retries -> 0 extra SEC calls (got ${calls - c1})`);
let j = await (await get("/.well-known/x402")).json();
ok(j.version === 1 && j.resources[0] === B + "/company", "/.well-known/x402 lists /company");
r = await get("/llms.txt"); const t = await r.text();
ok(/text\/plain/.test(r.headers.get("content-type")) && t.includes(B + "/company") && t.includes("/sample") && t.includes("$0.02"), "/llms.txt");
r = await get("/company");
const pr = JSON.parse(Buffer.from(r.headers.get("PAYMENT-REQUIRED"), "base64").toString());
ok(r.status === 402 && pr.resource.description.includes("/sample") && pr.extensions.bazaar.info.output.example.ticker === "AAPL", "402 has description with sample + worked example");
const oa = await (await get("/openapi.json")).json();
ok(oa.paths["/company"].post.requestBody.content["application/json"].example.ticker && oa.paths["/company"].post.responses[200].content["application/json"].example, "openapi has request/response examples");
console.log(fails ? `${fails} FAILED` : "ALL PASS"); process.exit(fails ? 1 : 0);
