// x402 Services Status (nojunk-status Worker) — live build floor + service monitor for Mick's x402 services.
// Bindings: KV namespace "STATUS" (key "buildlog" = JSON array of {t, kind, text, service?}).
const WALLET = "0x6f762720b8515b7091e6aa69e8361f7b9909233f";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const BASE = (n) => `https://${n}.mick8511.workers.dev`;
// Our own test-buyer wallet (Bazaar indexing / keep-alive payments). Shown as "test", never as agent revenue.
const TEST_WALLETS = ["0x40834c089e7e62d9e827e366d2be28ec4f769faf"];
// Coinbase Bazaar listings for the wallet: fetched only by the cron (1 subrequest per run) and stored in the
// existing cron-written KV value, so viewers read it for free. A Bazaar listing is created only by a payment
// settled through the Coinbase (CDP) facilitator, so a listed route proves Coinbase processes its payments.
const BAZAAR_URL = `https://api.cdp.coinbase.com/platform/v2/x402/discovery/merchant?payTo=${WALLET}&limit=100`;
async function fetchBazaar() {
  const r = await timed(BAZAAR_URL);
  const j = r.ok && r.status === 200 ? tryJson(r.text) : null;
  if (!j || !Array.isArray(j.resources)) return null;
  const by = {};
  for (const x of j.resources) {
    const u = typeof x.resource === "string" ? x.resource : x.resource && x.resource.url;
    const m = /^https:\/\/([a-z0-9-]+)\.mick8511\.workers\.dev(\/[^?#]*)/.exec(u || "");
    if (!m) continue;
    (by[m[1]] = by[m[1]] || []).push({ path: m[2], last: (x.quality && x.quality.lastCalledAt) || x.lastUpdated || null });
  }
  for (const k of Object.keys(by)) by[k].sort((a, b) => (a.path < b.path ? -1 : 1));
  return { checked_at: new Date().toISOString(), total: (j.pagination && j.pagination.total) || j.resources.length, by };
}
const bazaarKey = (b) => (b ? JSON.stringify(Object.keys(b.by).sort().map((k) => [k, b.by[k].map((x) => x.path)])) : "");
const SERVICES = [
  { id: "florida-sirs-check", name: "Florida Condo SIRS Check", what: "Has a Florida condo filed its structural reserve study?", route: "/sirs", price: "$0.01", probe: "/" },
  { id: "nojunk-token-check", name: "Token Check", what: "Is this crypto token junk? Honeypot, taxes, owner powers, holders.", route: "/check", price: "$0.01", probe: "/health/data", demo: "/health/data", demoLabel: "Data sources" },
  { id: "nojunk-address-check", name: "Address Check", what: "Has this wallet been reported for phishing, theft or scams?", route: "/check", price: "$0.01", probe: "/" },
  { id: "fx-reference-rates", name: "FX Reference Rates", what: "Currency conversion from ECB reference rates.", route: "/rate", price: "$0.003", probe: "/" },
  { id: "sec-company-snapshot", name: "SEC Company Snapshot", what: "Revenue, income, balance sheet for any US-listed company.", route: "/company", price: "$0.02", probe: "/", demo: "/sample", demoLabel: "Live sample (AAPL)" },
  { id: "nojunk-web-read", name: "Web Page Reader", what: "Any web page turned into clean text and markdown.", route: "/read", price: "$0.002", probe: "/" },
  { id: "nojunk-email-check", name: "Email Check", what: "Is this email real? Syntax, mail server, disposable, typos.", route: "/verify", price: "$0.001", probe: "/" },
  { id: "nojunk-crypto-price", name: "Crypto Price", what: "USD price and market data for 270+ coins or any on-chain token.", route: "/price", price: "$0.001", probe: "/health/data", demo: "/health/data", demoLabel: "Data source" },
  { id: "nojunk-domain-intel", name: "Domain Intel", what: "Domain age, registrar, DNS, email security, risk score.", route: "/domain", price: "$0.003", probe: "/" },
  { id: "nojunk-ai-text", name: "AI Text Tools", what: "Summarize, extract facts, classify text with a 70B model.", route: "/summarize", price: "$0.005", probe: "/" },
  { id: "nojunk-speech", name: "Speech", what: "Transcribe audio, speak text, translate 100 languages.", route: "/transcribe", price: "$0.02", probe: "/" },
  { id: "nojunk-image", name: "Image", what: "Generate a picture from text; describe any image.", route: "/generate", price: "$0.01", probe: "/" },
  { id: "nojunk-document", name: "Document Converter", what: "PDF, Word, Excel or image file turned into text.", route: "/convert", price: "$0.01", probe: "/" },
  { id: "nojunk-web-search", name: "Web Search", what: "Ten live web results for any query.", route: "/search", price: "$0.002", probe: "/health/search", demo: "/health/search", demoLabel: "Live search check" },
  { id: "nojunk-geo", name: "Geocoding & Weather", what: "Address to coordinates and back; 7-day weather for any place.", route: "/geocode", price: "$0.002", probe: "/health/data", demo: "/health/data", demoLabel: "Data sources" },
  { id: "nojunk-qr", name: "QR Code Generator", what: "QR codes as SVG, PNG or data; single or batch of 25.", route: "/qr", price: "$0.001", probe: "/", demo: "/sample.svg", demoLabel: "Sample QR" },
  { id: "nojunk-llm", name: "AI Chat (LLM)", what: "OpenAI-compatible 70B chat model and embeddings.", route: "/v1/chat/completions", price: "$0.005", probe: "/v1/models", demo: "/v1/models", demoLabel: "Models offered" },
  { id: "nojunk-stocks", name: "Stock Quotes", what: "Stock, ETF, index, FX and commodity quotes, history and stats.", route: "/quote", price: "$0.001", probe: "/" },
  { id: "nojunk-moderate", name: "Text Moderation", what: "Sentiment, safety, rerank, PII detection and language ID.", route: "/sentiment", price: "$0.001", probe: "/" },
  { id: "nojunk-chain", name: "Blockchain Data", what: "Wallet balances, gas, transactions and blocks on 9 chains.", route: "/balance", price: "$0.002", probe: "/" },
];
const SITE = { id: "nojunkcrypto.com", name: "nojunkcrypto.com (free checkers)", url: "https://nojunkcrypto.com/" };

const timed = async (url, init = {}) => {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal, headers: { accept: "application/json, text/html", "user-agent": "NoJunk Status/1.0 (+https://nojunkcrypto.com)", ...(init.headers || {}) } });
    const text = await r.text();
    return { ok: true, status: r.status, ms: Date.now() - t0, text, headers: r.headers };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, text: "", error: String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
};
const tryJson = (t) => { try { return JSON.parse(t); } catch { return null; } };

