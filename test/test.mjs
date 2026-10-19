import { generateKeyPairSync, verify as nverify } from "node:crypto";
import { writeFileSync } from "node:fs";
const W = (await import(process.argv[2])).default;
const PAY = "0x6f762720b8515b7091e6aa69e8361f7b9909233f";
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const dec = (h) => JSON.parse(Buffer.from(h, "base64").toString());
const NOW = Date.now(), iso = (daysAgo) => new Date(NOW - daysAgo * 86400000).toISOString();

const BRETT = "0x532f27101965dd16442E59d40670FaF5eBB142E4";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const HONEY = "0x1111111111111111111111111111111111111111";
const NEWT = "0x2222222222222222222222222222222222222222";
const UNKNOWN = "0x3333333333333333333333333333333333333333";
const STABLE = "0x4444444444444444444444444444444444444444";
const RENOUNCED = "0x5555555555555555555555555555555555555555";
const GP = {
  [BRETT.toLowerCase()]: { buy_tax: "0", sell_tax: "0", is_honeypot: "0", cannot_sell_all: "0", cannot_buy: "0", is_open_source: "1", hidden_owner: "0", is_mintable: "0", owner_address: "0x0000000000000000000000000000000000000000", owner_percent: "0.0", creator_percent: "0.000000", honeypot_with_same_creator: "3", holder_count: "908869", token_symbol: "BRETT", token_name: "Brett",
    holders: [{ address: "0xpool", is_contract: 1, percent: "0.30", is_locked: 0 }, { address: "0xaaa", is_contract: 0, percent: "0.05", is_locked: 0 }, { address: "0xbbb", is_contract: 0, percent: "0.04", is_locked: 0 }] },
  [HONEY]: { buy_tax: "0", sell_tax: "0.99", is_honeypot: "1", is_open_source: "0", owner_address: "0x9999999999999999999999999999999999999999", is_mintable: "1", owner_percent: "0.4", creator_percent: "0", holder_count: "40", token_symbol: "SCAM",
    holders: [{ address: "0x9999999999999999999999999999999999999999", is_contract: 0, percent: "0.40", is_locked: 0 }, { address: "0xccc", is_contract: 0, percent: "0.25", is_locked: 0 }] },
  [NEWT]: { buy_tax: "0.03", sell_tax: "0.08", is_honeypot: "0", is_open_source: "1", owner_address: "0x0000000000000000000000000000000000000000", is_mintable: "0", holder_count: "350", token_symbol: "NEWT",
    holders: [{ address: "0xddd", is_contract: 0, percent: "0.20", is_locked: 0 }, { address: "0xeee", is_contract: 0, percent: "0.15", is_locked: 0 }, { address: "0x000000000000000000000000000000000000dead", is_contract: 0, percent: "0.30", is_locked: 0 }] },
};
GP[STABLE] = { buy_tax: "0", sell_tax: "0", is_honeypot: "0", is_open_source: "1", is_proxy: "1", is_mintable: "1", is_blacklisted: "1", owner_address: "0x7777777777777777777777777777777777777777", trust_list: "1", holder_count: "11000000", token_symbol: "USDX", holders: [] };
GP[RENOUNCED] = { buy_tax: "0", sell_tax: "0", is_honeypot: "0", is_open_source: "1", transfer_pausable: "1", is_blacklisted: "1", owner_address: "0x0000000000000000000000000000000000000000", holder_count: "500000", token_symbol: "FROG", holders: [] };
const GP_SOL = { [BONK]: { balance_mutable_authority: { authority: [], status: "0" }, closable: { status: "0" }, freezable: { status: "0" }, mintable: { status: "0" }, metadata_mutable: { status: "1" }, non_transferable: "0", transfer_fee: {}, transfer_hook: [], trusted_token: 0, holder_count: "1020153", metadata: { name: "Bonk", symbol: "Bonk" },
  holders: [{ account: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", percent: "0.0883", is_locked: 0 }, { account: "51yZyDSnec4xnUv7XLRVYcDyV4x3wUtzrDcRaYbmQU5j", percent: "0.0679", is_locked: 0 }] } };
const GT_TOK = {
  base: { [BRETT.toLowerCase()]: { name: "Brett", symbol: "BRETT", price_usd: "0.012", fdv_usd: "120000000" }, [HONEY]: { name: "Scam", symbol: "SCAM", price_usd: "0.0001" }, [NEWT]: { name: "Newt", symbol: "NEWT", price_usd: "0.5" } },
  solana: { [BONK]: { name: "Bonk", symbol: "Bonk", price_usd: "0.0000031", fdv_usd: "270000000" } },
};
const GT_POOLS = {
  base: { [BRETT.toLowerCase()]: [{ reserve_in_usd: "4000000", pool_created_at: iso(900), volume_usd: { h24: "800000" } }, { reserve_in_usd: "1500000", pool_created_at: iso(600), volume_usd: { h24: "200000" } }],
    [HONEY]: [{ reserve_in_usd: "3500", pool_created_at: iso(0.2), volume_usd: { h24: "900" } }],
    [NEWT]: [{ reserve_in_usd: "30000", pool_created_at: iso(3), volume_usd: { h24: "12000" } }] },
  solana: { [BONK]: [{ reserve_in_usd: "336272", pool_created_at: "2023-07-05T14:41:09Z", volume_usd: { h24: "401822" } }, { reserve_in_usd: "1400000", pool_created_at: "2023-01-01T00:00:00Z", volume_usd: { h24: "300000" } }] },
};
let calls = [], mode = "good", upstream = "up";
const R = (o, status = 200) => new Response(JSON.stringify(o), { status });
globalThis.fetch = async (u, init) => {
  u = String(u);
  if (u.includes("gopluslabs") || u.includes("geckoterminal")) {
    calls.push({ u, kind: "data" });
    if (upstream === "down") throw new Error("network down");
    if (upstream === "throttled") return u.includes("gopluslabs") ? R({ code: 4029, message: "too many requests" }) : new Response("rate limited", { status: 429 });
    if (upstream === "gt429" && u.includes("geckoterminal")) return new Response("rate limited", { status: 429 });
    if (/\/token_security\/\d+\?/.test(u)) { const a = decodeURIComponent(u.split("=").pop()).toLowerCase(); return R({ code: 1, message: "OK", result: GP[a] ? { [a]: GP[a] } : {} }); }
    if (u.includes("/solana/token_security")) { const a = decodeURIComponent(u.split("=").pop()); return R({ code: 1, message: "ok", result: GP_SOL[a] ? { [a]: GP_SOL[a] } : {} }); }
    const NETS = { base: "base", eth: "base", solana: "solana" };
    const m2 = u.match(/networks\/([a-z_]+)\/tokens\/([^/?]+)(\/pools)?/);
    const gnet = m2[1], key = NETS[gnet] || gnet, aa = key === "solana" ? decodeURIComponent(m2[2]) : decodeURIComponent(m2[2]).toLowerCase();
    if (!m2[3]) return R({ errors: [{ status: "404" }] }, 404);
    const tok = GT_TOK[key] && GT_TOK[key][aa];
    return GT_POOLS[key] && GT_POOLS[key][aa] ? R({ data: GT_POOLS[key][aa].map((x) => ({ attributes: { ...x, name: (tok ? tok.symbol : "X") + " / WETH", base_token_price_usd: tok && tok.price_usd, fdv_usd: tok && tok.fdv_usd }, relationships: { base_token: { data: { id: gnet + "_" + aa } }, quote_token: { data: { id: gnet + "_0xweth" } } } })) }) : R({ errors: [{ status: "404" }] }, 404);
  }
  calls.push({ u, init, kind: "fac" });
  const op = u.split("/").pop();
  if (mode === "badverify" && op === "verify") return R({ isValid: false, invalidReason: "insufficient_funds", payer: "0xabc" });
  if (mode === "badsettle" && op === "settle") return R({ success: false, errorReason: "invalid_transaction_state", payer: "0xabc", transaction: "", network: "eip155:8453" }, 400);
  if (op === "verify") return R({ isValid: true, payer: "0xabc" });
  return R({ success: true, payer: "0xabc", transaction: "0xdeadbeef", network: "eip155:8453" });
};
const env = {};
const base = "https://tok.example.workers.dev";
let r = await W.fetch(new Request(base + "/"), env); let j = await r.json();
ok(r.status === 200 && j.service === "Token Check" && j.facilitator === "payai", "info page");
r = await W.fetch(new Request(base + "/check", { method: "POST" }), env);
ok(r.status === 402, "POST probe without payment -> 402");
const pr = dec(r.headers.get("PAYMENT-REQUIRED"));
ok(pr.accepts[0].amount === "10000" && pr.accepts[0].payTo === PAY && pr.accepts[0].network === "eip155:8453" && pr.accepts[0].asset === "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "402 requirements correct (default wallet)");
ok(pr.resource.url === base + "/check", "resource url");
writeFileSync(process.argv[3], JSON.stringify(pr.extensions.bazaar));
const hdr = Buffer.from(JSON.stringify({ x402Version: 2, resource: pr.resource, accepted: pr.accepts[0], payload: { signature: "0x00", authorization: {} }, extensions: pr.extensions })).toString("base64");
const paid = (body, extra = {}) => W.fetch(new Request(base + "/check", { method: "POST", headers: { "PAYMENT-SIGNATURE": hdr, "Content-Type": "application/json", ...extra }, body: JSON.stringify(body) }), env);

calls = []; r = await paid({ tokenAddress: "not-an-address" }); ok(r.status === 400 && calls.length === 0, "bad address -> 400, nothing charged or fetched");
calls = []; r = await paid({ tokenAddress: BRETT, chain: "tron" }); ok(r.status === 400 && calls.length === 0, "unsupported chain -> 400");
calls = []; r = await paid({ tokenAddress: BRETT, chain: "eth" }); j = await r.json();
ok(r.status === 200 && j.token.chain === "ethereum" && calls.some((c) => c.u.includes("/token_security/1?")) && calls.some((c) => c.u.includes("/networks/eth/")), "chain alias eth -> ethereum, right data URLs");
ok(j.market.price_usd === 0.012 && j.market.fdv_usd === 120000000, "price/fdv read from pool data");
calls = []; r = await paid({ tokenAddress: BRETT, chain: "solana" }); ok(r.status === 400 && calls.length === 0, "0x address with chain=solana -> 400");
calls = []; r = await paid({ tokenAddress: BONK, chain: "base" }); ok(r.status === 400 && calls.length === 0, "solana mint with chain=base -> 400");

calls = []; r = await paid({ tokenAddress: BRETT }); j = await r.json();
ok(r.status === 200 && j.grade === "CAUTION" && j.token.chain === "base" && j.token.symbol === "BRETT", "BRETT auto-detected base, graded " + j.grade + " score " + j.risk_score);
ok(j.red_flags.length === 1 && j.red_flags[0].flag === "creator_history", "BRETT only flag is creator history: " + j.red_flags.map((f) => f.flag));
ok(j.market.liquidity_usd === 5500000 && j.market.oldest_pool_age_days > 800 && j.market.top10_holder_share === 0.09, "BRETT market + holders (pool contract excluded)");
ok(dec(r.headers.get("PAYMENT-RESPONSE")).transaction === "0xdeadbeef", "receipt header");
const fac = calls.filter((c) => c.kind === "fac").map((c) => c.u.split("/").pop());
ok(fac.join(",") === "verify,settle", "verify then settle");
ok(j.sources.includes("Powered by CoinGecko") && j.disclaimer.includes("Not financial"), "attribution + disclaimer present");

r = await paid({ tokenAddress: HONEY }); j = await r.json();
ok(j.grade === "JUNK" && j.red_flags[0].severity === "critical" && j.one_liner.startsWith("SCAM: junk."), "honeypot -> JUNK: " + j.one_liner);
ok(["honeypot", "sell_tax", "closed_source", "mintable", "holder_concentration", "low_liquidity", "brand_new", "insider_holdings"].every((f) => j.red_flags.some((x) => x.flag === f)), "honeypot flags all present");

r = await paid({ tokenAddress: NEWT }); j = await r.json();
ok(j.grade === "RISKY" || j.grade === "CAUTION", "new low-liq token graded " + j.grade + " score " + j.risk_score + " flags " + j.red_flags.map((f) => f.flag));
ok(j.market.top10_holder_share === 0.35, "dead address excluded from holder share");

r = await W.fetch(new Request(base + "/check?tokenAddress=" + BONK, { headers: { "PAYMENT-SIGNATURE": hdr } }), env); j = await r.json();
ok(r.status === 200 && j.token.chain === "solana" && j.grade === "CLEAN" && j.green_flags.includes("Mint authority revoked."), "BONK via GET, solana auto-detect -> " + j.grade + " " + j.risk_score);

upstream = "gt429"; r = await paid({ tokenAddress: BRETT }); j = await r.json(); upstream = "up";
ok(r.status === 200 && !j.red_flags.some((f) => f.flag === "no_market") && j.red_flags.some((f) => f.flag === "market_data_unavailable"), "market throttled -> 'unavailable' note, not 'no market' (" + j.grade + ")");
r = await paid({ tokenAddress: STABLE }); j = await r.json();
ok(r.status === 200 && !j.red_flags.some((f) => ["upgradeable_proxy", "mintable", "blacklist"].includes(f.flag)) && j.green_flags.some((g) => g.includes("trusted")), "trusted stablecoin admin controls not counted (" + j.grade + ", flags " + j.red_flags.map((f) => f.flag) + ")");
r = await paid({ tokenAddress: RENOUNCED }); j = await r.json();
ok(j.red_flags.filter((f) => ["transfer_pausable", "blacklist"].includes(f.flag)).every((f) => f.severity === "low"), "renounced owner -> pause/blacklist downgraded to low (" + j.grade + " " + j.risk_score + ")");
calls = []; r = await paid({ tokenAddress: UNKNOWN }); j = await r.json();
ok(r.status === 404 && !calls.some((c) => c.kind === "fac" && c.u.endsWith("settle")), "unknown token -> 404, not settled");
upstream = "down"; calls = []; r = await paid({ tokenAddress: BRETT });
ok(r.status === 502 && !calls.some((c) => c.kind === "fac" && c.u.endsWith("settle")), "upstream down -> 502, not settled"); upstream = "up";
mode = "badverify"; calls = []; r = await paid({ tokenAddress: BRETT });
ok(r.status === 402 && !calls.some((c) => c.kind === "data"), "verify fail -> 402, no data fetched");
mode = "badsettle"; r = await paid({ tokenAddress: BRETT }); const t = await r.text();
ok(r.status === 402 && !t.includes("BRETT"), "settle fail -> 402, no data leaked"); mode = "good";
const under = Buffer.from(JSON.stringify({ x402Version: 2, accepted: { ...pr.accepts[0], amount: "1" }, payload: {} })).toString("base64");
r = await W.fetch(new Request(base + "/check", { method: "POST", headers: { "PAYMENT-SIGNATURE": under }, body: JSON.stringify({ tokenAddress: BRETT }) }), env); ok(r.status === 402, "underpaid -> 402");

r = await W.fetch(new Request(base + "/openapi.json"), env); const o = await r.json();
ok(o.openapi === "3.1.0" && o.info["x-guidance"] && o.paths["/check"].post["x-payment-info"].price.amount === "0.010000" && o.paths["/check"].post.responses["402"] && o.paths["/check"].post.requestBody.content["application/json"].schema.required[0] === "tokenAddress", "openapi.json valid");

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const jwk = privateKey.export({ format: "jwk" });
const secret = Buffer.concat([Buffer.from(jwk.d, "base64url"), Buffer.from(jwk.x, "base64url")]).toString("base64");
calls = []; r = await W.fetch(new Request(base + "/check", { method: "POST", headers: { "PAYMENT-SIGNATURE": hdr }, body: JSON.stringify({ tokenAddress: BRETT }) }), { CDP_API_KEY_ID: "kid", CDP_API_KEY_SECRET: secret });
const fc = calls.find((c) => c.kind === "fac");
const [h, p, sg] = fc.init.headers.Authorization.slice(7).split(".");
ok(r.status === 200 && fc.u === "https://api.cdp.coinbase.com/platform/v2/x402/verify" && nverify(null, Buffer.from(h + "." + p), publicKey, Buffer.from(sg, "base64url")) && JSON.parse(Buffer.from(p, "base64url")).uris[0] === "POST api.cdp.coinbase.com/platform/v2/x402/verify", "CDP Ed25519 JWT valid");
upstream = "throttled"; calls = []; r = await paid({ tokenAddress: BRETT, chain: "base" });
ok(r.status === 502 && !calls.some((c) => c.kind === "fac" && c.u.endsWith("settle")), "both sources throttled -> 502 (not 404), not settled"); upstream = "up";
console.log(fails ? `${fails} FAILED` : "ALL PASS");
