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
    resource: { url: `${url.origin}/check`, description: `${DESCRIPTION} Free sample (no payment): ${url.origin}/sample. Docs: ${url.origin}/llms.txt.`, mimeType: "application/json" },
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
  const responses = { 200: { description: "Risk report", content: { "application/json": { schema: out, example: EXAMPLE_OUT } } }, 402: { description: "Payment Required (x402 v2 challenge in the PAYMENT-REQUIRED header)" } };
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
      "/sample": { get: { operationId: "sampleTokenCheck", summary: "Free cached example report (BRETT on Base); no payment", tags: ["Crypto", "Security"], responses: { 200: { description: "Example request and report" } } } },
      "/check": {
        post: { operationId: "checkToken", summary: "Grade a token on Base, Ethereum, BNB Chain, Arbitrum, Polygon, Optimism, Avalanche or Solana for junk/rug risk", tags: ["Crypto", "Security"], "x-payment-info": pay, requestBody: { required: true, content: { "application/json": { schema: body, example: SAMPLE_TOKEN } } }, responses },
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


// ---------- free sample + discovery (/sample, /.well-known/x402, /llms.txt) ----------
// Samples are cached 6 h in memory (per isolate) and in caches.default (custom domains only; it is a
// no-op on *.workers.dev), so a public sample costs at most one upstream call per isolate per 6 h.
// A failed sample is remembered for 60 s so a burst of retries cannot hammer the upstream.
const SAMPLE_TTL_S = 21600;
const SAMPLE_FAIL_TTL_S = 60;
const _sampleMem = new Map();
async function cachedSample(name, produce, ctx) {
  const now = Date.now();
  const m = _sampleMem.get(name);
  if (m && now - m.at < (m.body ? SAMPLE_TTL_S : SAMPLE_FAIL_TTL_S) * 1000) return m.body;
  const cache = typeof caches !== "undefined" && caches && caches.default ? caches.default : null;
  const key = "https://sample-cache.invalid/" + encodeURIComponent(SERVICE) + "/" + name + "/v1";
  if (cache) {
    try { const hit = await cache.match(key); if (hit) { const body = await hit.text(); _sampleMem.set(name, { at: now, body }); return body; } } catch {}
  }
  let out = null;
  try { out = await produce(); } catch { out = null; }
  const body = out ? JSON.stringify(out, null, 2) : null;
  _sampleMem.set(name, { at: now, body });
  if (body && cache) {
    const p = cache.put(key, new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${SAMPLE_TTL_S}` } })).catch(() => {});
    if (ctx && ctx.waitUntil) ctx.waitUntil(p); else await p;
  }
  return body;
}
function sampleResponse(body) {
  if (!body) return json({ error: "Sample temporarily unavailable; please retry in a minute." }, 502, { "Cache-Control": "no-store" });
  return new Response(body, { headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=3600" } });
}
const NOJUNK_INDEX = "https://nojunkcrypto.com/services";
function wellKnownX402(origin, paths) {
  return json({ version: 1, resources: paths.map((p) => origin + p), instructions: `${SERVICE}: ${DESCRIPTION} Pay per call in USDC on Base via x402. Free sample: ${origin}/sample. Docs: ${origin}/llms.txt. All NoJunk services: ${NOJUNK_INDEX}` }, 200, { "Cache-Control": "public, max-age=3600" });
}
function textResponse(t) {
  return new Response(t, { headers: { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=3600" } });
}

const SAMPLE_TOKEN = { tokenAddress: "0x532f27101965dd16442E59d40670FaF5eBB142E4", chain: "base" }; // BRETT on Base, a well-known token
function tokenLlms(origin) {
  return `# ${SERVICE}

> ${DESCRIPTION}

- Endpoint: POST ${origin}/check (or GET ${origin}/check?tokenAddress=...&chain=...)
- Price: $0.01 USDC on Base per check, paid with x402 (HTTP 402 -> pay -> retry with PAYMENT-SIGNATURE). No signup, no API key.
- Invalid addresses and tokens with no data are rejected before payment is settled.
- Chains: ${Object.keys(CHAINS).join(", ")} (0x addresses default to base; Solana mints are auto-detected)
- Free sample (no payment, cached): ${origin}/sample
- OpenAPI: ${origin}/openapi.json
- x402 discovery: ${origin}/.well-known/x402

## Example
Request: POST ${origin}/check {"tokenAddress":"${SAMPLE_TOKEN.tokenAddress}","chain":"base"}
Response (abridged): ${JSON.stringify({ grade: EXAMPLE_OUT.grade, risk_score: EXAMPLE_OUT.risk_score, one_liner: EXAMPLE_OUT.one_liner, red_flags: EXAMPLE_OUT.red_flags, green_flags: EXAMPLE_OUT.green_flags })}

## Related
- NoJunk Address Check (wallet/contract safety before you send or approve): https://nojunk-address-check.mick8511.workers.dev/llms.txt
- All NoJunk services: ${NOJUNK_INDEX}
`;
}

export default {
  async fetch(request, env0, ctx) {
    const env = { ...(env0 || {}), PAY_TO: (env0 && env0.PAY_TO) || DEFAULT_PAY_TO };
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "PAYMENT-SIGNATURE, X-PAYMENT, Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" } });
    }
    // On the public domain, the home page is the free checker; the API info JSON stays at /api.
    const publicSite = /(^|\.)nojunkcrypto\.com$/i.test(url.hostname);
    if (publicSite && url.pathname === "/") return scanPage(env, url);
    if (url.pathname === "/api") url.pathname = "/";
    if (url.pathname === "/sample") {
      return sampleResponse(await cachedSample("token-brett-base", async () => {
        const d = await fetchTokenData({ address: SAMPLE_TOKEN.tokenAddress, chain: SAMPLE_TOKEN.chain }, env);
        if (d.upstreamDown || !d.gpOk) return null;
        if (!d.security && !d.token && !d.pools.length) return null;
        return { note: `Free sample (cached up to 6 h). Paid endpoint: POST ${url.origin}/check, $0.01 USDC on Base via x402.`, request: { method: "POST", url: `${url.origin}/check`, body: SAMPLE_TOKEN }, response: analyze(SAMPLE_TOKEN.chain, SAMPLE_TOKEN.tokenAddress, d) };
      }, ctx));
    }
    if (url.pathname === "/.well-known/x402") return wellKnownX402(url.origin, ["/check"]);
    if (url.pathname === "/llms.txt") return textResponse(publicSite ? catalogLlms() : tokenLlms(url.origin));
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
        free_sample: `${url.origin}/sample`,
        llms_txt: `${url.origin}/llms.txt`,
        x402_discovery: `${url.origin}/.well-known/x402`,
        all_services: NOJUNK_INDEX,
        chains: Object.keys(CHAINS),
        facilitator: env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET ? "cdp" : "payai",
        sources: SOURCES,
        disclaimer: DISCLAIMER,
      });
    }
    if (url.pathname === "/scan" || url.pathname === "/scan/") return scanPage(env, url);
    if (url.pathname === "/free") return handleFree(request, url);
    if (url.pathname === "/og.png") return ogImage();
    { const r = siteRoute(request, url, env); if (r) return r; }
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

const SITE_CSS = "\n:root{--ink:#13213C;--ink2:#3A4558;--muted:#4A5568;--line:#D5DAE1;--paper:#FFFFFF;--soft:#F1F3F6;--gold:#FFD23F;--goldtext:#8A6A00;--red:#B01E33;--redbg:#FBE9EC;--orange:#A44A00;--orangebg:#FDEEDF;--green:#16663A;--greenbg:#E6F3EB}\n*{box-sizing:border-box}\nbody{margin:0;background:var(--paper);color:var(--ink);font-family:'Archivo',system-ui,-apple-system,sans-serif;font-variant-numeric:tabular-nums;-webkit-text-size-adjust:100%}\na{color:var(--ink)}a:hover{color:var(--goldtext)}\na:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid var(--ink);outline-offset:3px}\n.wrap{max-width:860px;margin:0 auto;padding:0 16px}\n.safety{background:var(--ink);color:#fff;font-size:13px;text-align:center;padding:7px 16px}\n.safety b{color:var(--gold)}\nheader{border-bottom:3px solid var(--ink)}\n.brand{display:flex;align-items:center;gap:10px;padding:16px 0;text-decoration:none;color:var(--ink)}\n.brand span{font-stretch:72%;font-weight:850;font-size:28px;letter-spacing:-.01em}\n.hero{background:var(--gold);padding:36px 0 32px}\n.kick{margin:0 0 10px;font-weight:700;font-size:15px;color:var(--ink)}\nh1{font-stretch:70%;font-weight:850;font-size:clamp(44px,9vw,76px);line-height:.93;letter-spacing:-.01em;margin:0 0 14px}\n.dek{font-family:'Source Serif 4',Georgia,serif;font-size:19px;line-height:1.45;margin:0 0 22px;max-width:620px}\nform{display:grid;grid-template-columns:1fr auto;gap:10px}\n.field{display:flex;flex-direction:column;gap:6px;grid-column:1 / -1}\nlabel{font-weight:700;font-size:14px}\ninput,select{font:inherit;font-size:17px;color:var(--ink);background:#fff;border:2px solid var(--ink);border-radius:6px;padding:13px 14px;min-height:52px;width:100%}\ninput::placeholder{color:#6B7486}\n.row{display:grid;grid-template-columns:1fr 1fr;gap:10px;grid-column:1 / -1}\nbutton{font:inherit;font-weight:800;font-size:18px;cursor:pointer;border-radius:6px;min-height:52px}\n.go{background:var(--ink);color:#fff;border:2px solid var(--ink);padding:0 22px}\n.go:hover{background:#0B1428}\n.go[disabled]{opacity:.6;cursor:wait}\n.tries{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:14px;font-size:14px}\n.tries button{font-size:14px;font-weight:700;min-height:44px;padding:0 14px;background:transparent;color:var(--ink);border:2px solid var(--ink)}\n.tries button:hover{background:rgba(19,33,60,.08)}\nmain{padding:28px 0 8px}\n.msg{border:2px solid var(--ink);border-radius:8px;padding:16px;font-size:16px;line-height:1.5}\n.msg.err{border-color:var(--red);background:var(--redbg)}\n.card{border:3px solid var(--ink);border-radius:10px;overflow:hidden}\n.verdict{display:flex;flex-wrap:wrap;gap:16px 22px;align-items:center;padding:22px}\n.stamp{font-stretch:68%;font-weight:900;font-size:56px;line-height:1;padding:10px 16px 8px;border-radius:6px;letter-spacing:.01em}\n.g-JUNK{background:var(--red);color:#fff}\n.g-RISKY{background:var(--orange);color:#fff}\n.g-CAUTION{background:var(--gold);color:var(--ink)}\n.g-CLEAN{background:var(--green);color:#fff}\n.vtext{flex:1 1 260px;min-width:0}\n.tname{font-stretch:80%;font-weight:800;font-size:26px;margin:0 0 4px;overflow-wrap:anywhere}\n.addr{font-size:13px;color:var(--muted);overflow-wrap:anywhere;margin:0 0 8px}\n.one{font-family:'Source Serif 4',Georgia,serif;font-size:18px;line-height:1.45;margin:0}\n.meter{padding:0 22px 18px}\n.meter .bar{height:12px;border-radius:6px;background:var(--soft);overflow:hidden;border:1px solid var(--line)}\n.meter .fill{height:100%;border-radius:6px}\n.meter p{margin:6px 0 0;font-size:14px;color:var(--muted)}\n.sect{border-top:1px solid var(--line);padding:18px 22px}\n.sect h2{font-stretch:78%;font-weight:850;font-size:22px;margin:0 0 12px}\nul.flags{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}\nul.flags li{display:flex;gap:10px;align-items:flex-start;font-size:16px;line-height:1.45}\n.sev{flex:none;font-size:12px;font-weight:800;letter-spacing:.03em;text-transform:uppercase;border-radius:3px;padding:3px 7px;margin-top:2px;min-width:72px;text-align:center}\n.s-critical{background:var(--red);color:#fff}\n.s-high{background:var(--redbg);color:var(--red)}\n.s-medium{background:var(--orangebg);color:var(--orange)}\n.s-low{background:var(--soft);color:var(--ink2)}\n.s-good{background:var(--greenbg);color:var(--green)}\n.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}\n.stat{background:var(--soft);border-radius:6px;padding:12px}\n.stat b{display:block;font-stretch:80%;font-weight:800;font-size:22px}\n.stat span{font-size:13px;color:var(--muted)}\n.actions{display:flex;flex-wrap:wrap;gap:10px;padding:18px 22px;border-top:1px solid var(--line);background:var(--soft)}\n.actions a,.actions button{display:inline-flex;align-items:center;justify-content:center;gap:8px;font-weight:800;font-size:16px;min-height:48px;padding:0 18px;border-radius:6px;text-decoration:none}\n.x{background:var(--ink);color:#fff;border:2px solid var(--ink)}\n.x:hover{color:#fff;background:#0B1428}\n.ghost{background:#fff;color:var(--ink);border:2px solid var(--ink)}\n.checked{font-size:13px;color:var(--muted);padding:0 22px 16px;margin:0;background:var(--soft)}\n.explain{padding:28px 0}\n.explain h2{font-stretch:74%;font-weight:850;font-size:34px;line-height:1;margin:0 0 14px}\n.grid4{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px}\n.grade{border-top:3px solid var(--ink);padding-top:10px}\n.grade .stamp{font-size:24px;padding:5px 9px 4px;display:inline-block}\n.grade p{font-family:'Source Serif 4',Georgia,serif;font-size:16px;line-height:1.45;margin:10px 0 0;color:var(--ink2)}\n.checks{columns:2 260px;column-gap:28px;font-family:'Source Serif 4',Georgia,serif;font-size:17px;line-height:1.5;padding-left:20px;margin:0}\n.checks li{margin-bottom:8px;break-inside:avoid}\n.partners{border-top:3px solid var(--ink);padding:24px 0 8px}\n.partners h2{font-stretch:74%;font-weight:850;font-size:30px;margin:0 0 6px}\n.partners .dek{font-size:17px;margin:0 0 16px}\n.plist{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}\n.p{border:2px solid var(--ink);border-radius:8px;padding:14px;display:flex;flex-direction:column;gap:8px}\n.p b{font-size:19px}\n.p span{font-family:'Source Serif 4',Georgia,serif;font-size:15px;line-height:1.45;color:var(--ink2)}\n.p a{align-self:flex-start;font-weight:800;font-size:15px;min-height:44px;display:inline-flex;align-items:center}\n.paid{display:inline-block;font-size:11px;font-weight:800;letter-spacing:.02em;background:var(--soft);color:var(--ink2);border-radius:3px;padding:2px 6px;vertical-align:middle;margin-left:6px}\nfooter{border-top:3px solid var(--ink);margin-top:28px;padding:20px 0 36px;font-size:14px;line-height:1.55;color:var(--ink2)}\nfooter p{margin:0 0 10px}\n.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}\n.spin{display:inline-block;width:18px;height:18px;border:3px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:s .8s linear infinite;vertical-align:-3px;margin-right:8px}\n@keyframes s{to{transform:rotate(360deg)}}\n@media (max-width:560px){form{grid-template-columns:1fr}.row{grid-template-columns:1fr}.go{width:100%}.stamp{font-size:44px}.verdict,.sect,.actions,.meter{padding-left:16px;padding-right:16px}.checked{padding-left:16px;padding-right:16px}}\n@media (prefers-reduced-motion:reduce){.spin{animation:none}}\n\n";
const PAGE_HTML = "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>Is This Token Junk? Free Token Checker | NoJunkCrypto</title>\n<meta name=\"description\" content=\"Paste any token address and get a plain-English verdict in seconds: honeypot, sell tax, mint authority, owner powers, holder concentration, liquidity and pool age. Free. Base, Ethereum, Solana, BNB Chain and more.\">\n<meta property=\"og:title\" content=\"Is this token junk? Check it free.\">\n<meta property=\"og:description\" content=\"Paste a token address. Get JUNK, RISKY, CAUTION or CLEAN in seconds, with the reasons. Free, no sign-up.\">\n<meta property=\"og:type\" content=\"website\">\n<meta property=\"og:image\" content=\"__OGIMG__\">\n<meta property=\"og:image:width\" content=\"1200\">\n<meta property=\"og:image:height\" content=\"630\">\n<meta property=\"og:image:alt\" content=\"NoJunkCrypto: Is this token junk? Free token checker.\">\n<meta name=\"twitter:card\" content=\"summary_large_image\">\n<meta name=\"twitter:image\" content=\"__OGIMG__\">\n<meta name=\"theme-color\" content=\"#13213C\">\n<link rel=\"canonical\" href=\"__CANONICAL__\">\n<meta property=\"og:url\" content=\"__CANONICAL__\">\n<link rel=\"icon\" href=\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%2313213C'/%3E%3Cpath d='M9 16.5l4.5 4.5L23 11' stroke='%23FFD23F' stroke-width='3.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\">\n<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n<link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>\n<link href=\"https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..900&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap\" rel=\"stylesheet\">\n<style>\n:root{--ink:#13213C;--ink2:#3A4558;--muted:#4A5568;--line:#D5DAE1;--paper:#FFFFFF;--soft:#F1F3F6;--gold:#FFD23F;--goldtext:#8A6A00;--red:#B01E33;--redbg:#FBE9EC;--orange:#A44A00;--orangebg:#FDEEDF;--green:#16663A;--greenbg:#E6F3EB}\n*{box-sizing:border-box}\nbody{margin:0;background:var(--paper);color:var(--ink);font-family:'Archivo',system-ui,-apple-system,sans-serif;font-variant-numeric:tabular-nums;-webkit-text-size-adjust:100%}\na{color:var(--ink)}a:hover{color:var(--goldtext)}\na:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid var(--ink);outline-offset:3px}\n.wrap{max-width:860px;margin:0 auto;padding:0 16px}\n.safety{background:var(--ink);color:#fff;font-size:13px;text-align:center;padding:7px 16px}\n.safety b{color:var(--gold)}\nheader{border-bottom:3px solid var(--ink)}\n.brand{display:flex;align-items:center;gap:10px;padding:16px 0;text-decoration:none;color:var(--ink)}\n.brand span{font-stretch:72%;font-weight:850;font-size:28px;letter-spacing:-.01em}\n.hero{background:var(--gold);padding:36px 0 32px}\n.kick{margin:0 0 10px;font-weight:700;font-size:15px;color:var(--ink)}\nh1{font-stretch:70%;font-weight:850;font-size:clamp(44px,9vw,76px);line-height:.93;letter-spacing:-.01em;margin:0 0 14px}\n.dek{font-family:'Source Serif 4',Georgia,serif;font-size:19px;line-height:1.45;margin:0 0 22px;max-width:620px}\nform{display:grid;grid-template-columns:1fr auto;gap:10px}\n.field{display:flex;flex-direction:column;gap:6px;grid-column:1 / -1}\nlabel{font-weight:700;font-size:14px}\ninput,select{font:inherit;font-size:17px;color:var(--ink);background:#fff;border:2px solid var(--ink);border-radius:6px;padding:13px 14px;min-height:52px;width:100%}\ninput::placeholder{color:#6B7486}\n.row{display:grid;grid-template-columns:1fr 1fr;gap:10px;grid-column:1 / -1}\nbutton{font:inherit;font-weight:800;font-size:18px;cursor:pointer;border-radius:6px;min-height:52px}\n.go{background:var(--ink);color:#fff;border:2px solid var(--ink);padding:0 22px}\n.go:hover{background:#0B1428}\n.go[disabled]{opacity:.6;cursor:wait}\n.tries{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:14px;font-size:14px}\n.tries button{font-size:14px;font-weight:700;min-height:44px;padding:0 14px;background:transparent;color:var(--ink);border:2px solid var(--ink)}\n.tries button:hover{background:rgba(19,33,60,.08)}\nmain{padding:28px 0 8px}\n.msg{border:2px solid var(--ink);border-radius:8px;padding:16px;font-size:16px;line-height:1.5}\n.msg.err{border-color:var(--red);background:var(--redbg)}\n.card{border:3px solid var(--ink);border-radius:10px;overflow:hidden}\n.verdict{display:flex;flex-wrap:wrap;gap:16px 22px;align-items:center;padding:22px}\n.stamp{font-stretch:68%;font-weight:900;font-size:56px;line-height:1;padding:10px 16px 8px;border-radius:6px;letter-spacing:.01em}\n.g-JUNK{background:var(--red);color:#fff}\n.g-RISKY{background:var(--orange);color:#fff}\n.g-CAUTION{background:var(--gold);color:var(--ink)}\n.g-CLEAN{background:var(--green);color:#fff}\n.vtext{flex:1 1 260px;min-width:0}\n.tname{font-stretch:80%;font-weight:800;font-size:26px;margin:0 0 4px;overflow-wrap:anywhere}\n.addr{font-size:13px;color:var(--muted);overflow-wrap:anywhere;margin:0 0 8px}\n.one{font-family:'Source Serif 4',Georgia,serif;font-size:18px;line-height:1.45;margin:0}\n.meter{padding:0 22px 18px}\n.meter .bar{height:12px;border-radius:6px;background:var(--soft);overflow:hidden;border:1px solid var(--line)}\n.meter .fill{height:100%;border-radius:6px}\n.meter p{margin:6px 0 0;font-size:14px;color:var(--muted)}\n.sect{border-top:1px solid var(--line);padding:18px 22px}\n.sect h2{font-stretch:78%;font-weight:850;font-size:22px;margin:0 0 12px}\nul.flags{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}\nul.flags li{display:flex;gap:10px;align-items:flex-start;font-size:16px;line-height:1.45}\n.sev{flex:none;font-size:12px;font-weight:800;letter-spacing:.03em;text-transform:uppercase;border-radius:3px;padding:3px 7px;margin-top:2px;min-width:72px;text-align:center}\n.s-critical{background:var(--red);color:#fff}\n.s-high{background:var(--redbg);color:var(--red)}\n.s-medium{background:var(--orangebg);color:var(--orange)}\n.s-low{background:var(--soft);color:var(--ink2)}\n.s-good{background:var(--greenbg);color:var(--green)}\n.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}\n.stat{background:var(--soft);border-radius:6px;padding:12px}\n.stat b{display:block;font-stretch:80%;font-weight:800;font-size:22px}\n.stat span{font-size:13px;color:var(--muted)}\n.actions{display:flex;flex-wrap:wrap;gap:10px;padding:18px 22px;border-top:1px solid var(--line);background:var(--soft)}\n.actions a,.actions button{display:inline-flex;align-items:center;justify-content:center;gap:8px;font-weight:800;font-size:16px;min-height:48px;padding:0 18px;border-radius:6px;text-decoration:none}\n.x{background:var(--ink);color:#fff;border:2px solid var(--ink)}\n.x:hover{color:#fff;background:#0B1428}\n.ghost{background:#fff;color:var(--ink);border:2px solid var(--ink)}\n.checked{font-size:13px;color:var(--muted);padding:0 22px 16px;margin:0;background:var(--soft)}\n.explain{padding:28px 0}\n.explain h2{font-stretch:74%;font-weight:850;font-size:34px;line-height:1;margin:0 0 14px}\n.grid4{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px}\n.grade{border-top:3px solid var(--ink);padding-top:10px}\n.grade .stamp{font-size:24px;padding:5px 9px 4px;display:inline-block}\n.grade p{font-family:'Source Serif 4',Georgia,serif;font-size:16px;line-height:1.45;margin:10px 0 0;color:var(--ink2)}\n.checks{columns:2 260px;column-gap:28px;font-family:'Source Serif 4',Georgia,serif;font-size:17px;line-height:1.5;padding-left:20px;margin:0}\n.checks li{margin-bottom:8px;break-inside:avoid}\n.partners{border-top:3px solid var(--ink);padding:24px 0 8px}\n.partners h2{font-stretch:74%;font-weight:850;font-size:30px;margin:0 0 6px}\n.partners .dek{font-size:17px;margin:0 0 16px}\n.plist{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}\n.p{border:2px solid var(--ink);border-radius:8px;padding:14px;display:flex;flex-direction:column;gap:8px}\n.p b{font-size:19px}\n.p span{font-family:'Source Serif 4',Georgia,serif;font-size:15px;line-height:1.45;color:var(--ink2)}\n.p a{align-self:flex-start;font-weight:800;font-size:15px;min-height:44px;display:inline-flex;align-items:center}\n.paid{display:inline-block;font-size:11px;font-weight:800;letter-spacing:.02em;background:var(--soft);color:var(--ink2);border-radius:3px;padding:2px 6px;vertical-align:middle;margin-left:6px}\nfooter{border-top:3px solid var(--ink);margin-top:28px;padding:20px 0 36px;font-size:14px;line-height:1.55;color:var(--ink2)}\nfooter p{margin:0 0 10px}\n.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}\n.spin{display:inline-block;width:18px;height:18px;border:3px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:s .8s linear infinite;vertical-align:-3px;margin-right:8px}\n@keyframes s{to{transform:rotate(360deg)}}\n@media (max-width:560px){form{grid-template-columns:1fr}.row{grid-template-columns:1fr}.go{width:100%}.stamp{font-size:44px}.verdict,.sect,.actions,.meter{padding-left:16px;padding-right:16px}.checked{padding-left:16px;padding-right:16px}}\n@media (prefers-reduced-motion:reduce){.spin{animation:none}}\n__EXTRA_CSS__\n</style>\n</head>\n<body>\n<div class=\"safety\">We will never DM you or ask for your recovery phrase. <b>Anyone who does is a scammer.</b></div>\n<header><div class=\"wrap\"><a class=\"brand\" href=\"__HOME__\">\n<svg width=\"34\" height=\"34\" viewBox=\"0 0 32 32\" aria-hidden=\"true\"><rect width=\"32\" height=\"32\" rx=\"6\" fill=\"#13213C\"/><path d=\"M9 16.5l4.5 4.5L23 11\" stroke=\"#FFD23F\" stroke-width=\"3.5\" fill=\"none\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>\n<span>NoJunkCrypto</span></a>__NAV__</div></header>\n\n<section class=\"hero\"><div class=\"wrap\">\n<p class=\"kick\">Free token checker</p>\n<h1>Is this token junk?</h1>\n<p class=\"dek\">Paste a token's contract address before you buy. In a few seconds you get a grade and the plain-English reasons: honeypot traps, sell taxes, who can print more coins, and whether a few wallets own it all.</p>\n<form id=\"f\" novalidate>\n<div class=\"field\"><label for=\"addr\">Token contract address</label>\n<input id=\"addr\" name=\"address\" autocomplete=\"off\" autocapitalize=\"off\" spellcheck=\"false\" placeholder=\"0x… or a Solana mint address\" required></div>\n<div class=\"row\">\n<div class=\"field\" style=\"grid-column:auto\"><label for=\"chain\">Blockchain</label>\n<select id=\"chain\" name=\"chain\">\n<option value=\"\">Detect it for me</option>\n<option value=\"ethereum\">Ethereum</option><option value=\"base\">Base</option><option value=\"solana\">Solana</option><option value=\"bsc\">BNB Chain</option><option value=\"arbitrum\">Arbitrum</option><option value=\"polygon\">Polygon</option><option value=\"optimism\">Optimism</option><option value=\"avalanche\">Avalanche</option>\n</select></div>\n<div class=\"field\" style=\"grid-column:auto;justify-content:flex-end\"><button class=\"go\" id=\"go\" type=\"submit\">Check this token</button></div>\n</div>\n</form>\n<div class=\"tries\"><span>Try one:</span>\n<button type=\"button\" data-a=\"0x6982508145454Ce325dDbE47a25d4ec3d2311933\" data-c=\"ethereum\">PEPE</button>\n<button type=\"button\" data-a=\"EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm\" data-c=\"solana\">WIF</button>\n<button type=\"button\" data-a=\"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913\" data-c=\"base\">USDC on Base</button>\n</div>\n</div></section>\n\n<main class=\"wrap\" id=\"out\" aria-live=\"polite\"></main>\n\n<section class=\"wrap explain\">\n<h2>What the grades mean</h2>\n<div class=\"grid4\">\n<div class=\"grade\"><span class=\"stamp g-JUNK\">JUNK</span><p>A serious trap was found, or so many problems that buying is a gamble you will probably lose.</p></div>\n<div class=\"grade\"><span class=\"stamp g-RISKY\">RISKY</span><p>Several real warning signs. Insiders may control the supply, the price or your ability to sell.</p></div>\n<div class=\"grade\"><span class=\"stamp g-CAUTION\">CAUTION</span><p>Nothing fatal, but something to understand first, such as thin trading or a very new pool.</p></div>\n<div class=\"grade\"><span class=\"stamp g-CLEAN\">CLEAN</span><p>No major red flags in the contract or market data. That is not the same as a good investment.</p></div>\n</div>\n</section>\n\n<section class=\"wrap explain\" style=\"padding-top:0\">\n<h2>What we check</h2>\n<ul class=\"checks\">\n<li><b>Honeypots.</b> Can you actually sell after you buy?</li>\n<li><b>Taxes.</b> Hidden buy and sell fees, and whether the owner can raise them.</li>\n<li><b>Printing.</b> Whether someone can mint more coins and water yours down.</li>\n<li><b>Owner powers.</b> Pausing trades, blacklisting wallets, changing balances.</li>\n<li><b>Solana authorities.</b> Live mint and freeze authority on the token.</li>\n<li><b>Who holds it.</b> How much of the supply sits in the top 10 wallets.</li>\n<li><b>Liquidity.</b> How much real money is in the trading pools.</li>\n<li><b>Age.</b> How long it has traded. Most rugs happen in the first days.</li>\n</ul>\n</section>\n\n__PARTNERS__\n\n<footer><div class=\"wrap\">\n<p><b>This is an automated screen, not advice.</b> It reads public contract and market data and can be wrong, late, or fooled by a clever contract. A CLEAN grade does not mean a token will go up. Never put in money you can't afford to lose.</p>\n<p>Security data: <a href=\"https://gopluslabs.io\" rel=\"noopener\">GoPlus Security</a>. Market data: GeckoTerminal, <a href=\"https://www.coingecko.com\" rel=\"noopener\">Powered by CoinGecko</a>.</p>\n<p>For AI agents and apps: the same check is available as a paid API. <a href=\"/api\">API details</a> (x402, $0.01 per check).</p>\n</div></footer>\n\n<script>\n(function(){\nvar f=document.getElementById('f'),a=document.getElementById('addr'),c=document.getElementById('chain'),go=document.getElementById('go'),out=document.getElementById('out');\nvar LABEL={ethereum:'Ethereum',base:'Base',solana:'Solana',bsc:'BNB Chain',arbitrum:'Arbitrum',polygon:'Polygon',optimism:'Optimism',avalanche:'Avalanche'};\nvar SEV={critical:'Critical',high:'High',medium:'Medium',low:'Low'};\nvar COLOR={JUNK:'#B01E33',RISKY:'#A44A00',CAUTION:'#C9A000',CLEAN:'#16663A'};\nfunction esc(s){return String(s==null?'':s).replace(/[&<>\"']/g,function(m){return{'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[m]})}\nfunction usd(n){if(n==null)return'Unknown';if(n>=1e9)return'$'+(n/1e9).toFixed(2)+'B';if(n>=1e6)return'$'+(n/1e6).toFixed(2)+'M';if(n>=1e3)return'$'+(n/1e3).toFixed(1)+'K';if(n>=1)return'$'+n.toFixed(2);if(n>0)return'$'+n.toPrecision(3);return'$0'}\nfunction age(d){if(d==null)return'Unknown';if(d<1)return'Under a day';if(d<60)return Math.floor(d)+' days';if(d<730)return Math.floor(d/30.4)+' months';return(d/365).toFixed(1)+' years'}\nfunction pick(s){s=String(s||'').trim();var m=s.match(/0x[0-9a-fA-F]{40}/);if(m)return m[0];m=s.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);return m?m[0]:s}\nfunction busy(b){go.disabled=b;go.innerHTML=b?'<span class=\"spin\" aria-hidden=\"true\"></span>Checking…':'Check this token'}\nfunction err(t){out.innerHTML='<div class=\"msg err\" role=\"alert\">'+esc(t)+'</div>'}\nfunction render(r){\n var t=r.token||{},m=r.market||{},g=r.grade,name=t.symbol?(t.name&&t.name!==t.symbol?esc(t.name)+' ('+esc(t.symbol)+')':esc(t.symbol)):'Unnamed token';\n var FM=__FLAGMAP__;var flags=(r.red_flags||[]).map(function(x){var s=FM[x.flag];return'<li><span class=\"sev s-'+esc(x.severity)+'\">'+SEV[x.severity]+'</span><span>'+esc(x.detail)+(s?' <a class=\"flaglink\" href=\"/learn/'+s+'\">What this means</a>':'')+'</span></li>'}).join('');\n var good=(r.green_flags||[]).map(function(x){return'<li><span class=\"sev s-good\">Good</span><span>'+esc(x)+'</span></li>'}).join('');\n var tag=t.symbol?'$'+String(t.symbol).replace(/[^A-Za-z0-9]/g,''):'this token';\n var share='I ran '+tag+' through the NoJunk token checker: '+g+'.\\n\\nCheck any token free before you buy:';\n var link=location.origin+location.pathname+'?a='+encodeURIComponent(t.address)+'&c='+encodeURIComponent(t.chain);\n var xurl='https://x.com/intent/post?text='+encodeURIComponent(share)+'&url='+encodeURIComponent(link);\n out.innerHTML='<article class=\"card\">'+\n '<div class=\"verdict\"><span class=\"stamp g-'+g+'\">'+g+'</span><div class=\"vtext\"><p class=\"tname\">'+name+'</p><p class=\"addr\">'+esc(LABEL[t.chain]||t.chain)+' · '+esc(t.address)+'</p><p class=\"one\">'+esc(r.one_liner)+'</p></div></div>'+\n '<div class=\"meter\"><div class=\"bar\" role=\"img\" aria-label=\"Risk score '+r.risk_score+' out of 100\"><div class=\"fill\" style=\"width:'+Math.max(3,r.risk_score)+'%;background:'+COLOR[g]+'\"></div></div><p>Risk score '+r.risk_score+' out of 100. Higher is worse.</p></div>'+\n (flags?'<div class=\"sect\"><h2>Red flags</h2><ul class=\"flags\">'+flags+'</ul></div>':'<div class=\"sect\"><h2>Red flags</h2><p style=\"margin:0\">None found.</p></div>')+\n (good?'<div class=\"sect\"><h2>In its favor</h2><ul class=\"flags\">'+good+'</ul></div>':'')+\n '<div class=\"sect\"><h2>Market</h2><div class=\"stats\">'+\n '<div class=\"stat\"><b>'+usd(m.price_usd)+'</b><span>Price</span></div>'+\n '<div class=\"stat\"><b>'+usd(m.liquidity_usd)+'</b><span>Liquidity in pools</span></div>'+\n '<div class=\"stat\"><b>'+usd(m.volume_24h_usd)+'</b><span>24-hour volume</span></div>'+\n '<div class=\"stat\"><b>'+age(m.oldest_pool_age_days)+'</b><span>Trading for</span></div>'+\n '<div class=\"stat\"><b>'+(m.top10_holder_share==null?'Unknown':Math.round(m.top10_holder_share*100)+'%')+'</b><span>Held by top 10 wallets</span></div>'+\n '<div class=\"stat\"><b>'+(t.holders==null?'Unknown':Number(t.holders).toLocaleString('en-US'))+'</b><span>Holders</span></div>'+\n '</div></div>'+\n '<div class=\"actions\"><a class=\"x\" href=\"'+esc(xurl)+'\" target=\"_blank\" rel=\"noopener\">Share on X</a><button type=\"button\" class=\"ghost\" id=\"cp\">Copy link</button><button type=\"button\" class=\"ghost\" id=\"again\">Check another</button></div>'+\n '<p class=\"checked\">Checked '+new Date(r.checked_at).toLocaleString()+'. Automated screen, not financial advice.</p>'+\n '</article>';\n document.getElementById('cp').onclick=function(){var b=this;try{navigator.clipboard.writeText(link).then(function(){b.textContent='Copied'},function(){b.textContent='Copy failed'})}catch(e){b.textContent='Copy failed'}};\n document.getElementById('again').onclick=function(){a.value='';a.focus();window.scrollTo({top:0,behavior:'smooth'})};\n try{history.replaceState(null,'',link)}catch(e){}\n out.querySelector('.card').scrollIntoView({behavior:'smooth',block:'start'});\n}\nfunction run(addr,chain){\n addr=pick(addr);a.value=addr;\n if(!addr){err('Paste a token contract address first.');a.focus();return}\n busy(true);out.innerHTML='';\n var evm=/^0x[0-9a-fA-F]{40}$/.test(addr),sol=!evm&&/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);\n if(!evm&&!sol){busy(false);err(\"That doesn't look like a token address. It should start with 0x, or be a Solana mint address.\");return}\n (chain?Promise.resolve(chain):sol?Promise.resolve('solana'):detect(addr)).then(function(ch){\n  if(evm&&ch==='solana')ch='ethereum';\n  c.value=ch;\n  var n=NET[ch],gpu=n.gp+'?contract_addresses='+encodeURIComponent(addr),gtu=GT+'/networks/'+n.gt+'/tokens/'+encodeURIComponent(addr)+'/pools?page=1';\n  return Promise.all([raw(gpu),raw(gtu)]).then(function(x){\n   return fetch('free',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({address:addr,chain:ch,gp:x[0],gt:x[1]})});\n  });\n }).then(function(res){return res.json().then(function(j){return{ok:res.ok,j:j}})}).then(function(x){\n  busy(false);\n  if(!x.ok){err(x.j&&x.j.error?x.j.error:'Something went wrong. Please try again.');return}\n  render(x.j);\n }).catch(function(){busy(false);err('Could not reach the checker. Check your connection and try again.')});\n}\nvar GPB='https://api.gopluslabs.io/api/v1/',GT='https://api.geckoterminal.com/api/v2';\nvar NET={ethereum:{gp:GPB+'token_security/1',gt:'eth'},base:{gp:GPB+'token_security/8453',gt:'base'},bsc:{gp:GPB+'token_security/56',gt:'bsc'},arbitrum:{gp:GPB+'token_security/42161',gt:'arbitrum'},polygon:{gp:GPB+'token_security/137',gt:'polygon_pos'},optimism:{gp:GPB+'token_security/10',gt:'optimism'},avalanche:{gp:GPB+'token_security/43114',gt:'avax'},solana:{gp:GPB+'solana/token_security',gt:'solana'}};\nvar FROMGT={eth:'ethereum',base:'base',bsc:'bsc',arbitrum:'arbitrum',polygon_pos:'polygon',optimism:'optimism',avax:'avalanche'};\nfunction raw(u){return fetch(u,{headers:{accept:'application/json'}}).then(function(r){return r.text().then(function(t){var d=null;try{d=JSON.parse(t)}catch(e){}return{status:r.status,data:d}})},function(){return{status:0,data:null}})}\nfunction rid(d,k){try{return String(d.relationships[k].data.id||'')}catch(e){return''}}\nfunction detect(addr){\n var want=addr.toLowerCase();\n return raw(GT+'/search/pools?query='+encodeURIComponent(addr)).then(function(x){\n  var n={};(x.data&&x.data.data||[]).forEach(function(d){[rid(d,'base_token'),rid(d,'quote_token')].forEach(function(id){id=id.toLowerCase();var k=id.lastIndexOf('_'),net=id.slice(0,k);if(k>0&&id.slice(k+1)===want&&FROMGT[net])n[net]=(n[net]||0)+1})});\n  var best=Object.keys(n).sort(function(a,b){return n[b]-n[a]})[0];return best?FROMGT[best]:'ethereum';\n });\n}\nf.addEventListener('submit',function(e){e.preventDefault();run(a.value,c.value)});\ndocument.querySelectorAll('.tries button').forEach(function(b){b.addEventListener('click',function(){c.value=b.getAttribute('data-c');run(b.getAttribute('data-a'),b.getAttribute('data-c'))})});\nvar p=new URLSearchParams(location.search);if(p.get('a')){if(p.get('c'))c.value=p.get('c');run(p.get('a'),p.get('c')||'')}\n})();\n</script>\n</body>\n</html>\n";
const OG_PNG_B64 = "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";

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
  const html = PAGE_HTML.replace("__HOME__", homeHref).split("__CANONICAL__").join(canonical).split("__OGIMG__").join((isPublic ? "https://nojunkcrypto.com" : url.origin) + "/og.png").replace("__NAV__", navHtml("/")).replace("__EXTRA_CSS__", EXTRA_CSS).replace("__FLAGMAP__", JSON.stringify(FLAG_TO_SLUG)).replace("__PARTNERS__", partnersHtml(env));
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

// ---------- nojunkcrypto.com site pages (wallet checker, explainers, info pages, sitemap) ----------
const SITE_NAME = "NoJunkCrypto";
const SITE_ORIGIN = "https://nojunkcrypto.com";
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));

const NAV = [
  ["/", "Token checker"],
  ["/wallet", "Wallet checker"],
  ["/learn", "Red flags explained"],
  ["/about", "About"],
];

const EXTRA_CSS = `
.nav{display:flex;flex-wrap:wrap;gap:4px 22px;padding:0 0 6px}
header .wrap{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:4px 24px}
.nav a{text-decoration:none;font-weight:600;font-size:15px;padding:10px 0;border-bottom:3px solid transparent;min-height:44px;display:inline-flex;align-items:center}
.nav a.on{border-bottom-color:var(--gold)}
.hero.plain{background:var(--paper);padding:30px 0 10px;border-bottom:3px solid var(--ink)}
.hero.plain h1{font-size:clamp(36px,7vw,60px)}
.prose{font-family:'Source Serif 4',Georgia,serif;font-size:18px;line-height:1.55;max-width:720px}
.prose h2{font-family:'Archivo',system-ui,sans-serif;font-stretch:76%;font-weight:850;font-size:28px;line-height:1.05;margin:30px 0 10px}
.prose p{margin:0 0 16px}
.prose ul,.prose ol{padding-left:22px;margin:0 0 16px}
.prose li{margin-bottom:8px}
.prose .callout{border:3px solid var(--ink);border-radius:8px;padding:14px 16px;margin:18px 0;font-family:'Archivo',system-ui,sans-serif;font-size:16px}
.prose .callout b{display:block;font-size:14px;letter-spacing:.02em;text-transform:uppercase;margin-bottom:4px}
.prose .callout.danger{background:var(--redbg);border-color:var(--red)}
.prose .callout.ok{background:var(--greenbg);border-color:var(--green)}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px;margin:18px 0}
.lcard{border:2px solid var(--ink);border-radius:8px;padding:16px;text-decoration:none;display:flex;flex-direction:column;gap:8px;color:var(--ink)}
.lcard:hover{background:var(--soft);color:var(--ink)}
.lcard b{font-stretch:80%;font-weight:800;font-size:21px;line-height:1.1}
.lcard span{font-family:'Source Serif 4',Georgia,serif;font-size:15px;line-height:1.45;color:var(--ink2)}
.cta{display:inline-flex;align-items:center;min-height:48px;padding:0 20px;border-radius:6px;background:var(--ink);color:#fff;font-weight:800;text-decoration:none;font-family:'Archivo',system-ui,sans-serif;font-size:16px}
.cta:hover{color:#fff;background:#0B1428}
.flaglink{color:var(--ink);text-decoration:underline;text-decoration-color:var(--gold);text-decoration-thickness:2px;text-underline-offset:3px}
.sev-key{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 18px}
`;

function navHtml(path) {
  return `<nav class="nav" aria-label="Main">${NAV.map(([h, l]) => `<a href="${h}"${h === path || (h !== "/" && path.startsWith(h)) ? ' class="on"' : ""}>${l}</a>`).join("")}</nav>`;
}

function shell({ title, description, path, body, extraHead = "", bodyClass = "", nav = true }) {
  const canonical = SITE_ORIGIN + path;
  const navHtmlStr = nav ? navHtml(path) : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} | ${SITE_NAME}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${canonical}">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:type" content="website">
<meta property="og:url" content="${canonical}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${SITE_ORIGIN}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="NoJunkCrypto: Is this token junk? Free token checker.">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${SITE_ORIGIN}/og.png">
<meta name="theme-color" content="#13213C">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%2313213C'/%3E%3Cpath d='M9 16.5l4.5 4.5L23 11' stroke='%23FFD23F' stroke-width='3.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..900&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap" rel="stylesheet">
<style>${SITE_CSS}${EXTRA_CSS}</style>
${extraHead}
</head>
<body class="${bodyClass}">
<div class="safety">We will never DM you or ask for your recovery phrase. <b>Anyone who does is a scammer.</b></div>
<header><div class="wrap"><a class="brand" href="/">
<svg width="34" height="34" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="6" fill="#13213C"/><path d="M9 16.5l4.5 4.5L23 11" stroke="#FFD23F" stroke-width="3.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
<span>${SITE_NAME}</span></a>${navHtmlStr}</div></header>
${body}
<footer><div class="wrap">
<p><b>This is an automated screen, not advice.</b> It reads public blockchain and security data and can be wrong, late, or fooled by a clever contract. A clean result is not proof of safety. Never put in money you can't afford to lose.</p>
<p><a href="/about">About</a> · <a href="/learn">Red flags explained</a> · <a href="/disclosure">How we make money</a> · <a href="/privacy">Privacy</a> · <a href="/contact">Contact</a> · <a href="/api">API for AI agents</a></p>
<p>Security data: <a href="https://gopluslabs.io" rel="noopener">GoPlus Security</a>. Market data: GeckoTerminal, <a href="https://www.coingecko.com" rel="noopener">Powered by CoinGecko</a>.</p>
</div></footer>
</body>
</html>`;
}

const htmlResponse = (html, extra = {}) =>
  new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=600",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https://api.gopluslabs.io https://api.geckoterminal.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      ...extra,
    },
  });

// ---------- red-flag explainers ----------
const FLAG_PAGES = {
  honeypot: {
    title: "What is a honeypot token?",
    short: "You can buy it, but you can never sell. The most common way newcomers lose everything.",
    flags: ["honeypot", "cannot_sell_all", "cannot_buy"],
    sev: "critical",
    body: `
<p>A honeypot is a token whose contract lets you buy but quietly blocks you from selling. The chart looks healthy because every trade is a buy. Nobody can get out, so the price only goes up, until the creator pulls the money and it goes to zero.</p>
<h2>How it works</h2>
<p>The sell function is rigged. It might fail for everyone except the creator's wallet, charge a 100% tax on sales, or require an approval that never gets granted. From the outside it looks like a normal token. The trap is only in the code.</p>
<h2>How we catch it</h2>
<p>We check the contract's code for known honeypot patterns and run a simulated buy and sell. If the sell fails or returns almost nothing, the token is marked <b>JUNK</b> no matter what else looks good.</p>
<div class="callout danger"><b>If you see this flag</b>Do not buy. There is no "small position" in a honeypot. Whatever you put in stays in.</div>
<h2>Already holding one?</h2>
<p>Try selling a tiny amount on the exchange the token trades on. If it fails, the money is most likely gone. Do not pay anyone who offers to "recover" it: that is a second scam aimed at the same victims.</p>`,
  },
  "sell-tax": {
    title: "What is a sell tax (and a buy tax)?",
    short: "A fee the contract takes from every trade. A few percent is common, over 10% is a warning, over 50% is a trap.",
    flags: ["sell_tax", "buy_tax", "tax_modifiable", "transfer_fee"],
    sev: "high",
    body: `
<p>Some tokens charge a fee on every buy, sell or transfer, written into the contract. The project keeps the fee. A 5% sell tax means you lose 5% the moment you sell, on top of normal exchange fees and price moves.</p>
<h2>What's normal</h2>
<ul>
<li><b>0%:</b> most established tokens. Bitcoin, Ethereum, stablecoins and the major coins have no built-in tax.</li>
<li><b>1% to 5%:</b> common on meme and "reflection" tokens. Not a scam by itself, but it eats into any gain.</li>
<li><b>Over 10%:</b> a red flag. You need a 10% gain just to break even.</li>
<li><b>Over 50%:</b> effectively a honeypot. We mark these JUNK.</li>
</ul>
<h2>The quieter danger: changeable taxes</h2>
<p>Some contracts let the owner change the tax at any time. A token can launch at 2% and move to 99% once enough people have bought. We flag this as <b>taxes can be changed</b>, and treat it as a serious warning unless the owner has given up control.</p>
<div class="callout"><b>Rule of thumb</b>If you can't say why a token needs a tax, it doesn't. The tax is the product.</div>`,
  },
  "mint-authority": {
    title: "Mint authority: who can print more coins?",
    short: "If someone can create new tokens at will, your share of the supply can be watered down to nothing.",
    flags: ["mintable", "mint_authority"],
    sev: "high",
    body: `
<p>Every token has a supply. If the contract has a working mint function, or on Solana a live mint authority, someone can create more tokens whenever they like. Your 1% of the supply becomes 0.01% overnight, and the price falls to match.</p>
<h2>Why it matters more than it sounds</h2>
<p>A creator who can mint doesn't need a honeypot. They can print a huge batch, sell it into the pool, and walk away. Holders see the price collapse and only later learn the supply quietly tripled.</p>
<h2>What good looks like</h2>
<ul>
<li>On Ethereum-style chains: no mint function, or the owner has <b>renounced</b> ownership so no one can call it.</li>
<li>On Solana: <b>mint authority revoked</b>. This is a one-time, permanent step and serious projects do it at launch.</li>
</ul>
<div class="callout ok"><b>Green flag</b>"Mint authority revoked" or "Ownership renounced" means nobody can print more. It's one of the strongest signals a token isn't set up to rug.</div>`,
  },
  "freeze-authority": {
    title: "Freeze authority: can they lock your wallet?",
    short: "A Solana setting that lets the token's creator freeze any holder's tokens so they can't be moved or sold.",
    flags: ["freeze_authority", "transfer_pausable", "blacklist", "non_transferable"],
    sev: "high",
    body: `
<p>On Solana, a token can keep a <b>freeze authority</b>. Whoever holds it can freeze the token in any wallet. Your balance still shows, but you can't send or sell. On Ethereum-style chains the same trick comes as a <b>pause</b> switch or a <b>blacklist</b> that blocks chosen addresses.</p>
<h2>How scams use it</h2>
<p>The creator lets early buyers in, freezes everyone once the pool has enough money, then sells their own tokens into it. Frozen holders can only watch.</p>
<h2>Legitimate uses</h2>
<p>Regulated stablecoins like USDC keep freeze and blacklist powers to comply with sanctions law. That's why we don't count these powers against tokens on the trusted list. For an unknown meme token, there is no good reason to have them.</p>
<div class="callout ok"><b>Green flag</b>"Freeze authority revoked" on Solana, or "Ownership renounced" on other chains, means nobody can lock you out.</div>`,
  },
  "owner-powers": {
    title: "Owner powers: what the creator can still do",
    short: "Hidden owners, balance changes, self-destruct and other switches that let one wallet control everyone's money.",
    flags: ["hidden_owner", "can_take_back_ownership", "owner_can_change_balances", "selfdestruct", "upgradeable_proxy", "external_call", "trading_cooldown", "anti_whale_modifiable", "closable", "transfer_hook", "metadata_mutable"],
    sev: "high",
    body: `
<p>A token contract can give its owner powers far beyond what a normal coin has. We check for the ones that matter:</p>
<ul>
<li><b>Hidden owner:</b> the contract says ownership was given up, but a backdoor still lets someone control it.</li>
<li><b>Can take back ownership:</b> "renounced" today, reclaimed tomorrow.</li>
<li><b>Owner can change balances:</b> the owner can edit how many tokens you hold. Yes, really.</li>
<li><b>Self-destruct:</b> the contract can be deleted, taking every balance with it.</li>
<li><b>Upgradeable proxy:</b> the code can be swapped for different code later. Fine for big, audited projects; dangerous for an anonymous launch.</li>
<li><b>External calls:</b> the contract calls other contracts during trades, so its behavior can change without the code changing.</li>
</ul>
<h2>Renounced ownership</h2>
<p>When an owner renounces, owner-only powers can no longer be used. We downgrade pause, blacklist and tax-change flags to "low" when ownership is renounced, because the switch exists but nobody can flip it.</p>
<div class="callout"><b>The question to ask</b>If the creator decided to take everyone's money tonight, could the code let them? If yes, the only thing protecting you is their good will.</div>`,
  },
  "holder-concentration": {
    title: "Holder concentration: who owns it all?",
    short: "When a few wallets hold most of the supply, they set the price, and they can crash it whenever they sell.",
    flags: ["holder_concentration", "insider_holdings", "few_holders", "creator_history"],
    sev: "medium",
    body: `
<p>We add up how much of the supply sits in the top 10 wallets, leaving out exchange pools, burn addresses and locked tokens. If a handful of wallets own half the token, they decide what it's worth.</p>
<h2>What the numbers mean</h2>
<ul>
<li><b>Under 30%:</b> widely held. Normal for established coins.</li>
<li><b>30% to 50%:</b> concentrated. One large seller can move the price a lot.</li>
<li><b>Over 50%:</b> a few wallets control it. We flag this as a serious warning.</li>
</ul>
<h2>Why this catches rugs early</h2>
<p>Most pulled rugs share a pattern: the creator and a few linked wallets hold most of the supply, wait for buyers, then sell everything at once. The honeypot check won't catch this, because selling works fine. Concentration does.</p>
<h2>Exchange wallets</h2>
<p>Big tokens often show high concentration because exchanges hold customer coins in a few wallets. If a token has hundreds of thousands of holders and is years old, high concentration is usually custody, not insiders. We note that on the result.</p>`,
  },
  liquidity: {
    title: "Liquidity: how much real money is behind the price?",
    short: "A token with $3,000 in its pool can show any price it likes. You just can't sell into it.",
    flags: ["low_liquidity", "no_market"],
    sev: "high",
    body: `
<p>On a decentralized exchange, every token trades against a pool of real money (usually ETH, SOL or a stablecoin). The pool size is the liquidity. It's the most honest number about a token, because it can't be faked by a chart.</p>
<h2>Why a tiny pool is dangerous</h2>
<p>If a pool holds $5,000, a $500 sell moves the price 10%. A $5,000 sell wipes it out. Your "position" is only worth what the pool can pay, which may be a fraction of what the screen says.</p>
<h2>What we flag</h2>
<ul>
<li><b>Under $10,000:</b> serious warning. You may not be able to sell at anything near the shown price.</li>
<li><b>Under $50,000:</b> caution. Fine for a small position, risky for anything more.</li>
<li><b>No pool at all:</b> there is no market. Either the token hasn't launched or it's dead.</li>
</ul>
<h2>Locked liquidity</h2>
<p>Serious launches lock their pool for months or years so the creator can't withdraw it. Unlocked liquidity means the creator can pull the pool at any moment, which is the classic rug pull.</p>`,
  },
  "pool-age": {
    title: "Pool age: why brand-new tokens are the riskiest",
    short: "Most rug pulls happen within days of launch, before anyone has had time to look.",
    flags: ["brand_new", "new_token", "new_contract"],
    sev: "medium",
    body: `
<p>We check when a token's oldest trading pool was created. A token that started trading an hour ago has no track record, no community watching it, and usually no one who has read the code.</p>
<h2>The launch window</h2>
<p>Scam tokens are built for speed. Launch, pump with bots and paid posts, sell, abandon. Most of it happens inside the first 48 hours. If you're seeing a token for the first time on social media and it's under a day old, you're probably the exit liquidity.</p>
<h2>What we flag</h2>
<ul>
<li><b>Under 24 hours:</b> serious warning.</li>
<li><b>Under 7 days:</b> caution.</li>
<li><b>Over a year:</b> green flag. It has survived long enough that a quick rug is off the table.</li>
</ul>
<div class="callout"><b>Waiting costs nothing</b>A real project will still be there next week. The ones that won't are the ones you want to miss.</div>`,
  },
  "unverified-code": {
    title: "Unverified code: what are you trusting?",
    short: "If the contract's source code isn't published, nobody can check what it actually does.",
    flags: ["closed_source", "unverified_source", "unverified_code", "no_security_data", "limited_checks", "simulation_failed"],
    sev: "high",
    body: `
<p>Every token is a program. Serious projects publish the human-readable source so anyone can confirm the program does what it claims. When the source is not verified, all anyone can see is machine code. The checks that look for honeypots, taxes and owner powers can't read it either.</p>
<h2>Why it's a red flag for tokens</h2>
<p>Verifying source takes a few minutes and costs nothing. A token creator who skips it is either careless or hiding something. For a meme token launched this week, assume the second.</p>
<h2>When it's not a red flag</h2>
<p>Smart-contract wallets and delegated accounts often show as unverified code. They aren't tokens, and the pattern is normal. Our wallet checker treats these as a low note, not a danger.</p>
<h2>"Limited checks" on a result</h2>
<p>If a result says limited checks, our main security source was unavailable and we graded from a backup. The honeypot and tax checks still ran, but owner-permission checks did not. Treat the grade as a floor, not a full report.</p>`,
  },
};
const FLAG_TO_SLUG = {};
for (const [slug, p] of Object.entries(FLAG_PAGES)) for (const f of p.flags) FLAG_TO_SLUG[f] = slug;

const SEV_LABEL = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };

