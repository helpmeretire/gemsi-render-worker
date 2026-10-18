// Usage: node test/status-bazaar-test.mjs ./worker.js
// Bazaar listings: cron-only fetch (1 subrequest/run), stored in the existing cron KV value, viewers read it free.
import { copyFileSync } from "node:fs";
const tmp = "/tmp/_status_bz_" + Date.now() + ".mjs"; copyFileSync(process.argv[2], tmp);
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const kv = { store: { buildlog: "[]" }, reads: 0, writes: 0, async get(k) { this.reads++; return this.store[k] ?? null; }, async put(k, v) { this.writes++; this.store[k] = v; } };
let block = 40_000_000, fetches = 0, bzCalls = 0, listed = ["nojunk-token-check/check", "sec-company-snapshot/company"];
const TEST = "0x40834c089e7e62d9e827e366d2be28ec4f769faf";
const payReq = Buffer.from(JSON.stringify({ accepts: [{ payTo: "0x6f762720b8515b7091e6aa69e8361f7b9909233f", amount: "10000" }] })).toString("base64");
globalThis.fetch = async (url, init = {}) => {
  fetches++; const s = String(url);
  if (s.includes("discovery/merchant")) { bzCalls++; return new Response(JSON.stringify({ pagination: { total: listed.length }, resources: listed.map((x) => ({ resource: `https://${x.split("/")[0]}.mick8511.workers.dev/${x.split("/").slice(1).join("/")}`, quality: { lastCalledAt: "2026-10-18T16:21:29.844Z" } })) })); }
  if (s.includes("publicnode")) {
    const b = JSON.parse(init.body);
    if (b.method === "eth_blockNumber") return new Response(JSON.stringify({ result: "0x" + block.toString(16) }));
    if (b.method === "eth_call") return new Response(JSON.stringify({ result: "0x" + (396013).toString(16) }));
    if (b.method === "eth_getLogs") return new Response(JSON.stringify({ result: b.params[0].fromBlock === "0x" + (block - 899).toString(16) ? [{ blockNumber: "0x1", transactionHash: "0xabc", data: "0x" + (10000).toString(16), topics: ["t", "0x" + TEST.slice(2).padStart(64, "0"), "x"] }] : [] }));
    if (b.method === "eth_getBlockByNumber") return new Response(JSON.stringify({ result: { timestamp: "0x6700000" } }));
  }
  const u = new URL(url);
  if (u.pathname !== "/" && !/\/health|\/v1\/models|\/sample/.test(u.pathname)) return new Response("{}", { status: 402, headers: { "payment-required": payReq } });
  return new Response("{}", { status: 200 });
};
const W = (await import(tmp)).default; const env = { STATUS: kv }; const ctx = { waitUntil() {} };
await W.scheduled({}, env, { waitUntil: (p) => p }); await new Promise((r) => setTimeout(r, 50));
ok(bzCalls === 1, "cron fetches Bazaar once per run");
ok(JSON.parse(kv.store.payments).bazaar.by["nojunk-token-check"].length === 1, "Bazaar listings stored in the existing cron KV value");
const f0 = fetches, b0 = bzCalls, w0 = kv.writes;
const j = await (await W.fetch(new Request("https://x/api/status"), env, ctx)).json();
ok(bzCalls === b0, "viewer path makes no Bazaar call");
ok(fetches - f0 <= 29, `subrequests per status compute = ${fetches - f0} (unchanged, <= 29)`);
ok(kv.writes === w0, "viewer path does zero KV writes");
const tc = j.services.find((s) => s.id === "nojunk-token-check"), fx = j.services.find((s) => s.id === "fx-reference-rates");
ok(j.services.length === 20 && tc.facilitator === "Coinbase" && tc.bazaar.listed && tc.bazaar.routes === 1, "listed service: facilitator Coinbase, Bazaar listed");
ok(fx.bazaar.known && !fx.bazaar.listed && fx.facilitator === "not confirmed", "unlisted service: not listed");
ok(j.bazaar.services_listed === 2, "summary counts listed services");
ok(j.wallet.usdc_payments.length === 0 || j.wallet.usdc_payments.every((p) => p.test === (p.from.toLowerCase() === TEST)), "payments from the test wallet are flagged test");
// a day of cron runs: listing set changes once -> at most one extra write
let w1 = kv.writes;
for (let i = 0; i < 288; i++) { block += 150; if (i === 100) listed = [...listed, "fx-reference-rates/rate"]; await W.scheduled({}, env, { waitUntil: (p) => p }); await new Promise((r) => setTimeout(r, 0)); }
await new Promise((r) => setTimeout(r, 50));
ok(kv.writes - w1 <= 101, `cron KV writes per day with Bazaar = ${kv.writes - w1} (free tier 1,000)`);
ok(JSON.parse(kv.store.payments).bazaar.by["fx-reference-rates"], "new listing picked up by cron");
const page = await (await W.fetch(new Request("https://x/"), env, ctx)).text();
ok(page.includes("listed in Coinbase Bazaar") && page.includes("payments: ") && page.includes("not revenue"), "page shows facilitator, Bazaar status, test-wallet label");
console.log(fails ? `${fails} FAILED` : "ALL PASS"); process.exit(fails ? 1 : 0);