function summarizeDemo(svc, j) {
  if (!j) return null;
  if (svc.id === "sec-company-snapshot") return j.company ? `${j.company} (${j.ticker}) FY${j.latest_fiscal_year && j.latest_fiscal_year.fiscal_year} revenue $${((j.latest_fiscal_year && j.latest_fiscal_year.revenue) / 1e9).toFixed(1)}B` : null;
  if (svc.id === "nojunk-web-search") return `${j.status}: ${j.result_count} results in ${j.ms} ms`;
  if (svc.id === "nojunk-llm") return Array.isArray(j.data) ? j.data.map((m) => m.id).join(", ") : null;
  if (svc.id === "nojunk-crypto-price") return `CoinGecko key ${j.coingecko_key_set ? "set" : "missing"}, status ${j.coingecko_status}`;
  if (svc.id === "nojunk-geo") return `Nominatim ${j.nominatim_status}, Open-Meteo ${j.open_meteo_status} (${j.ms} ms)`;
  if (svc.id === "nojunk-token-check") return `CoinGecko ${j.coingecko_status}, GoPlus ${j.goplus_code === 1 ? "ok" : "throttled (backup: Honeypot.is " + j.honeypot_is_status + ", RugCheck " + j.rugcheck_status + ")"}`;
  return null;
}

