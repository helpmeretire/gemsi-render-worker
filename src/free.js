// ---------- free human checker (/scan page + /free JSON for that page only) ----------
// Referral links are read from Worker variables; any left unset are simply not shown.
const PARTNERS = [
  { env: "REF_GEMINI", name: "Gemini", blurb: "US-regulated exchange. Simple app, good for a first account." },
  { env: "REF_ROBINHOOD", name: "Robinhood", blurb: "Buy major coins in the same app as stocks." },
  { env: "REF_UPHOLD", name: "Uphold", blurb: "Exchange with clear, upfront pricing on each trade." },
  { env: "REF_LEDGER", name: "Ledger", blurb: "Hardware wallet: keep coins off exchanges, under your own key." },
  { env: "REF_TREZOR", name: "Trezor", blurb: "Hardware wallet with open-source software." },
];
const FREE_LIMIT = 20; // checks per IP per window, per Worker instance
const FREE_WINDOW_MS = 10 * 60 * 1000;
const freeHits = new Map();
const GT_TO_CHAIN = { eth: "ethereum", base: "base", bsc: "bsc", arbitrum: "arbitrum", polygon_pos: "polygon", optimism: "optimism", avax: "avalanche", solana: "solana" };

function partnersHtml(env) {
  const safe = (s) => String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
  const live = PARTNERS.filter((p) => /^https:\/\/\S+$/.test(String((env && env[p.env]) || "").trim()));
  if (!live.length) return "";
  const cards = live
    .map((p) => `<div class="p"><b>${safe(p.name)}<span class="paid">paid link</span></b><span>${safe(p.blurb)}</span><a href="${safe(String(env[p.env]).trim())}" rel="sponsored noopener" target="_blank">Visit ${safe(p.name)}</a></div>`)
    .join("");
  return `<section class="wrap partners"><h2>Skip the junk entirely</h2><p class="dek">Newcomers do best buying established coins on a regulated exchange and holding them in a wallet they control. If you open an account through a link marked "paid link", we may earn a flat fee. It never changes a grade.</p><div class="plist">${cards}</div></section>`;
}

function scanPage(env, url) {
  const home = String((env && env.HOME_URL) || "").trim();
  const html = PAGE_HTML.replace("__HOME__", /^https:\/\/\S+$/.test(home) ? home.replace(/"/g, "") : url.origin + "/scan").replace("__PARTNERS__", partnersHtml(env));
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    },
  });
}

function freeAllowed(request, url) {
  const site = request.headers.get("Sec-Fetch-Site");
  if (site) return site === "same-origin";
  const ref = request.headers.get("Referer") || "";
  return ref.startsWith(url.origin + "/scan");
}

function rateLimited(ip, now = Date.now()) {
  if (freeHits.size > 5000) for (const [k, v] of freeHits) if (now - v.start > FREE_WINDOW_MS) freeHits.delete(k);
  const e = freeHits.get(ip);
  if (!e || now - e.start > FREE_WINDOW_MS) { freeHits.set(ip, { start: now, n: 1 }); return false; }
  e.n++;
  return e.n > FREE_LIMIT;
}

async function detectChain(address) {
  if (SOL_RE.test(address) && !EVM_RE.test(address)) return "solana";
  const r = await getJSON(`https://api.geckoterminal.com/api/v2/search/pools?query=${encodeURIComponent(address)}`, 600);
  if (r.ok && r.data && Array.isArray(r.data.data)) {
    const want = address.toLowerCase();
    const counts = {};
    for (const d of r.data.data) {
      const net = String((d.relationships && d.relationships.network && d.relationships.network.data && d.relationships.network.data.id) || "");
      const ids = ["base_token", "quote_token"].map((k) => String((d.relationships && d.relationships[k] && d.relationships[k].data && d.relationships[k].data.id) || "").toLowerCase());
      if (GT_TO_CHAIN[net] && ids.includes(`${net}_${want}`)) counts[GT_TO_CHAIN[net]] = (counts[GT_TO_CHAIN[net]] || 0) + 1;
    }
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (best) return best[0];
  }
  return "ethereum";
}

async function handleFree(request, url) {
  if (!freeAllowed(request, url)) return json({ error: "The free checker is for the web page at /scan. AI agents and apps: use the paid endpoint POST /check (x402, $0.01)." }, 403);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (rateLimited(ip)) return json({ error: "You've run a lot of checks in a short time. Please wait a few minutes and try again." }, 429);
  const params = parseParams(Object.fromEntries(url.searchParams));
  if (!params.address) return json({ error: "Paste a token contract address first." }, 400);
  if (!url.searchParams.get("chain") && EVM_RE.test(params.address)) params.chain = await detectChain(params.address);
  const bad = validate(params);
  if (bad) return json({ error: "That doesn't look like a token address we can check. " + bad }, 400);
  const data = await fetchTokenData(params);
  if (data.upstreamDown) return json({ error: "Our data sources are busy right now. Please try again in a minute." }, 502);
  if (!data.security && !data.token && !data.pools.length) return json({ error: `We couldn't find a token at that address on ${CHAINS[params.chain].label}. Check the address, or pick the right blockchain from the list.` }, 404);
  return json(analyze(params.chain, params.address, data), 200, { "Cache-Control": "no-store" });
}