function learnIndex() {
  const cards = Object.entries(FLAG_PAGES)
    .map(([slug, p]) => `<a class="lcard" href="/learn/${slug}"><span class="sev s-${p.sev}" style="align-self:flex-start">${SEV_LABEL[p.sev]} risk</span><b>${esc(p.title)}</b><span>${esc(p.short)}</span></a>`)
    .join("");
  return shell({
    title: "Crypto red flags explained",
    description: "Plain-English explanations of the warning signs our token checker looks for: honeypots, sell taxes, mint and freeze authority, owner powers, holder concentration, liquidity and pool age.",
    path: "/learn",
    body: `<section class="hero plain"><div class="wrap"><p class="kick">Learn</p><h1>Red flags, explained</h1><p class="dek">Every warning our checker can raise, what it means in plain English, and what to do about it.</p></div></section>
<main class="wrap"><div class="cards">${cards}</div>
<p class="prose" style="margin-top:8px">Have a token in front of you? <a href="/">Run it through the checker</a>: every flag on the result links back to its page here.</p></main>`,
  });
}

function learnPage(slug) {
  const p = FLAG_PAGES[slug];
  if (!p) return null;
  const others = Object.entries(FLAG_PAGES).filter(([s]) => s !== slug).slice(0, 4)
    .map(([s, q]) => `<a class="lcard" href="/learn/${s}"><b>${esc(q.title)}</b><span>${esc(q.short)}</span></a>`).join("");
  const faq = { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: [{ "@type": "Question", name: p.title, acceptedAnswer: { "@type": "Answer", text: p.short } }] };
  return shell({
    title: p.title,
    description: p.short,
    path: "/learn/" + slug,
    extraHead: `<script type="application/ld+json">${JSON.stringify(faq)}</script>`,
    body: `<section class="hero plain"><div class="wrap"><p class="kick"><a href="/learn" style="text-decoration:none">Red flags explained</a> · <span class="sev s-${p.sev}">${SEV_LABEL[p.sev]} risk</span></p><h1>${esc(p.title)}</h1><p class="dek">${esc(p.short)}</p></div></section>
<main class="wrap"><article class="prose">${p.body}
<p style="margin-top:28px"><a class="cta" href="/">Check a token for this flag</a></p></article>
<h2 class="prose" style="font-family:'Archivo',sans-serif;font-stretch:76%;font-weight:850;font-size:26px;margin:36px 0 6px">More red flags</h2>
<div class="cards">${others}</div></main>`,
  });
}

