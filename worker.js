// NoJunk Crypto Price — a paid (x402) USD crypto price lookup for AI agents.
// Data: CoinGecko (simple/price for listed coins, on-chain token API for contract addresses).
// Settings (Cloudflare Worker > Settings > Variables and Secrets):
//   PAY_TO              (optional) Base wallet address that receives USDC (defaults to DEFAULT_PAY_TO)
//   CG_DEMO_KEY         (optional, Secret) CoinGecko Demo API key -> sent as x-cg-demo-api-key; without it
//                       the keyless public endpoints are used (api.coingecko.com simple/price, GeckoTerminal on-chain)
//   CDP_API_KEY_ID      (optional) Coinbase Developer Platform API key id   -> enables Bazaar listing
//   CDP_API_KEY_SECRET  (optional, Secret) Coinbase Developer Platform API key secret
// Without the CDP keys the service uses the keyless PayAI facilitator.

const DEFAULT_PAY_TO = "0x6f762720b8515b7091e6aa69e8361f7b9909233f"; // Mick's Base wallet
const PRICE_ATOMIC = "1000"; // $0.001 in USDC (6 decimals)
const NETWORK = "eip155:8453"; // Base mainnet
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CDP_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
const PAYAI_URL = "https://facilitator.payai.network";
const SERVICE = "NoJunk Crypto Price";
const DESCRIPTION =
  "Current USD price, market cap, 24h volume and 24h change for up to 10 cryptocurrencies by ticker symbol (BTC, ETH, SOL, ...) or for any on-chain token by contract address and chain (ethereum, base, bsc, arbitrum, polygon, optimism, avalanche, solana). Data from CoinGecko.";

const CG_API = "https://api.coingecko.com/api/v3";
const GT_API = "https://api.geckoterminal.com/api/v2"; // keyless fallback for on-chain lookups
const SOURCE = "CoinGecko";
const ATTRIBUTION = "Powered by CoinGecko (https://www.coingecko.com)";
const USER_AGENT = "NoJunk Crypto Price/1.0 (+https://nojunkcrypto.com)";
const MAX_SYMBOLS = 10;
const MAX_QUERY_CHARS = 2048;
const MAX_BODY_BYTES = 8192;
const CACHE_SECONDS = 30;
const UPSTREAM_TIMEOUT_MS = 8000;

// chain name (input) -> { cg: CoinGecko on-chain network id, evm: address format }
const CHAINS = {
  ethereum: { cg: "eth", evm: true },
  base: { cg: "base", evm: true },
  bsc: { cg: "bsc", evm: true },
  arbitrum: { cg: "arbitrum", evm: true },
  polygon: { cg: "polygon_pos", evm: true },
  optimism: { cg: "optimism", evm: true },
  avalanche: { cg: "avax", evm: true },
  solana: { cg: "solana", evm: false },
};
const CHAIN_ALIASES = { eth: "ethereum", mainnet: "ethereum", bnb: "bsc", "binance-smart-chain": "bsc", arb: "arbitrum", arbitrum_one: "arbitrum", "arbitrum-one": "arbitrum", matic: "polygon", polygon_pos: "polygon", "polygon-pos": "polygon", op: "optimism", avax: "avalanche", sol: "solana" };

