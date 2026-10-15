// NoJunk Token Check — a paid (x402) crypto token risk grader for AI agents.
// Security data: GoPlus Security API. Market data: GeckoTerminal (Powered by CoinGecko).
// Settings (Cloudflare Worker > Settings > Variables and Secrets):
//   PAY_TO              (optional) Base wallet that receives USDC (defaults to Mick's wallet)
//   CDP_API_KEY_ID      (optional) Coinbase Developer Platform API key id   -> Coinbase facilitator / Bazaar
//   CDP_API_KEY_SECRET  (optional, Secret) Coinbase Developer Platform API key secret
// Without the CDP keys the service uses the keyless PayAI facilitator.

const DEFAULT_PAY_TO = "0x6f762720b8515b7091e6aa69e8361f7b9909233f"; // Mick's Base wallet
const PRICE_ATOMIC = "10000"; // $0.01 in USDC (6 decimals)
const NETWORK = "eip155:8453"; // Base mainnet
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CDP_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
const PAYAI_URL = "https://facilitator.payai.network";
const SERVICE = "NoJunk Token Check";
const DESCRIPTION =
  "Crypto token junk/rug-risk check for Base, Ethereum, BNB Chain, Arbitrum, Polygon, Optimism, Avalanche and Solana tokens. Send a token contract address (0x... with chain, defaults to Base; or a Solana mint); get a grade (JUNK, RISKY, CAUTION, CLEAN), a 0-100 risk score, specific red and green flags (honeypot, sell tax, mint/freeze authority, owner powers, holder concentration, liquidity, pool age) and market stats. Not financial advice.";
const GP_EVM = "https://api.gopluslabs.io/api/v1/token_security/";
const CHAINS = {
  base: { evm: true, goplus: GP_EVM + "8453?contract_addresses=", gt: "base", label: "Base" },
  ethereum: { evm: true, goplus: GP_EVM + "1?contract_addresses=", gt: "eth", label: "Ethereum" },
  bsc: { evm: true, goplus: GP_EVM + "56?contract_addresses=", gt: "bsc", label: "BNB Chain" },
  arbitrum: { evm: true, goplus: GP_EVM + "42161?contract_addresses=", gt: "arbitrum", label: "Arbitrum" },
  polygon: { evm: true, goplus: GP_EVM + "137?contract_addresses=", gt: "polygon_pos", label: "Polygon" },
  optimism: { evm: true, goplus: GP_EVM + "10?contract_addresses=", gt: "optimism", label: "Optimism" },
  avalanche: { evm: true, goplus: GP_EVM + "43114?contract_addresses=", gt: "avax", label: "Avalanche" },
  solana: { evm: false, goplus: "https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=", gt: "solana", label: "Solana" },
};
const CHAIN_ALIASES = { sol: "solana", eth: "ethereum", mainnet: "ethereum", bnb: "bsc", binance: "bsc", "bnb chain": "bsc", arb: "arbitrum", matic: "polygon", polygon_pos: "polygon", op: "optimism", avax: "avalanche" };
const DISCLAIMER = "Automated risk screen for information and entertainment only. Not financial, investment or trading advice. Data can be wrong or stale; always do your own research.";
const SOURCES = "Security data: GoPlus Security. Market data: GeckoTerminal - Powered by CoinGecko (https://www.coingecko.com).";

// ---------- helpers ----------
const b64e = (obj) => {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const b64d = (str) => {
  const bin = atob(str);
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
};
const b64url = (bytes) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE", ...headers },
  });

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((key) => deepEqual(a[key], b[key]));
}

// ---------- CDP auth (Ed25519 or EC P-256 key), mirrors @coinbase/cdp-sdk generateJwt ----------
async function cdpJwt(env, method, host, path) {
  const secret = String(env.CDP_API_KEY_SECRET).trim().replace(/\\n/g, "\n");
  const now = Math.floor(Date.now() / 1000);
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = [...nonceBytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const claims = { sub: env.CDP_API_KEY_ID, iss: "cdp", uris: [`${method} ${host}${path}`], iat: now, nbf: now, exp: now + 120 };
  let alg, key, signParams;
  if (secret.includes("BEGIN")) {
    // EC key in PEM (PKCS#8 or SEC1 "EC PRIVATE KEY")
    const body = secret.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
    let der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
    if (secret.includes("BEGIN EC PRIVATE KEY")) der = sec1ToPkcs8(der);
    key = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    alg = "ES256";
    signParams = { name: "ECDSA", hash: "SHA-256" };
  } else {
    const raw = Uint8Array.from(atob(secret), (c) => c.charCodeAt(0));
    if (raw.length !== 64) throw new Error("CDP_API_KEY_SECRET is not a valid Ed25519 key");
    key = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", d: b64url(raw.slice(0, 32)), x: b64url(raw.slice(32)) }, { name: "Ed25519" }, false, ["sign"]);
    alg = "EdDSA";
    signParams = { name: "Ed25519" };
  }
  const header = { alg, kid: env.CDP_API_KEY_ID, typ: "JWT", nonce };
  const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const input = `${enc(header)}.${enc(claims)}`;
  const sig = new Uint8Array(await crypto.subtle.sign(signParams, key, new TextEncoder().encode(input)));
  return `${input}.${b64url(sig)}`;
}
function der(tag, content) {
  const n = content.length;
  const len = n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255];
  return Uint8Array.from([tag, ...len, ...content]);
}
function sec1ToPkcs8(sec1) {
  // PKCS#8 = SEQUENCE { INTEGER 0, SEQUENCE { id-ecPublicKey, prime256v1 }, OCTET STRING sec1 }
  const algId = Uint8Array.from([0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]);
  return der(0x30, [0x02, 0x01, 0x00, ...algId, ...der(0x04, sec1)]);
}

