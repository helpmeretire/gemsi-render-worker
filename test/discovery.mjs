// Free samples, /.well-known/x402, /llms.txt and 402 metadata. Usage: node test/discovery.mjs ./worker.js
const W = (await import(process.argv[2])).default;
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
let calls = 0;
globalThis.fetch = async (u) => {
  calls++; u = String(u);
  if (u.toLowerCase().includes("address_security/0x098b")) return new Response(JSON.stringify({ code: 1, result: { stealing_attack: "1", sanctioned: "1", data_source: "test" } }));
  if (u.includes("address_security")) return new Response(JSON.stringify({ code: 1, result: { contract_address: "1" } }));
  if (u.includes("approval_security")) return new Response(JSON.stringify({ code: 1, result: {} }));
  return new Response("{}", { status: 404 });
};
const B = "https://nojunk-address-check.mick8511.workers.dev";
const get = (p) => W.fetch(new Request(B + p), {});
let r = await get("/sample"); let j = await r.json();
ok(r.status === 200 && j.response && j.response.verdict === "NO KNOWN ISSUES" && j.request.body.address, "/sample returns request + report");
r = await get("/sample/flagged"); j = await r.json();
ok(r.status === 200 && j.response.verdict === "DANGER" && /exploiter/i.test(j.note), "/sample/flagged shows a flagged report");
const c1 = calls; for (let i = 0; i < 20; i++) { await get("/sample"); await get("/sample/flagged"); }
ok(calls === c1, `40 more sample hits -> 0 extra upstream calls (got ${calls - c1})`);
j = await (await get("/.well-known/x402")).json();
ok(j.version === 1 && j.resources[0] === B + "/check", "/.well-known/x402 lists /check");
r = await get("/llms.txt"); const t = await r.text();
ok(/text\/plain/.test(r.headers.get("content-type")) && t.includes(B + "/check") && t.includes("/sample") && t.includes("$0.01"), "/llms.txt");
r = await get("/check");
const pr = JSON.parse(Buffer.from(r.headers.get("PAYMENT-REQUIRED"), "base64").toString());
ok(r.status === 402 && pr.resource.description.includes("/sample") && pr.resource.description.length <= 500 && pr.extensions.bazaar.info.output.example.verdict, "402 has description (<=500 chars, for CDP Bazaar) with sample + worked example");
const oa = await (await get("/openapi.json")).json();
ok(oa.paths["/check"].post.requestBody.content["application/json"].example.address && oa.paths["/check"].post.responses[200].content["application/json"].example, "openapi has request/response examples");
console.log(fails ? `${fails} FAILED` : "ALL PASS"); process.exit(fails ? 1 : 0);