// ---------- info pages ----------
function aboutPage() {
  return shell({
    title: "About NoJunkCrypto",
    description: "Free tools that tell crypto newcomers whether a token or wallet is junk before they put money in. Built by GEMSI in Florida.",
    path: "/about",
    body: `<section class="hero plain"><div class="wrap"><p class="kick">About</p><h1>Built for the person about to click Buy</h1></div></section>
<main class="wrap"><article class="prose">
<p>Tens of thousands of new tokens launch every day. Most are junk, and a good share are traps built to take money from people who have been in crypto for less than a few years. The tools on this site exist so that person can paste an address and get a straight answer before they buy.</p>
<h2>What we do</h2>
<ul>
<li><a href="/">Token checker</a>: a grade (JUNK, RISKY, CAUTION, CLEAN) with the reasons, drawn from the contract's code and its market.</li>
<li><a href="/wallet">Wallet checker</a>: whether an address has been reported for phishing, theft or scams, before you send to it or approve it.</li>
<li><a href="/learn">Red flags explained</a>: every warning in plain English.</li>
</ul>
<h2>What we don't do</h2>
<p>We don't rate coins, pick winners, or give investment advice. A CLEAN grade means we found no major red flags in the data we check. It says nothing about whether the price will go up.</p>
<h2>Where the data comes from</h2>
<p>Contract security comes from <a href="https://gopluslabs.io" rel="noopener">GoPlus Security</a>, with Honeypot.is and RugCheck as backups. Market data comes from GeckoTerminal and CoinGecko. We don't hold the tokens we check.</p>
<h2>Who runs it</h2>
<p>NoJunkCrypto is a GEMSI project, based in Sunrise, Florida. The same checks are offered to AI agents and apps as a paid API; see <a href="/api">API details</a>. Questions: <a href="/contact">contact us</a>.</p>
</article></main>`,
  });
}

