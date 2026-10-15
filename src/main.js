// ---------- token check ----------
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ZERO_ADDRS = new Set(["0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dead", "0xdead000000000000000042069420694206942069"]);
const SOL_SKIP_OWNERS = new Set([
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", // Raydium AMM authority
  "GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL", // Raydium CPMM authority
  "WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh", // Raydium launchpad authority
  "1nc1nerator11111111111111111111111111111111", // incinerator
]);

function parseParams(p) {
  const address = String(p.tokenAddress || p.address || p.token || "").trim();
  let chain = String(p.chain || "").trim().toLowerCase();
  if (chain === "sol") chain = "solana";
  if (!chain) chain = EVM_RE.test(address) ? "base" : SOL_RE.test(address) ? "solana" : "";
  return { address, chain };
}
function validate({ address, chain }) {
  if (!address) return "Missing required parameter: tokenAddress";
  if (!CHAINS[chain]) return "Unsupported or undetectable chain. Use chain=base (0x... address) or chain=solana (mint address).";
  if (chain === "base" && !EVM_RE.test(address)) return "Invalid Base token address (expected 0x followed by 40 hex characters).";
  if (chain === "solana" && !SOL_RE.test(address)) return "Invalid Solana mint address.";
  return null;
}

async function getJSON(url, ttl = 120) {
  const cache = typeof caches !== "undefined" && caches.default ? caches.default : null;
  const key = new Request(url);
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return { ok: true, status: hit.status, data: await hit.json() };
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: ctrl.signal });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    if (res.ok && data && cache) {
      await cache.put(key, new Response(text, { headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${ttl}` } }));
    }
    return { ok: res.ok && data !== null, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: null, error: String(e) };
  } finally {
    clearTimeout(t);
  }
}

async function fetchTokenData({ address, chain }) {
  const c = CHAINS[chain];
  const gpUrl = c.goplus + encodeURIComponent(address);
  const gtBase = `https://api.geckoterminal.com/api/v2/networks/${c.gt}/tokens/${encodeURIComponent(address)}`;
  const [gp, gtTok, gtPools] = await Promise.all([getJSON(gpUrl), getJSON(gtBase), getJSON(gtBase + "/pools?page=1")]);
  let security = null;
  if (gp.ok && gp.data && gp.data.result && typeof gp.data.result === "object") {
    const r = gp.data.result;
    security = r[address] || r[address.toLowerCase()] || Object.values(r)[0] || null;
    if (security && typeof security === "object" && Object.keys(security).length === 0) security = null;
  }
  const token = gtTok.ok && gtTok.data && gtTok.data.data ? gtTok.data.data.attributes || null : null;
  const pools = gtPools.ok && gtPools.data && Array.isArray(gtPools.data.data) ? gtPools.data.data.map((d) => d.attributes || {}) : [];
  const upstreamDown = !gp.ok && gp.status !== 404 && !gtTok.ok && gtTok.status !== 404;
  return { security, token, pools, gpOk: gp.ok, gtOk: gtTok.ok || gtPools.ok, upstreamDown };
}

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};
const on = (v) => v === "1" || v === 1 || v === true;
const fmtUsd = (n) => (n === null ? "unknown" : n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(0)}`);
const pct = (x) => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;

function analyze(chain, address, d, now = Date.now()) {
  const red = [];
  const green = [];
  const add = (severity, flag, detail) => red.push({ severity, flag, detail });
  const s = d.security || {};

  // ----- contract / mint security (GoPlus) -----
  if (!d.security) add("medium", "no_security_data", "No contract security data was available for this token, so honeypot and owner checks could not be run.");
  if (chain === "base" && d.security) {
    const buy = num(s.buy_tax), sell = num(s.sell_tax);
    if (on(s.is_honeypot)) add("critical", "honeypot", "Flagged as a honeypot: buyers may be unable to sell.");
    if (on(s.cannot_sell_all)) add("critical", "cannot_sell_all", "Holders cannot sell their full balance.");
    if (on(s.cannot_buy)) add("critical", "cannot_buy", "The token cannot currently be bought.");
    for (const [name, v] of [["sell_tax", sell], ["buy_tax", buy]]) {
      if (v === null) continue;
      if (v >= 0.5) add("critical", name, `${name === "sell_tax" ? "Sell" : "Buy"} tax is ${pct(v)}.`);
      else if (v > 0.1) add("high", name, `${name === "sell_tax" ? "Sell" : "Buy"} tax is ${pct(v)}.`);
      else if (v > 0.05) add("medium", name, `${name === "sell_tax" ? "Sell" : "Buy"} tax is ${pct(v)}.`);
    }
    if (s.is_open_source === "0") add("high", "closed_source", "Contract source code is not verified.");
    if (on(s.hidden_owner)) add("high", "hidden_owner", "Contract has a hidden owner.");
    if (on(s.can_take_back_ownership)) add("high", "can_take_back_ownership", "Ownership can be reclaimed after being renounced.");
    if (on(s.owner_change_balance)) add("high", "owner_can_change_balances", "Owner can change holder balances.");
    if (on(s.selfdestruct)) add("high", "selfdestruct", "Contract can self-destruct.");
    const ownerLive = s.owner_address && !ZERO_ADDRS.has(String(s.owner_address).toLowerCase());
    if (on(s.is_mintable) && ownerLive) add("high", "mintable", "Owner can mint new tokens.");
    else if (on(s.is_mintable)) add("medium", "mintable", "Contract has a mint function.");
    if (on(s.is_proxy)) add("medium", "upgradeable_proxy", "Contract is an upgradeable proxy; its code can change.");
    if (on(s.transfer_pausable)) add("medium", "transfer_pausable", "Transfers can be paused.");
    if (on(s.is_blacklisted)) add("medium", "blacklist", "Contract can blacklist addresses.");
    if (on(s.slippage_modifiable) || on(s.personal_slippage_modifiable)) add("medium", "tax_modifiable", "Taxes can be changed by the owner.");
    if (on(s.trading_cooldown)) add("medium", "trading_cooldown", "Trading cooldown is enforced.");
    if (on(s.external_call)) add("medium", "external_call", "Contract makes external calls that could change behavior.");
    const hp = num(s.honeypot_with_same_creator);
    if (hp && hp > 0) add("medium", "creator_history", `Creator is linked to ${hp} other honeypot token(s).`);
    const insider = (num(s.creator_percent) || 0) + (ownerLive ? num(s.owner_percent) || 0 : 0);
    if (insider > 0.1) add("medium", "insider_holdings", `Creator/owner hold about ${pct(insider)} of supply.`);
    if (on(s.anti_whale_modifiable)) add("low", "anti_whale_modifiable", "Anti-whale limits can be changed.");
    if (!ownerLive && s.owner_address !== undefined) green.push("Ownership renounced or no owner.");
    if (s.is_open_source === "1") green.push("Contract source is verified.");
    if (on(s.trust_list)) green.push("On GoPlus trusted list.");
  }
  if (chain === "solana" && d.security) {
    const st = (o) => (o && typeof o === "object" ? o.status : o);
    if (on(st(s.balance_mutable_authority))) add("critical", "balance_mutable", "An authority can change holder balances.");
    if (on(s.non_transferable)) add("critical", "non_transferable", "Token is non-transferable.");
    const fee = s.transfer_fee && typeof s.transfer_fee === "object" ? num(s.transfer_fee.current_fee_rate ?? s.transfer_fee.fee_rate) : null;
    if (fee !== null && fee >= 0.5) add("critical", "transfer_fee", `Transfer fee is ${pct(fee)}.`);
    else if (fee !== null && fee > 0.05) add("high", "transfer_fee", `Transfer fee is ${pct(fee)}.`);
    if (on(st(s.mintable))) add("high", "mint_authority", "Mint authority is still active: supply can be increased.");
    else green.push("Mint authority revoked.");
    if (on(st(s.freezable))) add("high", "freeze_authority", "Freeze authority is active: accounts can be frozen.");
    else green.push("Freeze authority revoked.");
    if (on(st(s.closable))) add("medium", "closable", "Token accounts can be closed by an authority.");
    if (Array.isArray(s.transfer_hook) ? s.transfer_hook.length > 0 : on(st(s.transfer_hook))) add("medium", "transfer_hook", "Token has a transfer hook that runs custom code on transfers.");
    if (on(st(s.metadata_mutable))) add("low", "metadata_mutable", "Token name/metadata can still be changed.");
    if (on(s.trusted_token)) green.push("On GoPlus trusted list.");
  }

  // ----- holder concentration -----
  let top10 = null;
  if (Array.isArray(s.holders) && s.holders.length) {
    const list = s.holders.filter((h) => {
      if (on(h.is_locked)) return false;
      const a = String(h.address || h.account || "");
      if (ZERO_ADDRS.has(a.toLowerCase()) || SOL_SKIP_OWNERS.has(a)) return false;
      if (chain === "base" && on(h.is_contract)) return false;
      return true;
    });
    top10 = list.slice(0, 10).reduce((t, h) => t + (num(h.percent) || 0), 0);
    if (top10 > 0.5) add("high", "holder_concentration", `Top 10 wallets hold about ${pct(top10)} of supply.`);
    else if (top10 > 0.3) add("medium", "holder_concentration", `Top 10 wallets hold about ${pct(top10)} of supply.`);
    else green.push(`Top 10 wallets hold about ${pct(top10)} of supply.`);
  }
  const holderCount = num(s.holder_count);
  if (holderCount !== null && holderCount < 100) add("low", "few_holders", `Only ${holderCount} holders.`);
  else if (holderCount !== null && holderCount >= 10000) green.push(`${holderCount.toLocaleString("en-US")} holders.`);

  // ----- market (GeckoTerminal) -----
  const pools = d.pools || [];
  const liquidity = pools.length ? pools.reduce((t, p) => t + (num(p.reserve_in_usd) || 0), 0) : num(d.token && d.token.total_reserve_in_usd);
  const volume24h = pools.length ? pools.reduce((t, p) => t + (num(p.volume_usd && p.volume_usd.h24) || 0), 0) : num(d.token && d.token.volume_usd && d.token.volume_usd.h24);
  const created = pools.map((p) => Date.parse(p.pool_created_at)).filter(Number.isFinite);
  const ageDays = created.length ? (now - Math.min(...created)) / 86400000 : null;
  if (!pools.length && !d.token) add("high", "no_market", "No DEX pools or market data found for this token.");
  if (liquidity !== null) {
    if (liquidity < 10000) add("high", "low_liquidity", `Total DEX liquidity is only ${fmtUsd(liquidity)}.`);
    else if (liquidity < 50000) add("medium", "low_liquidity", `Total DEX liquidity is ${fmtUsd(liquidity)}.`);
    else if (liquidity >= 1000000) green.push(`Deep liquidity: ${fmtUsd(liquidity)}.`);
  }
  if (ageDays !== null) {
    if (ageDays < 1) add("high", "brand_new", `Oldest trading pool is under 24 hours old.`);
    else if (ageDays < 7) add("medium", "new_token", `Oldest trading pool is ${Math.floor(ageDays)} days old.`);
    else if (ageDays >= 365) green.push(`Trading for over ${Math.floor(ageDays / 365)} year(s).`);
  }

  // ----- grade -----
  const W = { critical: 100, high: 30, medium: 12, low: 4 };
  const score = Math.min(100, red.reduce((t, f) => t + W[f.severity], 0));
  const critical = red.some((f) => f.severity === "critical");
  const grade = critical || score >= 60 ? "JUNK" : score >= 30 ? "RISKY" : score >= 10 ? "CAUTION" : "CLEAN";
  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  red.sort((a, b) => order[a.severity] - order[b.severity]);
  const symbol = (d.token && d.token.symbol) || s.token_symbol || (s.metadata && s.metadata.symbol) || "This token";
  const top = red[0];
  const one_liner =
    grade === "JUNK" ? `${symbol}: junk. ${top ? top.detail : ""}`.trim()
    : grade === "RISKY" ? `${symbol}: risky. ${top ? top.detail : ""}`.trim()
    : grade === "CAUTION" ? `${symbol}: proceed with caution. ${top ? top.detail : ""}`.trim()
    : `${symbol}: no major red flags found.`;

  return {
    token: {
      chain,
      address,
      name: (d.token && d.token.name) || s.token_name || (s.metadata && s.metadata.name) || null,
      symbol: (d.token && d.token.symbol) || s.token_symbol || (s.metadata && s.metadata.symbol) || null,
      holders: holderCount,
    },
    grade,
    risk_score: score,
    one_liner,
    red_flags: red,
    green_flags: green,
    market: {
      price_usd: num(d.token && d.token.price_usd),
      fdv_usd: num(d.token && d.token.fdv_usd),
      liquidity_usd: liquidity,
      volume_24h_usd: volume24h,
      pools_counted: pools.length,
      oldest_pool_age_days: ageDays === null ? null : Math.round(ageDays * 10) / 10,
      top10_holder_share: top10 === null ? null : Math.round(top10 * 1000) / 1000,
    },
    checked_at: new Date(now).toISOString(),
    disclaimer: DISCLAIMER,
    sources: SOURCES,
  };
}

// ---------- x402 ----------
function requirements(env) {
  return {
    scheme: "exact",
    network: NETWORK,
    amount: PRICE_ATOMIC,
    asset: USDC_BASE,
    payTo: env.PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { name: "USD Coin", version: "2" },
  };
}
const EXAMPLE_OUT = {
  token: { chain: "base", address: "0x532f27101965dd16442E59d40670FaF5eBB142E4", name: "Brett", symbol: "BRETT", holders: 908869 },
  grade: "CLEAN",
  risk_score: 0,
  one_liner: "BRETT: no major red flags found.",
  red_flags: [],
  green_flags: ["Ownership renounced or no owner.", "Contract source is verified."],
  market: { price_usd: 0.01, liquidity_usd: 5000000, volume_24h_usd: 1000000, oldest_pool_age_days: 900 },
  disclaimer: DISCLAIMER,
};
function paymentRequired(env, url, error) {
  return {
    x402Version: 2,
    error,
    resource: { url: `${url.origin}/check`, description: DESCRIPTION, mimeType: "application/json" },
    accepts: [requirements(env)],
    extensions: {
      bazaar: {
        info: {
          input: { type: "http", method: "POST", bodyType: "json", body: { tokenAddress: "0x532f27101965dd16442E59d40670FaF5eBB142E4", chain: "base" } },
          output: { type: "json", example: EXAMPLE_OUT },
        },
        schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            input: {
              type: "object",
              properties: {
                type: { type: "string", const: "http" },
                method: { type: "string", enum: ["POST", "PUT", "PATCH"] },
                bodyType: { type: "string", enum: ["json", "form-data", "text"] },
                body: {
                  type: "object",
                  properties: {
                    tokenAddress: { type: "string", description: "Token contract address (Base 0x...) or Solana mint" },
                    chain: { type: "string", enum: ["base", "solana"], description: "Optional; auto-detected from the address format" },
                  },
                  required: ["tokenAddress"],
                },
                queryParams: { type: "object", additionalProperties: { type: "string" } },
                headers: { type: "object", additionalProperties: { type: "string" } },
              },
              required: ["type", "method", "bodyType", "body"],
              additionalProperties: false,
            },
            output: { type: "object", properties: { type: { type: "string" }, example: { type: "object" } }, required: ["type"] },
          },
          required: ["input"],
        },
      },
    },
  };
}
function send402(env, url, error) {
  const pr = paymentRequired(env, url, error);
  return json(pr, 402, { "PAYMENT-REQUIRED": b64e(pr) });
}

async function readParams(request, url) {
  const p = Object.fromEntries(url.searchParams);
  if (request.method === "POST") {
    try { const b = await request.clone().json(); if (b && typeof b === "object") Object.assign(p, b); } catch {}
  }
  return parseParams(p);
}

function openapi(origin) {
  const body = {
    type: "object",
    properties: {
      tokenAddress: { type: "string", minLength: 32, description: "Token contract address (Base 0x...) or Solana mint address" },
      chain: { type: "string", enum: ["base", "solana"], description: "Optional; auto-detected from the address format" },
    },
    required: ["tokenAddress"],
  };
  const out = {
    type: "object",
    properties: {
      token: { type: "object" },
      grade: { type: "string", enum: ["JUNK", "RISKY", "CAUTION", "CLEAN"] },
      risk_score: { type: "integer", minimum: 0, maximum: 100 },
      one_liner: { type: "string" },
      red_flags: { type: "array", items: { type: "object", properties: { severity: { type: "string" }, flag: { type: "string" }, detail: { type: "string" } } } },
      green_flags: { type: "array", items: { type: "string" } },
      market: { type: "object" },
      disclaimer: { type: "string" },
      sources: { type: "string" },
    },
    required: ["grade", "risk_score", "red_flags"],
  };
  const pay = { price: { mode: "fixed", currency: "USD", amount: "0.010000" }, protocols: [{ x402: {} }] };
  const responses = { 200: { description: "Risk report", content: { "application/json": { schema: out } } }, 402: { description: "Payment Required" } };
  return {
    openapi: "3.1.0",
    info: {
      title: SERVICE,
      version: "1.0.0",
      description: DESCRIPTION,
      "x-guidance": "POST /check with JSON {\"tokenAddress\": \"<Base 0x address or Solana mint>\", \"chain\": \"base\"|\"solana\" (optional)} or GET /check?tokenAddress=...&chain=... to get a junk/rug-risk grade (JUNK, RISKY, CAUTION, CLEAN), a 0-100 risk score, red/green flags and market stats. $0.01 USDC on Base per check via x402. Invalid addresses and tokens with no data are rejected before payment is settled. Not financial advice.",
    },
    servers: [{ url: origin }],
    paths: {
      "/check": {
        post: { operationId: "checkToken", summary: "Grade a Base or Solana token for junk/rug risk", tags: ["Crypto", "Security"], "x-payment-info": pay, requestBody: { required: true, content: { "application/json": { schema: body } } }, responses },
        get: {
          operationId: "checkTokenGet",
          summary: "Grade a Base or Solana token for junk/rug risk",
          tags: ["Crypto", "Security"],
          "x-payment-info": pay,
          parameters: [
            { name: "tokenAddress", in: "query", required: true, schema: { type: "string" }, description: body.properties.tokenAddress.description },
            { name: "chain", in: "query", required: false, schema: { type: "string", enum: ["base", "solana"] }, description: body.properties.chain.description },
          ],
          responses,
        },
      },
    },
  };
}

export default {
  async fetch(request, env0) {
    const env = { ...(env0 || {}), PAY_TO: (env0 && env0.PAY_TO) || DEFAULT_PAY_TO };
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "PAYMENT-SIGNATURE, X-PAYMENT, Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" } });
    }
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        service: SERVICE,
        description: DESCRIPTION,
        endpoint: `${url.origin}/check`,
        openapi: `${url.origin}/openapi.json`,
        usage: 'POST /check {"tokenAddress":"0x...","chain":"base"} or GET /check?tokenAddress=...',
        price: "$0.01 USDC on Base per check (x402)",
        chains: Object.keys(CHAINS),
        facilitator: env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET ? "cdp" : "payai",
        sources: SOURCES,
        disclaimer: DISCLAIMER,
      });
    }
    if (url.pathname === "/openapi.json" || url.pathname === "/.well-known/openapi.json") return json(openapi(url.origin));
    if (url.pathname !== "/check") return json({ error: "Not found. Use POST /check" }, 404);
    if (!/^0x[0-9a-fA-F]{40}$/.test(env.PAY_TO)) return json({ error: "Service not configured: PAY_TO wallet address invalid" }, 500);
    if (request.method !== "GET" && request.method !== "POST") return json({ error: "Use GET or POST" }, 405);

    const header = request.headers.get("PAYMENT-SIGNATURE") || request.headers.get("X-PAYMENT");
    if (!header) return send402(env, url, "PAYMENT-SIGNATURE header is required");
    const params = await readParams(request, url);
    const bad = validate(params);
    if (bad) return json({ error: bad + " (no payment was taken)" }, 400);

    let payload;
    try { payload = b64d(header); } catch { return json({ error: "Invalid payment payload" }, 400); }
    const reqs = requirements(env);
    if (payload.x402Version !== 2 || !deepEqual(payload.accepted, reqs)) return send402(env, url, "No matching payment requirements found");

    const fac = facilitator(env);
    const body = { x402Version: 2, paymentPayload: payload, paymentRequirements: reqs };
    let v;
    try { v = await fac.call("verify", body); } catch (e) { return json({ error: "Facilitator unreachable", detail: String(e) }, 500); }
    if (!v.ok || !v.data.isValid) return send402(env, url, v.data.invalidReason || v.data.error || `verify failed (${v.status})`);

    const data = await fetchTokenData(params);
    if (data.upstreamDown) return json({ error: "Data sources temporarily unavailable. No payment was taken; please retry." }, 502);
    if (!data.security && !data.token && !data.pools.length) return json({ error: `No data found for ${params.address} on ${params.chain}. No payment was taken.` }, 404);
    const result = analyze(params.chain, params.address, data);

    let s;
    try { s = await fac.call("settle", body); } catch (e) { return json({ error: "Facilitator unreachable", detail: String(e) }, 500); }
    if (!s.ok || !s.data.success) {
      const fail = { success: false, errorReason: s.data.errorReason || s.data.error || `settle failed (${s.status})`, transaction: "", network: NETWORK, payer: s.data.payer || v.data.payer };
      return json({}, 402, { "PAYMENT-RESPONSE": b64e(fail) });
    }
    const receipt = { success: true, transaction: s.data.transaction, network: s.data.network || NETWORK, payer: s.data.payer || v.data.payer };
    return json(result, 200, { "PAYMENT-RESPONSE": b64e(receipt) });
  },
};