// Ticker symbol -> [CoinGecko coin id, display name].
const SYMBOLS = {
  BTC: ["bitcoin", "Bitcoin"], ETH: ["ethereum", "Ethereum"], USDT: ["tether", "Tether"], XRP: ["ripple", "XRP"],
  BNB: ["binancecoin", "BNB"], SOL: ["solana", "Solana"], USDC: ["usd-coin", "USDC"], TRX: ["tron", "TRON"],
  DOGE: ["dogecoin", "Dogecoin"], ADA: ["cardano", "Cardano"], HYPE: ["hyperliquid", "Hyperliquid"], WBTC: ["wrapped-bitcoin", "Wrapped Bitcoin"],
  STETH: ["staked-ether", "Lido Staked Ether"], BCH: ["bitcoin-cash", "Bitcoin Cash"], LINK: ["chainlink", "Chainlink"], XLM: ["stellar", "Stellar"],
  LEO: ["leo-token", "LEO Token"], USDS: ["usds", "USDS"], AVAX: ["avalanche-2", "Avalanche"], HBAR: ["hedera-hashgraph", "Hedera"],
  SUI: ["sui", "Sui"], LTC: ["litecoin", "Litecoin"], SHIB: ["shiba-inu", "Shiba Inu"], TON: ["the-open-network", "Toncoin"],
  CRO: ["crypto-com-chain", "Cronos"], DOT: ["polkadot", "Polkadot"], XMR: ["monero", "Monero"], USDE: ["ethena-usde", "Ethena USDe"],
  DAI: ["dai", "Dai"], UNI: ["uniswap", "Uniswap"], WLFI: ["world-liberty-financial", "World Liberty Financial"], PEPE: ["pepe", "Pepe"],
  AAVE: ["aave", "Aave"], OKB: ["okb", "OKB"], ENA: ["ethena", "Ethena"], MNT: ["mantle", "Mantle"],
  TAO: ["bittensor", "Bittensor"], BGB: ["bitget-token", "Bitget Token"], NEAR: ["near", "NEAR Protocol"], ETC: ["ethereum-classic", "Ethereum Classic"],
  APT: ["aptos", "Aptos"], ICP: ["internet-computer", "Internet Computer"], ONDO: ["ondo-finance", "Ondo"], POL: ["polygon-ecosystem-token", "POL (ex-MATIC)"],
  MATIC: ["matic-network", "Polygon (MATIC)"], PI: ["pi-network", "Pi Network"], ARB: ["arbitrum", "Arbitrum"], KAS: ["kaspa", "Kaspa"],
  ALGO: ["algorand", "Algorand"], RENDER: ["render-token", "Render"], RNDR: ["render-token", "Render"], VET: ["vechain", "VeChain"],
  ATOM: ["cosmos", "Cosmos Hub"], WLD: ["worldcoin-wld", "Worldcoin"], SEI: ["sei-network", "Sei"], FIL: ["filecoin", "Filecoin"],
  JUP: ["jupiter-exchange-solana", "Jupiter"], FET: ["fetch-ai", "Artificial Superintelligence Alliance"], QNT: ["quant-network", "Quant"], INJ: ["injective-protocol", "Injective"],
  OP: ["optimism", "Optimism"], TIA: ["celestia", "Celestia"], STX: ["blockstack", "Stacks"], IMX: ["immutable-x", "Immutable"],
  PYUSD: ["paypal-usd", "PayPal USD"], GT: ["gatechain-token", "GateToken"], BONK: ["bonk", "Bonk"], FDUSD: ["first-digital-usd", "First Digital USD"],
  LDO: ["lido-dao", "Lido DAO"], IP: ["story-2", "Story"], FLR: ["flare-networks", "Flare"], PUMP: ["pump-fun", "Pump.fun"],
  ETHFI: ["ether-fi", "Ether.fi"], PENDLE: ["pendle", "Pendle"], S: ["sonic-3", "Sonic"], FTM: ["fantom", "Fantom"],
  CAKE: ["pancakeswap-token", "PancakeSwap"], XDC: ["xdce-crowd-sale", "XDC Network"], VIRTUAL: ["virtual-protocol", "Virtuals Protocol"], TRUMP: ["official-trump", "OFFICIAL TRUMP"],
  GALA: ["gala", "GALA"], SKY: ["sky", "Sky"], NEXO: ["nexo", "NEXO"], CRV: ["curve-dao-token", "Curve DAO"],
  JTO: ["jito-governance-token", "Jito"], THETA: ["theta-token", "Theta Network"], DEXE: ["dexe", "DeXe"], GRT: ["the-graph", "The Graph"],
  ENS: ["ethereum-name-service", "Ethereum Name Service"], XAUT: ["tether-gold", "Tether Gold"], PAXG: ["pax-gold", "PAX Gold"], HNT: ["helium", "Helium"],
  ZEC: ["zcash", "Zcash"], MKR: ["maker", "Maker"], AR: ["arweave", "Arweave"], RAY: ["raydium", "Raydium"],
  FLOW: ["flow", "Flow"], SAND: ["the-sandbox", "The Sandbox"], MANA: ["decentraland", "Decentraland"], AXS: ["axie-infinity", "Axie Infinity"],
  APE: ["apecoin", "ApeCoin"], CHZ: ["chiliz", "Chiliz"], KSM: ["kusama", "Kusama"], EGLD: ["elrond-erd-2", "MultiversX"],
  NEO: ["neo", "NEO"], IOTA: ["iota", "IOTA"], XTZ: ["tezos", "Tezos"], EOS: ["eos", "EOS"],
  RUNE: ["thorchain", "THORChain"], BSV: ["bitcoin-cash-sv", "Bitcoin SV"], DASH: ["dash", "Dash"], MINA: ["mina-protocol", "Mina Protocol"],
  ROSE: ["oasis-network", "Oasis"], KAVA: ["kava", "Kava"], ZIL: ["zilliqa", "Zilliqa"], "1INCH": ["1inch", "1inch"],
  COMP: ["compound-governance-token", "Compound"], SNX: ["havven", "Synthetix Network"], LRC: ["loopring", "Loopring"], BAT: ["basic-attention-token", "Basic Attention Token"],
  ENJ: ["enjincoin", "Enjin Coin"], CFX: ["conflux-token", "Conflux"], DYDX: ["dydx-chain", "dYdX"], GMX: ["gmx", "GMX"],
  PYTH: ["pyth-network", "Pyth Network"], W: ["wormhole", "Wormhole"], STRK: ["starknet", "Starknet"], ZK: ["zksync", "ZKsync"],
  ZRO: ["layerzero", "LayerZero"], EIGEN: ["eigenlayer", "EigenCloud (EIGEN)"], ATH: ["aethir", "Aethir"], CORE: ["coredaoorg", "Core"],
  BEAM: ["beam-2", "Beam"], BLUR: ["blur", "Blur"], ORDI: ["ordinals", "ORDI"], FLOKI: ["floki", "FLOKI"],
  WIF: ["dogwifcoin", "dogwifhat"], BRETT: ["brett", "Brett"], POPCAT: ["popcat", "Popcat"], FARTCOIN: ["fartcoin", "Fartcoin"],
  SPX: ["spx6900", "SPX6900"], MOG: ["mog-coin", "Mog Coin"], MEW: ["cat-in-a-dogs-world", "cat in a dogs world"], TOSHI: ["toshi", "Toshi"],
  AI16Z: ["ai16z", "ai16z"], KAITO: ["kaito", "KAITO"], MORPHO: ["morpho", "Morpho"], AERO: ["aerodrome-finance", "Aerodrome Finance"],
  VELO: ["velodrome-finance", "Velodrome Finance"], JASMY: ["jasmycoin", "JasmyCoin"], RON: ["ronin", "Ronin"], OM: ["mantra-dao", "MANTRA"],
  AKT: ["akash-network", "Akash Network"], TUSD: ["true-usd", "TrueUSD"], USD1: ["usd1-wlfi", "USD1"], RLUSD: ["ripple-usd", "Ripple USD"],
  BDX: ["beldex", "Beldex"], XEC: ["ecash", "eCash"], BTT: ["bittorrent", "BitTorrent"], JST: ["just", "JUST"],
  SUN: ["sun-token", "Sun Token"], WBNB: ["wbnb", "Wrapped BNB"], WETH: ["weth", "WETH"], CBBTC: ["coinbase-wrapped-btc", "Coinbase Wrapped BTC"],
  WSTETH: ["wrapped-steth", "Wrapped stETH"], RETH: ["rocket-pool-eth", "Rocket Pool ETH"], RPL: ["rocket-pool", "Rocket Pool"], CELO: ["celo", "Celo"],
  ASTR: ["astar", "Astar"], GLMR: ["moonbeam", "Moonbeam"], ANKR: ["ankr", "Ankr Network"], OCEAN: ["ocean-protocol", "Ocean Protocol"],
  RSR: ["reserve-rights-token", "Reserve Rights"], DCR: ["decred", "Decred"], XNO: ["nano", "Nano"], TWT: ["trust-wallet-token", "Trust Wallet"],
  SAFE: ["safe", "Safe"], NOT: ["notcoin", "Notcoin"], DOGS: ["dogs-2", "DOGS"], HMSTR: ["hamster-kombat", "Hamster Kombat"],
  GNO: ["gnosis", "Gnosis"], AMP: ["amp-token", "Amp"], HOT: ["holotoken", "Holo"], QTUM: ["qtum", "Qtum"],
  ICX: ["icon", "ICON"], ONT: ["ontology", "Ontology"], WAVES: ["waves", "Waves"], LUNC: ["terra-luna", "Terra Luna Classic"],
  LUNA: ["terra-luna-2", "Terra"], SFP: ["safepal", "SafePal"], XCH: ["chia", "Chia"], KDA: ["kadena", "Kadena"],
  CKB: ["nervos-network", "Nervos Network"], SC: ["siacoin", "Siacoin"], RVN: ["ravencoin", "Ravencoin"], DGB: ["digibyte", "DigiByte"],
  XEM: ["nem", "NEM"], XYM: ["symbol", "Symbol"], MOVE: ["movement", "Movement"], PLUME: ["plume", "Plume"],
  BERA: ["berachain-bera", "Berachain"], INIT: ["initia", "Initia"], WAL: ["walrus-2", "Walrus"], ZORA: ["zora", "Zora"],
  AIXBT: ["aixbt", "aixbt by Virtuals"], SYRUP: ["syrup", "Maple Finance"], USDT0: ["usdt0", "USDT0"], USDD: ["usdd", "USDD"],
  FRAX: ["frax", "Frax Legacy (FXS)"], FRXUSD: ["frax-usd", "Frax USD"], LUSD: ["liquity-usd", "Liquity USD"], GHO: ["gho", "GHO"],
  CRVUSD: ["crvusd", "crvUSD"], JITOSOL: ["jito-staked-sol", "Jito Staked SOL"], MSOL: ["msol", "Marinade Staked SOL"], WEETH: ["wrapped-eeth", "Wrapped eETH"],
  EZETH: ["renzo-restaked-eth", "Renzo Restaked ETH"], SUSDE: ["ethena-staked-usde", "Ethena Staked USDe"], SOLVBTC: ["solv-btc", "Solv Protocol SolvBTC"], LBTC: ["lombard-staked-btc", "Lombard Staked BTC"],
  TBTC: ["tbtc", "tBTC"], XPL: ["plasma", "Plasma"], ASTER: ["aster-2", "Aster"], LINEA: ["linea", "Linea"],
  MON: ["monad", "Monad"], SKL: ["skale", "SKALE"], COTI: ["coti", "COTI"], CVX: ["convex-finance", "Convex Finance"],
  UMA: ["uma", "UMA"], BAND: ["band-protocol", "Band Protocol"], API3: ["api3", "API3"], TRB: ["tellor", "Tellor Tributes"],
  OGN: ["origin-protocol", "Origin Protocol"], ILV: ["illuvium", "Illuvium"], YGG: ["yield-guild-games", "Yield Guild Games"], MAGIC: ["magic", "Treasure (MAGIC)"],
  PRIME: ["echelon-prime", "Echelon Prime"], PIXEL: ["pixels", "Pixels"], DRIFT: ["drift-protocol", "Drift"], KMNO: ["kamino", "Kamino"],
  ORCA: ["orca", "Orca"], IO: ["io", "io.net"], ZETA: ["zetachain", "ZetaChain"], TAIKO: ["taiko", "Taiko"],
  MANTA: ["manta-network", "Manta Network"], ALT: ["altlayer", "AltLayer"], DYM: ["dymension", "Dymension"], SAGA: ["saga-2", "Saga"],
  OMNI: ["omni-network", "Omni Network"], XAI: ["xai-blockchain", "Xai"], ACE: ["endurance", "Fusionist (ACE)"], ARKM: ["arkham", "Arkham"],
  CYBER: ["cyberconnect", "Cyber"], MAV: ["maverick-protocol", "Maverick Protocol"], EDU: ["edu-coin", "Open Campus"], ID: ["space-id", "SPACE ID"],
  RDNT: ["radiant-capital", "Radiant Capital"], GNS: ["gains-network", "Gains Network"], JOE: ["joe", "JOE"], STG: ["stargate-finance", "Stargate Finance"],
  BAL: ["balancer", "Balancer"], SUSHI: ["sushi", "Sushi"], YFI: ["yearn-finance", "yearn.finance"], ZRX: ["0x", "0x Protocol"],
  KNC: ["kyber-network-crystal", "Kyber Network Crystal"], BNT: ["bancor", "Bancor Network"], LPT: ["livepeer", "Livepeer"], STORJ: ["storj", "Storj"],
  NMR: ["numeraire", "Numeraire"], OXT: ["orchid-protocol", "Orchid Protocol"], AUDIO: ["audius", "Audius"], MASK: ["mask-network", "Mask Network"],
  XVS: ["venus", "Venus"], HOOK: ["hooked-protocol", "Hooked Protocol"],
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


// ---------- upstream (CoinGecko) ----------
const num = (v) => { const n = Number(v); return v === null || v === undefined || v === "" || !Number.isFinite(n) ? null : n; };
const round = (v, d) => (v === null ? null : Number(v.toFixed(d)));

// GET JSON with 8s timeout, identifying User-Agent, optional 30s edge cache.
// Returns { ok, status, data } — ok=false and status=0 on network/timeout failure. Never throws.
async function fetchJson(url, headers, ctx) {
  const cache = typeof caches !== "undefined" && caches && caches.default ? caches.default : null;
  if (cache) {
    try { const hit = await cache.match(url); if (hit) return { ok: true, status: 200, data: await hit.json(), cached: true }; } catch {}
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": USER_AGENT, ...headers }, signal: ctrl.signal });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    if (res.ok && data && typeof data === "object" && cache) {
      const put = cache.put(url, new Response(text, { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${CACHE_SECONDS}` } })).catch(() => {});
      if (ctx && ctx.waitUntil) ctx.waitUntil(put);
    }
    return { ok: res.ok && data !== null && typeof data === "object", status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: null, error: String(e && e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

function cgHeaders(env) {
  const key = String((env && env.CG_DEMO_KEY) || "").trim();
  return key ? { "x-cg-demo-api-key": key } : {};
}

// ---------- params ----------
async function readParams(request, url, bodyText) {
  const p = Object.fromEntries(url.searchParams);
  if (request.method === "POST" && bodyText) {
    try { const b = JSON.parse(bodyText); if (b && typeof b === "object" && !Array.isArray(b)) Object.assign(p, b); } catch {}
  }
  const s = (v) => (v === undefined || v === null || v === "" ? undefined : String(v).trim());
  const symRaw = p.symbol !== undefined ? p.symbol : p.symbols;
  const symbol = Array.isArray(symRaw) ? symRaw.map((x) => String(x)).join(",") : s(symRaw);
  return { symbol, address: s(p.address), chain: s(p.chain) };
}

// Returns { error } or { mode: "symbols", symbols } or { mode: "onchain", address, chain }
function validate(q) {
  const bad = (msg, extra = {}) => ({ error: `${msg} (no payment was taken)`, ...extra });
  const hasSym = q.symbol !== undefined, hasAddr = q.address !== undefined || q.chain !== undefined;
  if (!hasSym && !hasAddr) return bad("Provide either symbol (e.g. BTC or BTC,ETH,SOL) or address + chain");
  if (hasSym && hasAddr) return bad("Provide either symbol or address + chain, not both");
  if (hasSym) {
    const symbols = [...new Set(q.symbol.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean))];
    if (!symbols.length) return bad("Missing required parameter: symbol");
    if (symbols.length > MAX_SYMBOLS) return bad(`Too many symbols: at most ${MAX_SYMBOLS} per request`);
    const malformed = symbols.filter((x) => !/^[A-Z0-9][A-Z0-9.$_-]{0,19}$/.test(x));
    if (malformed.length) return bad(`Invalid symbol: ${malformed.join(", ")}`);
    return { mode: "symbols", symbols };
  }
  if (!q.address) return bad("Missing required parameter: address");
  if (!q.chain) return bad("Missing required parameter: chain", { supported_chains: Object.keys(CHAINS) });
  const key = q.chain.toLowerCase();
  const chain = CHAINS[key] ? key : CHAIN_ALIASES[key];
  if (!chain) return bad(`Unsupported chain: ${q.chain}`, { supported_chains: Object.keys(CHAINS) });
  const address = q.address;
  if (CHAINS[chain].evm) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return bad(`address must be a 0x-prefixed 40-hex-character contract address on ${chain}`);
    return { mode: "onchain", address: address.toLowerCase(), chain };
  }
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return bad("address must be a base58 Solana mint address");
  return { mode: "onchain", address, chain };
}

// ---------- data ----------
// Returns { status, body } — status !== 200 means do not settle.
async function loadSymbols(q, env, ctx) {
  const fetched_at = new Date().toISOString();
  const known = q.symbols.filter((s) => SYMBOLS[s]);
  const unknown = q.symbols.filter((s) => !SYMBOLS[s]);
  if (!known.length) return { status: 404, body: { error: `Unknown symbol${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")} — not in the supported list (no payment was taken)`, unknown, hint: "Use a top-market-cap ticker like BTC, ETH, SOL, or look up an on-chain token with address + chain." } };
  const ids = [...new Set(known.map((s) => SYMBOLS[s][0]))].join(",");
  const url = `${CG_API}/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=usd&include_market_cap=true&include_24hr_vol=true&include_24hr_change=true&include_last_updated_at=true`;
  const r = await fetchJson(url, cgHeaders(env), ctx);
  if (!r.ok) return { status: 502, body: { error: "CoinGecko is temporarily unavailable; no payment was taken. Please retry.", upstream_status: r.status || undefined, detail: r.error } };
  const results = [];
  for (const s of known) {
    const [id, name] = SYMBOLS[s], d = r.data[id];
    if (!d || num(d.usd) === null) { unknown.push(s); continue; }
    results.push({
      query: s, id, name, symbol: s,
      price_usd: num(d.usd),
      market_cap_usd: round(num(d.usd_market_cap), 2),
      volume_24h_usd: round(num(d.usd_24h_vol), 2),
      change_24h_pct: round(num(d.usd_24h_change), 4),
      last_updated: num(d.last_updated_at) !== null ? new Date(num(d.last_updated_at) * 1000).toISOString() : null,
    });
  }
  if (!results.length) return { status: 404, body: { error: `No price data returned for: ${q.symbols.join(", ")} (no payment was taken)`, unknown } };
  return { status: 200, body: { results, unknown, source: SOURCE, attribution: ATTRIBUTION, fetched_at } };
}

async function loadOnchain(q, env, ctx) {
  const fetched_at = new Date().toISOString();
  const net = CHAINS[q.chain].cg;
  const headers = cgHeaders(env);
  const path = `/networks/${net}/tokens/${encodeURIComponent(q.address)}`;
  const url = Object.keys(headers).length ? `${CG_API}/onchain${path}` : `${GT_API}${path}`;
  const r = await fetchJson(url, headers, ctx);
  if (r.status === 404) return { status: 404, body: { error: `Token ${q.address} not found on ${q.chain} (no payment was taken)`, unknown: [q.address] } };
  const a = r.ok && r.data && r.data.data && r.data.data.attributes;
  if (!r.ok) return { status: 502, body: { error: "CoinGecko on-chain data is temporarily unavailable; no payment was taken. Please retry.", upstream_status: r.status || undefined, detail: r.error } };
  if (!a || num(a.price_usd) === null) return { status: 404, body: { error: `No price data for token ${q.address} on ${q.chain} (no payment was taken)`, unknown: [q.address] } };
  const vol = a.volume_usd && typeof a.volume_usd === "object" ? a.volume_usd.h24 : a.volume_usd;
  const result = {
    query: q.address, id: r.data.data.id || `${net}_${q.address}`, name: a.name || null, symbol: a.symbol || null,
    price_usd: num(a.price_usd),
    market_cap_usd: round(num(a.market_cap_usd) !== null ? num(a.market_cap_usd) : num(a.fdv_usd), 2),
    volume_24h_usd: round(num(vol), 2),
    change_24h_pct: null,
    last_updated: fetched_at,
    chain: q.chain, address: a.address || q.address,
    fdv_usd: round(num(a.fdv_usd), 2),
    liquidity_usd: round(num(a.total_reserve_in_usd), 2),
    decimals: num(a.decimals),
  };
  return { status: 200, body: { results: [result], unknown: [], source: SOURCE, attribution: ATTRIBUTION, fetched_at } };
}

const loadData = (q, env, ctx) => (q.mode === "onchain" ? loadOnchain(q, env, ctx) : loadSymbols(q, env, ctx));

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
const EXAMPLE_OUTPUT = {
  results: [
    { query: "BTC", id: "bitcoin", name: "Bitcoin", symbol: "BTC", price_usd: 112345.67, market_cap_usd: 2235000000000, volume_24h_usd: 48200000000, change_24h_pct: 1.2345, last_updated: "2026-10-15T14:02:11.000Z" },
    { query: "ETH", id: "ethereum", name: "Ethereum", symbol: "ETH", price_usd: 4012.34, market_cap_usd: 484000000000, volume_24h_usd: 31500000000, change_24h_pct: -0.4567, last_updated: "2026-10-15T14:02:09.000Z" },
  ],
  unknown: [],
  source: SOURCE,
  attribution: ATTRIBUTION,
  fetched_at: "2026-10-15T14:02:15.123Z",
};
function paymentRequired(env, url, error) {
  const resourceUrl = `${url.origin}/price`;
  return {
    x402Version: 2,
    error,
    resource: { url: resourceUrl, description: DESCRIPTION, mimeType: "application/json" },
    accepts: [requirements(env)],
    extensions: {
      bazaar: {
        info: {
          input: { type: "http", method: "GET", queryParams: { symbol: "BTC,ETH" } },
          output: { type: "json", example: EXAMPLE_OUTPUT },
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
                queryParams: {
                  type: "object",
                  properties: {
                    symbol: { type: "string", description: "Ticker symbol or comma-separated list of up to 10, e.g. BTC or BTC,ETH,SOL" },
                    address: { type: "string", description: "On-chain token contract address (use with chain instead of symbol)" },
                    chain: { type: "string", enum: Object.keys(CHAINS), description: "Chain of the contract address" },
                  },
                },
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
function send402(env, url, error) {
  const pr = paymentRequired(env, url, error);
  return json(pr, 402, { "PAYMENT-REQUIRED": b64e(pr) });
}

function openapi(origin) {
  const params = {
    type: "object",
    properties: {
      symbol: { type: "string", description: "Ticker symbol or comma-separated list of up to 10 (JSON array also accepted in POST), e.g. 'BTC' or 'BTC,ETH,SOL'. Use this OR address+chain." },
      address: { type: "string", description: "Token contract address (0x... for EVM chains, base58 mint for Solana). Requires chain." },
      chain: { type: "string", enum: Object.keys(CHAINS), description: "Chain of the contract address." },
    },
  };
  const resultItem = {
    type: "object",
    properties: {
      query: { type: "string" }, id: { type: "string", description: "CoinGecko coin id or on-chain token id" }, name: { type: ["string", "null"] }, symbol: { type: ["string", "null"] },
      price_usd: { type: "number" }, market_cap_usd: { type: ["number", "null"] }, volume_24h_usd: { type: ["number", "null"] }, change_24h_pct: { type: ["number", "null"] },
      last_updated: { type: ["string", "null"] },
      chain: { type: "string" }, address: { type: "string" }, fdv_usd: { type: ["number", "null"] }, liquidity_usd: { type: ["number", "null"] }, decimals: { type: ["number", "null"] },
    },
    required: ["query", "id", "price_usd"],
  };
  const out = {
    type: "object",
    properties: {
      results: { type: "array", items: resultItem },
      unknown: { type: "array", items: { type: "string" }, description: "Requested symbols that were not recognised or had no data" },
      source: { type: "string" },
      attribution: { type: "string", description: "Must be displayed when surfacing the data: Powered by CoinGecko" },
      fetched_at: { type: "string" },
    },
    required: ["results", "unknown", "source", "attribution", "fetched_at"],
  };
  const op = (method) => ({
    operationId: method === "post" ? "getPricePost" : "getPrice",
    summary: "Current USD price, market cap, 24h volume and 24h change for crypto tickers or an on-chain token",
    tags: ["Crypto", "Finance", "Prices"],
    "x-payment-info": { price: { mode: "fixed", currency: "USD", amount: "0.001000" }, protocols: [{ x402: {} }] },
    ...(method === "post"
      ? { requestBody: { required: true, content: { "application/json": { schema: params } } } }
      : { parameters: Object.entries(params.properties).map(([n, sch]) => ({ name: n, in: "query", required: false, schema: { type: "string" }, description: sch.description })) }),
    responses: {
      200: { description: "Prices", content: { "application/json": { schema: out } } },
      400: { description: "Invalid parameters (no charge)" },
      402: { description: "Payment Required" },
      404: { description: "No recognised symbols / token not found (no charge)" },
      413: { description: "Request too large (no charge)" },
      502: { description: "CoinGecko temporarily unavailable (no charge)" },
    },
  });
  return {
    openapi: "3.1.0",
    info: {
      title: SERVICE,
      version: "1.0.0",
      description: DESCRIPTION,
      "x-guidance": "Use GET /price?symbol=BTC,ETH,SOL (up to 10 tickers; or POST /price with JSON {symbol: [...]}) for a quick current USD price with market cap, 24h volume and 24h % change. For a token that is not a listed ticker, use ?address=0x...&chain=base (chains: " + Object.keys(CHAINS).join(", ") + "). Costs $0.001 USDC on Base per request via x402; nothing is charged for unknown symbols (listed in `unknown`), 400/404 or upstream failures. Data is from CoinGecko and cached about 30 seconds — when you show the price, include the `attribution` string (Powered by CoinGecko). Not investment advice.",
    },
    servers: [{ url: origin }],
    paths: { "/price": { get: op("get"), post: op("post") } },
  };
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
        endpoint: `${url.origin}/price?symbol=BTC,ETH,SOL  |  ${url.origin}/price?address=<contract>&chain=<${Object.keys(CHAINS).join("|")}>`,
        price: "$0.001 USDC on Base per request (x402)",
        max_symbols: MAX_SYMBOLS,
        supported_symbols: Object.keys(SYMBOLS),
        supported_chains: Object.keys(CHAINS),
        source: SOURCE,
        attribution: ATTRIBUTION,
        configured: Boolean(env.PAY_TO),
        facilitator: env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET ? "cdp" : "payai",
      });
    }
    if (url.pathname === "/openapi.json" || url.pathname === "/.well-known/openapi.json") return json(openapi(url.origin));
    if (url.pathname !== "/price") return json({ error: "Not found. Use /price?symbol=BTC,ETH or /price?address=0x...&chain=base" }, 404);
    if (!env.PAY_TO || !/^0x[0-9a-fA-F]{40}$/.test(env.PAY_TO)) return json({ error: "Service not configured: PAY_TO wallet address missing" }, 500);
    if (request.method !== "GET" && request.method !== "POST") return json({ error: "Use GET or POST" }, 405);

    // Size guard before any payment work.
    if (url.search.length > MAX_QUERY_CHARS) return json({ error: `Query string too long (max ${MAX_QUERY_CHARS} characters; no payment was taken)` }, 413);
    let bodyText = "";
    if (request.method === "POST") {
      const cl = Number(request.headers.get("content-length"));
      if (Number.isFinite(cl) && cl > MAX_BODY_BYTES) return json({ error: `Request body too large (max ${MAX_BODY_BYTES} bytes; no payment was taken)` }, 413);
      try { bodyText = await request.clone().text(); } catch { bodyText = ""; }
      if (bodyText.length > MAX_BODY_BYTES) return json({ error: `Request body too large (max ${MAX_BODY_BYTES} bytes; no payment was taken)` }, 413);
    }

    const header = request.headers.get("PAYMENT-SIGNATURE") || request.headers.get("X-PAYMENT");
    if (!header) return send402(env, url, "PAYMENT-SIGNATURE header is required");
    const q = validate(await readParams(request, url, bodyText));
    if (q.error) return json(q, 400);

    let payload;
    try { payload = b64d(header); } catch { return json({ error: "Invalid payment payload" }, 400); }
    const reqs = requirements(env);
    if (payload.x402Version !== 2 || !deepEqual(payload.accepted, reqs)) return send402(env, url, "No matching payment requirements found");

    const fac = facilitator(env);
    const body = { x402Version: 2, paymentPayload: payload, paymentRequirements: reqs };
    let v;
    try { v = await fac.call("verify", body); } catch (e) { return json({ error: "Facilitator unreachable", detail: String(e) }, 500); }
    if (!v.ok || !v.data.isValid) return send402(env, url, v.data.invalidReason || v.data.error || `verify failed (${v.status})`);

    let result;
    try { result = await loadData(q, env, ctx); } catch (e) { return json({ error: "CoinGecko is temporarily unavailable; no payment was taken. Please retry.", detail: String(e.message || e) }, 502); }
    if (result.status !== 200) return json(result.body, result.status);

    let s;
    try { s = await fac.call("settle", body); } catch (e) { return json({ error: "Facilitator unreachable", detail: String(e) }, 500); }
    if (!s.ok || !s.data.success) {
      const fail = { success: false, errorReason: s.data.errorReason || s.data.error || `settle failed (${s.status})`, transaction: "", network: NETWORK, payer: s.data.payer || v.data.payer };
      return json({}, 402, { "PAYMENT-RESPONSE": b64e(fail) });
    }
    const receipt = { success: true, transaction: s.data.transaction, network: s.data.network || NETWORK, payer: s.data.payer || v.data.payer };
    return json(result.body, 200, { "PAYMENT-RESPONSE": b64e(receipt) });
  },
};