function disclosurePage() {
  return shell({
    title: "How we make money",
    description: "NoJunkCrypto is free to use. Here is every way the site earns, and the rule that keeps money away from the results.",
    path: "/disclosure",
    body: `<section class="hero plain"><div class="wrap"><p class="kick">Disclosure</p><h1>How we make money</h1></div></section>
<main class="wrap"><article class="prose">
<p>The checkers are free and always will be. The site earns in two ways, both labeled where they appear.</p>
<h2>Referral links</h2>
<p>Below each result we list exchanges and wallets. Some of those links are referral links: if you open an account through one, we may earn a fee or a share of fees from that company. Every such link is marked <span class="paid">paid link</span>. The grade a token gets is computed before and separately from any of this, and no exchange, wallet or token project can pay to change a result.</p>
<h2>Advertising</h2>
<p>We may show display ads from Google. Ad categories for gambling and crypto trading are blocked.</p>
<h2>What we don't take</h2>
<ul>
<li>No payment from any token project to list, rate or promote a token.</li>
<li>No tokens or airdrops from projects we check.</li>
<li>No paid placement inside a result card.</li>
</ul>
<p>If you believe a result is wrong, <a href="/contact">tell us</a>. Corrections are made to the rules, not to individual tokens.</p>
</article></main>`,
  });
}

