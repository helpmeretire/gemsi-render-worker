// NoJunk Status — live build floor + service monitor for Mick's x402 services.
// Bindings: KV namespace "STATUS" (key "buildlog" = JSON array of {t, kind, text, service?}).
const WALLET = "0x6f762720b8515b7091e6aa69e8361f7b9909233f";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const BASE = (n) => `https://${n}.mick8511.workers.dev`;
const SERVICES = [
  { id: "florida-sirs-check", name: "Florida Condo SIRS Check", what: "Has a Florida condo filed its structural reserve study?", route: "/sirs", price: "$0.01", probe: "/" },
  { id: "nojunk-token-check", name: "NoJunk Token Check", what: "Is this crypto token junk? Honeypot, taxes, owner powers, holders.", route: "/check", price: "$0.01", probe: "/health/data", demo: "/health/data", demoLabel: "Data sources" },
  { id: "nojunk-address-check", name: "NoJunk Address Check", what: "Has this wallet been reported for phishing, theft or scams?", route: "/check", price: "$0.01", probe: "/" },
  { id: "fx-reference-rates", name: "FX Reference Rates", what: "Currency conversion from ECB reference rates.", route: "/rate", price: "$0.003", probe: "/" },
  { id: "sec-company-snapshot", name: "SEC Company Snapshot", what: "Revenue, income, balance sheet for any US-listed company.", route: "/company", price: "$0.02", probe: "/", demo: "/sample", demoLabel: "Live sample (AAPL)" },
  { id: "nojunk-web-read", name: "NoJunk Web Read", what: "Any web page turned into clean text and markdown.", route: "/read", price: "$0.002", probe: "/" },
  { id: "nojunk-email-check", name: "NoJunk Email Check", what: "Is this email real? Syntax, mail server, disposable, typos.", route: "/verify", price: "$0.001", probe: "/" },
  { id: "nojunk-crypto-price", name: "NoJunk Crypto Price", what: "USD price and market data for 270+ coins or any on-chain token.", route: "/price", price: "$0.001", probe: "/health/data", demo: "/health/data", demoLabel: "Data source" },
  { id: "nojunk-domain-intel", name: "NoJunk Domain Intel", what: "Domain age, registrar, DNS, email security, risk score.", route: "/domain", price: "$0.003", probe: "/" },
  { id: "nojunk-ai-text", name: "NoJunk AI Text", what: "Summarize, extract facts, classify text with a 70B model.", route: "/summarize", price: "$0.005", probe: "/" },
  { id: "nojunk-speech", name: "NoJunk Speech", what: "Transcribe audio, speak text, translate 100 languages.", route: "/transcribe", price: "$0.02", probe: "/" },
  { id: "nojunk-image", name: "NoJunk Image", what: "Generate a picture from text; describe any image.", route: "/generate", price: "$0.01", probe: "/" },
  { id: "nojunk-document", name: "NoJunk Document", what: "PDF, Word, Excel or image file turned into text.", route: "/convert", price: "$0.01", probe: "/" },
  { id: "nojunk-web-search", name: "NoJunk Web Search", what: "Ten live web results for any query.", route: "/search", price: "$0.002", probe: "/health/search", demo: "/health/search", demoLabel: "Live search check" },
  { id: "nojunk-llm", name: "NoJunk LLM", what: "OpenAI-compatible 70B chat model and embeddings.", route: "/v1/chat/completions", price: "$0.005", probe: "/v1/models", demo: "/v1/models", demoLabel: "Models offered" },
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
  if (svc.id === "nojunk-token-check") return `CoinGecko ${j.coingecko_status}, GoPlus ${j.goplus_code === 1 ? "ok" : "throttled (backup: Honeypot.is " + j.honeypot_is_status + ", RugCheck " + j.rugcheck_status + ")"}`;
  return null;
}

async function checkService(svc) {
  const [info, pay, demo] = await Promise.all([
    timed(BASE(svc.id) + svc.probe),
    timed(BASE(svc.id) + svc.route, { method: svc.id === "nojunk-llm" ? "POST" : "GET" }),
    svc.demo ? timed(BASE(svc.id) + svc.demo) : Promise.resolve(null),
  ]);
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
    demo: svc.demo ? { label: svc.demoLabel, ok: demo && demo.ok && demo.status === 200, ms: demo && demo.ms, text: summarizeDemo(svc, demo && tryJson(demo.text)) } : null,
  };
}

