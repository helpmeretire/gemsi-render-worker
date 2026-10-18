// Usage: node status-kv-test.mjs /path/to/worker.js   (copied to .mjs internally)
import { copyFileSync } from "node:fs";
const src = process.argv[2]; const tmp = "/tmp/_status_under_test_" + Date.now() + ".mjs";
copyFileSync(src, tmp);
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const kv = { store: { buildlog: "[]" }, reads: 0, writes: 0,
  async get(k) { this.reads++; return this.store[k] ?? null; }, async put(k, v) { this.writes++; this.store[k] = v; } };
let block = 40_000_000, fetches = 0, rpcLogs = 0;
const payReq = Buffer.from(JSON.stringify({ accepts: [{ payTo: "0x6f762720b8515b7091e6aa69e8361f7b9909233f", amount: "10000" }] })).toString("base64");
globalThis.fetch = async (url, init = {}) => {
  fetches++;
  if (String(url).includes("publicnode")) {
    const b = JSON.parse(init.body);
    if (b.method === "eth_blockNumber") return new Response(JSON.stringify({ result: "0x" + block.toString(16) }));
    if (b.method === "eth_call") return new Response(JSON.stringify({ result: "0x" + (396013).toString(16) }));
    if (b.method === "eth_getLogs") { rpcLogs++; return new Response(JSON.stringify({ result: [] })); }
  }
  const u = new URL(url);
  if (u.pathname !== "/" && (init.method === "POST" || /\/(sirs|check|rate|company|read|verify|price|domain|summarize|transcribe|generate|convert|search|geocode|qr|quote|sentiment|balance)$/.test(u.pathname)))
    return new Response("{}", { status: 402, headers: { "payment-required": payReq } });
  return new Response("{}", { status: 200 });
};
const W = (await import(tmp)).default;
const env = { STATUS: kv }; const ctx = { waitUntil() {} };
// 30 viewers polling: should compute once
for (let i = 0; i < 30; i++) { const r = await W.fetch(new Request("https://x/api/status"), env, ctx); if (i === 0) { const j = await r.json(); ok(j.services.length === 20, "status JSON has all 20 services"); ok(/s-maxage=300/.test(r.headers.get("cache-control")), "api/status cache-control s-maxage=300"); } }
ok(kv.writes === 0, `viewer polls do zero KV writes (writes=${kv.writes})`);
ok(kv.reads <= 2, `30 polls -> <=2 KV reads (reads=${kv.reads})`);
ok(rpcLogs === 0, "viewer path does not scan chain logs");
const perCompute = fetches; ok(perCompute <= 35, `subrequests per status compute = ${perCompute} (free plan cap 50)`);
// cron: 1 day of 5-min runs, chain advances 150 blocks per 5 min
let w0 = kv.writes; for (let i = 0; i < 288; i++) { block += 150; await W.scheduled({}, env, { waitUntil: (p) => p }); await new Promise((r) => setTimeout(r, 0)); }
// scheduled uses waitUntil; ensure promises settle
await new Promise((r) => setTimeout(r, 50));
const cronWrites = kv.writes - w0; ok(cronWrites > 0 && cronWrites <= 100, `cron KV writes per day ~${cronWrites} (was 288)`);
const page = await (await W.fetch(new Request("https://x/"), env, ctx)).text();
ok(page.includes("300000") && !page.includes("setInterval(tick,20000)"), "client polls every 5 min");
ok(!page.includes("?t='+Date.now()"), "no cache-buster on client poll");
console.log(fails ? `${fails} FAILED` : "ALL PASS"); process.exit(fails ? 1 : 0);