function privacyPage() {
  return shell({
    title: "Privacy policy",
    description: "What NoJunkCrypto collects (very little), what it doesn't, and how addresses you check are handled.",
    path: "/privacy",
    body: `<section class="hero plain"><div class="wrap"><p class="kick">Privacy</p><h1>Privacy policy</h1></div></section>
<main class="wrap"><article class="prose">
<p><em>Last updated October 15, 2026.</em></p>
<h2>What we collect</h2>
<p>We don't ask you to create an account, and we don't collect your name or email to use the checkers. When you check a token or wallet, your browser requests data from our security and market data providers directly, and sends their responses to our server to be graded. Our server sees the address you checked and your IP address, which it uses only to limit abuse. We don't keep a history of what you checked tied to you.</p>
<h2>Addresses you check</h2>
<p>An address you paste is public blockchain data. We send it to the data providers listed on each result (GoPlus Security, GeckoTerminal/CoinGecko, and backups Honeypot.is and RugCheck) so they can report on it. Their own privacy policies apply to those requests.</p>
<h2>Cookies and ads</h2>
<p>The checkers set no cookies. If display ads are shown, Google may use cookies to serve them; you can opt out of personalized ads in your Google ad settings.</p>
<h2>Referral links</h2>
<p>Links marked "paid link" go to third-party companies. Once you leave this site, their policies apply.</p>
<h2>Contact</h2>
<p>Questions about this policy: <a href="/contact">contact us</a>.</p>
</article></main>`,
  });
}