// Subrequest budget (Workers Free: 50 per invocation). With 20 services we make at most 2 calls each:
// when the info probe is just "/", the paywall call doubles as the liveness check (a 402 from the
// Worker proves it is up), so those services cost 1 call; a demo URL equal to the probe is reused.
// Total today: 20 paywall + 5 probes (demo reused) + 2 separate demos + 1 site + 1 RPC = 29.
async function checkService(svc) {
  const payOnly = svc.probe === "/";
  let [info, pay, demo] = await Promise.all([
    payOnly ? Promise.resolve(null) : timed(BASE(svc.id) + svc.probe),
    timed(BASE(svc.id) + svc.route, { method: svc.id === "nojunk-llm" ? "POST" : "GET" }),
    svc.demo && svc.demo !== svc.probe ? timed(BASE(svc.id) + svc.demo) : Promise.resolve(null),
  ]);
  if (svc.demo && svc.demo === svc.probe) demo = info; // same URL: reuse, no second upstream call
  if (payOnly) info = { ok: pay.ok, status: pay.ok && pay.status === 402 ? 200 : pay.status, ms: pay.ms };
  let paywall = null;
  if (pay.ok && pay.status === 402) {
    const h = pay.headers.get("payment-required");
    try { const d = JSON.parse(atob(h)); const a = d.accepts && d.accepts[0]; paywall = { ok: a && a.payTo && a.payTo.toLowerCase() === WALLET, amount: a ? "$" + (Number(a.amount) / 1e6).toFixed(3).replace(/0+$/, "").replace(/\.$/, "") : null }; } catch { paywall = { ok: false }; }
  }
  const up = info.ok && info.status >= 200 && info.status < 400;
  return {
    id: svc.id, name: svc.name, what: svc.what, price: svc.price, url: BASE(svc.id),
    up, ms: info.ms, status: info.status,
    paywall: pay.ok && pay.status === 402 ? (paywall && paywall.ok ? "up, pays your wallet" : "up (wallet mismatch!)") : `NOT 402 (got ${pay.status})`,
    paywall_ok: pay.ok && pay.status === 402 && paywall && paywall.ok,
    demo: svc.demo ? { label: svc.demoLabel, ok: demo && demo.ok && demo.status === 200, ms: demo && demo.ms, text: svc.id === "nojunk-qr" ? (demo && demo.status === 200 && demo.text.startsWith("<svg") ? `rendered ${demo.text.length} bytes of SVG in ${demo.ms} ms` : null) : summarizeDemo(svc, demo && tryJson(demo.text)) } : null,
  };
}