function facilitator(env) {
  const useCdp = env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET;
  const base = useCdp ? CDP_URL : PAYAI_URL;
  const u = new URL(base);
  return {
    name: useCdp ? "cdp" : "payai",
    async call(op, body) {
      const headers = { "Content-Type": "application/json" };
      if (useCdp) headers.Authorization = `Bearer ${await cdpJwt(env, "POST", u.host, `${u.pathname.replace(/\/$/, "")}/${op}`)}`;
      const res = await fetch(`${base}/${op}`, { method: "POST", headers, body: JSON.stringify(body) });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 300) }; }
      return { ok: res.ok, status: res.status, data };
    },
  };
}


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
  chain = CHAIN_ALIASES[chain] || chain;
  if (!chain) chain = EVM_RE.test(address) ? "base" : SOL_RE.test(address) ? "solana" : "";
  return { address, chain };
}
function validate({ address, chain }) {
  if (!address) return "Missing required parameter: tokenAddress";
  if (!CHAINS[chain]) return "Unsupported or undetectable chain. Use one of: " + Object.keys(CHAINS).join(", ") + " (0x addresses default to base).";
  if (CHAINS[chain].evm && !EVM_RE.test(address)) return `Invalid ${CHAINS[chain].label} token address (expected 0x followed by 40 hex characters).`;
  if (chain === "solana" && !SOL_RE.test(address)) return "Invalid Solana mint address.";
  return null;
}