function contactPage() {
  return shell({
    title: "Contact",
    description: "How to reach NoJunkCrypto about a result, a correction or a partnership.",
    path: "/contact",
    body: `<section class="hero plain"><div class="wrap"><p class="kick">Contact</p><h1>Get in touch</h1></div></section>
<main class="wrap"><article class="prose">
<p>Email <a href="mailto:hello@nojunkcrypto.com">hello@nojunkcrypto.com</a>.</p>
<ul>
<li><b>A result looks wrong:</b> include the address and chain. We fix rules, not single tokens, so a good report helps everyone.</li>
<li><b>Partnerships:</b> exchanges and wallets only. We don't list, rate or promote tokens for payment.</li>
<li><b>Press:</b> same address.</li>
</ul>
<div class="callout danger"><b>We will never contact you first</b>Nobody from this site will DM you, ask for your recovery phrase, or offer to recover lost funds. Anyone doing so is a scammer.</div>
</article></main>`,
  });
}

// ---------- wallet checker ----------
const ADDR_CHAIN_IDS = { base: "8453", ethereum: "1", bsc: "56", arbitrum: "42161", polygon: "137", optimism: "10", avalanche: "43114" };
const ADDRESS_FLAGS = [
  ["stealing_attack", "critical", "Reported for theft/stealing attacks."],
  ["phishing_activities", "critical", "Reported for phishing."],
  ["sanctioned", "critical", "On a sanctions list."],
  ["honeypot_related_address", "critical", "Linked to honeypot or scam token creation."],
  ["fake_token", "critical", "Counterfeit of a mainstream token."],
  ["blackmail_activities", "high", "Reported for blackmail."],
  ["cybercrime", "high", "Reported for cybercrime."],
  ["money_laundering", "high", "Reported for money laundering."],
  ["financial_crime", "high", "Reported for financial crime."],
  ["darkweb_transactions", "high", "Linked to dark web transactions."],
  ["fake_kyc", "high", "Linked to fake KYC."],
  ["gas_abuse", "high", "Reported for gas abuse (can drain gas from interacting users)."],
  ["malicious_mining_activities", "medium", "Linked to malicious mining activity."],
  ["mixer", "medium", "Coin mixer address; interacting may get your address added to risk lists."],
  ["reinit", "medium", "Contract can be redeployed with different code at the same address."],
  ["fake_standard_interface", "medium", "Contract fakes a standard token interface (common in scams)."],
  ["blacklist_doubt", "medium", "Suspected of malicious behavior (unconfirmed)."],
];
const ADDR_DISCLAIMER = "Automated screen against third-party security databases. A clean result means no known reports, not proof of safety; flags are reports, not legal findings. Not financial or legal advice.";

