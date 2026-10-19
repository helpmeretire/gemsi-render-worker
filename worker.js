// Blockchain Data — paid (x402) multi-chain blockchain lookups for AI agents.
// Four routes (GET query or POST JSON), each paid per successful call in USDC on Base:
//   /balance $0.002  native + USDC balance and tx count for a wallet on 7 EVM chains, Solana or Bitcoin
//   /gas     $0.001  gas price, base fee and priority-fee percentiles (gwei) per EVM chain; Bitcoin sat/vB fees
//   /tx      $0.002  transaction + receipt with decoded ERC-20 transfers (EVM), Bitcoin tx, Solana tx
//   /block   $0.001  block header summary by number/hash (EVM, Bitcoin) or slot (Solana)
// Data: public JSON-RPC nodes (publicnode.com) and mempool.space. No API keys, nothing logged.
// Settings (Cloudflare Worker > Settings > Variables and Secrets):
//   PAY_TO              (optional) Base wallet address that receives USDC (defaults to DEFAULT_PAY_TO)
//   CDP_API_KEY_ID      (optional) Coinbase Developer Platform API key id   -> enables Bazaar listing
//   CDP_API_KEY_SECRET  (optional, Secret) Coinbase Developer Platform API key secret
// Without the CDP keys the service uses the keyless PayAI facilitator.

const DEFAULT_PAY_TO = "0x6f762720b8515b7091e6aa69e8361f7b9909233f"; // Mick's Base wallet
const NETWORK = "eip155:8453"; // Base mainnet
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CDP_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
const PAYAI_URL = "https://facilitator.payai.network";
const SERVICE = "Blockchain Data";
const DESCRIPTION =
  "Multi-chain wallet balances, gas prices, transaction and block lookups across 7 EVM chains, Solana and Bitcoin. Pay per call with USDC on Base (x402). No API key.";
const UPSTREAM_UA = "NoJunk Chain/1.0 (+https://nojunkcrypto.com)";
const TIMEOUT_MS = 8000; // each upstream fetch must finish within this
const MAX_REQUEST_BYTES = 16 * 1024; // POST bodies larger than this are rejected with 413