async function getJSON(url, ttl = 120, extraHeaders = {}) {
  const cache = typeof caches !== "undefined" && caches.default ? caches.default : null;
  const key = new Request(url);
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return { ok: true, status: hit.status, data: await hit.json() };
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { headers: { accept: "application/json", ...extraHeaders }, signal: ctrl.signal });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    if (res.ok && data && cache && !(data.code !== undefined && data.code !== 1)) {
      await cache.put(key, new Response(text, { headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${ttl}` } }));
    }
    return { ok: res.ok && data !== null, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: null, error: String(e) };
  } finally {
    clearTimeout(t);
  }
}

async function fetchTokenData({ address, chain }, env = {}) {
  const c = CHAINS[chain];
  const gpUrl = c.goplus + encodeURIComponent(address);
  // With a CoinGecko Demo key, use CoinGecko's on-chain API (same data as GeckoTerminal, own rate limit);
  // without one, fall back to the public GeckoTerminal API, which throttles Cloudflare's shared IPs.
  const cgKey = String(env.CG_DEMO_KEY || "").trim();
  const path = `/networks/${c.gt}/tokens/${encodeURIComponent(address)}/pools?page=1`;
  const gtReq = cgKey ? getJSON("https://api.coingecko.com/api/v3/onchain" + path, 120, { "x-cg-demo-api-key": cgKey }) : getJSON("https://api.geckoterminal.com/api/v2" + path);
  let [gp, gtPools] = await Promise.all([getJSON(gpUrl), gtReq]);
  const gpFailed = !gp.ok || !gp.data || (gp.data.code !== undefined && gp.data.code !== 1);
  let fb = null;
  if (gpFailed) {
    fb = await fallbackSecurity({ address, chain });
    if (fb) gp = { ok: true, status: 200, data: { code: 1, result: { [address]: fb.security } } };
  }
  const d = interpretTokenData({ address, chain }, gp, gtPools);
  if (fb) { d.extraRed = fb.extraRed; d.securitySource = fb.source; }
  return d;
}

// Backup security sources, used only when GoPlus is unavailable (it throttles Cloudflare's shared IPs).
// Their results are mapped onto GoPlus field names so the same grading rules apply.
const HONEYPOT_CHAIN_IDS = { ethereum: 1, bsc: 56, base: 8453 };
async function fallbackSecurity({ address, chain }) {
  if (chain === "solana") {
    const r = await getJSON(`https://api.rugcheck.xyz/v1/tokens/${encodeURIComponent(address)}/report`, 300);
    const j = r.ok && r.data;
    if (!j || !j.mint) return null;
    const meta = j.tokenMeta || {};
    const extraRed = [{ severity: "low", flag: "limited_checks", detail: "Primary security source was unavailable; Solana authority, fee and holder checks came from RugCheck." }];
    if (j.rugged) extraRed.push({ severity: "critical", flag: "rugged", detail: "RugCheck marks this token as rugged." });
    for (const k of j.risks || []) if (k && k.level === "danger" && !/mint authority|freeze authority|top 10|single holder|low liquidity|low amount of lp/i.test(String(k.name))) extraRed.push({ severity: "high", flag: "rugcheck_danger", detail: `RugCheck: ${String(k.name).slice(0, 120)}.` });
    return {
      source: "RugCheck",
      extraRed,
      security: {
        mintable: { status: j.mintAuthority ? "1" : "0" },
        freezable: { status: j.freezeAuthority ? "1" : "0" },
        metadata_mutable: { status: meta.mutable ? "1" : "0" },
        metadata: { name: meta.name || null, symbol: meta.symbol || null },
        transfer_fee: { current_fee_rate: j.transferFee && Number.isFinite(+j.transferFee.pct) ? +j.transferFee.pct / 100 : 0 },
        holder_count: j.totalHolders != null ? String(j.totalHolders) : undefined,
        holders: (j.topHolders || []).map((h) => ({ account: h.owner || h.address, percent: String((+h.pct || 0) / 100), is_locked: 0 })),
      },
    };
  }
  const id = HONEYPOT_CHAIN_IDS[chain];
  if (!id) return null;
  const r = await getJSON(`https://api.honeypot.is/v2/IsHoneypot?address=${encodeURIComponent(address)}&chainID=${id}`, 300);
  const j = r.ok && r.data;
  if (!j || !j.token) return null;
  const sim = j.simulationResult || {}, code = j.contractCode || {}, hp = j.honeypotResult || {};
  const extraRed = [{ severity: "low", flag: "limited_checks", detail: "Primary security source was unavailable; honeypot and taxes were verified by trade simulation (Honeypot.is), but owner-permission and holder checks were not run." }];
  if (j.simulationSuccess === false) extraRed.push({ severity: "medium", flag: "simulation_failed", detail: "A test buy and sell could not be simulated, so honeypot status is unknown." });
  const tax = (v) => (v !== undefined && v !== null && Number.isFinite(+v) ? String(+v / 100) : undefined);
  return {
    source: "Honeypot.is",
    extraRed,
    security: {
      is_honeypot: hp.isHoneypot ? "1" : "0",
      buy_tax: tax(sim.buyTax),
      sell_tax: tax(sim.sellTax),
      is_open_source: code.openSource === true ? "1" : code.openSource === false ? "0" : undefined,
      is_proxy: code.isProxy ? "1" : "0",
      token_symbol: j.token.symbol || undefined,
      token_name: j.token.name || undefined,
      holder_count: j.token.totalHolders != null ? String(j.token.totalHolders) : undefined,
    },
  };
}

function interpretTokenData({ address, chain }, gp, gtPools) {
  const c = CHAINS[chain];
  // GoPlus signals throttling with HTTP 200 + code 4029; treat any non-1 code as a failed lookup, not "no token".
  if (gp.ok && gp.data && gp.data.code !== undefined && gp.data.code !== 1) gp = { ...gp, ok: false, status: gp.data.code === 4029 ? 429 : 502 };
  let security = null;
  if (gp.ok && gp.data && gp.data.result && typeof gp.data.result === "object") {
    const r = gp.data.result;
    security = r[address] || r[address.toLowerCase()] || Object.values(r)[0] || null;
    if (security && typeof security === "object" && Object.keys(security).length === 0) security = null;
  }
  const raw = gtPools.ok && gtPools.data && Array.isArray(gtPools.data.data) ? gtPools.data.data : [];
  const pools = raw.map((d) => d.attributes || {});
  const want = `${c.gt}_${c.evm ? address.toLowerCase() : address}`;
  const idOf = (d, k) => String((d.relationships && d.relationships[k] && d.relationships[k].data && d.relationships[k].data.id) || "");
  let token = null;
  for (const d of raw) {
    const a = d.attributes || {};
    const isBase = (c.evm ? idOf(d, "base_token").toLowerCase() : idOf(d, "base_token")) === want;
    const isQuote = (c.evm ? idOf(d, "quote_token").toLowerCase() : idOf(d, "quote_token")) === want;
    if (isBase || isQuote) {
      const sym = String(a.name || "").split(" / ")[isBase ? 0 : 1] || null;
      token = { symbol: sym ? sym.trim() : null, price_usd: isBase ? a.base_token_price_usd : a.quote_token_price_usd, fdv_usd: isBase ? a.fdv_usd : null };
      break;
    }
  }
  const upstreamDown = !gp.ok && gp.status !== 404 && !gtPools.ok && gtPools.status !== 404;
  const marketMissing = gtPools.status === 404 || (gtPools.ok && pools.length === 0);
  const marketUnavailable = !gtPools.ok && !marketMissing;
  return { security, token, pools, gpOk: gp.ok, gtOk: gtPools.ok, upstreamDown, marketMissing, marketUnavailable };
}

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};
const on = (v) => v === "1" || v === 1 || v === true;
const fmtUsd = (n) => (n === null ? "unknown" : n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(0)}`);
const pct = (x) => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;

function analyze(chain, address, d, now = Date.now()) {
  const red = [...(d.extraRed || [])];
  const green = [];
  const add = (severity, flag, detail) => red.push({ severity, flag, detail });
  const s = d.security || {};

  // ----- contract / mint security (GoPlus) -----
  if (!d.security) add("medium", "no_security_data", "No contract security data was available for this token, so honeypot and owner checks could not be run.");
  if (CHAINS[chain].evm && d.security) {
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
    if (!ownerLive && s.owner_address !== undefined) {
      green.push("Ownership renounced or no owner.");
      const OWNER_ONLY = ["transfer_pausable", "blacklist", "tax_modifiable", "trading_cooldown", "anti_whale_modifiable"];
      for (const f of red) if (OWNER_ONLY.includes(f.flag)) { f.severity = "low"; f.detail += " Owner is renounced, so this is likely unusable."; }
    }
    if (s.is_open_source === "1") green.push("Contract source is verified.");
    if (on(s.trust_list)) {
      green.push("On GoPlus trusted list (e.g. major stablecoin or blue-chip); its admin controls are expected and not counted as risk.");
      for (let i = red.length - 1; i >= 0; i--) if (["upgradeable_proxy", "mintable", "blacklist", "transfer_pausable", "insider_holdings", "external_call"].includes(red[i].flag)) red.splice(i, 1);
    }
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
  const holderCountRaw = num(s.holder_count);
  let top10 = null;
  if (Array.isArray(s.holders) && s.holders.length) {
    const list = s.holders.filter((h) => {
      if (on(h.is_locked)) return false;
      const a = String(h.address || h.account || "");
      if (ZERO_ADDRS.has(a.toLowerCase()) || SOL_SKIP_OWNERS.has(a)) return false;
      if (CHAINS[chain].evm && on(h.is_contract)) return false;
      return true;
    });
    top10 = list.slice(0, 10).reduce((t, h) => t + (num(h.percent) || 0), 0);
    const note = holderCountRaw !== null && holderCountRaw > 50000 ? " (may include exchange wallets)" : "";
    if (top10 > 0.5) add("high", "holder_concentration", `Top 10 wallets hold about ${pct(top10)} of supply${note}.`);
    else if (top10 > 0.3) add("medium", "holder_concentration", `Top 10 wallets hold about ${pct(top10)} of supply${note}.`);
    else green.push(`Top 10 wallets hold about ${pct(top10)} of supply.`);
  }
  const holderCount = num(s.holder_count);
  if (holderCount !== null && holderCount < 100) add("low", "few_holders", `Only ${holderCount} holders.`);
  else if (holderCount !== null && holderCount >= 10000) green.push(`${holderCount.toLocaleString("en-US")} holders.`);

  // ----- market (GeckoTerminal) -----
  const pools = d.pools || [];
  const liquidity = pools.length ? pools.reduce((t, p) => t + (num(p.reserve_in_usd) || 0), 0) : null;
  const volume24h = pools.length ? pools.reduce((t, p) => t + (num(p.volume_usd && p.volume_usd.h24) || 0), 0) : null;
  const created = pools.map((p) => Date.parse(p.pool_created_at)).filter(Number.isFinite);
  const ageDays = created.length ? (now - Math.min(...created)) / 86400000 : null;
  if (d.marketMissing) add("high", "no_market", "No DEX pools found for this token.");
  else if (d.marketUnavailable) add("low", "market_data_unavailable", "Market data was temporarily unavailable; liquidity and age were not checked.");
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
  const symbol = s.token_symbol || (s.metadata && s.metadata.symbol) || (d.token && d.token.symbol) || "This token";
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
      name: s.token_name || (s.metadata && s.metadata.name) || null,
      symbol: s.token_symbol || (s.metadata && s.metadata.symbol) || (d.token && d.token.symbol) || null,
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
    sources: d.securitySource ? SOURCES.replace("GoPlus Security", d.securitySource) : SOURCES,
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
                    tokenAddress: { type: "string", description: "Token contract address (0x...) or Solana mint" },
                    chain: { type: "string", enum: Object.keys(CHAINS), description: "Optional; 0x addresses default to base, Solana mints are auto-detected" },
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
      chain: { type: "string", enum: Object.keys(CHAINS), description: "Optional; 0x addresses default to base, Solana mints are auto-detected" },
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
      "x-guidance": "POST /check with JSON {\"tokenAddress\": \"<Base 0x address or Solana mint>\", \"chain\": one of base, ethereum, bsc, arbitrum, polygon, optimism, avalanche, solana (optional; 0x defaults to base)} or GET /check?tokenAddress=...&chain=... to get a junk/rug-risk grade (JUNK, RISKY, CAUTION, CLEAN), a 0-100 risk score, red/green flags and market stats. $0.01 USDC on Base per check via x402. Invalid addresses and tokens with no data are rejected before payment is settled. Not financial advice.",
    },
    servers: [{ url: origin }],
    paths: {
      "/check": {
        post: { operationId: "checkToken", summary: "Grade a token on Base, Ethereum, BNB Chain, Arbitrum, Polygon, Optimism, Avalanche or Solana for junk/rug risk", tags: ["Crypto", "Security"], "x-payment-info": pay, requestBody: { required: true, content: { "application/json": { schema: body } } }, responses },
        get: {
          operationId: "checkTokenGet",
          summary: "Grade a token on Base, Ethereum, BNB Chain, Arbitrum, Polygon, Optimism, Avalanche or Solana for junk/rug risk",
          tags: ["Crypto", "Security"],
          "x-payment-info": pay,
          parameters: [
            { name: "tokenAddress", in: "query", required: true, schema: { type: "string" }, description: body.properties.tokenAddress.description },
            { name: "chain", in: "query", required: false, schema: { type: "string", enum: Object.keys(CHAINS) }, description: body.properties.chain.description },
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
    if (url.pathname === "/health/data") {
      // Reports only upstream status codes (no data, no keys) so the operator can confirm the data sources respond.
      const cgKey = String(env.CG_DEMO_KEY || "").trim();
      const probe = "/networks/base/tokens/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913/pools?page=1";
      const [m, g] = await Promise.all([
        cgKey ? fetch("https://api.coingecko.com/api/v3/onchain" + probe, { headers: { accept: "application/json", "x-cg-demo-api-key": cgKey } }).then((r) => r.status, () => 0) : Promise.resolve(null),
        fetch("https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=0x833589fcd6edb6e08f4c7c32d4f71b54bda02913").then((r) => r.json().then((j) => (j && j.code) || r.status, () => r.status), () => 0),
      ]);
      const st = (u) => fetch(u, { headers: { accept: "application/json" } }).then((r) => r.status, () => 0);
      const [hp, rc] = await Promise.all([
        st("https://api.honeypot.is/v2/IsHoneypot?address=0x6982508145454Ce325dDbE47a25d4ec3d2311933&chainID=1"),
        st("https://api.rugcheck.xyz/v1/tokens/EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm/report"),
      ]);
      return json({ coingecko_key_set: !!cgKey, coingecko_status: m, goplus_code: g, honeypot_is_status: hp, rugcheck_status: rc }, 200, { "Cache-Control": "no-store" });
    }
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        service: SERVICE,
        description: DESCRIPTION,
        endpoint: `${url.origin}/check`,
        openapi: `${url.origin}/openapi.json`,
        usage: 'POST /check {"tokenAddress":"0x...","chain":"base"} or GET /check?tokenAddress=...',
        price: "$0.01 USDC on Base per check (x402)",
        humans: `Free web checker: ${url.origin}/scan`,
        chains: Object.keys(CHAINS),
        facilitator: env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET ? "cdp" : "payai",
        sources: SOURCES,
        disclaimer: DISCLAIMER,
      });
    }
    if (url.pathname === "/scan" || url.pathname === "/scan/") return scanPage(env, url);
    if (url.pathname === "/free") return handleFree(request, url);
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

    const data = await fetchTokenData(params, env);
    if (data.upstreamDown || !data.gpOk) return json({ error: "Security data source temporarily unavailable. No payment was taken; please retry shortly." }, 502);
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

const PAGE_HTML = "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>Is This Token Junk? Free Token Checker | NoJunkCrypto</title>\n<meta name=\"description\" content=\"Paste any token address and get a plain-English verdict in seconds: honeypot, sell tax, mint authority, owner powers, holder concentration, liquidity and pool age. Free. Base, Ethereum, Solana, BNB Chain and more.\">\n<meta property=\"og:title\" content=\"Is this token junk? Check it free.\">\n<meta property=\"og:description\" content=\"Paste a token address. Get JUNK, RISKY, CAUTION or CLEAN in seconds, with the reasons. Free, no sign-up.\">\n<meta property=\"og:type\" content=\"website\">\n<meta name=\"twitter:card\" content=\"summary\">\n<meta name=\"theme-color\" content=\"#13213C\">\n<link rel=\"icon\" href=\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%2313213C'/%3E%3Cpath d='M9 16.5l4.5 4.5L23 11' stroke='%23FFD23F' stroke-width='3.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\">\n<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n<link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>\n<link href=\"https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..900&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap\" rel=\"stylesheet\">\n<style>\n:root{--ink:#13213C;--ink2:#3A4558;--muted:#4A5568;--line:#D5DAE1;--paper:#FFFFFF;--soft:#F1F3F6;--gold:#FFD23F;--goldtext:#8A6A00;--red:#B01E33;--redbg:#FBE9EC;--orange:#A44A00;--orangebg:#FDEEDF;--green:#16663A;--greenbg:#E6F3EB}\n*{box-sizing:border-box}\nbody{margin:0;background:var(--paper);color:var(--ink);font-family:'Archivo',system-ui,-apple-system,sans-serif;font-variant-numeric:tabular-nums;-webkit-text-size-adjust:100%}\na{color:var(--ink)}a:hover{color:var(--goldtext)}\na:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid var(--ink);outline-offset:3px}\n.wrap{max-width:860px;margin:0 auto;padding:0 16px}\n.safety{background:var(--ink);color:#fff;font-size:13px;text-align:center;padding:7px 16px}\n.safety b{color:var(--gold)}\nheader{border-bottom:3px solid var(--ink)}\n.brand{display:flex;align-items:center;gap:10px;padding:16px 0;text-decoration:none;color:var(--ink)}\n.brand span{font-stretch:72%;font-weight:850;font-size:28px;letter-spacing:-.01em}\n.hero{background:var(--gold);padding:36px 0 32px}\n.kick{margin:0 0 10px;font-weight:700;font-size:15px;color:var(--ink)}\nh1{font-stretch:70%;font-weight:850;font-size:clamp(44px,9vw,76px);line-height:.93;letter-spacing:-.01em;margin:0 0 14px}\n.dek{font-family:'Source Serif 4',Georgia,serif;font-size:19px;line-height:1.45;margin:0 0 22px;max-width:620px}\nform{display:grid;grid-template-columns:1fr auto;gap:10px}\n.field{display:flex;flex-direction:column;gap:6px;grid-column:1 / -1}\nlabel{font-weight:700;font-size:14px}\ninput,select{font:inherit;font-size:17px;color:var(--ink);background:#fff;border:2px solid var(--ink);border-radius:6px;padding:13px 14px;min-height:52px;width:100%}\ninput::placeholder{color:#6B7486}\n.row{display:grid;grid-template-columns:1fr 1fr;gap:10px;grid-column:1 / -1}\nbutton{font:inherit;font-weight:800;font-size:18px;cursor:pointer;border-radius:6px;min-height:52px}\n.go{background:var(--ink);color:#fff;border:2px solid var(--ink);padding:0 22px}\n.go:hover{background:#0B1428}\n.go[disabled]{opacity:.6;cursor:wait}\n.tries{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:14px;font-size:14px}\n.tries button{font-size:14px;font-weight:700;min-height:44px;padding:0 14px;background:transparent;color:var(--ink);border:2px solid var(--ink)}\n.tries button:hover{background:rgba(19,33,60,.08)}\nmain{padding:28px 0 8px}\n.msg{border:2px solid var(--ink);border-radius:8px;padding:16px;font-size:16px;line-height:1.5}\n.msg.err{border-color:var(--red);background:var(--redbg)}\n.card{border:3px solid var(--ink);border-radius:10px;overflow:hidden}\n.verdict{display:flex;flex-wrap:wrap;gap:16px 22px;align-items:center;padding:22px}\n.stamp{font-stretch:68%;font-weight:900;font-size:56px;line-height:1;padding:10px 16px 8px;border-radius:6px;letter-spacing:.01em}\n.g-JUNK{background:var(--red);color:#fff}\n.g-RISKY{background:var(--orange);color:#fff}\n.g-CAUTION{background:var(--gold);color:var(--ink)}\n.g-CLEAN{background:var(--green);color:#fff}\n.vtext{flex:1 1 260px;min-width:0}\n.tname{font-stretch:80%;font-weight:800;font-size:26px;margin:0 0 4px;overflow-wrap:anywhere}\n.addr{font-size:13px;color:var(--muted);overflow-wrap:anywhere;margin:0 0 8px}\n.one{font-family:'Source Serif 4',Georgia,serif;font-size:18px;line-height:1.45;margin:0}\n.meter{padding:0 22px 18px}\n.meter .bar{height:12px;border-radius:6px;background:var(--soft);overflow:hidden;border:1px solid var(--line)}\n.meter .fill{height:100%;border-radius:6px}\n.meter p{margin:6px 0 0;font-size:14px;color:var(--muted)}\n.sect{border-top:1px solid var(--line);padding:18px 22px}\n.sect h2{font-stretch:78%;font-weight:850;font-size:22px;margin:0 0 12px}\nul.flags{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}\nul.flags li{display:flex;gap:10px;align-items:flex-start;font-size:16px;line-height:1.45}\n.sev{flex:none;font-size:12px;font-weight:800;letter-spacing:.03em;text-transform:uppercase;border-radius:3px;padding:3px 7px;margin-top:2px;min-width:72px;text-align:center}\n.s-critical{background:var(--red);color:#fff}\n.s-high{background:var(--redbg);color:var(--red)}\n.s-medium{background:var(--orangebg);color:var(--orange)}\n.s-low{background:var(--soft);color:var(--ink2)}\n.s-good{background:var(--greenbg);color:var(--green)}\n.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}\n.stat{background:var(--soft);border-radius:6px;padding:12px}\n.stat b{display:block;font-stretch:80%;font-weight:800;font-size:22px}\n.stat span{font-size:13px;color:var(--muted)}\n.actions{display:flex;flex-wrap:wrap;gap:10px;padding:18px 22px;border-top:1px solid var(--line);background:var(--soft)}\n.actions a,.actions button{display:inline-flex;align-items:center;justify-content:center;gap:8px;font-weight:800;font-size:16px;min-height:48px;padding:0 18px;border-radius:6px;text-decoration:none}\n.x{background:var(--ink);color:#fff;border:2px solid var(--ink)}\n.x:hover{color:#fff;background:#0B1428}\n.ghost{background:#fff;color:var(--ink);border:2px solid var(--ink)}\n.checked{font-size:13px;color:var(--muted);padding:0 22px 16px;margin:0;background:var(--soft)}\n.explain{padding:28px 0}\n.explain h2{font-stretch:74%;font-weight:850;font-size:34px;line-height:1;margin:0 0 14px}\n.grid4{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px}\n.grade{border-top:3px solid var(--ink);padding-top:10px}\n.grade .stamp{font-size:24px;padding:5px 9px 4px;display:inline-block}\n.grade p{font-family:'Source Serif 4',Georgia,serif;font-size:16px;line-height:1.45;margin:10px 0 0;color:var(--ink2)}\n.checks{columns:2 260px;column-gap:28px;font-family:'Source Serif 4',Georgia,serif;font-size:17px;line-height:1.5;padding-left:20px;margin:0}\n.checks li{margin-bottom:8px;break-inside:avoid}\n.partners{border-top:3px solid var(--ink);padding:24px 0 8px}\n.partners h2{font-stretch:74%;font-weight:850;font-size:30px;margin:0 0 6px}\n.partners .dek{font-size:17px;margin:0 0 16px}\n.plist{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}\n.p{border:2px solid var(--ink);border-radius:8px;padding:14px;display:flex;flex-direction:column;gap:8px}\n.p b{font-size:19px}\n.p span{font-family:'Source Serif 4',Georgia,serif;font-size:15px;line-height:1.45;color:var(--ink2)}\n.p a{align-self:flex-start;font-weight:800;font-size:15px;min-height:44px;display:inline-flex;align-items:center}\n.paid{display:inline-block;font-size:11px;font-weight:800;letter-spacing:.02em;background:var(--soft);color:var(--ink2);border-radius:3px;padding:2px 6px;vertical-align:middle;margin-left:6px}\nfooter{border-top:3px solid var(--ink);margin-top:28px;padding:20px 0 36px;font-size:14px;line-height:1.55;color:var(--ink2)}\nfooter p{margin:0 0 10px}\n.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}\n.spin{display:inline-block;width:18px;height:18px;border:3px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:s .8s linear infinite;vertical-align:-3px;margin-right:8px}\n@keyframes s{to{transform:rotate(360deg)}}\n@media (max-width:560px){form{grid-template-columns:1fr}.row{grid-template-columns:1fr}.go{width:100%}.stamp{font-size:44px}.verdict,.sect,.actions,.meter{padding-left:16px;padding-right:16px}.checked{padding-left:16px;padding-right:16px}}\n@media (prefers-reduced-motion:reduce){.spin{animation:none}}\n</style>\n</head>\n<body>\n<div class=\"safety\">We will never DM you or ask for your recovery phrase. <b>Anyone who does is a scammer.</b></div>\n<header><div class=\"wrap\"><a class=\"brand\" href=\"__HOME__\">\n<svg width=\"34\" height=\"34\" viewBox=\"0 0 32 32\" aria-hidden=\"true\"><rect width=\"32\" height=\"32\" rx=\"6\" fill=\"#13213C\"/><path d=\"M9 16.5l4.5 4.5L23 11\" stroke=\"#FFD23F\" stroke-width=\"3.5\" fill=\"none\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>\n<span>NoJunkCrypto</span></a></div></header>\n\n<section class=\"hero\"><div class=\"wrap\">\n<p class=\"kick\">Free token checker</p>\n<h1>Is this token junk?</h1>\n<p class=\"dek\">Paste a token's contract address before you buy. In a few seconds you get a grade and the plain-English reasons: honeypot traps, sell taxes, who can print more coins, and whether a few wallets own it all.</p>\n<form id=\"f\" novalidate>\n<div class=\"field\"><label for=\"addr\">Token contract address</label>\n<input id=\"addr\" name=\"address\" autocomplete=\"off\" autocapitalize=\"off\" spellcheck=\"false\" placeholder=\"0x… or a Solana mint address\" required></div>\n<div class=\"row\">\n<div class=\"field\" style=\"grid-column:auto\"><label for=\"chain\">Blockchain</label>\n<select id=\"chain\" name=\"chain\">\n<option value=\"\">Detect it for me</option>\n<option value=\"ethereum\">Ethereum</option><option value=\"base\">Base</option><option value=\"solana\">Solana</option><option value=\"bsc\">BNB Chain</option><option value=\"arbitrum\">Arbitrum</option><option value=\"polygon\">Polygon</option><option value=\"optimism\">Optimism</option><option value=\"avalanche\">Avalanche</option>\n</select></div>\n<div class=\"field\" style=\"grid-column:auto;justify-content:flex-end\"><button class=\"go\" id=\"go\" type=\"submit\">Check this token</button></div>\n</div>\n</form>\n<div class=\"tries\"><span>Try one:</span>\n<button type=\"button\" data-a=\"0x6982508145454Ce325dDbE47a25d4ec3d2311933\" data-c=\"ethereum\">PEPE</button>\n<button type=\"button\" data-a=\"EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm\" data-c=\"solana\">WIF</button>\n<button type=\"button\" data-a=\"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913\" data-c=\"base\">USDC on Base</button>\n</div>\n</div></section>\n\n<main class=\"wrap\" id=\"out\" aria-live=\"polite\"></main>\n\n<section class=\"wrap explain\">\n<h2>What the grades mean</h2>\n<div class=\"grid4\">\n<div class=\"grade\"><span class=\"stamp g-JUNK\">JUNK</span><p>A serious trap was found, or so many problems that buying is a gamble you will probably lose.</p></div>\n<div class=\"grade\"><span class=\"stamp g-RISKY\">RISKY</span><p>Several real warning signs. Insiders may control the supply, the price or your ability to sell.</p></div>\n<div class=\"grade\"><span class=\"stamp g-CAUTION\">CAUTION</span><p>Nothing fatal, but something to understand first, such as thin trading or a very new pool.</p></div>\n<div class=\"grade\"><span class=\"stamp g-CLEAN\">CLEAN</span><p>No major red flags in the contract or market data. That is not the same as a good investment.</p></div>\n</div>\n</section>\n\n<section class=\"wrap explain\" style=\"padding-top:0\">\n<h2>What we check</h2>\n<ul class=\"checks\">\n<li><b>Honeypots.</b> Can you actually sell after you buy?</li>\n<li><b>Taxes.</b> Hidden buy and sell fees, and whether the owner can raise them.</li>\n<li><b>Printing.</b> Whether someone can mint more coins and water yours down.</li>\n<li><b>Owner powers.</b> Pausing trades, blacklisting wallets, changing balances.</li>\n<li><b>Solana authorities.</b> Live mint and freeze authority on the token.</li>\n<li><b>Who holds it.</b> How much of the supply sits in the top 10 wallets.</li>\n<li><b>Liquidity.</b> How much real money is in the trading pools.</li>\n<li><b>Age.</b> How long it has traded. Most rugs happen in the first days.</li>\n</ul>\n</section>\n\n__PARTNERS__\n\n<footer><div class=\"wrap\">\n<p><b>This is an automated screen, not advice.</b> It reads public contract and market data and can be wrong, late, or fooled by a clever contract. A CLEAN grade does not mean a token will go up. Never put in money you can't afford to lose.</p>\n<p>Security data: <a href=\"https://gopluslabs.io\" rel=\"noopener\">GoPlus Security</a>. Market data: GeckoTerminal, <a href=\"https://www.coingecko.com\" rel=\"noopener\">Powered by CoinGecko</a>.</p>\n<p>For AI agents and apps: the same check is available as a paid API at <a href=\"/\">this address</a> (x402, $0.01 per check).</p>\n</div></footer>\n\n<script>\n(function(){\nvar f=document.getElementById('f'),a=document.getElementById('addr'),c=document.getElementById('chain'),go=document.getElementById('go'),out=document.getElementById('out');\nvar LABEL={ethereum:'Ethereum',base:'Base',solana:'Solana',bsc:'BNB Chain',arbitrum:'Arbitrum',polygon:'Polygon',optimism:'Optimism',avalanche:'Avalanche'};\nvar SEV={critical:'Critical',high:'High',medium:'Medium',low:'Low'};\nvar COLOR={JUNK:'#B01E33',RISKY:'#A44A00',CAUTION:'#C9A000',CLEAN:'#16663A'};\nfunction esc(s){return String(s==null?'':s).replace(/[&<>\"']/g,function(m){return{'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[m]})}\nfunction usd(n){if(n==null)return'Unknown';if(n>=1e9)return'$'+(n/1e9).toFixed(2)+'B';if(n>=1e6)return'$'+(n/1e6).toFixed(2)+'M';if(n>=1e3)return'$'+(n/1e3).toFixed(1)+'K';if(n>=1)return'$'+n.toFixed(2);if(n>0)return'$'+n.toPrecision(3);return'$0'}\nfunction age(d){if(d==null)return'Unknown';if(d<1)return'Under a day';if(d<60)return Math.floor(d)+' days';if(d<730)return Math.floor(d/30.4)+' months';return(d/365).toFixed(1)+' years'}\nfunction pick(s){s=String(s||'').trim();var m=s.match(/0x[0-9a-fA-F]{40}/);if(m)return m[0];m=s.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);return m?m[0]:s}\nfunction busy(b){go.disabled=b;go.innerHTML=b?'<span class=\"spin\" aria-hidden=\"true\"></span>Checking…':'Check this token'}\nfunction err(t){out.innerHTML='<div class=\"msg err\" role=\"alert\">'+esc(t)+'</div>'}\nfunction render(r){\n var t=r.token||{},m=r.market||{},g=r.grade,name=t.symbol?(t.name&&t.name!==t.symbol?esc(t.name)+' ('+esc(t.symbol)+')':esc(t.symbol)):'Unnamed token';\n var flags=(r.red_flags||[]).map(function(x){return'<li><span class=\"sev s-'+esc(x.severity)+'\">'+SEV[x.severity]+'</span><span>'+esc(x.detail)+'</span></li>'}).join('');\n var good=(r.green_flags||[]).map(function(x){return'<li><span class=\"sev s-good\">Good</span><span>'+esc(x)+'</span></li>'}).join('');\n var tag=t.symbol?'$'+String(t.symbol).replace(/[^A-Za-z0-9]/g,''):'this token';\n var share='I ran '+tag+' through the NoJunk token checker: '+g+'.\\n\\nCheck any token free before you buy:';\n var link=location.origin+location.pathname+'?a='+encodeURIComponent(t.address)+'&c='+encodeURIComponent(t.chain);\n var xurl='https://x.com/intent/post?text='+encodeURIComponent(share)+'&url='+encodeURIComponent(link);\n out.innerHTML='<article class=\"card\">'+\n '<div class=\"verdict\"><span class=\"stamp g-'+g+'\">'+g+'</span><div class=\"vtext\"><p class=\"tname\">'+name+'</p><p class=\"addr\">'+esc(LABEL[t.chain]||t.chain)+' · '+esc(t.address)+'</p><p class=\"one\">'+esc(r.one_liner)+'</p></div></div>'+\n '<div class=\"meter\"><div class=\"bar\" role=\"img\" aria-label=\"Risk score '+r.risk_score+' out of 100\"><div class=\"fill\" style=\"width:'+Math.max(3,r.risk_score)+'%;background:'+COLOR[g]+'\"></div></div><p>Risk score '+r.risk_score+' out of 100. Higher is worse.</p></div>'+\n (flags?'<div class=\"sect\"><h2>Red flags</h2><ul class=\"flags\">'+flags+'</ul></div>':'<div class=\"sect\"><h2>Red flags</h2><p style=\"margin:0\">None found.</p></div>')+\n (good?'<div class=\"sect\"><h2>In its favor</h2><ul class=\"flags\">'+good+'</ul></div>':'')+\n '<div class=\"sect\"><h2>Market</h2><div class=\"stats\">'+\n '<div class=\"stat\"><b>'+usd(m.price_usd)+'</b><span>Price</span></div>'+\n '<div class=\"stat\"><b>'+usd(m.liquidity_usd)+'</b><span>Liquidity in pools</span></div>'+\n '<div class=\"stat\"><b>'+usd(m.volume_24h_usd)+'</b><span>24-hour volume</span></div>'+\n '<div class=\"stat\"><b>'+age(m.oldest_pool_age_days)+'</b><span>Trading for</span></div>'+\n '<div class=\"stat\"><b>'+(m.top10_holder_share==null?'Unknown':Math.round(m.top10_holder_share*100)+'%')+'</b><span>Held by top 10 wallets</span></div>'+\n '<div class=\"stat\"><b>'+(t.holders==null?'Unknown':Number(t.holders).toLocaleString('en-US'))+'</b><span>Holders</span></div>'+\n '</div></div>'+\n '<div class=\"actions\"><a class=\"x\" href=\"'+esc(xurl)+'\" target=\"_blank\" rel=\"noopener\">Share on X</a><button type=\"button\" class=\"ghost\" id=\"cp\">Copy link</button><button type=\"button\" class=\"ghost\" id=\"again\">Check another</button></div>'+\n '<p class=\"checked\">Checked '+new Date(r.checked_at).toLocaleString()+'. Automated screen, not financial advice.</p>'+\n '</article>';\n document.getElementById('cp').onclick=function(){var b=this;try{navigator.clipboard.writeText(link).then(function(){b.textContent='Copied'},function(){b.textContent='Copy failed'})}catch(e){b.textContent='Copy failed'}};\n document.getElementById('again').onclick=function(){a.value='';a.focus();window.scrollTo({top:0,behavior:'smooth'})};\n try{history.replaceState(null,'',link)}catch(e){}\n out.querySelector('.card').scrollIntoView({behavior:'smooth',block:'start'});\n}\nfunction run(addr,chain){\n addr=pick(addr);a.value=addr;\n if(!addr){err('Paste a token contract address first.');a.focus();return}\n busy(true);out.innerHTML='';\n var evm=/^0x[0-9a-fA-F]{40}$/.test(addr),sol=!evm&&/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);\n if(!evm&&!sol){busy(false);err(\"That doesn't look like a token address. It should start with 0x, or be a Solana mint address.\");return}\n (chain?Promise.resolve(chain):sol?Promise.resolve('solana'):detect(addr)).then(function(ch){\n  if(evm&&ch==='solana')ch='ethereum';\n  c.value=ch;\n  var n=NET[ch],gpu=n.gp+'?contract_addresses='+encodeURIComponent(addr),gtu=GT+'/networks/'+n.gt+'/tokens/'+encodeURIComponent(addr)+'/pools?page=1';\n  return Promise.all([raw(gpu),raw(gtu)]).then(function(x){\n   return fetch('free',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({address:addr,chain:ch,gp:x[0],gt:x[1]})});\n  });\n }).then(function(res){return res.json().then(function(j){return{ok:res.ok,j:j}})}).then(function(x){\n  busy(false);\n  if(!x.ok){err(x.j&&x.j.error?x.j.error:'Something went wrong. Please try again.');return}\n  render(x.j);\n }).catch(function(){busy(false);err('Could not reach the checker. Check your connection and try again.')});\n}\nvar GPB='https://api.gopluslabs.io/api/v1/',GT='https://api.geckoterminal.com/api/v2';\nvar NET={ethereum:{gp:GPB+'token_security/1',gt:'eth'},base:{gp:GPB+'token_security/8453',gt:'base'},bsc:{gp:GPB+'token_security/56',gt:'bsc'},arbitrum:{gp:GPB+'token_security/42161',gt:'arbitrum'},polygon:{gp:GPB+'token_security/137',gt:'polygon_pos'},optimism:{gp:GPB+'token_security/10',gt:'optimism'},avalanche:{gp:GPB+'token_security/43114',gt:'avax'},solana:{gp:GPB+'solana/token_security',gt:'solana'}};\nvar FROMGT={eth:'ethereum',base:'base',bsc:'bsc',arbitrum:'arbitrum',polygon_pos:'polygon',optimism:'optimism',avax:'avalanche'};\nfunction raw(u){return fetch(u,{headers:{accept:'application/json'}}).then(function(r){return r.text().then(function(t){var d=null;try{d=JSON.parse(t)}catch(e){}return{status:r.status,data:d}})},function(){return{status:0,data:null}})}\nfunction rid(d,k){try{return String(d.relationships[k].data.id||'')}catch(e){return''}}\nfunction detect(addr){\n var want=addr.toLowerCase();\n return raw(GT+'/search/pools?query='+encodeURIComponent(addr)).then(function(x){\n  var n={};(x.data&&x.data.data||[]).forEach(function(d){[rid(d,'base_token'),rid(d,'quote_token')].forEach(function(id){id=id.toLowerCase();var k=id.lastIndexOf('_'),net=id.slice(0,k);if(k>0&&id.slice(k+1)===want&&FROMGT[net])n[net]=(n[net]||0)+1})});\n  var best=Object.keys(n).sort(function(a,b){return n[b]-n[a]})[0];return best?FROMGT[best]:'ethereum';\n });\n}\nf.addEventListener('submit',function(e){e.preventDefault();run(a.value,c.value)});\ndocument.querySelectorAll('.tries button').forEach(function(b){b.addEventListener('click',function(){c.value=b.getAttribute('data-c');run(b.getAttribute('data-a'),b.getAttribute('data-c'))})});\nvar p=new URLSearchParams(location.search);if(p.get('a')){if(p.get('c'))c.value=p.get('c');run(p.get('a'),p.get('c')||'')}\n})();\n</script>\n</body>\n</html>\n";

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
  const html = PAGE_HTML.replace("__HOME__", /^https:\/\/\S+$/.test(home) ? home.replace(/"/g, "") : url.origin + "/scan").replace("__PARTNERS__", partnersHtml(env));
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