async function wallet() {
  const UA = { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36" };
  // Balance straight from the Base network (ERC-20 balanceOf).
  const data = "0x70a08231" + WALLET.slice(2).padStart(64, "0");
  const rpc = await timed("https://mainnet.base.org", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: USDC, data }, "latest"] }) });
  const rj = rpc.ok ? tryJson(rpc.text) : null;
  const balance = rj && rj.result ? Number(BigInt(rj.result)) / 1e6 : null;
  // Incoming USDC transfers: Blockscout first, Routescan as backup.
  let items = null, source = null;
  const b = await timed(`https://base.blockscout.com/api/v2/addresses/${WALLET}/token-transfers?type=ERC-20&filter=to`, { headers: UA });
  const bj = b.ok && b.status === 200 ? tryJson(b.text) : null;
  if (bj && Array.isArray(bj.items)) { source = "blockscout"; items = bj.items.map((t) => ({ when: t.timestamp, token: t.token && t.token.symbol, addr: t.token && String(t.token.address).toLowerCase(), value: Number(t.total && t.total.value), decimals: Number(t.token && t.token.decimals) || 18, from: t.from && t.from.hash })); }
  if (!items) {
    const r = await timed(`https://api.routescan.io/v2/network/mainnet/evm/8453/etherscan/api?module=account&action=tokentx&address=${WALLET}&sort=desc&page=1&offset=50`, { headers: UA });
    const rj2 = r.ok && r.status === 200 ? tryJson(r.text) : null;
    if (rj2 && Array.isArray(rj2.result)) { source = "routescan"; items = rj2.result.filter((t) => String(t.to).toLowerCase() === WALLET).map((t) => ({ when: new Date(Number(t.timeStamp) * 1000).toISOString(), token: t.tokenSymbol, addr: String(t.contractAddress).toLowerCase(), value: Number(t.value), decimals: Number(t.tokenDecimal) || 18, from: t.from })); }
  }
  const all = items || [];
  const usdc = all.filter((t) => t.addr === USDC).map((t) => ({ when: t.when, usd: t.value / 1e6, from: t.from }));
  return { ok: items !== null, source, balance_source: balance === null ? null : "base rpc", usdc_balance: balance === null ? 0 : balance, usdc_payments: usdc.slice(0, 10), payments_count: usdc.length, last_any_transfer: all[0] ? { when: all[0].when, token: all[0].token } : null, explorer_status: { blockscout: b.status, routescan: items && source === "routescan" ? 200 : undefined } };
}

