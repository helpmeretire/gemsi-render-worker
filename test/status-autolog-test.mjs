// Usage: node test/status-autolog-test.mjs ./worker.js
// Build floor updates itself: the cron adds a "money" entry for new outside payments (not test-wallet ones) and a
// milestone when Bazaar's listed count changes, stored in the existing cron KV value; no extra writes; page links full addresses.
import { copyFileSync } from "node:fs";
const tmp = "/tmp/_status_autolog_" + Date.now() + ".mjs"; copyFileSync(process.argv[2], tmp);
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const TEST = "0x40834c089e7e62d9e827e366d2be28ec4f769faf", A1 = "0xec2abd3eda89bed90124736e317e847d5fb6d034", A2 = "0xc9c7b38c0942914fc8ea12063bc92dcd3b581670";
const kv = { store: { buildlog: JSON.stringify([{ t: "2026-10-15T22:39:29.869Z", kind: "milestone", text: "Build floor opened." }]) }, reads: 0, writes: 0, async get(k) { this.reads++; return this.store[k] ?? null; }, async put(k, v) { this.writes++; this.store[k] = v; } };
let block = 40_000_000, listed = 2, pending = [], fetches = 0, n = 0;
const payReq = Buffer.from(JSON.stringify({ accepts: [{ payTo: "0x6f762720b8515b7091e6aa69e8361f7b9909233f", amount: "10000" }] })).toString("base64");
const topic = (a) => "0x" + a.slice(2).padStart(64, "0");
globalThis.fetch = async (url, init = {}) => {
  fetches++; const s = String(url);
  if (s.includes("discovery/merchant")) return new Response(JSON.stringify({ pagination: { total: listed }, resources: Array.from({ length: listed }, (_, i) => ({ resource: `https://nojunk-qr.mick8511.workers.dev/r${i}` })) }));
  if (s.includes("publicnode")) {
    const b = JSON.parse(init.body);
    if (b.method === "eth_blockNumber") return new Response(JSON.stringify({ result: "0x" + block.toString(16) }));
    if (b.method === "eth_call") return new Response(JSON.stringify({ result: "0x0" }));
    if (b.method === "eth_getLogs") { const r = pending.map((p) => ({ blockNumber: "0x" + (block - 1 - (p.dblk || 0)).toString(16), transactionHash: "0x" + (++n).toString(16).padStart(64, "0"), data: "0x" + p.amt.toString(16), topics: ["t", topic(p.from), "x"] })); pending = []; return new Response(JSON.stringify({ result: r })); }
    if (b.method === "eth_getBlockByNumber") return new Response(JSON.stringify({ result: { timestamp: "0x" + Math.floor(Date.parse("2026-10-19T12:00:00Z") / 1000).toString(16) } }));
  }
  const u = new URL(url);
  if (u.pathname !== "/" && !/\/health|\/v1\/models|\/sample/.test(u.pathname)) return new Response("{}", { status: 402, headers: { "payment-required": payReq } });
  return new Response("{}", { status: 200 });
};
const W = (await import(tmp)).default; const env = { STATUS: kv }; const ctx = { waitUntil() {} };
const cron = async () => { block += 150; let p; await W.scheduled({}, env, { waitUntil: (x) => { p = x; } }); await p; };
const state = () => JSON.parse(kv.store.payments);
await cron();
ok(state().autolog.length === 0, "first run (no baseline): nothing logged");
pending = [{ from: TEST, amt: 10000 }]; await cron()
ok(state().items.length === 1 && state().autolog.length === 0, "test-wallet payment is not logged as money");
pending = [{ from: A1, amt: 1000 }, { from: A1, amt: 2000 }, { from: A2, amt: 1000 }]; await cron();
const e = state().autolog.at(-1);
ok(e && e.kind === "money" && /^3 new payments, \$0\.004 USDC, from 0xec2a…d034, 0xc9c7…1670\.$/.test(e.text), "outside payments -> one money entry: " + (e && e.text));
const w0 = kv.writes; for (let i = 0; i < 288; i++) await cron();
ok(state().autolog.length === 1, "quiet day: no new entries");
ok(kv.writes - w0 <= 100, `quiet day cron KV writes = ${kv.writes - w0} (free tier 1,000)`);
listed = 3; const w1 = kv.writes; await cron();
ok(state().autolog.at(-1).text === "Coinbase Bazaar now lists 3 paid routes (was 2).", "Bazaar count change -> milestone entry");
ok(kv.writes - w1 === 1, "listing change costs exactly one KV write");
await cron(); ok(state().autolog.length === 2, "unchanged Bazaar count is not re-logged");
const f0 = fetches, w2 = kv.writes;
const j = await (await W.fetch(new Request("https://x/api/status"), env, ctx)).json();
ok(fetches - f0 <= 29, `viewer subrequests = ${fetches - f0} (<= 29)`); ok(kv.writes === w2, "viewer path: zero KV writes");
ok(j.buildlog[0].text.startsWith("Coinbase Bazaar now lists 3") && j.buildlog.at(-1).text === "Build floor opened." && j.buildlog.some((x) => x.kind === "money"), "buildlog merges hand-written + auto entries, newest first");
ok(!("autolog" in j.wallet), "autolog not duplicated in wallet JSON");
ok(j.wallet.totals.revenue_count === 3 && j.wallet.totals.revenue_usd === 0.004 && j.wallet.totals.payers === 2 && j.wallet.totals.test_count === 1 && j.wallet.totals.test_usd === 0.01, "totals: revenue excludes test wallet");
ok(j.wallet.usdc_payments.some((p) => p.from === A1 && !p.test) && j.wallet.usdc_payments.some((p) => p.test), "full payer address in payments, test flagged");
const page = await (await W.fetch(new Request("https://x/"), env, ctx)).text();
ok(page.includes("https://basescan.org/address/") && page.includes("https://basescan.org/tx/") && page.includes("break-all") && page.includes("test wallet, not revenue"), "page links full address + tx to basescan, wraps on phones, labels test");
// burst: 40 payments in 40 different blocks in one run stays far under 50 subrequests
pending = Array.from({ length: 40 }, (_, i) => ({ from: A2, amt: 1000, dblk: i })); const f1 = fetches; await cron();
ok(fetches - f1 <= 20, `40-payment burst: cron subrequests = ${fetches - f1} (cap 50)`);
ok(state().autolog.at(-1).text.startsWith("40 new payments, $0.040 USDC"), "burst logged as one entry");
const ws = state().items.filter((x) => x.usd === 0.001 && x.from === A2).map((x) => Date.parse(x.when)); ok(ws.every((t) => Number.isFinite(t)), "burst timestamps valid");
console.log(fails ? `${fails} FAILED` : "ALL PASS"); process.exit(fails ? 1 : 0);