function analyzeAddress(chain, address, d, now = Date.now()) {
  const red = [];
  const green = [];
  const add = (severity, flag, detail) => red.push({ severity, flag, detail });
  const f = d.flags || {};
  if (!d.flags) add("low", "address_data_unavailable", "Address reputation data was unavailable for this check.");
  for (const [k, sev, text] of ADDRESS_FLAGS) if (on(f[k])) add(sev, k, text);
  const nMal = parseInt(f.number_of_malicious_contracts_created, 10);
  if (nMal > 0) add("critical", "malicious_contract_creator", `Created ${nMal} malicious contract(s).`);
  const src = f.data_source ? String(f.data_source) : "";
  const c = d.contract;
  const isContract = on(f.contract_address) || (c && on(c.is_contract));
  let contract = null;
  if (c && on(c.is_contract)) {
    const scan = c.contract_scan || {};
    const deployed = Number(c.deployed_time);
    const ageDays = Number.isFinite(deployed) && deployed > 0 ? (now / 1000 - deployed) / 86400 : null;
    const mal = Array.isArray(c.malicious_behavior) ? c.malicious_behavior : [];
    if (mal.length) add("critical", "malicious_behavior", `Contract has reported malicious behavior: ${mal.join(", ")}.`);
    if (on(c.doubt_list)) add("medium", "doubt_list", "Contract is on a suspicious-contract list.");
    if (on(scan.approval_abuse)) add("critical", "approval_abuse", "Contract can abuse token approvals (can move tokens you approve).");
    if (on(scan.privilege_withdraw)) add("medium", "privileged_withdraw", "Owner can withdraw funds held by the contract.");
    if (on(scan.withdraw_missing)) add("medium", "withdraw_missing", "Contract has no withdraw function; funds sent may be stuck.");
    if (on(scan.selfdestruct)) add("medium", "selfdestruct", "Contract can self-destruct.");
    if (on(scan.blacklist)) add("medium", "blacklist", "Contract can blacklist addresses.");
    const looksLikeWallet = !c.contract_name && !(Number(c.deployed_time) > 0);
    if (c.is_open_source !== undefined && !on(c.is_open_source)) {
      if (looksLikeWallet) add("low", "unverified_code", "Address has unpublished code (typical of smart wallets and delegated accounts).");
      else add("medium", "unverified_source", "Contract source code is not verified.");
    }
    if (on(c.is_proxy)) add("medium", "upgradeable_proxy", "Contract is an upgradeable proxy; its code can change.");
    if (ageDays !== null && ageDays < 7) add("medium", "new_contract", `Contract was deployed ${ageDays < 1 ? "less than a day" : Math.floor(ageDays) + " days"} ago.`);
    if (on(c.trust_list)) green.push("Contract is on a trusted list.");
    if (on(c.is_open_source)) green.push("Contract source code is verified.");
    if (ageDays !== null && ageDays >= 365) green.push(`Contract has existed for over ${Math.floor(ageDays / 365)} year(s).`);
    contract = { name: c.contract_name || null, verified: c.is_open_source === undefined ? null : on(c.is_open_source), deployed_at: Number.isFinite(deployed) && deployed > 0 ? new Date(deployed * 1000).toISOString() : null, trusted: on(c.trust_list) };
  }
  if (d.flags && !red.some((x) => ADDRESS_FLAGS.some(([k]) => k === x.flag) || x.flag === "malicious_contract_creator")) green.push("No reports in the address security databases checked.");
  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  red.sort((a, b) => order[a.severity] - order[b.severity]);
  const worst = red.length ? red[0].severity : null;
  const verdict = worst === "critical" || worst === "high" ? "DANGER" : worst === "medium" ? "SUSPICIOUS" : "NO KNOWN ISSUES";
  const label = isContract ? (contract && contract.name ? `Contract ${contract.name}` : "This smart account/contract") : "This address";
  const summary = verdict === "DANGER" ? `${label}: danger. ${red[0].detail}` : verdict === "SUSPICIOUS" ? `${label}: suspicious. ${red[0].detail}` : `${label}: no known issues in the databases checked.`;
  return { address, chain, is_contract: d.flags || d.contract ? Boolean(isContract) : null, verdict, summary, red_flags: red, green_flags: green, contract, report_source: src || null, checked_at: new Date(now).toISOString(), disclaimer: ADDR_DISCLAIMER };
}

async function handleFreeWallet(request, url) {
  if (!freeAllowed(request, url)) return json({ error: "The free wallet checker is for the web page at /wallet. AI agents and apps: use the paid NoJunk Address Check API." }, 403);
  if (request.method !== "POST") return json({ error: "Use the checker page at /wallet." }, 405);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (rateLimited("w:" + ip)) return json({ error: "You've run a lot of checks in a short time. Please wait a few minutes and try again." }, 429);
  const text = await request.text();
  if (text.length > FREE_MAX_BODY) return json({ error: "Request too large." }, 413);
  let b;
  try { b = JSON.parse(text); } catch { return json({ error: "Bad request." }, 400); }
  const address = String((b && b.address) || "").trim();
  let chain = String((b && b.chain) || "base").trim().toLowerCase();
  chain = CHAIN_ALIASES[chain] || chain;
  if (!EVM_RE.test(address)) return json({ error: "That doesn't look like a wallet address. It should start with 0x and be 42 characters long." }, 400);
  if (!ADDR_CHAIN_IDS[chain]) return json({ error: "Unsupported chain. The wallet checker covers Ethereum, Base, BNB Chain, Arbitrum, Polygon, Optimism and Avalanche." }, 400);
  const okRes = (x) => x && Number(x.status) === 200 && x.data && typeof x.data === "object" && x.data.code === 1;
  const a = okRes(b.addr) ? b.addr.data : null, c = okRes(b.contract) ? b.contract.data : null;
  const flags = a && a.result && typeof a.result === "object" ? a.result : null;
  let contract = c && c.result && typeof c.result === "object" && !Array.isArray(c.result) ? c.result : null;
  if (contract && contract[address.toLowerCase()]) contract = contract[address.toLowerCase()];
  if (contract && Object.keys(contract).length === 0) contract = null;
  if (!flags && !contract) return json({ error: "Our security data source is busy right now. Please wait a minute and try again." }, 502);
  return json(analyzeAddress(chain, address, { flags, contract }), 200, { "Cache-Control": "no-store" });
}

function walletPage() {
  const body = `
<section class="hero"><div class="wrap">
<p class="kick">Free wallet checker</p>
<h1>Is this wallet safe to send to?</h1>
<p class="dek">Before you send money to an address, approve a contract, or trust someone's "support" wallet, paste it here. We check it against databases of reported phishing, theft and scam addresses.</p>
<form id="f" novalidate>
<div class="field"><label for="addr">Wallet or contract address</label>
<input id="addr" name="address" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="0x…" required></div>
<div class="row">
<div class="field" style="grid-column:auto"><label for="chain">Blockchain</label>
<select id="chain" name="chain">
<option value="ethereum">Ethereum</option><option value="base">Base</option><option value="bsc">BNB Chain</option><option value="arbitrum">Arbitrum</option><option value="polygon">Polygon</option><option value="optimism">Optimism</option><option value="avalanche">Avalanche</option>
</select></div>
<div class="field" style="grid-column:auto;justify-content:flex-end"><button class="go" id="go" type="submit">Check this address</button></div>
</div>
</form>
<div class="tries"><span>Try one:</span>
<button type="button" data-a="0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" data-c="ethereum">vitalik.eth</button>
<button type="button" data-a="0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD" data-c="ethereum">Uniswap router</button>
</div>
</div></section>
<main class="wrap" id="out" aria-live="polite"></main>
<section class="wrap explain">
<h2>What the results mean</h2>
<div class="grid4">
<div class="grade"><span class="stamp g-JUNK">DANGER</span><p>Reported for phishing, theft, scams or sanctions. Do not send to it, approve it or sign anything from it.</p></div>
<div class="grade"><span class="stamp g-RISKY">SUSPICIOUS</span><p>Unconfirmed reports, or a contract with risky powers such as moving tokens you approve.</p></div>
<div class="grade"><span class="stamp g-CLEAN">NO KNOWN ISSUES</span><p>Nothing in the databases we check. That is not proof the address is honest, only that nobody has reported it yet.</p></div>
</div>
</section>
<section class="wrap explain" style="padding-top:0">
<h2>When to use this</h2>
<ul class="checks">
<li><b>Before sending.</b> Someone gives you an address to pay or "verify" with. Check it first.</li>
<li><b>Before approving.</b> A site asks your wallet to approve a contract. Paste the contract address.</li>
<li><b>After a DM.</b> "Support" asks you to send funds to a safe wallet. There is no such thing. Check it anyway, then block them.</li>
<li><b>Airdrop claims.</b> A claim site wants a signature. Check the contract before you sign.</li>
</ul>
</section>
__PARTNERS__
<script>
(function(){
var f=document.getElementById('f'),a=document.getElementById('addr'),c=document.getElementById('chain'),go=document.getElementById('go'),out=document.getElementById('out');
var IDS={ethereum:'1',base:'8453',bsc:'56',arbitrum:'42161',polygon:'137',optimism:'10',avalanche:'43114'};
var LABEL={ethereum:'Ethereum',base:'Base',bsc:'BNB Chain',arbitrum:'Arbitrum',polygon:'Polygon',optimism:'Optimism',avalanche:'Avalanche'};
var SEV={critical:'Critical',high:'High',medium:'Medium',low:'Low'};
var G={DANGER:'g-JUNK','SUSPICIOUS':'g-RISKY','NO KNOWN ISSUES':'g-CLEAN'};
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(m){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]})}
function busy(b){go.disabled=b;go.innerHTML=b?'<span class="spin" aria-hidden="true"></span>Checking…':'Check this address'}
function err(t){out.innerHTML='<div class="msg err" role="alert">'+esc(t)+'</div>'}
function raw(u){return fetch(u,{headers:{accept:'application/json'}}).then(function(r){return r.text().then(function(t){var d=null;try{d=JSON.parse(t)}catch(e){}return{status:r.status,data:d}})},function(){return{status:0,data:null}})}
function render(r){
 var flags=(r.red_flags||[]).map(function(x){return'<li><span class="sev s-'+esc(x.severity)+'">'+SEV[x.severity]+'</span><span>'+esc(x.detail)+'</span></li>'}).join('');
 var good=(r.green_flags||[]).map(function(x){return'<li><span class="sev s-good">Good</span><span>'+esc(x)+'</span></li>'}).join('');
 var kind=r.is_contract===true?(r.contract&&r.contract.name?'Contract: '+esc(r.contract.name):'Smart contract / smart account'):r.is_contract===false?'Regular wallet':'Address';
 var link=location.origin+'/wallet?a='+encodeURIComponent(r.address)+'&c='+encodeURIComponent(r.chain);
 var xurl='https://x.com/intent/post?text='+encodeURIComponent('Checked this address on NoJunkCrypto: '+r.verdict+'.\\n\\nCheck any wallet free before you send:')+'&url='+encodeURIComponent(link);
 out.innerHTML='<article class="card">'+
 '<div class="verdict"><span class="stamp '+G[r.verdict]+'" style="font-size:'+(r.verdict.length>8?'34px':'56px')+'">'+esc(r.verdict)+'</span><div class="vtext"><p class="tname">'+kind+'</p><p class="addr">'+esc(LABEL[r.chain]||r.chain)+' · '+esc(r.address)+'</p><p class="one">'+esc(r.summary)+'</p></div></div>'+
 (flags?'<div class="sect"><h2>Red flags</h2><ul class="flags">'+flags+'</ul></div>':'<div class="sect"><h2>Red flags</h2><p style="margin:0">None found.</p></div>')+
 (good?'<div class="sect"><h2>In its favor</h2><ul class="flags">'+good+'</ul></div>':'')+
 (r.report_source?'<div class="sect"><p style="margin:0;font-size:14px;color:var(--muted)">Report source: '+esc(r.report_source)+'</p></div>':'')+
 '<div class="actions"><a class="x" href="'+esc(xurl)+'" target="_blank" rel="noopener">Share on X</a><button type="button" class="ghost" id="cp">Copy link</button><button type="button" class="ghost" id="again">Check another</button></div>'+
 '<p class="checked">Checked '+new Date(r.checked_at).toLocaleString()+'. '+esc(r.disclaimer)+'</p></article>';
 document.getElementById('cp').onclick=function(){var b=this;try{navigator.clipboard.writeText(link).then(function(){b.textContent='Copied'},function(){b.textContent='Copy failed'})}catch(e){b.textContent='Copy failed'}};
 document.getElementById('again').onclick=function(){a.value='';a.focus();window.scrollTo({top:0,behavior:'smooth'})};
 try{history.replaceState(null,'',link)}catch(e){}
 out.querySelector('.card').scrollIntoView({behavior:'smooth',block:'start'});
}
function run(addr,chain){
 addr=String(addr||'').trim();var m=addr.match(/0x[0-9a-fA-F]{40}/);addr=m?m[0]:addr;a.value=addr;
 if(!addr){err('Paste an address first.');a.focus();return}
 if(!/^0x[0-9a-fA-F]{40}$/.test(addr)){err("That doesn't look like a wallet address. It should start with 0x and be 42 characters long. (Solana wallets aren't supported yet.)");return}
 chain=chain||'ethereum';c.value=chain;var id=IDS[chain];
 busy(true);out.innerHTML='';
 Promise.all([raw('https://api.gopluslabs.io/api/v1/address_security/'+addr+'?chain_id='+id),raw('https://api.gopluslabs.io/api/v1/approval_security/'+id+'?contract_addresses='+addr)]).then(function(x){
  return fetch('free-wallet',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({address:addr,chain:chain,addr:x[0],contract:x[1]})});
 }).then(function(res){return res.json().then(function(j){return{ok:res.ok,j:j}})}).then(function(x){
  busy(false);if(!x.ok){err(x.j&&x.j.error?x.j.error:'Something went wrong. Please try again.');return}render(x.j);
 }).catch(function(){busy(false);err('Could not reach the checker. Check your connection and try again.')});
}
f.addEventListener('submit',function(e){e.preventDefault();run(a.value,c.value)});
document.querySelectorAll('.tries button').forEach(function(b){b.addEventListener('click',function(){run(b.getAttribute('data-a'),b.getAttribute('data-c'))})});
var p=new URLSearchParams(location.search);if(p.get('a'))run(p.get('a'),p.get('c')||'ethereum');
})();
</script>`;
  return shell({
    title: "Is this wallet safe? Free address checker",
    description: "Paste any wallet or contract address and see if it has been reported for phishing, theft, scams or sanctions before you send to it or approve it. Free, no sign-up. Ethereum, Base, BNB Chain and more.",
    path: "/wallet",
    body,
  });
}