async function status(env) {
  const [services, site, w, log] = await Promise.all([
    Promise.all(SERVICES.map(checkService)),
    timed(SITE.url),
    wallet(),
    env.STATUS ? env.STATUS.get("buildlog").then((v) => tryJson(v || "[]") || []) : Promise.resolve([]),
  ]);
  return { checked_at: new Date().toISOString(), services, site: { ...SITE, up: site.ok && site.status === 200, ms: site.ms }, wallet: w, buildlog: log.slice(-60).reverse() };
}

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NoJunk Build Floor</title>
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
<header><div class="brand"><svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="6" fill="#13213C"/><path d="M9 16.5l4.5 4.5L23 11" stroke="#FFD23F" stroke-width="3.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>NoJunk Build Floor</div><div class="live"><span class="dot"></span><span id="upd">checking…</span></div></header>
<div class="tiles"><div class="tile"><b id="n-up">–</b><span>services up</span></div><div class="tile"><b id="n-pay">–</b><span>paywalls live, paying your wallet</span></div><div class="tile"><b id="n-usdc">–</b><span>USDC received from agents</span></div><div class="tile"><b id="n-bal">–</b><span>USDC in wallet</span></div><div class="tile"><b id="n-ms">–</b><span>avg response (ms)</span></div></div>
<div class="grid">
<section><h2>Build floor <span class="muted">(what I'm doing, newest first)</span></h2><div class="log" id="log"></div>
<h2>Money</h2><div class="tile pay"><div class="big" id="usdc">$0.000</div><div id="pays" class="muted">No agent payments yet.</div></div></section>
<section><h2>Services running <span class="muted">(checked live from Cloudflare every 20 s)</span></h2><div id="svcs"></div></section>
</div>
<p class="muted" id="site"></p>
</div>
<script>
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(m){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]})}
function fmtT(t){var d=new Date(t);return d.toLocaleDateString(undefined,{month:'short',day:'numeric'})+' '+d.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'})}
async function tick(){
 try{
  var r=await fetch('/api/status?t='+Date.now(),{cache:'no-store'}); var j=await r.json();
  var up=j.services.filter(function(s){return s.up}).length, pay=j.services.filter(function(s){return s.paywall_ok}).length;
  var ms=Math.round(j.services.reduce(function(a,s){return a+s.ms},0)/j.services.length);
  document.getElementById('n-up').textContent=up+'/'+j.services.length; document.getElementById('n-pay').textContent=pay+'/'+j.services.length;
  document.getElementById('n-usdc').textContent='$'+j.wallet.usdc_payments.reduce(function(a,p){return a+p.usd},0).toFixed(3); document.getElementById('n-bal').textContent='$'+j.wallet.usdc_balance.toFixed(2); document.getElementById('n-ms').textContent=ms;
  document.getElementById('usdc').textContent='$'+j.wallet.usdc_payments.reduce(function(a,p){return a+p.usd},0).toFixed(3);
  document.getElementById('pays').innerHTML=j.wallet.usdc_payments.length?j.wallet.usdc_payments.map(function(p){return '<div>'+esc(fmtT(p.when))+' · $'+p.usd.toFixed(4)+' from '+esc(p.from.slice(0,10))+'…</div>'}).join(''):'No agent payments yet. Last thing received: '+(j.wallet.last_any_transfer?esc(j.wallet.last_any_transfer.token)+' on '+esc(fmtT(j.wallet.last_any_transfer.when)):'nothing')+'.';
  document.getElementById('log').innerHTML=j.buildlog.map(function(e){return '<div><span class="t">'+esc(fmtT(e.t))+'</span><span class="k-'+esc(e.kind||'build')+'">'+esc(e.text)+'</span></div>'}).join('')||'<div>No entries yet.</div>';
  document.getElementById('svcs').innerHTML=j.services.map(function(s){return '<div class="svc"><span class="st '+(s.up?'up':'down')+'"></span><span class="nm"><a href="'+esc(s.url)+'" style="color:inherit;text-decoration:none">'+esc(s.name)+'</a></span><span class="pr">'+esc(s.price)+'</span><span class="what">'+esc(s.what)+'</span><span class="meta"><span class="'+(s.up?'ok':'bad')+'">'+(s.up?'UP':'DOWN')+' · '+s.ms+' ms</span><span class="'+(s.paywall_ok?'ok':'bad')+'">paywall '+esc(s.paywall)+'</span></span>'+(s.demo?'<span class="demo '+(s.demo.ok?'':'bad')+'">'+esc(s.demo.label)+': '+esc(s.demo.text||(s.demo.ok?'ok':'unavailable'))+'</span>':'')+'</div>'}).join('');
  document.getElementById('site').textContent='Free site '+j.site.name+': '+(j.site.up?'up':'down')+' ('+j.site.ms+' ms). Last check '+new Date(j.checked_at).toLocaleTimeString()+'.';
  document.getElementById('upd').textContent='live · updated '+new Date().toLocaleTimeString();
 }catch(e){document.getElementById('upd').textContent='check failed, retrying';}
}
tick(); setInterval(tick,20000);
</script></body></html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/status") {
      const s = await status(env);
      return new Response(JSON.stringify(s), { headers: { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" } });
    }
    if (url.pathname === "/api/walletdebug") {
      const UA = { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36" };
      const data = "0x70a08231" + WALLET.slice(2).padStart(64, "0");
      const tests = await Promise.all([
        timed("https://mainnet.base.org", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: USDC, data }, "latest"] }) }),
        timed("https://base-rpc.publicnode.com", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: USDC, data }, "latest"] }) }),
        timed("https://base.llamarpc.com", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: USDC, data }, "latest"] }) }),
        timed(`https://base.blockscout.com/api/v2/addresses/${WALLET}/token-transfers?type=ERC-20&filter=to`, { headers: UA }),
        timed(`https://api.routescan.io/v2/network/mainnet/evm/8453/etherscan/api?module=account&action=tokentx&address=${WALLET}&sort=desc&page=1&offset=5`, { headers: UA }),
        timed(`https://api.basescan.org/api?module=account&action=tokentx&address=${WALLET}&sort=desc&page=1&offset=5`, { headers: UA }),
      ]);
      return new Response(JSON.stringify(tests.map((t) => ({ status: t.status, ms: t.ms, err: t.error, head: (t.text || "").slice(0, 160) })), null, 1), { headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/" || url.pathname === "/status") return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    return new Response("Not found", { status: 404 });
  },
};