const RPC = "https://base-rpc.publicnode.com";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
async function rpc(method, params) {
  const r = await timed(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = r.ok ? tryJson(r.text) : null;
  if (!j || j.error) throw new Error((j && j.error && j.error.message) || `rpc ${method} failed (${r.status})`);
  return j.result;
}
const hex = (n) => "0x" + n.toString(16);
// Scans the chain for USDC Transfer events to the wallet, keeping a cursor + found payments in KV.
// KV budget (free tier: 1,000 writes/day): only the cron (scan=true) scans and writes, and it writes
// only when a new payment appears or the cursor moved >= CURSOR_WRITE_EVERY blocks (~15 min on Base).
// Page viewers (scan=false) do one KV read and never write.
const CURSOR_WRITE_EVERY = 450;
async function wallet(env, { scan = false } = {}) {
  const out = { ok: false, usdc_balance: 0, usdc_payments: [], payments_count: 0, last_any_transfer: null, scanned_to_block: null, note: null };
  try {
    const data = "0x70a08231" + WALLET.slice(2).padStart(64, "0");
    const bal = await rpc("eth_call", [{ to: USDC, data }, "latest"]);
    out.usdc_balance = Number(BigInt(bal)) / 1e6;
  } catch (e) { out.note = "balance: " + e.message; }
  try {
    const saved = env.STATUS ? tryJson((await env.STATUS.get("payments")) || "") : null;
    if (!scan) {
      const items = saved && Array.isArray(saved.items) ? saved.items : [];
      out.ok = true; out.scanned_to_block = saved && saved.cursor ? saved.cursor : null;
      out.usdc_payments = items.slice(0, 10); out.payments_count = items.length;
      out.last_any_transfer = items[0] ? { when: items[0].when, token: "USDC" } : null;
      out.bazaar = saved && saved.bazaar ? saved.bazaar : null;
      return out;
    }
    const latest = Number(BigInt(await rpc("eth_blockNumber", [])));
    // First run: start about 3 days before now (Base makes a block every 2 s).
    // The public node only serves recent blocks, so the cursor stays near the head; a 5-minute cron keeps it moving.
    const MAX_BEHIND = 900, CHUNK = 450;
    let cursor = saved && saved.cursor ? saved.cursor : latest - MAX_BEHIND;
    let items = saved && Array.isArray(saved.items) ? saved.items : [];
    if (cursor < latest - MAX_BEHIND) { out.note = `gap: blocks ${cursor + 1}-${latest - MAX_BEHIND} not scanned`; cursor = latest - MAX_BEHIND; }
    let steps = 0;
    while (cursor < latest && steps < 2) {
      const to = Math.min(cursor + CHUNK, latest);
      const logs = await rpc("eth_getLogs", [{ address: USDC, fromBlock: hex(cursor + 1), toBlock: hex(to), topics: [TRANSFER_TOPIC, null, "0x" + WALLET.slice(2).padStart(64, "0")] }]);
      for (const l of logs) {
        const blk = await rpc("eth_getBlockByNumber", [l.blockNumber, false]);
        items.push({ when: new Date(Number(BigInt(blk.timestamp)) * 1000).toISOString(), usd: Number(BigInt(l.data)) / 1e6, from: "0x" + l.topics[1].slice(26), tx: l.transactionHash, block: Number(BigInt(l.blockNumber)) });
      }
      cursor = to; steps++;
    }
    items = items.filter((x, i, a) => a.findIndex((y) => y.tx === x.tx) === i).sort((a, b) => b.block - a.block).slice(0, 200);
    const prevLen = saved && Array.isArray(saved.items) ? saved.items.length : -1;
    const moved = !saved || !saved.cursor || cursor - saved.cursor >= CURSOR_WRITE_EVERY;
    const fresh = await fetchBazaar().catch(() => null);
    const bazaar = fresh || (saved && saved.bazaar) || null;
    const bzChanged = !!fresh && bazaarKey(fresh) !== bazaarKey(saved && saved.bazaar);
    if (env.STATUS && (prevLen !== items.length || moved || bzChanged)) await env.STATUS.put("payments", JSON.stringify({ cursor, items, bazaar }));
    out.bazaar = bazaar;
    out.ok = true; out.scanned_to_block = cursor; out.usdc_payments = items.slice(0, 10); out.payments_count = items.length;
    out.last_any_transfer = items[0] ? { when: items[0].when, token: "USDC" } : null;
  } catch (e) { out.note = (out.note ? out.note + "; " : "") + "scan: " + e.message; }
  return out;
}

async function status(env) {
  const [services, site, w, log] = await Promise.all([
    Promise.all(SERVICES.map(checkService)),
    timed(SITE.url),
    wallet(env, { scan: false }),
    env.STATUS ? env.STATUS.get("buildlog").then((v) => tryJson(v || "[]") || []) : Promise.resolve([]),
  ]);
  const bz = w && w.bazaar;
  for (const s of services) {
    const routes = bz && bz.by ? bz.by[s.id] || [] : null;
    s.bazaar = routes === null ? { known: false } : { known: true, listed: routes.length > 0, routes: routes.length, paths: routes.map((x) => x.path), last_paid: routes.reduce((m, x) => (x.last && (!m || x.last > m) ? x.last : m), null) };
    s.facilitator = routes && routes.length ? "Coinbase" : routes === null ? "unknown" : "not confirmed";
  }
  for (const p of (w && w.usdc_payments) || []) p.test = TEST_WALLETS.includes(String(p.from).toLowerCase());
  return { checked_at: new Date().toISOString(), services, site: { ...SITE, up: site.ok && site.status === 200, ms: site.ms }, wallet: w,
    bazaar: bz ? { checked_at: bz.checked_at, total_listed: bz.total, services_listed: services.filter((s) => s.bazaar.listed).length } : null, buildlog: log.slice(-60).reverse() };
}

// Status is computed at most once per STATUS_TTL_S per isolate (and shared via caches.default on the
// custom domain), so N open tabs or bots cost ~1 computation per 5 min instead of 1 per poll each.
// No KV writes on this path. caches.default is a no-op on *.workers.dev, so the in-memory copy is the fallback.
const STATUS_TTL_S = 300;
const CACHE_KEY = "https://status-cache.invalid/api/status/v2";
let mem = null; // { at, body }
let inflight = null;
async function cachedStatus(env, ctx) {
  const now = Date.now();
  if (mem && now - mem.at < STATUS_TTL_S * 1000) return mem.body;
  const cache = typeof caches !== "undefined" && caches && caches.default ? caches.default : null;
  if (cache) {
    try {
      const hit = await cache.match(CACHE_KEY);
      if (hit) { const body = await hit.text(); const j = tryJson(body); if (j && now - Date.parse(j.checked_at) < STATUS_TTL_S * 1000) { mem = { at: Date.parse(j.checked_at), body }; return body; } }
    } catch {}
  }
  if (!inflight) {
    inflight = status(env).then((s) => {
      const body = JSON.stringify(s);
      mem = { at: Date.now(), body };
      if (cache) {
        const put = cache.put(CACHE_KEY, new Response(body, { headers: { "content-type": "application/json", "cache-control": `public, max-age=${STATUS_TTL_S}` } })).catch(() => {});
        if (ctx && ctx.waitUntil) ctx.waitUntil(put);
      }
      return body;
    }).finally(() => { inflight = null; });
  }
  return inflight;
}

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>x402 Services Status</title>
<meta name="robots" content="noindex">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%2313213C'/%3E%3Cpath d='M9 16.5l4.5 4.5L23 11' stroke='%23FFD23F' stroke-width='3.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..900&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
:root{--ink:#13213C;--ink2:#4A5568;--line:#D5DAE1;--paper:#F6F4EC;--panel:#fff;--gold:#FFD23F;--gold2:#8A6A00;--green:#16663A;--greenbg:#E4F2EA;--red:#B01E33;--redbg:#FBE9EC;--coin:#2775CA}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:'Archivo',system-ui,sans-serif;font-variant-numeric:tabular-nums;padding:0 16px 40px}
.wrap{max-width:1180px;margin:0 auto}
header{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;padding:18px 0 10px;border-bottom:3px solid var(--ink)}
.brand{display:flex;align-items:center;gap:10px;font-stretch:72%;font-weight:850;font-size:26px}
.live{display:inline-flex;align-items:center;gap:8px;font-family:'JetBrains Mono',monospace;font-size:13px;color:var(--ink2)}
.dot{width:10px;height:10px;border-radius:50%;background:var(--green);box-shadow:0 0 0 0 rgba(22,102,58,.5);animation:pulse 1.6s infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(22,102,58,.5)}70%{box-shadow:0 0 0 10px rgba(22,102,58,0)}100%{box-shadow:0 0 0 0 rgba(22,102,58,0)}}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:18px 0}
.tile{background:var(--panel);border:2px solid var(--ink);border-radius:10px;padding:14px}
.tile b{display:block;font-stretch:78%;font-weight:850;font-size:30px;line-height:1}
.tile span{font-size:13px;color:var(--ink2)}
h2{font-stretch:74%;font-weight:850;font-size:26px;margin:26px 0 10px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}
@media(max-width:860px){.grid{grid-template-columns:1fr}}
.log{background:var(--ink);color:#fff;border-radius:10px;padding:14px 16px;font-family:'JetBrains Mono',monospace;font-size:13px;line-height:1.55;max-height:520px;overflow:auto}
.log div{display:flex;gap:10px;align-items:baseline;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.08)}
.log .t{color:#A9B4C7;flex:none;width:118px}
.log .k-milestone{color:var(--gold);font-weight:700}.log .k-deploy{color:#7CC6FF}.log .k-test{color:#7CE39B}.log .k-build{color:#fff}.log .k-fail{color:#FF8A9B}.log .k-money{color:var(--gold);font-weight:700}
.svc{background:var(--panel);border:2px solid var(--ink);border-radius:10px;padding:12px 14px;display:grid;grid-template-columns:auto 1fr auto;gap:6px 12px;align-items:center;margin-bottom:10px}
.svc .st{width:14px;height:14px;border-radius:50%;background:var(--line)}
.svc .st.up{background:var(--green)}.svc .st.down{background:var(--red)}
.svc .nm{font-stretch:80%;font-weight:800;font-size:17px}
.svc .pr{font-family:'JetBrains Mono',monospace;font-size:13px;color:var(--gold2);font-weight:700}
.svc .what{grid-column:2/4;font-size:13px;color:var(--ink2)}
.svc .meta{grid-column:2/4;display:flex;flex-wrap:wrap;gap:6px 14px;font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--ink2)}
.svc .meta .ok{color:var(--green)}.svc .meta .bad{color:var(--red)}
.svc .demo{grid-column:2/4;font-size:13px;background:var(--greenbg);border-radius:6px;padding:6px 10px;color:var(--green)}
.svc .demo.bad{background:var(--redbg);color:var(--red)}
.pay{font-family:'JetBrains Mono',monospace;font-size:13px}
.pay .big{font-size:34px;font-weight:700;color:var(--coin)}
.muted{color:var(--ink2);font-size:13px}
</style></head><body><div class="wrap">
<header><div class="brand"><svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="6" fill="#13213C"/><path d="M9 16.5l4.5 4.5L23 11" stroke="#FFD23F" stroke-width="3.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>x402 Services Status</div><div class="live"><span class="dot"></span><span id="upd">checking…</span></div></header>
<div class="tiles"><div class="tile"><b id="n-up">–</b><span>services up</span></div><div class="tile"><b id="n-pay">–</b><span>paywalls live, paying your wallet</span></div><div class="tile"><b id="n-usdc">–</b><span>USDC received from agents</span></div><div class="tile"><b id="n-bal">–</b><span>USDC in wallet</span></div><div class="tile"><b id="n-ms">–</b><span>avg response (ms)</span></div><div class="tile"><b id="n-bz">–</b><span>listed in Coinbase Bazaar</span></div></div>
<div class="grid">
<section><h2>Build floor <span class="muted">(what I'm doing, newest first)</span></h2><div class="log" id="log"></div>
<h2>Money</h2><div class="tile pay"><div class="big" id="usdc">$0.000</div><div id="pays" class="muted">No agent payments yet.</div></div></section>
<section><h2>Services running <span class="muted">(checked from Cloudflare every 5 min)</span></h2><div id="svcs"></div></section>
</div>
<p class="muted" id="site"></p>
</div>
<script>
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(m){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]})}
function fmtT(t){var d=new Date(t);return d.toLocaleDateString(undefined,{month:'short',day:'numeric'})+' '+d.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'})}
var lastTick=0;
async function tick(){ lastTick=Date.now();
 try{
  var r=await fetch('/api/status'); var j=await r.json();
  var up=j.services.filter(function(s){return s.up}).length, pay=j.services.filter(function(s){return s.paywall_ok}).length;
  var ms=Math.round(j.services.reduce(function(a,s){return a+s.ms},0)/j.services.length);
  document.getElementById('n-up').textContent=up+'/'+j.services.length; document.getElementById('n-pay').textContent=pay+'/'+j.services.length;
  document.getElementById('n-usdc').textContent='$'+j.wallet.usdc_payments.reduce(function(a,p){return a+(p.test?0:p.usd)},0).toFixed(3); document.getElementById('n-bal').textContent='$'+j.wallet.usdc_balance.toFixed(2); document.getElementById('n-ms').textContent=ms;
  document.getElementById('n-bz').textContent=j.bazaar?j.bazaar.services_listed+'/'+j.services.length:'–';
  document.getElementById('usdc').textContent='$'+j.wallet.usdc_payments.reduce(function(a,p){return a+(p.test?0:p.usd)},0).toFixed(3);
  document.getElementById('pays').innerHTML=j.wallet.usdc_payments.length?j.wallet.usdc_payments.map(function(p){return '<div>'+esc(fmtT(p.when))+' · $'+p.usd.toFixed(4)+' from '+esc(p.from.slice(0,10))+'…'+(p.test?' (our test wallet, not revenue)':'')+'</div>'}).join(''):'No agent payments yet. Watching the Base blockchain for USDC sent to your wallet (scanned to block '+(j.wallet.scanned_to_block||'?')+').'+(j.wallet.note?' Note: '+esc(j.wallet.note):'');
  document.getElementById('log').innerHTML=j.buildlog.map(function(e){return '<div><span class="t">'+esc(fmtT(e.t))+'</span><span class="k-'+esc(e.kind||'build')+'">'+esc(e.text)+'</span></div>'}).join('')||'<div>No entries yet.</div>';
  document.getElementById('svcs').innerHTML=j.services.map(function(s){return '<div class="svc"><span class="st '+(s.up?'up':'down')+'"></span><span class="nm"><a href="'+esc(s.url)+'" style="color:inherit;text-decoration:none">'+esc(s.name)+'</a></span><span class="pr">'+esc(s.price)+'</span><span class="what">'+esc(s.what)+'</span><span class="meta"><span class="'+(s.up?'ok':'bad')+'">'+(s.up?'UP':'DOWN')+' · '+s.ms+' ms</span><span class="'+(s.paywall_ok?'ok':'bad')+'">paywall '+esc(s.paywall)+'</span><span class="'+(s.facilitator==='Coinbase'?'ok':'')+'">payments: '+esc(s.facilitator==='Coinbase'?'Coinbase':'Coinbase '+(s.facilitator||'unknown'))+'</span><span class="'+(s.bazaar&&s.bazaar.listed?'ok':'bad')+'">Bazaar: '+(!s.bazaar||!s.bazaar.known?'unknown':s.bazaar.listed?'listed ('+s.bazaar.routes+' route'+(s.bazaar.routes>1?'s':'')+')':'not listed')+'</span></span>'+(s.demo?'<span class="demo '+(s.demo.ok?'':'bad')+'">'+esc(s.demo.label)+': '+esc(s.demo.text||(s.demo.ok?'ok':'unavailable'))+'</span>':'')+'</div>'}).join('');
  document.getElementById('site').textContent='Free site '+j.site.name+': '+(j.site.up?'up':'down')+' ('+j.site.ms+' ms). Last check '+new Date(j.checked_at).toLocaleTimeString()+'.';
  document.getElementById('upd').textContent='live · updated '+new Date().toLocaleTimeString();
 }catch(e){document.getElementById('upd').textContent='check failed, retrying';}
}
tick(); setInterval(function(){ if(!document.hidden) tick(); },300000);
document.addEventListener('visibilitychange',function(){ if(!document.hidden && Date.now()-lastTick>300000) tick(); });
</script></body></html>`;

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(wallet(env, { scan: true })); },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/status") {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("Use GET", { status: 405 });
      const body = await cachedStatus(env, ctx);
      return new Response(body, { headers: { "content-type": "application/json", "cache-control": `public, max-age=60, s-maxage=${STATUS_TTL_S}`, "access-control-allow-origin": "*" } });
    }
    if (url.pathname === "/" || url.pathname === "/status") return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" } });
    return new Response("Not found", { status: 404 });
  },
};