// ---------- sitemap / robots ----------
function sitemapXml() {
  const today = new Date().toISOString().slice(0, 10);
  const urls = ["/", "/wallet", "/learn", ...Object.keys(FLAG_PAGES).map((s) => "/learn/" + s), "/about", "/services", "/disclosure", "/privacy", "/contact"];
  const body = urls.map((u) => `<url><loc>${SITE_ORIGIN}${u}</loc><lastmod>${today}</lastmod><changefreq>${u === "/" || u === "/wallet" ? "weekly" : "monthly"}</changefreq><priority>${u === "/" ? "1.0" : u === "/wallet" ? "0.9" : u.startsWith("/learn") ? "0.7" : "0.4"}</priority></url>`).join("");
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</urlset>`, { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
}
function robotsTxt() {
  return new Response(`User-agent: *\nAllow: /\nDisallow: /free\nDisallow: /free-wallet\nDisallow: /check\nDisallow: /health\nSitemap: ${SITE_ORIGIN}/sitemap.xml\n`, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
}

function siteRoute(request, url, env) {
  const p = url.pathname.replace(/\/+$/, "") || "/";
  if (p === "/wallet") return htmlResponse(walletPage().replace("__PARTNERS__", partnersHtml(env)));
  if (p === "/free-wallet") return handleFreeWallet(request, url);
  if (p === "/learn") return htmlResponse(learnIndex());
  if (p.startsWith("/learn/")) { const h = learnPage(p.slice(7)); return h ? htmlResponse(h) : null; }
  if (p === "/about") return htmlResponse(aboutPage());
  if (p === "/services") return htmlResponse(servicesPage());
  if (p === "/disclosure") return htmlResponse(disclosurePage());
  if (p === "/privacy") return htmlResponse(privacyPage());
  if (p === "/contact") return htmlResponse(contactPage());
  if (p === "/sitemap.xml") return sitemapXml();
  if (p === "/robots.txt") return robotsTxt();
  return null;
}

// ---------- NoJunk catalog (shared by /services and /llms.txt on nojunkcrypto.com) ----------
const NJ = (n) => `https://${n}.mick8511.workers.dev`;
const NOJUNK_CATALOG = [
  { name: "NoJunk Token Check", base: NJ("nojunk-token-check"), path: "/check", price: "$0.01", hero: true, what: "Junk/rug-risk grade (JUNK, RISKY, CAUTION, CLEAN), 0-100 risk score, honeypot, taxes, owner powers, holder concentration, liquidity. Base, Ethereum, BNB, Arbitrum, Polygon, Optimism, Avalanche, Solana.", example: 'POST /check {"tokenAddress":"0x532f27101965dd16442E59d40670FaF5eBB142E4","chain":"base"}' },
  { name: "NoJunk Address Check", base: NJ("nojunk-address-check"), path: "/check", price: "$0.01", hero: true, what: "Before sending funds or approving a spender: is this wallet or contract reported for phishing, theft, scams, sanctions or mixers? Contract risks too.", example: 'POST /check {"address":"0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD","chain":"ethereum"}' },
  { name: "SEC Company Snapshot", base: NJ("sec-company-snapshot"), path: "/company", price: "$0.02", hero: true, what: "Revenue, net income, EPS, balance sheet and recent filings for any US-listed company, straight from SEC EDGAR with citations.", example: 'POST /company {"ticker":"AAPL"}' },
  { name: "NoJunk Crypto Price", base: NJ("nojunk-crypto-price"), path: "/price", price: "$0.001", what: "USD price and market data for major coins or any on-chain token." },
  { name: "NoJunk Chain", base: NJ("nojunk-chain"), path: "/balance", price: "$0.002", what: "Wallet balances, gas, transactions and blocks on 9 chains." },
  { name: "NoJunk Stocks", base: NJ("nojunk-stocks"), path: "/quote", price: "$0.001", what: "Stock, ETF, index, FX and commodity quotes, history and stats." },
  { name: "NoJunk Domain Intel", base: NJ("nojunk-domain-intel"), path: "/domain", price: "$0.003", what: "Domain age, registrar, DNS, email security and a risk score." },
  { name: "NoJunk Email Check", base: NJ("nojunk-email-check"), path: "/verify", price: "$0.001", what: "Is this email real? Syntax, mail server, disposable, typos." },
  { name: "Florida Condo SIRS Check", base: NJ("florida-sirs-check"), path: "/sirs", price: "$0.01", what: "Has a Florida condo association filed its structural integrity reserve study?" },
];
function catalogLlms() {
  const hero = NOJUNK_CATALOG.filter((s) => s.hero), more = NOJUNK_CATALOG.filter((s) => !s.hero);
  return `# NoJunk APIs

> Pay-per-call APIs for AI agents. No signup, no API key: call the endpoint, get an HTTP 402 with x402 payment requirements, pay in USDC on Base, retry with the PAYMENT-SIGNATURE header. Invalid input and upstream failures are rejected before payment is settled.

## Main services
${hero.map((s) => `- [${s.name}](${s.base}${s.path}): ${s.what} ${s.price} per call. Example: \`${s.example}\`. Free sample: ${s.base}/sample. Docs: ${s.base}/llms.txt. OpenAPI: ${s.base}/openapi.json`).join("\n")}

## More services
${more.map((s) => `- [${s.name}](${s.base}${s.path}): ${s.what} ${s.price} per call. OpenAPI: ${s.base}/openapi.json`).join("\n")}

## Humans
- Free token checker: https://nojunkcrypto.com/
- Free wallet checker: https://nojunkcrypto.com/wallet
`;
}
function servicesPage() {
  const card = (s) => `<li><strong><a href="${esc(s.base)}/">${esc(s.name)}</a></strong> · <code>${esc(s.price)}</code> per call<br>${esc(s.what)}<br><small>Endpoint <code>${esc(s.base + s.path)}</code>${s.hero ? ` · <a href="${esc(s.base)}/sample">free sample</a> · <a href="${esc(s.base)}/llms.txt">llms.txt</a>` : ""} · <a href="${esc(s.base)}/openapi.json">OpenAPI</a></small></li>`;
  return shell({
    title: "APIs for AI agents",
    description: "NoJunk pay-per-call APIs for AI agents: token risk, wallet safety, SEC fundamentals and more. x402, USDC on Base, no signup.",
    path: "/services",
    body: `<section class="hero plain"><div class="wrap"><p class="kick">For developers and AI agents</p><h1>NoJunk APIs</h1></div></section>
<main class="wrap"><article class="prose">
<p>Every service is pay-per-call over <a href="https://www.x402.org/">x402</a>: call the endpoint, get an HTTP 402 with the price, pay in USDC on Base, retry. No signup, no API key. Bad input and upstream failures are rejected before payment is settled. Machine-readable list: <a href="/llms.txt">/llms.txt</a>.</p>
<h2>Main services</h2><ul>${NOJUNK_CATALOG.filter((s) => s.hero).map(card).join("")}</ul>
<h2>More services</h2><ul>${NOJUNK_CATALOG.filter((s) => !s.hero).map(card).join("")}</ul>
</article></main>`,
  });
}