// EVM chains: keyless public RPC endpoints (publicnode.com) + canonical USDC contract per chain.
const EVM = {
  base: { chain_id: 8453, name: "Base", rpc: "https://base-rpc.publicnode.com", symbol: "ETH", usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", usdc_decimals: 6, explorer: "https://basescan.org" },
  ethereum: { chain_id: 1, name: "Ethereum", rpc: "https://ethereum-rpc.publicnode.com", symbol: "ETH", usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", usdc_decimals: 6, explorer: "https://etherscan.io" },
  bsc: { chain_id: 56, name: "BNB Smart Chain", rpc: "https://bsc-rpc.publicnode.com", symbol: "BNB", usdc: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", usdc_decimals: 18, explorer: "https://bscscan.com" },
  arbitrum: { chain_id: 42161, name: "Arbitrum One", rpc: "https://arbitrum-one-rpc.publicnode.com", symbol: "ETH", usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", usdc_decimals: 6, explorer: "https://arbiscan.io" },
  polygon: { chain_id: 137, name: "Polygon PoS", rpc: "https://polygon-bor-rpc.publicnode.com", symbol: "POL", usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", usdc_decimals: 6, explorer: "https://polygonscan.com" },
  optimism: { chain_id: 10, name: "OP Mainnet", rpc: "https://optimism-rpc.publicnode.com", symbol: "ETH", usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", usdc_decimals: 6, explorer: "https://optimistic.etherscan.io" },
  avalanche: { chain_id: 43114, name: "Avalanche C-Chain", rpc: "https://avalanche-c-chain-rpc.publicnode.com", symbol: "AVAX", usdc: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", usdc_decimals: 6, explorer: "https://snowtrace.io" },
};
const EVM_CHAINS = Object.keys(EVM);
const SOLANA_RPC = "https://solana-rpc.publicnode.com";
const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MEMPOOL_API = "https://mempool.space/api";
const ALL_CHAINS = [...EVM_CHAINS, "solana", "bitcoin"];
const FEE_HISTORY_BLOCKS = 5;
const FEE_PERCENTILES = [25, 50, 75];
const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const MAX_ERC20_TRANSFERS = 100; // decoded Transfer logs returned per transaction

// Per-route prices in USDC atomic units (6 decimals). Every paid route accepts GET (query) and POST (JSON).
const ROUTES = {
  "/balance": { name: "balance", price: "2000", usd: "0.002000" },
  "/gas": { name: "gas", price: "1000", usd: "0.001000" },
  "/tx": { name: "tx", price: "2000", usd: "0.002000" },
  "/block": { name: "block", price: "1000", usd: "0.001000" },
};

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


// ---------- params & validation (nothing here touches the network) ----------
const isStr = (v) => typeof v === "string";
const present = (v) => v !== undefined && v !== null && !(isStr(v) && v.trim() === "");
const fail = (msg) => ({ error: `${msg} (no payment was taken)` });
const RE_EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;
const RE_HEX32 = /^0x[0-9a-fA-F]{64}$/; // EVM tx / block hash
const RE_HEX32_BARE = /^[0-9a-fA-F]{64}$/; // Bitcoin txid / block hash
const RE_BASE58_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/; // Solana pubkey
const RE_BASE58_SIG = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/; // Solana signature (64 bytes)
const RE_BTC_BECH32 = /^(bc1[02-9ac-hj-np-z]{11,87}|BC1[02-9AC-HJ-NP-Z]{11,87})$/;
const RE_BTC_LEGACY = /^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/;
const RE_DECIMAL = /^\s*\d{1,12}\s*$/;

// Merges query-string params with a POST JSON body (body wins). Returns { params } or { error }.
async function readParams(request, url) {
  const p = Object.fromEntries(url.searchParams);
  if (request.method === "POST") {
    let text = "";
    try { text = await request.clone().text(); } catch { return { error: "Request body could not be read" }; }
    if (text.length > MAX_REQUEST_BYTES) return { error: `Request body too large (max ${MAX_REQUEST_BYTES} bytes)`, status: 413 };
    if (text.trim()) {
      let b;
      try { b = JSON.parse(text); } catch { return { error: "Request body must be a JSON object" }; }
      if (!b || typeof b !== "object" || Array.isArray(b)) return { error: "Request body must be a JSON object" };
      Object.assign(p, b);
    }
  }
  return { params: p };
}

const chainList = () => `${EVM_CHAINS.join(", ")}, solana, bitcoin`;
// Returns { error } or { chain } where chain is a known chain name or "all".
function checkChain(v, { allowAll = true, allowSolana = true, allowBitcoin = true } = {}) {
  if (!present(v)) return { chain: null };
  if (!isStr(v)) return { error: "chain must be a string" };
  const c = v.trim().toLowerCase();
  if (c === "all") return allowAll ? { chain: "all" } : { error: "chain=all is not supported here; name one chain" };
  if (c === "eth" || c === "mainnet") return { chain: "ethereum" };
  if (c === "matic") return { chain: "polygon" };
  if (c === "avax") return { chain: "avalanche" };
  if (c === "bnb" || c === "binance") return { chain: "bsc" };
  if (c === "op") return { chain: "optimism" };
  if (c === "arb" || c === "arbitrum-one") return { chain: "arbitrum" };
  if (c === "sol") return allowSolana ? { chain: "solana" } : { error: "solana is not supported on this route" };
  if (c === "btc") return allowBitcoin ? { chain: "bitcoin" } : { error: "bitcoin is not supported on this route" };
  if (c === "solana") return allowSolana ? { chain: "solana" } : { error: "solana is not supported on this route" };
  if (c === "bitcoin") return allowBitcoin ? { chain: "bitcoin" } : { error: "bitcoin is not supported on this route" };
  if (EVM[c]) return { chain: c };
  return { error: `Unknown chain "${c}". Supported: ${chainList()}${allowAll ? ", all" : ""}` };
}

// Classifies an address by its format: "evm", "solana" or "bitcoin"; null if it is none of them.
function addressKind(a) {
  if (RE_EVM_ADDR.test(a)) return "evm";
  if (RE_BTC_BECH32.test(a)) return "bitcoin";
  if (RE_BTC_LEGACY.test(a) && a.length <= 35) return "bitcoin";
  if (RE_BASE58_ADDR.test(a)) return "solana";
  return null;
}

function validateBalance(p) {
  if (!present(p.address)) return fail("Missing required parameter: address (0x EVM address, Solana base58 address or Bitcoin address)");
  if (!isStr(p.address)) return fail("address must be a string");
  const address = p.address.trim();
  const kind = addressKind(address);
  if (!kind) return fail("address is not a valid EVM (0x + 40 hex), Solana (base58, 32-44 chars) or Bitcoin (bc1..., 1..., 3...) address");
  const c = checkChain(p.chain); if (c.error) return fail(c.error);
  let chains;
  if (kind === "evm") {
    if (c.chain === null || c.chain === "all") chains = EVM_CHAINS;
    else if (EVM[c.chain]) chains = [c.chain];
    else return fail(`A 0x address is an EVM address; chain must be one of ${EVM_CHAINS.join(", ")} or all, not ${c.chain}`);
  } else if (kind === "solana") {
    if (c.chain === null || c.chain === "solana" || c.chain === "all") chains = ["solana"];
    else if (c.chain === "bitcoin" && RE_BTC_LEGACY.test(address)) chains = ["bitcoin"]; // explicit override for long legacy-looking addresses
    else return fail(`${address.slice(0, 8)}... is a Solana (base58) address; chain must be solana or omitted, not ${c.chain}`);
  } else {
    if (c.chain === null || c.chain === "bitcoin" || c.chain === "all") chains = ["bitcoin"];
    else if (c.chain === "solana" && RE_BASE58_ADDR.test(address)) chains = ["solana"]; // explicit override: base58 address that also looks like legacy BTC
    else return fail(`${address.slice(0, 8)}... is a Bitcoin address; chain must be bitcoin or omitted, not ${c.chain}`);
  }
  // EVM addresses and bech32 Bitcoin addresses are case-insensitive; base58 (Solana, legacy Bitcoin) is not.
  return { address: kind === "evm" || RE_BTC_BECH32.test(address) ? address.toLowerCase() : address, kind: chains[0] === "solana" ? "solana" : chains[0] === "bitcoin" ? "bitcoin" : "evm", chains, scope: chains.length > 1 ? "all" : chains[0] };
}

function validateGas(p) {
  const c = checkChain(p.chain, { allowSolana: false }); if (c.error) return fail(c.error);
  if (c.chain === null || c.chain === "all") return { chains: EVM_CHAINS, scope: "all" };
  return { chains: [c.chain], scope: c.chain };
}

function validateTx(p) {
  if (!present(p.hash)) return fail("Missing required parameter: hash (transaction hash / txid / Solana signature)");
  if (!isStr(p.hash)) return fail("hash must be a string");
  const hash = p.hash.trim();
  const c = checkChain(p.chain, { allowAll: false }); if (c.error) return fail(c.error);
  if (RE_HEX32.test(hash)) {
    if (c.chain === null) return fail(`chain is required for a 0x transaction hash: one of ${EVM_CHAINS.join(", ")}`);
    if (!EVM[c.chain]) return fail(`A 0x transaction hash is an EVM hash; chain must be one of ${EVM_CHAINS.join(", ")}, not ${c.chain}`);
    return { chain: c.chain, hash: hash.toLowerCase() };
  }
  if (RE_HEX32_BARE.test(hash)) {
    if (c.chain !== null && c.chain !== "bitcoin") {
      if (EVM[c.chain]) return { chain: c.chain, hash: "0x" + hash.toLowerCase() }; // EVM hash given without the 0x prefix
      return fail("A 64-hex txid without 0x is a Bitcoin txid; chain must be bitcoin or omitted");
    }
    return { chain: "bitcoin", hash: hash.toLowerCase() };
  }
  if (RE_BASE58_SIG.test(hash)) {
    if (c.chain !== null && c.chain !== "solana") return fail("A base58 signature is a Solana transaction; chain must be solana or omitted");
    return { chain: "solana", hash };
  }
  return fail("hash is not a valid transaction hash: EVM 0x + 64 hex, Bitcoin 64 hex, or Solana base58 signature");
}

function validateBlock(p) {
  if (!present(p.chain)) return fail(`Missing required parameter: chain (one of ${chainList()})`);
  const c = checkChain(p.chain, { allowAll: false }); if (c.error) return fail(c.error);
  const chain = c.chain;
  const hasNum = present(p.number), hasHash = present(p.hash);
  if (hasNum && hasHash) return fail("Provide either number or hash, not both");
  if (hasHash) {
    if (!isStr(p.hash)) return fail("hash must be a string");
    const h = p.hash.trim();
    if (chain === "solana") return fail("Solana blocks are looked up by slot number (number=...), not by hash");
    if (chain === "bitcoin") { if (!RE_HEX32_BARE.test(h) && !RE_HEX32.test(h)) return fail("Bitcoin block hash must be 64 hex characters"); return { chain, hash: h.replace(/^0x/, "").toLowerCase(), number: null }; }
    if (!RE_HEX32.test(h) && !RE_HEX32_BARE.test(h)) return fail("EVM block hash must be 0x + 64 hex characters");
    return { chain, hash: (h.startsWith("0x") ? h : "0x" + h).toLowerCase(), number: null };
  }
  if (hasNum) {
    let n;
    if (typeof p.number === "number") { if (!Number.isInteger(p.number) || p.number < 0 || p.number > 999999999999) return fail("number must be a non-negative integer (or \"latest\")"); n = p.number; }
    else if (isStr(p.number)) {
      const s = p.number.trim().toLowerCase();
      if (s === "latest") return { chain, hash: null, number: null };
      if (/^0x[0-9a-f]{1,12}$/.test(s)) n = parseInt(s, 16);
      else if (RE_DECIMAL.test(s)) n = Number(s);
      else return fail("number must be a non-negative integer (decimal or 0x hex) or \"latest\"");
    } else return fail("number must be a non-negative integer (decimal or 0x hex) or \"latest\"");
    return { chain, hash: null, number: n };
  }
  return { chain, hash: null, number: null };
}
const VALIDATORS = { balance: validateBalance, gas: validateGas, tx: validateTx, block: validateBlock };

// ---------- upstream fetch (JSON-RPC + REST), 8 s timeout, identifying UA, no keys ----------
class FetchError extends Error { constructor(status, message) { super(message); this.status = status; } }
const notFound = (msg) => new FetchError(404, msg);
const upstreamErr = (msg) => new FetchError(502, msg);

async function fetchWithTimeout(upstreamUrl, init, label) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    let res;
    try {
      res = await fetch(upstreamUrl, { ...init, redirect: "follow", signal: ctrl.signal, headers: { "user-agent": UPSTREAM_UA, accept: "application/json", ...(init.headers || {}) } });
    } catch (e) {
      if (ctrl.signal.aborted) throw upstreamErr(`${label} did not respond within ${TIMEOUT_MS / 1000} seconds`);
      throw upstreamErr(`Could not reach ${label}: ${String(e && e.message ? e.message : e).slice(0, 200)}`);
    }
    let text;
    try { text = await res.text(); } catch {
      if (ctrl.signal.aborted) throw upstreamErr(`${label} did not finish sending within ${TIMEOUT_MS / 1000} seconds`);
      throw upstreamErr(`Could not read the ${label} response`);
    }
    return { status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

// JSON-RPC 2.0 batch: calls = [[method, params], ...] -> array of results in the same order.
// A per-call error is returned as { __error: {code, message} } so callers can decide whether it is fatal.
async function rpcBatch(rpcUrl, label, calls) {
  const body = calls.map(([method, params], i) => ({ jsonrpc: "2.0", id: i + 1, method, params }));
  const { status, text } = await fetchWithTimeout(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, label);
  if (status < 200 || status >= 300) throw upstreamErr(`${label} responded with HTTP ${status}`);
  let data;
  try { data = JSON.parse(text); } catch { throw upstreamErr(`${label} returned an unreadable response`); }
  if (!Array.isArray(data)) {
    if (data && typeof data === "object" && data.error) throw upstreamErr(`${label} RPC error: ${String(data.error.message || data.error.code || "unknown").slice(0, 200)}`);
    throw upstreamErr(`${label} returned an unexpected response`);
  }
  const byId = new Map(data.filter((r) => r && typeof r === "object").map((r) => [r.id, r]));
  return calls.map((_, i) => {
    const r = byId.get(i + 1);
    if (!r) return { __error: { code: null, message: "missing result" } };
    if (r.error) return { __error: { code: r.error.code ?? null, message: String(r.error.message || "RPC error").slice(0, 200) } };
    return r.result === undefined ? null : r.result;
  });
}
const rpcErr = (r) => (r && typeof r === "object" && r.__error) || null;
const need = (r, label, what) => { const e = rpcErr(r); if (e) throw upstreamErr(`${label} ${what} failed: ${e.message}`); return r; };

// GET JSON from mempool.space; 404 -> FetchError(404) with notFoundMsg, other non-2xx -> 502.
async function restGet(path, label, notFoundMsg) {
  const { status, text } = await fetchWithTimeout(`${MEMPOOL_API}${path}`, { method: "GET" }, label);
  if (status === 404 || (status === 400 && notFoundMsg)) throw notFound(notFoundMsg || `${label}: not found`);
  if (status < 200 || status >= 300) throw upstreamErr(`${label} responded with HTTP ${status}`);
  const t = text.trim();
  if (/^-?\d+$/.test(t)) return Number(t); // plain-number endpoints (tip height)
  if (/^[0-9a-fA-F]{64}$/.test(t)) return t; // plain-hash endpoints (block-height/{h})
  try { return JSON.parse(t); } catch { throw upstreamErr(`${label} returned an unreadable response`); }
}

// ---------- number formatting (BigInt, no floats for raw values) ----------
const isHexQty = (v) => isStr(v) && /^0x[0-9a-fA-F]*$/.test(v);
const hexToBig = (v) => (isHexQty(v) && v.length > 2 ? BigInt(v) : v === "0x" ? 0n : null);
const hexToNum = (v) => { const b = hexToBig(v); return b === null ? null : Number(b); };
const bigStr = (b) => (b === null || b === undefined ? null : b.toString());
// 1234567n, 6 -> "1.234567"; trims trailing zeros, keeps at least one integer digit.
function formatUnits(b, decimals) {
  if (b === null || b === undefined) return null;
  const neg = b < 0n; if (neg) b = -b;
  const s = b.toString().padStart(decimals + 1, "0");
  const int = s.slice(0, s.length - decimals) || "0";
  let frac = decimals ? s.slice(s.length - decimals).replace(/0+$/, "") : "";
  return (neg ? "-" : "") + int + (frac ? "." + frac : "");
}
const toGwei = (b) => (b === null || b === undefined ? null : Number(formatUnits(b, 9)));
const fmtEth = (b) => formatUnits(b, 18);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strOrNull = (v) => (isStr(v) && v ? v : null);
const iso = (unix) => (num(unix) === null ? null : new Date(unix * 1000).toISOString());

// ---------- route logic: each returns { status, body } (status !== 200 means do not settle) ----------
const BALANCE_OF_SELECTOR = "0x70a08231";
const padAddr = (a) => a.slice(2).toLowerCase().padStart(64, "0");

async function evmBalance(chain, address) {
  const c = EVM[chain];
  const [bal, usdcRaw, count, blk] = await rpcBatch(c.rpc, c.name, [
    ["eth_getBalance", [address, "latest"]],
    ["eth_call", [{ to: c.usdc, data: BALANCE_OF_SELECTOR + padAddr(address) }, "latest"]],
    ["eth_getTransactionCount", [address, "latest"]],
    ["eth_blockNumber", []],
  ]);
  need(bal, c.name, "eth_getBalance");
  const wei = hexToBig(bal);
  if (wei === null) throw upstreamErr(`${c.name} returned an invalid balance`);
  const usdcBig = rpcErr(usdcRaw) ? null : hexToBig(usdcRaw);
  const txCount = rpcErr(count) ? null : hexToNum(count);
  return {
    ok: true, chain, chain_id: c.chain_id, chain_name: c.name, address,
    native: { symbol: c.symbol, wei: wei.toString(), formatted: fmtEth(wei) },
    usdc: { contract: c.usdc, decimals: c.usdc_decimals, raw: bigStr(usdcBig), formatted: usdcBig === null ? null : formatUnits(usdcBig, c.usdc_decimals) },
    tx_count: txCount,
    block_number: rpcErr(blk) ? null : hexToNum(blk),
    explorer: `${c.explorer}/address/${address}`,
  };
}

async function solanaBalance(address) {
  const [bal, tokens, slot] = await rpcBatch(SOLANA_RPC, "Solana RPC", [
    ["getBalance", [address, { commitment: "confirmed" }]],
    ["getTokenAccountsByOwner", [address, { mint: SOLANA_USDC_MINT }, { encoding: "jsonParsed", commitment: "confirmed" }]],
    ["getSlot", [{ commitment: "confirmed" }]],
  ]);
  need(bal, "Solana RPC", "getBalance");
  const lamports = bal && typeof bal === "object" && typeof bal.value === "number" ? BigInt(bal.value) : null;
  if (lamports === null) throw upstreamErr("Solana RPC returned an invalid balance");
  let usdcRaw = null, usdcAccounts = null;
  if (!rpcErr(tokens) && tokens && Array.isArray(tokens.value)) {
    usdcRaw = 0n; usdcAccounts = tokens.value.length;
    for (const acc of tokens.value) {
      const amt = acc && acc.account && acc.account.data && acc.account.data.parsed && acc.account.data.parsed.info && acc.account.data.parsed.info.tokenAmount;
      if (amt && isStr(amt.amount) && /^\d+$/.test(amt.amount)) usdcRaw += BigInt(amt.amount);
    }
  }
  return {
    ok: true, chain: "solana", chain_name: "Solana", address,
    native: { symbol: "SOL", lamports: lamports.toString(), formatted: formatUnits(lamports, 9) },
    usdc: { mint: SOLANA_USDC_MINT, decimals: 6, raw: bigStr(usdcRaw), formatted: usdcRaw === null ? null : formatUnits(usdcRaw, 6), token_accounts: usdcAccounts },
    tx_count: null,
    slot: rpcErr(slot) ? null : num(slot),
    explorer: `https://solscan.io/account/${address}`,
  };
}

async function bitcoinBalance(address) {
  const d = await restGet(`/address/${address}`, "mempool.space", `Bitcoin address ${address} is invalid or unknown to mempool.space`);
  const cs = d && d.chain_stats ? d.chain_stats : {}, ms = d && d.mempool_stats ? d.mempool_stats : {};
  const sat = (v) => (typeof v === "number" && Number.isFinite(v) ? BigInt(Math.trunc(v)) : 0n);
  const confirmed = sat(cs.funded_txo_sum) - sat(cs.spent_txo_sum);
  const pending = sat(ms.funded_txo_sum) - sat(ms.spent_txo_sum);
  return {
    ok: true, chain: "bitcoin", chain_name: "Bitcoin", address,
    native: { symbol: "BTC", sats: confirmed.toString(), formatted: formatUnits(confirmed, 8), unconfirmed_sats: pending.toString(), unconfirmed_formatted: formatUnits(pending, 8) },
    usdc: null,
    tx_count: num(cs.tx_count),
    unconfirmed_tx_count: num(ms.tx_count),
    explorer: `https://mempool.space/address/${address}`,
  };
}

const chainFailure = (chain, e) => ({ ok: false, chain, error: e && e.message ? String(e.message).slice(0, 300) : "lookup failed" });
// Runs one lookup per chain in parallel; "all" -> 200 with per-chain ok/error unless every chain failed (502).
async function perChain(chains, scope, run) {
  const settled = await Promise.allSettled(chains.map((ch) => run(ch)));
  const results = {};
  let okCount = 0, firstErr = null;
  chains.forEach((ch, i) => {
    const s = settled[i];
    if (s.status === "fulfilled") { results[ch] = s.value; okCount++; }
    else { results[ch] = chainFailure(ch, s.reason); if (!firstErr) firstErr = s.reason; }
  });
  if (okCount === 0) {
    const e = firstErr;
    if (e instanceof FetchError && e.status === 404) return { status: 404, body: { error: `${e.message}; no payment was taken` } };
    return { status: 502, body: { error: `${e && e.message ? e.message : "Upstream error"}: data source temporarily unavailable, no payment taken`, chains: Object.fromEntries(chains.map((ch) => [ch, results[ch].error])) } };
  }
  return { status: 200, results, chains_ok: okCount, chains_failed: chains.length - okCount };
}

async function doBalance(p) {
  const run = (ch) => (ch === "solana" ? solanaBalance(p.address) : ch === "bitcoin" ? bitcoinBalance(p.address) : evmBalance(ch, p.address));
  const r = await perChain(p.chains, p.scope, run);
  if (r.status !== 200) return r;
  return { status: 200, body: { address: p.address, address_type: p.kind, scope: p.scope, chains_ok: r.chains_ok, chains_failed: r.chains_failed, balances: r.results, fetched_at: new Date().toISOString() } };
}

async function evmGas(chain) {
  const c = EVM[chain];
  const [gp, fh, bn] = await rpcBatch(c.rpc, c.name, [
    ["eth_gasPrice", []],
    ["eth_feeHistory", ["0x" + FEE_HISTORY_BLOCKS.toString(16), "latest", FEE_PERCENTILES]],
    ["eth_blockNumber", []],
  ]);
  need(gp, c.name, "eth_gasPrice");
  const gasPrice = hexToBig(gp);
  if (gasPrice === null) throw upstreamErr(`${c.name} returned an invalid gas price`);
  let baseFee = null, nextBaseFee = null, pri = { p25: null, p50: null, p75: null }, gasUsedRatio = null, oldest = null;
  if (!rpcErr(fh) && fh && typeof fh === "object") {
    const bfs = Array.isArray(fh.baseFeePerGas) ? fh.baseFeePerGas.map(hexToBig) : [];
    if (bfs.length >= 2) { baseFee = bfs[bfs.length - 2]; nextBaseFee = bfs[bfs.length - 1]; }
    else if (bfs.length === 1) { baseFee = bfs[0]; nextBaseFee = bfs[0]; }
    if (Array.isArray(fh.reward) && fh.reward.length) {
      const sums = [0n, 0n, 0n], counts = [0, 0, 0];
      for (const row of fh.reward) if (Array.isArray(row)) row.forEach((v, i) => { const b = hexToBig(v); if (b !== null && i < 3) { sums[i] += b; counts[i]++; } });
      const avg = (i) => (counts[i] ? sums[i] / BigInt(counts[i]) : null);
      pri = { p25: avg(0), p50: avg(1), p75: avg(2) };
    }
    if (Array.isArray(fh.gasUsedRatio) && fh.gasUsedRatio.length) { const xs = fh.gasUsedRatio.filter((x) => typeof x === "number"); if (xs.length) gasUsedRatio = Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000; }
    oldest = hexToNum(fh.oldestBlock);
  }
  const tier = (p) => (p === null ? null : { max_priority_fee_gwei: toGwei(p), max_fee_gwei: nextBaseFee === null ? toGwei(p + gasPrice) : toGwei(nextBaseFee * 2n + p) });
  return {
    ok: true, chain, chain_id: c.chain_id, chain_name: c.name,
    block_number: rpcErr(bn) ? null : hexToNum(bn),
    gas_price_gwei: toGwei(gasPrice), gas_price_wei: gasPrice.toString(),
    base_fee_gwei: toGwei(baseFee), next_base_fee_gwei: toGwei(nextBaseFee),
    priority_fee_gwei: { p25: toGwei(pri.p25), p50: toGwei(pri.p50), p75: toGwei(pri.p75) },
    suggested: { slow: tier(pri.p25), standard: tier(pri.p50), fast: tier(pri.p75) },
    fee_history: { blocks: FEE_HISTORY_BLOCKS, oldest_block: oldest, avg_gas_used_ratio: gasUsedRatio, percentiles: FEE_PERCENTILES },
    eip1559: nextBaseFee !== null,
  };
}

async function bitcoinGas() {
  const [fees, tip] = await Promise.allSettled([restGet("/v1/fees/recommended", "mempool.space"), restGet("/blocks/tip/height", "mempool.space")]);
  if (fees.status === "rejected") throw fees.reason;
  const f = fees.value && typeof fees.value === "object" ? fees.value : {};
  if (num(f.fastestFee) === null) throw upstreamErr("mempool.space returned an invalid fee estimate");
  return {
    ok: true, chain: "bitcoin", chain_name: "Bitcoin",
    block_height: tip.status === "fulfilled" ? num(tip.value) : null,
    fees_sat_per_vbyte: { fastest: num(f.fastestFee), half_hour: num(f.halfHourFee), hour: num(f.hourFee), economy: num(f.economyFee), minimum: num(f.minimumFee) },
    note: "Bitcoin fees are sat/vB estimates from mempool.space for next-block, ~30 min and ~60 min confirmation.",
  };
}

async function doGas(p) {
  const r = await perChain(p.chains, p.scope, (ch) => (ch === "bitcoin" ? bitcoinGas() : evmGas(ch)));
  if (r.status !== 200) return r;
  return { status: 200, body: { scope: p.scope, unit: "gwei (EVM) / sat per vbyte (bitcoin)", chains_ok: r.chains_ok, chains_failed: r.chains_failed, gas: r.results, fetched_at: new Date().toISOString() } };
}

function decodeErc20Transfers(logs) {
  const out = [];
  if (!Array.isArray(logs)) return out;
  for (const l of logs) {
    if (!l || !Array.isArray(l.topics) || l.topics.length !== 3 || String(l.topics[0]).toLowerCase() !== ERC20_TRANSFER_TOPIC) continue;
    const t1 = String(l.topics[1]), t2 = String(l.topics[2]);
    if (!/^0x[0-9a-fA-F]{64}$/.test(t1) || !/^0x[0-9a-fA-F]{64}$/.test(t2)) continue;
    const amount = isHexQty(l.data) && l.data.length === 66 ? BigInt(l.data) : isHexQty(l.data) && l.data.length > 2 ? BigInt(l.data) : null;
    if (amount === null) continue;
    out.push({ token: String(l.address || "").toLowerCase(), from: "0x" + t1.slice(26).toLowerCase(), to: "0x" + t2.slice(26).toLowerCase(), raw_amount: amount.toString(), log_index: hexToNum(l.logIndex) });
    if (out.length >= MAX_ERC20_TRANSFERS) break;
  }
  return out;
}

async function evmTx(chain, hash) {
  const c = EVM[chain];
  const [tx, rc, bn] = await rpcBatch(c.rpc, c.name, [["eth_getTransactionByHash", [hash]], ["eth_getTransactionReceipt", [hash]], ["eth_blockNumber", []]]);
  need(tx, c.name, "eth_getTransactionByHash");
  if (tx === null) throw notFound(`Transaction ${hash} was not found on ${c.name}`);
  if (typeof tx !== "object") throw upstreamErr(`${c.name} returned an invalid transaction`);
  const receipt = rpcErr(rc) || rc === null ? null : rc;
  const head = rpcErr(bn) ? null : hexToNum(bn);
  const blockNumber = hexToNum(tx.blockNumber);
  const value = hexToBig(tx.value) ?? 0n;
  const gasUsed = receipt ? hexToBig(receipt.gasUsed) : null;
  const effPrice = receipt ? hexToBig(receipt.effectiveGasPrice) ?? hexToBig(tx.gasPrice) : hexToBig(tx.gasPrice);
  const fee = gasUsed !== null && effPrice !== null ? gasUsed * effPrice : null;
  const statusHex = receipt ? receipt.status : null;
  const status = receipt === null ? "pending" : statusHex === "0x1" ? "success" : statusHex === "0x0" ? "failed" : "unknown";
  const input = isStr(tx.input) ? tx.input : "0x";
  return {
    chain, chain_id: c.chain_id, chain_name: c.name, hash,
    status, block_number: blockNumber, block_hash: strOrNull(tx.blockHash), transaction_index: hexToNum(tx.transactionIndex),
    confirmations: blockNumber !== null && head !== null ? Math.max(0, head - blockNumber + 1) : 0,
    from: isStr(tx.from) ? tx.from.toLowerCase() : null, to: isStr(tx.to) ? tx.to.toLowerCase() : null,
    contract_created: receipt && isStr(receipt.contractAddress) ? receipt.contractAddress.toLowerCase() : null,
    value_wei: value.toString(), value_formatted: fmtEth(value), native_symbol: c.symbol,
    nonce: hexToNum(tx.nonce), type: hexToNum(tx.type),
    gas_limit: hexToNum(tx.gas), gas_used: gasUsed === null ? null : Number(gasUsed),
    gas_price_wei: bigStr(hexToBig(tx.gasPrice)), effective_gas_price_wei: bigStr(effPrice), effective_gas_price_gwei: toGwei(effPrice),
    max_fee_per_gas_wei: bigStr(hexToBig(tx.maxFeePerGas)), max_priority_fee_per_gas_wei: bigStr(hexToBig(tx.maxPriorityFeePerGas)),
    fee_wei: bigStr(fee), fee_formatted: fee === null ? null : fmtEth(fee),
    input_selector: input.length >= 10 ? input.slice(0, 10) : null, input_bytes: Math.max(0, (input.length - 2) / 2),
    logs_count: receipt && Array.isArray(receipt.logs) ? receipt.logs.length : null,
    erc20_transfers: receipt ? decodeErc20Transfers(receipt.logs) : [],
    explorer: `${c.explorer}/tx/${hash}`,
  };
}

async function bitcoinTx(hash) {
  const [txr, tipr] = await Promise.allSettled([restGet(`/tx/${hash}`, "mempool.space", `Transaction ${hash} was not found on Bitcoin`), restGet("/blocks/tip/height", "mempool.space")]);
  if (txr.status === "rejected") throw txr.reason;
  const t = txr.value;
  if (!t || typeof t !== "object" || !isStr(t.txid)) throw upstreamErr("mempool.space returned an invalid transaction");
  const tip = tipr.status === "fulfilled" ? num(tipr.value) : null;
  const st = t.status && typeof t.status === "object" ? t.status : {};
  const height = num(st.block_height);
  const sumOut = (t.vout || []).reduce((a, o) => a + (num(o.value) || 0), 0);
  return {
    chain: "bitcoin", chain_name: "Bitcoin", hash: t.txid,
    status: st.confirmed ? "confirmed" : "unconfirmed",
    block_height: height, block_hash: strOrNull(st.block_hash), block_time: num(st.block_time), block_time_iso: iso(st.block_time),
    confirmations: st.confirmed && height !== null && tip !== null ? Math.max(0, tip - height + 1) : 0,
    fee_sats: num(t.fee), size: num(t.size), weight: num(t.weight), vsize: num(t.weight) === null ? null : Math.ceil(t.weight / 4),
    fee_rate_sat_per_vbyte: num(t.fee) !== null && num(t.weight) ? Math.round((t.fee / (t.weight / 4)) * 10) / 10 : null,
    inputs: (Array.isArray(t.vin) ? t.vin : []).slice(0, 100).map((v) => ({ txid: strOrNull(v.txid), vout: num(v.vout), address: v.prevout ? strOrNull(v.prevout.scriptpubkey_address) : null, value_sats: v.prevout ? num(v.prevout.value) : null, coinbase: Boolean(v.is_coinbase) })),
    outputs: (Array.isArray(t.vout) ? t.vout : []).slice(0, 100).map((o) => ({ address: strOrNull(o.scriptpubkey_address), value_sats: num(o.value), type: strOrNull(o.scriptpubkey_type) })),
    input_count: Array.isArray(t.vin) ? t.vin.length : null, output_count: Array.isArray(t.vout) ? t.vout.length : null,
    total_output_sats: sumOut, total_output_formatted: formatUnits(BigInt(sumOut), 8),
    explorer: `https://mempool.space/tx/${t.txid}`,
  };
}

async function solanaTx(sig) {
  const [tx, slot] = await rpcBatch(SOLANA_RPC, "Solana RPC", [["getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]], ["getSlot", [{ commitment: "confirmed" }]]]);
  need(tx, "Solana RPC", "getTransaction");
  if (tx === null) throw notFound(`Transaction ${sig} was not found on Solana (it may be older than the node's history)`);
  if (typeof tx !== "object") throw upstreamErr("Solana RPC returned an invalid transaction");
  const meta = tx.meta && typeof tx.meta === "object" ? tx.meta : {};
  const msg = tx.transaction && tx.transaction.message && typeof tx.transaction.message === "object" ? tx.transaction.message : {};
  const keys = Array.isArray(msg.accountKeys) ? msg.accountKeys : [];
  const pre = Array.isArray(meta.preBalances) ? meta.preBalances : [], post = Array.isArray(meta.postBalances) ? meta.postBalances : [];
  const accounts = keys.slice(0, 64).map((k, i) => ({ pubkey: isStr(k) ? k : strOrNull(k && k.pubkey), signer: Boolean(k && k.signer), writable: Boolean(k && k.writable), change_lamports: num(pre[i]) !== null && num(post[i]) !== null ? post[i] - pre[i] : null }));
  const ins = Array.isArray(msg.instructions) ? msg.instructions : [];
  const programs = [...new Set(ins.map((x) => (x && isStr(x.programId) ? x.programId : null)).filter(Boolean))];
  const head = rpcErr(slot) ? null : num(slot);
  const txSlot = num(tx.slot);
  return {
    chain: "solana", chain_name: "Solana", hash: sig, signature: sig,
    status: meta.err === null || meta.err === undefined ? "success" : "failed", error: meta.err === undefined ? null : meta.err,
    slot: txSlot, block_time: num(tx.blockTime), block_time_iso: iso(tx.blockTime),
    slots_since: txSlot !== null && head !== null ? Math.max(0, head - txSlot) : null,
    fee_lamports: num(meta.fee), fee_formatted: num(meta.fee) === null ? null : formatUnits(BigInt(meta.fee), 9),
    signers: accounts.filter((a) => a.signer).map((a) => a.pubkey),
    instruction_count: ins.length, programs,
    compute_units_consumed: num(meta.computeUnitsConsumed),
    accounts,
    log_messages_count: Array.isArray(meta.logMessages) ? meta.logMessages.length : null,
    version: tx.version === undefined ? null : tx.version,
    explorer: `https://solscan.io/tx/${sig}`,
  };
}

async function doTx(p) {
  let body;
  try { body = p.chain === "bitcoin" ? await bitcoinTx(p.hash) : p.chain === "solana" ? await solanaTx(p.hash) : await evmTx(p.chain, p.hash); }
  catch (e) {
    if (e instanceof FetchError && e.status === 404) return { status: 404, body: { error: `${e.message}; no payment was taken`, chain: p.chain, hash: p.hash } };
    return { status: 502, body: { error: `${e && e.message ? e.message : "Upstream error"}: data source temporarily unavailable, no payment taken` } };
  }
  return { status: 200, body: { ...body, fetched_at: new Date().toISOString() } };
}

async function evmBlock(chain, p) {
  const c = EVM[chain];
  const call = p.hash ? ["eth_getBlockByHash", [p.hash, false]] : ["eth_getBlockByNumber", [p.number === null ? "latest" : "0x" + p.number.toString(16), false]];
  const [b] = await rpcBatch(c.rpc, c.name, [call]);
  need(b, c.name, call[0]);
  if (b === null) throw notFound(`Block ${p.hash || (p.number === null ? "latest" : p.number)} was not found on ${c.name}`);
  if (typeof b !== "object") throw upstreamErr(`${c.name} returned an invalid block`);
  const gasUsed = hexToBig(b.gasUsed), gasLimit = hexToBig(b.gasLimit), baseFee = hexToBig(b.baseFeePerGas);
  const ts = hexToNum(b.timestamp);
  return {
    chain, chain_id: c.chain_id, chain_name: c.name,
    number: hexToNum(b.number), hash: strOrNull(b.hash), parent_hash: strOrNull(b.parentHash),
    timestamp: ts, timestamp_iso: iso(ts),
    tx_count: Array.isArray(b.transactions) ? b.transactions.length : null,
    gas_used: bigStr(gasUsed), gas_limit: bigStr(gasLimit),
    gas_used_pct: gasUsed !== null && gasLimit ? Number((gasUsed * 10000n) / gasLimit) / 100 : null,
    base_fee_wei: bigStr(baseFee), base_fee_gwei: toGwei(baseFee),
    miner: isStr(b.miner) ? b.miner.toLowerCase() : null,
    size_bytes: hexToNum(b.size),
    explorer: `${c.explorer}/block/${hexToNum(b.number) ?? ""}`,
  };
}

async function bitcoinBlock(p) {
  let hash = p.hash;
  if (!hash) {
    let h = p.number;
    if (h === null) { h = await restGet("/blocks/tip/height", "mempool.space"); if (num(h) === null) throw upstreamErr("mempool.space returned an invalid tip height"); }
    hash = await restGet(`/block-height/${h}`, "mempool.space", `Bitcoin block ${h} does not exist yet`);
    if (!isStr(hash) || !RE_HEX32_BARE.test(hash)) throw upstreamErr("mempool.space returned an invalid block hash");
  }
  const b = await restGet(`/block/${hash}`, "mempool.space", `Bitcoin block ${hash} was not found`);
  if (!b || typeof b !== "object" || !isStr(b.id)) throw upstreamErr("mempool.space returned an invalid block");
  return {
    chain: "bitcoin", chain_name: "Bitcoin",
    number: num(b.height), height: num(b.height), hash: b.id, parent_hash: strOrNull(b.previousblockhash),
    timestamp: num(b.timestamp), timestamp_iso: iso(b.timestamp), median_time: num(b.mediantime),
    tx_count: num(b.tx_count), size_bytes: num(b.size), weight: num(b.weight),
    difficulty: num(b.difficulty), nonce: num(b.nonce), bits: num(b.bits), version: num(b.version), merkle_root: strOrNull(b.merkle_root),
    explorer: `https://mempool.space/block/${b.id}`,
  };
}

async function solanaBlock(p) {
  let slot = p.number;
  if (slot === null) {
    const [s] = await rpcBatch(SOLANA_RPC, "Solana RPC", [["getSlot", [{ commitment: "confirmed" }]]]);
    need(s, "Solana RPC", "getSlot");
    if (num(s) === null) throw upstreamErr("Solana RPC returned an invalid slot");
    slot = s;
  }
  const [b] = await rpcBatch(SOLANA_RPC, "Solana RPC", [["getBlock", [slot, { encoding: "json", transactionDetails: "none", rewards: false, maxSupportedTransactionVersion: 0, commitment: "confirmed" }]]]);
  const e = rpcErr(b);
  if (e) {
    if (e.code === -32007 || e.code === -32009 || e.code === -32004 || /skipped|not available|missing/i.test(e.message)) throw notFound(`Solana slot ${slot} was skipped or is not available on this node`);
    throw upstreamErr(`Solana RPC getBlock failed: ${e.message}`);
  }
  if (b === null) throw notFound(`Solana slot ${slot} was not found`);
  if (typeof b !== "object") throw upstreamErr("Solana RPC returned an invalid block");
  return {
    chain: "solana", chain_name: "Solana",
    number: slot, slot, block_height: num(b.blockHeight), hash: strOrNull(b.blockhash), parent_hash: strOrNull(b.previousBlockhash), parent_slot: num(b.parentSlot),
    timestamp: num(b.blockTime), timestamp_iso: iso(b.blockTime),
    tx_count: Array.isArray(b.transactions) ? b.transactions.length : Array.isArray(b.signatures) ? b.signatures.length : null,
    explorer: `https://solscan.io/block/${slot}`,
  };
}

async function doBlock(p) {
  let body;
  try { body = p.chain === "bitcoin" ? await bitcoinBlock(p) : p.chain === "solana" ? await solanaBlock(p) : await evmBlock(p.chain, p); }
  catch (e) {
    if (e instanceof FetchError && e.status === 404) return { status: 404, body: { error: `${e.message}; no payment was taken`, chain: p.chain } };
    return { status: 502, body: { error: `${e && e.message ? e.message : "Upstream error"}: data source temporarily unavailable, no payment taken` } };
  }
  return { status: 200, body: { ...body, fetched_at: new Date().toISOString() } };
}

const HANDLERS = { balance: doBalance, gas: doGas, tx: doTx, block: doBlock };

// ---------- x402 ----------
function requirements(env, route) {
  return {
    scheme: "exact",
    network: NETWORK,
    amount: ROUTES[route].price,
    asset: USDC_BASE,
    payTo: env.PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { name: "USD Coin", version: "2" },
  };
}
// Two routes share each price, so the requirements alone cannot tell them apart: a payment signed for one
// route carries that route's resource URL and is rejected on another.
function resourceMatches(payload, route) {
  const res = payload && payload.resource;
  if (!res || !isStr(res.url)) return true; // tolerate clients that omit resource; requirements still must match
  try { return (new URL(res.url).pathname.replace(/\/+$/, "") || "/") === route; } catch { return false; }
}

const EX_ADDR = "0x6f762720b8515b7091e6aa69e8361f7b9909233f";
const EX_HASH = "0x5c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060";
const EXAMPLES = {
  "/balance": {
    input: { address: EX_ADDR, chain: "base" },
    output: {
      address: EX_ADDR, address_type: "evm", scope: "base", chains_ok: 1, chains_failed: 0,
      balances: { base: { ok: true, chain: "base", chain_id: 8453, chain_name: "Base", address: EX_ADDR, native: { symbol: "ETH", wei: "12345600000000000", formatted: "0.0123456" }, usdc: { contract: USDC_BASE, decimals: 6, raw: "25500000", formatted: "25.5" }, tx_count: 42, block_number: 36512345, explorer: `https://basescan.org/address/${EX_ADDR}` } },
      fetched_at: "2026-10-15T12:00:00.000Z",
    },
  },
  "/gas": {
    input: { chain: "base" },
    output: {
      scope: "base", unit: "gwei (EVM) / sat per vbyte (bitcoin)", chains_ok: 1, chains_failed: 0,
      gas: { base: { ok: true, chain: "base", chain_id: 8453, chain_name: "Base", block_number: 36512345, gas_price_gwei: 0.0105, gas_price_wei: "10500000", base_fee_gwei: 0.0098, next_base_fee_gwei: 0.0101, priority_fee_gwei: { p25: 0.0005, p50: 0.001, p75: 0.002 }, suggested: { slow: { max_priority_fee_gwei: 0.0005, max_fee_gwei: 0.0207 }, standard: { max_priority_fee_gwei: 0.001, max_fee_gwei: 0.0212 }, fast: { max_priority_fee_gwei: 0.002, max_fee_gwei: 0.0222 } }, fee_history: { blocks: 5, oldest_block: 36512340, avg_gas_used_ratio: 0.41, percentiles: [25, 50, 75] }, eip1559: true } },
      fetched_at: "2026-10-15T12:00:00.000Z",
    },
  },
  "/tx": {
    input: { hash: EX_HASH, chain: "base" },
    output: {
      chain: "base", chain_id: 8453, chain_name: "Base", hash: EX_HASH, status: "success", block_number: 36512300, block_hash: "0x9b1c6e0b0f5d2a3c4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5", transaction_index: 12, confirmations: 46,
      from: "0x1111111111111111111111111111111111111111", to: USDC_BASE.toLowerCase(), contract_created: null, value_wei: "0", value_formatted: "0", native_symbol: "ETH", nonce: 7, type: 2,
      gas_limit: 65000, gas_used: 48211, gas_price_wei: "10500000", effective_gas_price_wei: "10500000", effective_gas_price_gwei: 0.0105, max_fee_per_gas_wei: "21000000", max_priority_fee_per_gas_wei: "1000000", fee_wei: "506215500000", fee_formatted: "0.0000005062155",
      input_selector: "0xa9059cbb", input_bytes: 68, logs_count: 1,
      erc20_transfers: [{ token: USDC_BASE.toLowerCase(), from: "0x1111111111111111111111111111111111111111", to: EX_ADDR, raw_amount: "25500000", log_index: 3 }],
      explorer: `https://basescan.org/tx/${EX_HASH}`, fetched_at: "2026-10-15T12:00:00.000Z",
    },
  },
  "/block": {
    input: { chain: "base", number: "latest" },
    output: {
      chain: "base", chain_id: 8453, chain_name: "Base", number: 36512345, hash: "0x9b1c6e0b0f5d2a3c4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5", parent_hash: "0x8a0b5d9a9e4c1b2a3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4",
      timestamp: 1760529600, timestamp_iso: "2026-10-15T12:00:00.000Z", tx_count: 187, gas_used: "41234567", gas_limit: "120000000", gas_used_pct: 34.36, base_fee_wei: "9800000", base_fee_gwei: 0.0098, miner: "0x4200000000000000000000000000000000000011", size_bytes: 98213,
      explorer: "https://basescan.org/block/36512345", fetched_at: "2026-10-15T12:00:00.000Z",
    },
  },
};
const QUERY_PROPS = {
  "/balance": {
    address: { type: "string", description: "Wallet address: EVM 0x + 40 hex, Solana base58 (32-44 chars) or Bitcoin (bc1..., 1..., 3...)" },
    chain: { type: "string", description: `Optional: ${EVM_CHAINS.join(", ")}, solana, bitcoin or all (default: all 7 EVM chains for a 0x address, solana for base58, bitcoin for a Bitcoin address)` },
  },
  "/gas": {
    chain: { type: "string", description: `Optional: ${EVM_CHAINS.join(", ")}, bitcoin or all (default all = the 7 EVM chains)` },
  },
  "/tx": {
    hash: { type: "string", description: "Transaction hash: EVM 0x + 64 hex, Bitcoin 64-hex txid, or Solana base58 signature" },
    chain: { type: "string", description: `Required for an EVM hash (${EVM_CHAINS.join(", ")}); optional bitcoin / solana (inferred from the hash format)` },
  },
  "/block": {
    chain: { type: "string", description: `Required: ${EVM_CHAINS.join(", ")}, solana or bitcoin` },
    number: { type: "string", description: "Optional block number (decimal or 0x hex), Solana slot, or \"latest\" (default)" },
    hash: { type: "string", description: "Optional block hash instead of number (EVM 0x + 64 hex, Bitcoin 64 hex; not for Solana)" },
  },
};
const REQUIRED_QUERY = { "/balance": ["address"], "/gas": [], "/tx": ["hash"], "/block": ["chain"] };
const ROUTE_DESCRIPTIONS = {
  "/balance": "Wallet address -> native balance, USDC balance and transaction count on 7 EVM chains (one or all in parallel), Solana (SOL + USDC) or Bitcoin.",
  "/gas": "Current gas price, base fee and priority-fee percentiles in gwei for one or all 7 EVM chains (eth_feeHistory, 5 blocks), or Bitcoin sat/vB fee estimates.",
  "/tx": "Transaction hash -> status, from/to, value, gas used, fee, confirmations and decoded ERC-20 transfers (EVM); Bitcoin tx with inputs/outputs; Solana tx with signers, programs and balance changes.",
  "/block": "Block by number, hash or latest -> number, hash, timestamp, tx count, gas used/limit, base fee, miner (EVM); Bitcoin block header; Solana slot summary.",
};

function paymentRequired(env, url, route, error) {
  return {
    x402Version: 2,
    error,
    resource: { url: `${url.origin}${route}`, description: `${SERVICE} ${ROUTES[route].name}: ${ROUTE_DESCRIPTIONS[route]}`, mimeType: "application/json" },
    accepts: [requirements(env, route)],
    extensions: {
      bazaar: {
        info: {
          input: { type: "http", method: "GET", queryParams: EXAMPLES[route].input },
          output: { type: "json", example: EXAMPLES[route].output },
        },
        schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            input: {
              type: "object",
              properties: {
                type: { type: "string", const: "http" },
                method: { type: "string", enum: ["GET", "HEAD", "DELETE"] },
                queryParams: { type: "object", properties: QUERY_PROPS[route], required: REQUIRED_QUERY[route] },
              },
              required: ["type", "method"],
              additionalProperties: false,
            },
            output: {
              type: "object",
              properties: { type: { type: "string" }, example: { type: "object" } },
              required: ["type"],
            },
          },
          required: ["input"],
        },
      },
    },
  };
}
function send402(env, url, route, error) {
  const pr = paymentRequired(env, url, route, error);
  return json(pr, 402, { "PAYMENT-REQUIRED": b64e(pr) });
}

function openapi(origin) {
  const nullable = (t, extra = {}) => ({ type: [t, "null"], ...extra });
  const chainEnum = [...EVM_CHAINS, "solana", "bitcoin"];
  const params = {
    "/balance": {
      type: "object",
      properties: {
        address: { type: "string", description: "Wallet address. EVM: 0x + 40 hex (checked on every EVM chain unless chain is set). Solana: base58, 32-44 chars. Bitcoin: bc1..., 1... or 3..." },
        chain: { type: "string", enum: [...chainEnum, "all"], description: "Which chain to query. 0x address: one EVM chain or all (default all). Base58 address: solana (default). Bitcoin address: bitcoin (default)." },
      },
      required: ["address"],
    },
    "/gas": {
      type: "object",
      properties: { chain: { type: "string", enum: [...EVM_CHAINS, "bitcoin", "all"], default: "all", description: "One EVM chain, bitcoin, or all (= the 7 EVM chains in parallel)" } },
    },
    "/tx": {
      type: "object",
      properties: {
        hash: { type: "string", description: "EVM: 0x + 64 hex. Bitcoin: 64-hex txid. Solana: base58 signature (87-88 chars)." },
        chain: { type: "string", enum: chainEnum, description: "Required for EVM hashes (the same hash format is used on every EVM chain). bitcoin and solana are inferred from the hash format and may be omitted." },
      },
      required: ["hash"],
    },
    "/block": {
      type: "object",
      properties: {
        chain: { type: "string", enum: chainEnum },
        number: { type: ["string", "integer"], description: "Block number (decimal or 0x hex) / Solana slot, or \"latest\" (default when number and hash are omitted)" },
        hash: { type: "string", description: "Block hash (EVM 0x + 64 hex, Bitcoin 64 hex). Not supported for Solana. Mutually exclusive with number." },
      },
      required: ["chain"],
    },
  };
  const perChainNote = "Keyed by chain name. Each entry is either a result with ok: true or {ok: false, chain, error} when that chain's node failed; the call is only charged when at least one chain succeeded.";
  const evmBal = {
    type: "object",
    properties: {
      ok: { type: "boolean" }, chain: { type: "string" }, chain_id: nullable("integer"), chain_name: { type: "string" }, address: { type: "string" },
      native: { type: "object", description: "Native coin balance: {symbol, wei|lamports|sats (decimal string), formatted (decimal string in whole coins)}; Bitcoin adds unconfirmed_sats" },
      usdc: nullable("object", { description: "USDC balance on this chain: {contract|mint, decimals, raw (decimal string), formatted}; null on Bitcoin, raw/formatted null if the token call failed" }),
      tx_count: nullable("integer", { description: "EVM nonce (outgoing tx count) / Bitcoin confirmed tx count; null on Solana" }),
      block_number: nullable("integer"), slot: nullable("integer"), explorer: { type: "string" },
      error: { type: "string", description: "Only when ok is false" },
    },
    required: ["ok", "chain"],
  };
  const gasEntry = {
    type: "object",
    properties: {
      ok: { type: "boolean" }, chain: { type: "string" }, chain_id: nullable("integer"), chain_name: { type: "string" }, block_number: nullable("integer"),
      gas_price_gwei: nullable("number", { description: "eth_gasPrice in gwei" }), gas_price_wei: nullable("string"),
      base_fee_gwei: nullable("number", { description: "Base fee of the latest block" }), next_base_fee_gwei: nullable("number", { description: "Base fee of the next block (from eth_feeHistory)" }),
      priority_fee_gwei: { type: "object", description: "Average tip over the last 5 blocks at the 25th/50th/75th percentile: {p25, p50, p75}" },
      suggested: { type: "object", description: "{slow, standard, fast}: each {max_priority_fee_gwei, max_fee_gwei = 2 * next base fee + tip}" },
      fee_history: { type: "object" }, eip1559: { type: "boolean" },
      block_height: nullable("integer", { description: "Bitcoin only" }), fees_sat_per_vbyte: { type: "object", description: "Bitcoin only: {fastest, half_hour, hour, economy, minimum}" },
      error: { type: "string", description: "Only when ok is false" },
    },
    required: ["ok", "chain"],
  };
  const transfer = { type: "object", properties: { token: { type: "string", description: "ERC-20 contract address" }, from: { type: "string" }, to: { type: "string" }, raw_amount: { type: "string", description: "Token amount in the token's smallest unit (decimal string); divide by the token's decimals" }, log_index: nullable("integer") }, required: ["token", "from", "to", "raw_amount"] };
  const outputs = {
    "/balance": {
      type: "object",
      properties: { address: { type: "string" }, address_type: { type: "string", enum: ["evm", "solana", "bitcoin"] }, scope: { type: "string", description: "Chain queried, or all" }, chains_ok: { type: "integer" }, chains_failed: { type: "integer" }, balances: { type: "object", additionalProperties: evmBal, description: perChainNote }, fetched_at: { type: "string", format: "date-time" } },
      required: ["address", "address_type", "scope", "chains_ok", "chains_failed", "balances", "fetched_at"],
    },
    "/gas": {
      type: "object",
      properties: { scope: { type: "string" }, unit: { type: "string" }, chains_ok: { type: "integer" }, chains_failed: { type: "integer" }, gas: { type: "object", additionalProperties: gasEntry, description: perChainNote }, fetched_at: { type: "string", format: "date-time" } },
      required: ["scope", "chains_ok", "chains_failed", "gas", "fetched_at"],
    },
    "/tx": {
      type: "object",
      description: "EVM fields shown; Bitcoin returns {status confirmed|unconfirmed, block_height, confirmations, fee_sats, vsize, fee_rate_sat_per_vbyte, inputs[], outputs[], total_output_sats}; Solana returns {status success|failed, slot, block_time, fee_lamports, signers[], programs[], instruction_count, accounts[{pubkey, signer, writable, change_lamports}]}",
      properties: {
        chain: { type: "string" }, chain_id: nullable("integer"), chain_name: { type: "string" }, hash: { type: "string" },
        status: { type: "string", description: "EVM: success | failed | pending. Bitcoin: confirmed | unconfirmed. Solana: success | failed" },
        block_number: nullable("integer"), block_hash: nullable("string"), transaction_index: nullable("integer"), confirmations: { type: "integer", description: "Blocks since inclusion (0 when pending)" },
        from: nullable("string"), to: nullable("string", { description: "null for contract creation" }), contract_created: nullable("string"),
        value_wei: { type: "string" }, value_formatted: { type: "string", description: "Native value in whole coins" }, native_symbol: { type: "string" }, nonce: nullable("integer"), type: nullable("integer"),
        gas_limit: nullable("integer"), gas_used: nullable("integer"), gas_price_wei: nullable("string"), effective_gas_price_wei: nullable("string"), effective_gas_price_gwei: nullable("number"),
        max_fee_per_gas_wei: nullable("string"), max_priority_fee_per_gas_wei: nullable("string"), fee_wei: nullable("string"), fee_formatted: nullable("string", { description: "gas_used * effective gas price, in whole coins" }),
        input_selector: nullable("string", { description: "First 4 bytes of calldata (function selector), e.g. 0xa9059cbb = transfer" }), input_bytes: { type: "integer" }, logs_count: nullable("integer"),
        erc20_transfers: { type: "array", items: transfer, description: `Decoded Transfer(address,address,uint256) events (max ${MAX_ERC20_TRANSFERS})` },
        explorer: { type: "string" }, fetched_at: { type: "string", format: "date-time" },
      },
      required: ["chain", "hash", "status", "confirmations", "explorer", "fetched_at"],
    },
    "/block": {
      type: "object",
      description: "EVM fields shown; Bitcoin adds height, median_time, weight, difficulty, nonce, bits, version, merkle_root; Solana returns slot, block_height, hash (blockhash), parent_hash, parent_slot, timestamp",
      properties: {
        chain: { type: "string" }, chain_id: nullable("integer"), chain_name: { type: "string" }, number: nullable("integer"), hash: nullable("string"), parent_hash: nullable("string"),
        timestamp: nullable("integer", { description: "Unix seconds" }), timestamp_iso: nullable("string"), tx_count: nullable("integer"),
        gas_used: nullable("string"), gas_limit: nullable("string"), gas_used_pct: nullable("number"), base_fee_wei: nullable("string"), base_fee_gwei: nullable("number"), miner: nullable("string"), size_bytes: nullable("integer"),
        explorer: { type: "string" }, fetched_at: { type: "string", format: "date-time" },
      },
      required: ["chain", "number", "hash", "timestamp", "tx_count", "explorer", "fetched_at"],
    },
  };
  const summaries = {
    "/balance": "Native + USDC balance and tx count for a wallet on 7 EVM chains (one or all), Solana or Bitcoin",
    "/gas": "Gas price, base fee and priority-fee percentiles (gwei) for EVM chains; Bitcoin sat/vB fees",
    "/tx": "Transaction lookup with receipt, confirmations and decoded ERC-20 transfers (EVM), or Bitcoin / Solana transaction",
    "/block": "Block summary by number, hash or latest (EVM, Bitcoin) or slot (Solana)",
  };
  const notFoundDesc = { "/balance": "Bitcoin address unknown to mempool.space (no charge)", "/gas": "Not used", "/tx": "Transaction not found on that chain (no charge)", "/block": "Block / slot does not exist or was skipped (no charge)" };
  const op = (route, method) => ({
    operationId: ROUTES[route].name + (method === "post" ? "Post" : ""),
    summary: summaries[route],
    tags: ["Blockchain", "Crypto", "Web3", ROUTES[route].name],
    "x-payment-info": { price: { mode: "fixed", currency: "USD", amount: ROUTES[route].usd }, protocols: [{ x402: {} }] },
    ...(method === "post"
      ? { requestBody: { required: true, content: { "application/json": { schema: params[route] } } } }
      : { parameters: Object.entries(params[route].properties).map(([n, sch]) => ({ name: n, in: "query", required: (params[route].required || []).includes(n), schema: { type: "string" }, description: sch.description })) }),
    responses: {
      200: { description: "Result", content: { "application/json": { schema: outputs[route] } } },
      400: { description: "Missing or invalid parameters (no charge)" },
      402: { description: "Payment Required" },
      ...(route === "/gas" ? {} : { 404: { description: notFoundDesc[route] } }),
      413: { description: `Request body larger than ${MAX_REQUEST_BYTES} bytes (no charge)` },
      502: { description: `Node unreachable, timed out (${TIMEOUT_MS / 1000} s) or returned an error; for chain=all only when every chain failed (no charge)` },
    },
  });
  return {
    openapi: "3.1.0",
    info: {
      title: SERVICE,
      version: "1.0.0",
      description: DESCRIPTION,
      "x-guidance": `Cheap read-only blockchain lookups for AI agents, paid per call in USDC on Base via x402; you are only charged when data is returned (400/404/413/502 are free). GET with query parameters or POST a JSON body. Chains: ${EVM_CHAINS.join(", ")} (EVM), solana, bitcoin. /balance $0.002 {address, chain?} -> native balance (wei/lamports/sats + formatted), USDC balance (raw + formatted) and tx count; a 0x address defaults to all 7 EVM chains in one call (per-chain ok/error, charged if at least one succeeds), a base58 address to solana, a Bitcoin address to bitcoin. /gas $0.001 {chain?} -> per EVM chain: gas_price_gwei, base_fee_gwei, next_base_fee_gwei, priority_fee_gwei {p25, p50, p75} averaged over the last 5 blocks, suggested {slow, standard, fast} and block_number; default all 7 EVM chains; chain=bitcoin -> sat/vB estimates (fastest, half_hour, hour, economy, minimum). /tx $0.002 {hash, chain} -> EVM: status success|failed|pending, from, to, value, gas_used, fee, confirmations, erc20_transfers [{token, from, to, raw_amount}] decoded from Transfer logs (amounts are in the token's smallest unit); chain is required for 0x hashes because the same hash format is used on every EVM chain; bitcoin and solana are inferred from the hash. /block $0.001 {chain, number?|hash?} -> number, hash, timestamp, tx_count, gas_used, gas_limit, base_fee, miner (EVM); Bitcoin header; Solana slot (number = slot). All raw amounts are decimal strings (BigInt-safe); formatted values are decimal strings in whole coins. Data comes from public nodes (publicnode.com JSON-RPC, mempool.space REST) and is live, not cached. Best for: checking whether a wallet holds funds or USDC before acting, estimating gas before sending, confirming a payment or transfer landed, verifying a transaction's status and token movements, watching chain head / block times.`,
    },
    servers: [{ url: origin }],
    paths: Object.fromEntries(Object.keys(ROUTES).map((r) => [r, { get: op(r, "get"), post: op(r, "post") }])),
  };
}

// Free operator probe: one eth_blockNumber on Base, reports only status, block and latency.
async function healthData() {
  const t0 = Date.now();
  try {
    const [bn] = await rpcBatch(EVM.base.rpc, EVM.base.name, [["eth_blockNumber", []]]);
    const n = rpcErr(bn) ? null : hexToNum(bn);
    if (n === null) return json({ base_rpc_status: "down", base_block_number: null, ms: Date.now() - t0 }, 503);
    return json({ base_rpc_status: "ok", base_block_number: n, ms: Date.now() - t0 });
  } catch {
    return json({ base_rpc_status: "down", base_block_number: null, ms: Date.now() - t0 }, 503);
  }
}

export default {
  async fetch(request, env0, ctx) {
    const env = { ...env0, PAY_TO: (env0 && env0.PAY_TO) || DEFAULT_PAY_TO };
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "PAYMENT-SIGNATURE, Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" } });
    }
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        service: SERVICE,
        description: DESCRIPTION,
        openapi: `${url.origin}/openapi.json`,
        health: `${url.origin}/health/data`,
        chains: { evm: EVM_CHAINS, other: ["solana", "bitcoin"] },
        endpoints: Object.fromEntries(Object.keys(ROUTES).map((r) => [r, { methods: ["GET", "POST"], url: `${url.origin}${r}`, price: `$${Number(ROUTES[r].usd).toString()} USDC on Base per successful request (x402)`, example: `${url.origin}${r}?${new URLSearchParams(EXAMPLES[r].input)}`, description: ROUTE_DESCRIPTIONS[r] }])),
        params: {
          "/balance": { address: "required: 0x EVM, Solana base58 or Bitcoin address", chain: `optional: ${EVM_CHAINS.join("|")}|solana|bitcoin|all (default all EVM / solana / bitcoin by address type)` },
          "/gas": { chain: `optional: ${EVM_CHAINS.join("|")}|bitcoin|all (default all EVM)` },
          "/tx": { hash: "required: 0x + 64 hex (EVM), 64 hex (Bitcoin) or base58 signature (Solana)", chain: "required for EVM hashes; bitcoin/solana inferred" },
          "/block": { chain: "required", number: "optional: decimal, 0x hex, Solana slot or latest (default)", hash: "optional: block hash (EVM, Bitcoin)" },
        },
        sources: { evm: "publicnode.com JSON-RPC", solana: "publicnode.com Solana JSON-RPC", bitcoin: "mempool.space REST API" },
        limits: { timeout_seconds: TIMEOUT_MS / 1000, max_request_bytes: MAX_REQUEST_BYTES, erc20_transfers_max: MAX_ERC20_TRANSFERS },
        no_charge_on: ["400 invalid input", "404 transaction/block not found", "413 request too large", "502 node unavailable (for chain=all: every chain failed)"],
        configured: Boolean(env.PAY_TO),
        facilitator: env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET ? "cdp" : "payai",
      });
    }
    if (url.pathname === "/openapi.json" || url.pathname === "/.well-known/openapi.json") return json(openapi(url.origin));
    if (url.pathname === "/health/data") {
      if (request.method !== "GET") return json({ error: "Use GET" }, 405);
      return healthData();
    }
    const route = url.pathname.replace(/\/+$/, "") || url.pathname;
    if (!ROUTES[route]) return json({ error: `Not found. Use ${Object.keys(ROUTES).join(", ")}` }, 404);
    if (!env.PAY_TO || !/^0x[0-9a-fA-F]{40}$/.test(env.PAY_TO)) return json({ error: "Service not configured: PAY_TO wallet address missing" }, 500);
    if (request.method !== "GET" && request.method !== "POST") return json({ error: "Use GET or POST" }, 405);
    const len = Number(request.headers.get("content-length"));
    if (Number.isFinite(len) && len > MAX_REQUEST_BYTES) return json({ error: `Request body too large (max ${MAX_REQUEST_BYTES} bytes) (no payment was taken)` }, 413);
    if (request.url.length > MAX_REQUEST_BYTES) return json({ error: `Request URL too long (max ${MAX_REQUEST_BYTES} bytes) (no payment was taken)` }, 413);

    const header = request.headers.get("PAYMENT-SIGNATURE") || request.headers.get("X-PAYMENT");
    if (!header) return send402(env, url, route, "PAYMENT-SIGNATURE header is required");
    const rp = await readParams(request, url);
    if (rp.error) return json(fail(rp.error), rp.status || 400);
    const q = VALIDATORS[ROUTES[route].name](rp.params);
    if (q.error) return json(q, 400);

    let payload;
    try { payload = b64d(header); } catch { return json({ error: "Invalid payment payload" }, 400); }
    const reqs = requirements(env, route);
    if (payload.x402Version !== 2 || !deepEqual(payload.accepted, reqs) || !resourceMatches(payload, route)) return send402(env, url, route, "No matching payment requirements found");

    const fac = facilitator(env);
    const body = { x402Version: 2, paymentPayload: payload, paymentRequirements: reqs };
    let v;
    try { v = await fac.call("verify", body); } catch (e) { return json({ error: "Facilitator unreachable", detail: String(e) }, 500); }
    if (!v.ok || !v.data.isValid) return send402(env, url, route, v.data.invalidReason || v.data.error || `verify failed (${v.status})`);

    let result;
    try { result = await HANDLERS[ROUTES[route].name](q, ctx); } catch { return json({ error: "Data source temporarily unavailable, no payment taken" }, 502); }
    if (result.status !== 200) return json(result.body, result.status);

    let s;
    try { s = await fac.call("settle", body); } catch (e) { return json({ error: "Facilitator unreachable", detail: String(e) }, 500); }
    if (!s.ok || !s.data.success) {
      const failure = { success: false, errorReason: s.data.errorReason || s.data.error || `settle failed (${s.status})`, transaction: "", network: NETWORK, payer: s.data.payer || v.data.payer };
      return json({}, 402, { "PAYMENT-RESPONSE": b64e(failure) });
    }
    const receipt = { success: true, transaction: s.data.transaction, network: s.data.network || NETWORK, payer: s.data.payer || v.data.payer };
    return json(result.body, 200, { "PAYMENT-RESPONSE": b64e(receipt) });
  },
};
