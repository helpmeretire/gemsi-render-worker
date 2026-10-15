// ---------- free human checker (/scan page + /free JSON for that page only) ----------
// Referral links are read from Worker variables; any left unset are simply not shown.
const PARTNERS = [
  { env: "REF_COINBASE", name: "Coinbase", blurb: "Largest US-listed crypto exchange. Easy first account for buying major coins." },
  { env: "REF_COINBASE_ADVANCED", name: "Coinbase Advanced", blurb: "Coinbase's trading screen with lower fees, for people who already know the basics." },
  { env: "REF_GEMINI", name: "Gemini", blurb: "US-regulated exchange. Simple app, good for a first account." },
  { env: "REF_ROBINHOOD", name: "Robinhood", blurb: "Buy major coins in the same app as stocks." },
  { env: "REF_UPHOLD", name: "Uphold", blurb: "Exchange with clear, upfront pricing on each trade." },
  { env: "REF_CRYPTOCOM", name: "Crypto.com", blurb: "Large exchange app for buying and selling major coins." },
  { env: "REF_COINBASE_WALLET", name: "Coinbase Wallet", blurb: "Free self-custody wallet from Coinbase: you hold your own keys, not an exchange." },
  { env: "REF_LEDGER", name: "Ledger", blurb: "Hardware wallet: keep coins off exchanges, under your own key." },
  { env: "REF_TREZOR", name: "Trezor", blurb: "Hardware wallet with open-source software." },
];
const FREE_LIMIT = 20; // checks per IP per window, per Worker instance
const FREE_WINDOW_MS = 10 * 60 * 1000;
const freeHits = new Map();

function partnersHtml(env) {
  const safe = (s) => String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
  const live = PARTNERS.filter((p) => /^https:\/\/\S+$/.test(String((env && env[p.env]) || "").trim()));
  if (!live.length) return "";
  const cards = live
    .map((p) => `<div class="p"><b>${safe(p.name)}<span class="paid">paid link</span></b><span>${safe(p.blurb)}</span><a href="${safe(String(env[p.env]).trim())}" rel="sponsored noopener" target="_blank">Visit ${safe(p.name)}</a></div>`)
    .join("");
  return `<section class="wrap partners"><h2>Skip the junk entirely</h2><p class="dek">Newcomers do best buying established coins on a regulated exchange and holding them in a wallet they control. If you open an account through a link marked "paid link", we may earn a fee or a share of fees. It never changes a grade.</p><div class="plist">${cards}</div></section>`;
}

function scanPage(env, url) {
  const home = String((env && env.HOME_URL) || "").trim();
  const isPublic = /(^|\.)nojunkcrypto\.com$/i.test(url.hostname);
  const homeHref = /^https:\/\/\S+$/.test(home) ? home.replace(/"/g, "") : isPublic ? "https://nojunkcrypto.com/" : url.origin + "/scan";
  const canonical = isPublic ? "https://nojunkcrypto.com/" : url.origin + "/scan";
  const html = PAGE_HTML.replace("__HOME__", homeHref).split("__CANONICAL__").join(canonical).split("__OGIMG__").join((isPublic ? "https://nojunkcrypto.com" : url.origin) + "/og.png").replace("__PARTNERS__", partnersHtml(env));
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https://api.gopluslabs.io https://api.geckoterminal.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
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

// The /scan page fetches GoPlus and GeckoTerminal from the visitor's own browser (so each visitor
// uses their own rate limit) and posts the raw responses here to be graded with the same rules as /check.
const FREE_MAX_BODY = 1_500_000;
async function handleFree(request, url) {
  if (!freeAllowed(request, url)) return json({ error: "The free checker is for the web page at /scan. AI agents and apps: use the paid endpoint POST /check (x402, $0.01)." }, 403);
  if (request.method !== "POST") return json({ error: "Use the checker page at /scan." }, 405);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (rateLimited(ip)) return json({ error: "You've run a lot of checks in a short time. Please wait a few minutes and try again." }, 429);
  const text = await request.text();
  if (text.length > FREE_MAX_BODY) return json({ error: "Request too large." }, 413);
  let b;
  try { b = JSON.parse(text); } catch { return json({ error: "Bad request." }, 400); }
  const params = parseParams({ address: b && b.address, chain: b && b.chain });
  if (!params.address) return json({ error: "Paste a token contract address first." }, 400);
  const bad = validate(params);
  if (bad) return json({ error: "That doesn't look like a token address we can check. " + bad }, 400);
  const wrap = (x) => {
    const status = Number(x && x.status) || 0;
    const data = x && x.data && typeof x.data === "object" ? x.data : null;
    return { ok: status === 200 && data !== null, status, data };
  };
  const data = interpretTokenData(params, wrap(b.gp), wrap(b.gt));
  if (!data.gpOk && !data.gtOk) return json({ error: "Our data sources are busy right now. Please wait a minute and try again." }, 502);
  if (!data.security && !data.token && !data.pools.length) return json({ error: `We couldn't find a token at that address on ${CHAINS[params.chain].label}. Check the address, or pick the right blockchain from the list.` }, 404);
  return json(analyze(params.chain, params.address, data), 200, { "Cache-Control": "no-store" });
}

function ogImage() {
  const bin = atob(OG_PNG_B64);
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  return new Response(bytes, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400", "Access-Control-Allow-Origin": "*" } });
}
