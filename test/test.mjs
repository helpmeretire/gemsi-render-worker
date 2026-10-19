// Usage: node test/test.mjs ./worker.js /path/bazaar-out.json
import { generateKeyPairSync, verify as nverify } from "node:crypto";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const W = (await import(pathToFileURL(resolve(process.argv[2])).href)).default;
const PAY = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
let fails = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
const dec = (h) => JSON.parse(Buffer.from(h, "base64").toString());

// ---- fixtures in CoinGecko's real format ----
const SIMPLE = {
  bitcoin: { usd: 112345.67, usd_market_cap: 2235000000000.123, usd_24h_vol: 48200000000.456, usd_24h_change: 1.23456789, last_updated_at: 1760536931 },
  ethereum: { usd: 4012.34, usd_market_cap: 484000000000, usd_24h_vol: 31500000000, usd_24h_change: -0.456789, last_updated_at: 1760536929 },
  solana: { usd: 201.5, usd_market_cap: 110000000000, usd_24h_vol: 6100000000, usd_24h_change: 3.1, last_updated_at: 1760536930 },
};
const ONCHAIN = {
  data: {
    id: "base_0x532f27101965dd16442e59d40670faf5ebb142e4",
    type: "token",
    attributes: {
      address: "0x532f27101965dd16442e59d40670faf5ebb142e4", name: "Brett", symbol: "BRETT", decimals: 18,
      image_url: "https://example.invalid/brett.png", coingecko_coin_id: "brett",
      total_supply: "9910236866000000000000000000", normalized_total_supply: "9910236866.0",
      price_usd: "0.0412345678", fdv_usd: "408645123.5", total_reserve_in_usd: "12345678.9", volume_usd: { h24: "9876543.21" }, market_cap_usd: "407000000.0",
    },
    relationships: { top_pools: { data: [] } },
  },
};

let calls = [], mode = "good", cgCalls = [];
const SIMPLE_URL = "https://api.coingecko.com/api/v3/simple/price";
globalThis.fetch = async (u, init) => {
  u = String(u);
  if (u.startsWith("https://api.coingecko.com/") || u.startsWith("https://api.geckoterminal.com/")) {
    cgCalls.push({ u, init });
    if (mode === "cg429") return new Response(JSON.stringify({ status: { error_code: 429, error_message: "You've exceeded the Rate Limit." } }), { status: 429 });
    if (mode === "cg500") return new Response("Internal Server Error", { status: 500 });
    if (mode === "cgtimeout") throw new DOMException("The operation was aborted", "AbortError");
    if (u.includes("/networks/")) {
      if (mode === "tok404") return new Response(JSON.stringify({ errors: [{ status: "404", title: "Not Found" }] }), { status: 404 });
      return new Response(JSON.stringify(ONCHAIN), { headers: { "Content-Type": "application/json" } });
    }
    const ids = new URL(u).searchParams.get("ids").split(",");
    const out = {};
    for (const id of ids) if (SIMPLE[id]) out[id] = SIMPLE[id];
    return new Response(JSON.stringify(out), { headers: { "Content-Type": "application/json" } });
  }
  calls.push({ u, init });
  const op = u.split("/").pop();
  if (mode === "badverify" && op === "verify") return new Response(JSON.stringify({ isValid: false, invalidReason: "insufficient_funds", payer: "0xabc" }), { status: 200 });
  if (mode === "badsettle" && op === "settle") return new Response(JSON.stringify({ success: false, errorReason: "invalid_transaction_state", payer: "0xabc", transaction: "", network: "eip155:8453" }), { status: 400 });
  if (op === "verify") return new Response(JSON.stringify({ isValid: true, payer: "0xabc" }));
  return new Response(JSON.stringify({ success: true, payer: "0xabc", transaction: "0xdeadbeef", network: "eip155:8453" }));
};
const env = { PAY_TO: PAY };
const base = "https://price.example.workers.dev";
const settled = () => calls.some((c) => c.u.endsWith("/settle"));
const BRETT = "0x532f27101965dd16442e59d40670faf5ebb142e4";

// ---- info / unpaid ----
let r = await W.fetch(new Request(base + "/"), env); let j = await r.json();
ok(r.status === 200 && j.service === "Crypto Price" && j.facilitator === "payai" && j.supported_symbols.includes("BTC") && j.supported_chains.includes("solana") && j.attribution.includes("CoinGecko") && j.price.includes("$0.001"), "info page");
ok(j.supported_symbols.length >= 150, `symbol table has ${j.supported_symbols.length} tickers (>= 150)`);
r = await W.fetch(new Request(base + "/price?symbol=BTC"), {}); ok(r.status === 402 && dec(r.headers.get("PAYMENT-REQUIRED")).accepts[0].payTo === "0x6f762720b8515b7091e6aa69e8361f7b9909233f", "default wallet used");
r = await W.fetch(new Request(base + "/price"), env); ok(r.status === 402, "missing params unpaid -> 402 first");
r = await W.fetch(new Request(base + "/price?symbol=ZZZZZ"), env); ok(r.status === 402, "unknown symbol unpaid -> 402 first");
r = await W.fetch(new Request(base + "/price?symbol=BTC"), env);
ok(r.status === 402, "unpaid -> 402 probe");
ok(r.headers.get("Access-Control-Allow-Origin") === "*" && r.headers.get("Access-Control-Expose-Headers").includes("PAYMENT-REQUIRED"), "CORS headers");
const pr = dec(r.headers.get("PAYMENT-REQUIRED"));
const a0 = pr.accepts[0];
ok(pr.x402Version === 2 && pr.accepts.length === 1 && a0.scheme === "exact" && a0.amount === "1000" && a0.payTo === PAY && a0.network === "eip155:8453" && a0.asset === "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" && a0.extra.name === "USD Coin", "402 requirements correct (1000, payTo, asset, network)");
ok(pr.resource.url === base + "/price" && pr.resource.mimeType === "application/json", "resource url");
ok(pr.extensions.bazaar.info.input.type === "http" && pr.extensions.bazaar.info.input.queryParams.symbol === "BTC,ETH" && pr.extensions.bazaar.schema.properties.input.required.includes("method") && pr.extensions.bazaar.info.output.example.results[0].price_usd > 0, "bazaar ext present");
writeFileSync(process.argv[3], JSON.stringify(pr.extensions.bazaar));
const payload = { x402Version: 2, resource: pr.resource, accepted: pr.accepts[0], payload: { signature: "0x00", authorization: {} }, extensions: pr.extensions };
const hdr = Buffer.from(JSON.stringify(payload)).toString("base64");
const paid = (q, extra = {}, e = env) => W.fetch(new Request(base + "/price" + q, { ...extra, headers: { "PAYMENT-SIGNATURE": hdr, ...(extra.headers || {}) } }), e);
r = await W.fetch(new Request(base + "/price", { method: "OPTIONS" }), env); ok(r.status === 200 && r.headers.get("Access-Control-Allow-Headers").includes("PAYMENT-SIGNATURE"), "OPTIONS preflight");

// ---- bad input with payment -> 400, zero facilitator calls, zero upstream calls ----
const eleven = "BTC,ETH,SOL,XRP,BNB,DOGE,ADA,TRX,LINK,AVAX,SUI";
for (const [q, label, extra] of [
  ["", "no params"],
  ["?symbol=", "empty symbol"],
  ["?symbol=,,", "only commas"],
  ["?symbol=" + eleven, "11 symbols (>10)"],
  ["?symbol=BTC&address=" + BRETT + "&chain=base", "symbol and address together"],
  ["?address=" + BRETT, "address without chain"],
  ["?chain=base", "chain without address"],
  ["?address=" + BRETT + "&chain=tron", "unsupported chain"],
  ["?address=0x1234&chain=base", "malformed evm address"],
  ["?address=" + BRETT + "&chain=solana", "evm address on solana"],
  ["?address=not-base58-0OIl&chain=solana", "malformed solana address"],
  ["?symbol=BT%20C", "symbol with space"],
  ["", "POST empty object", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }],
  ["", "POST array body with 11 symbols", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbol: eleven.split(",") }) }],
]) {
  calls = []; cgCalls = [];
  r = await paid(q, extra); j = await r.json();
  ok(r.status === 400 && calls.length === 0 && cgCalls.length === 0 && /no payment was taken/.test(j.error), `paid + ${label} -> 400, no facilitator/upstream call`);
}
calls = []; r = await paid("?address=" + BRETT + "&chain=tron"); j = await r.json();
ok(r.status === 400 && Array.isArray(j.supported_chains) && j.supported_chains.join() === "ethereum,base,bsc,arbitrum,polygon,optimism,avalanche,solana" && calls.length === 0, "unsupported chain lists supported chains");

// ---- 413 size guard before any payment work ----
calls = []; cgCalls = [];
r = await W.fetch(new Request(base + "/price?symbol=" + "B".repeat(2100)), env); ok(r.status === 413 && calls.length === 0 && !r.headers.get("PAYMENT-REQUIRED"), "huge query string -> 413 before 402");
r = await W.fetch(new Request(base + "/price", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbol: "X".repeat(9000) }) }), env); ok(r.status === 413 && calls.length === 0 && cgCalls.length === 0, "huge POST body -> 413, no calls");

// ---- happy path: BTC + ETH ----
calls = []; cgCalls = [];
r = await paid("?symbol=btc,eth"); j = await r.json();
ok(r.status === 200, "paid BTC+ETH -> 200");
ok(dec(r.headers.get("PAYMENT-RESPONSE")).transaction === "0xdeadbeef" && dec(r.headers.get("PAYMENT-RESPONSE")).success === true, "PAYMENT-RESPONSE receipt");
ok(calls.length === 2 && calls[0].u === "https://facilitator.payai.network/verify" && calls[1].u.endsWith("/settle"), "verify then settle via payai");
const sent = JSON.parse(calls[0].init.body); ok(sent.x402Version === 2 && sent.paymentRequirements.payTo === PAY && sent.paymentPayload.accepted.amount === "1000", "facilitator body shape");
ok(cgCalls.length === 1 && cgCalls[0].u.startsWith(SIMPLE_URL + "?"), "one CoinGecko simple/price call");
const cgu = new URL(cgCalls[0].u);
ok(cgu.searchParams.get("ids") === "bitcoin,ethereum" && cgu.searchParams.get("vs_currencies") === "usd" && cgu.searchParams.get("include_market_cap") === "true" && cgu.searchParams.get("include_24hr_vol") === "true" && cgu.searchParams.get("include_24hr_change") === "true" && cgu.searchParams.get("include_last_updated_at") === "true", "simple/price query params");
ok(cgCalls[0].init.headers["User-Agent"] === "NoJunk Crypto Price/1.0 (+https://nojunkcrypto.com)" && cgCalls[0].init.signal instanceof AbortSignal, "identifying User-Agent + abort signal on upstream fetch");
ok(!("x-cg-demo-api-key" in cgCalls[0].init.headers), "no CoinGecko key header when CG_DEMO_KEY unset");
ok(Array.isArray(j.results) && j.results.length === 2 && j.results[0].query === "BTC" && j.results[0].id === "bitcoin" && j.results[0].name === "Bitcoin" && j.results[0].symbol === "BTC", "BTC result identity");
ok(j.results[0].price_usd === 112345.67 && j.results[0].market_cap_usd === 2235000000000.12 && j.results[0].volume_24h_usd === 48200000000.46 && j.results[0].change_24h_pct === 1.2346 && j.results[0].last_updated === new Date(1760536931000).toISOString(), "BTC numeric fields");
ok(j.results[1].id === "ethereum" && j.results[1].name === "Ethereum" && j.results[1].price_usd === 4012.34 && j.results[1].change_24h_pct === -0.4568, "ETH result");
ok(Array.isArray(j.unknown) && j.unknown.length === 0 && j.source === "CoinGecko" && j.attribution === "Powered by CoinGecko (https://www.coingecko.com)" && !Number.isNaN(Date.parse(j.fetched_at)), "output envelope (unknown[], source, attribution, fetched_at)");

// ---- unknown symbol mixed in ----
calls = []; cgCalls = [];
r = await paid("?symbol=BTC,FAKECOIN,SOL"); j = await r.json();
ok(r.status === 200 && j.results.map((x) => x.query).join() === "BTC,SOL" && j.unknown.join() === "FAKECOIN" && settled(), "unknown symbol listed in unknown[], known ones priced, settled");
ok(new URL(cgCalls[0].u).searchParams.get("ids") === "bitcoin,solana", "unknown symbol not sent upstream");
// symbol dropped by upstream -> moves to unknown
r = await paid("?symbol=BTC,XRP"); j = await r.json();
ok(r.status === 200 && j.results.length === 1 && j.unknown.join() === "XRP", "symbol missing from upstream response -> unknown[]");

// ---- all unknown -> 404, no upstream, no settle ----
calls = []; cgCalls = [];
r = await paid("?symbol=FAKECOIN,NOPE"); j = await r.json();
ok(r.status === 404 && calls.length === 1 && calls[0].u.endsWith("/verify") && !settled() && cgCalls.length === 0 && j.unknown.join() === "FAKECOIN,NOPE" && /no payment was taken/.test(j.error) && !r.headers.get("PAYMENT-RESPONSE"), "all unknown -> 404, no upstream call, no settle");
// upstream returns nothing for the only known symbol -> 404, no settle
calls = []; r = await paid("?symbol=XRP"); j = await r.json();
ok(r.status === 404 && !settled() && j.unknown.join() === "XRP", "no upstream data -> 404, no settle");

// ---- dedupe, lowercase, 10 symbols ok, POST array ----
cgCalls = []; r = await paid("?symbol=btc,BTC,eth"); j = await r.json();
ok(r.status === 200 && j.results.length === 2 && new URL(cgCalls[0].u).searchParams.get("ids") === "bitcoin,ethereum", "duplicates collapsed, case-insensitive");
r = await paid("?symbol=BTC,ETH,SOL,XRP,BNB,DOGE,ADA,TRX,LINK,AVAX"); ok(r.status === 200, "exactly 10 symbols accepted");
r = await paid("", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbol: ["sol", "eth"] }) }); j = await r.json();
ok(r.status === 200 && j.results.map((x) => x.query).join() === "SOL,ETH", "paid POST with symbol array");
r = await paid("", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbols: "BTC" }) }); j = await r.json();
ok(r.status === 200 && j.results[0].id === "bitcoin", "POST 'symbols' alias accepted");

// ---- on-chain token ----
calls = []; cgCalls = [];
r = await paid("?address=0x532F27101965dd16442E59d40670FaF5eBB142E4&chain=base"); j = await r.json();
ok(r.status === 200 && settled(), "on-chain token -> 200, settled");
ok(cgCalls.length === 1 && cgCalls[0].u === "https://api.geckoterminal.com/api/v2/networks/base/tokens/" + BRETT, "keyless on-chain uses GeckoTerminal public endpoint with lowercased address");
const t = j.results[0];
ok(j.results.length === 1 && t.query === BRETT && t.id === ONCHAIN.data.id && t.name === "Brett" && t.symbol === "BRETT" && t.chain === "base" && t.address === BRETT, "on-chain identity fields");
ok(t.price_usd === 0.0412345678 && t.market_cap_usd === 407000000 && t.volume_24h_usd === 9876543.21 && t.fdv_usd === 408645123.5 && t.liquidity_usd === 12345678.9 && t.decimals === 18 && t.change_24h_pct === null && t.last_updated === j.fetched_at, "on-chain numeric fields (price, mcap, vol h24, fdv, liquidity)");
ok(j.unknown.length === 0 && j.source === "CoinGecko" && j.attribution.includes("coingecko.com"), "on-chain envelope");
// network id mapping
for (const [chain, net] of [["ethereum", "eth"], ["base", "base"], ["bsc", "bsc"], ["arbitrum", "arbitrum"], ["polygon", "polygon_pos"], ["optimism", "optimism"], ["avalanche", "avax"]]) {
  cgCalls = []; r = await paid(`?address=${BRETT}&chain=${chain}`);
  ok(r.status === 200 && cgCalls[0].u.includes(`/networks/${net}/tokens/`), `chain ${chain} -> network ${net}`);
}
cgCalls = []; r = await paid("?address=DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263&chain=solana"); j = await r.json();
ok(r.status === 200 && cgCalls[0].u.includes("/networks/solana/tokens/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263") && j.results[0].query === "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", "solana mint address accepted, case preserved");
cgCalls = []; r = await paid(`?address=${BRETT}&chain=ETH`); ok(r.status === 200 && cgCalls[0].u.includes("/networks/eth/"), "chain alias/case (ETH -> ethereum)");
r = await paid("", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: BRETT, chain: "base" }) }); ok(r.status === 200, "on-chain via POST");
mode = "tok404"; calls = []; r = await paid(`?address=${BRETT}&chain=base`); j = await r.json();
ok(r.status === 404 && !settled() && /not found/.test(j.error) && j.unknown[0] === BRETT, "unknown on-chain token -> 404, no settle");
mode = "good";

// ---- CG_DEMO_KEY: header sent + CoinGecko on-chain host used ----
const envK = { PAY_TO: PAY, CG_DEMO_KEY: "CG-testkey123" };
cgCalls = []; r = await paid("?symbol=BTC", {}, envK); j = await r.json();
ok(r.status === 200 && cgCalls[0].init.headers["x-cg-demo-api-key"] === "CG-testkey123" && cgCalls[0].u.startsWith(SIMPLE_URL), "x-cg-demo-api-key header sent when CG_DEMO_KEY set");
ok(!JSON.stringify(j).includes("CG-testkey123"), "key never returned in body");
cgCalls = []; r = await paid(`?address=${BRETT}&chain=polygon`, {}, envK);
ok(r.status === 200 && cgCalls[0].u === "https://api.coingecko.com/api/v3/onchain/networks/polygon_pos/tokens/" + BRETT && cgCalls[0].init.headers["x-cg-demo-api-key"] === "CG-testkey123", "with key, on-chain uses api.coingecko.com/onchain + key header");
cgCalls = []; r = await paid("?symbol=BTC"); ok(r.status === 200 && !("x-cg-demo-api-key" in cgCalls[0].init.headers), "header absent again without key");

// ---- failures ----
const bad = { ...payload, accepted: { ...payload.accepted, amount: "1" } };
r = await W.fetch(new Request(base + "/price?symbol=BTC", { headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(bad)).toString("base64") } }), env); ok(r.status === 402, "underpaid accepted -> 402");
r = await W.fetch(new Request(base + "/price?symbol=BTC", { headers: { "PAYMENT-SIGNATURE": "!!!not-base64!!!" } }), env); ok(r.status === 400, "garbage payment header -> 400");
mode = "badverify"; calls = []; cgCalls = []; r = await paid("?symbol=BTC"); ok(r.status === 402 && dec(r.headers.get("PAYMENT-REQUIRED")).error === "insufficient_funds" && calls.length === 1 && cgCalls.length === 0, "verify fail -> 402, no upstream call");
mode = "badsettle"; calls = []; r = await paid("?symbol=BTC"); j = await r.text(); ok(r.status === 402 && j.trim() === "{}" && !j.includes("112345") && dec(r.headers.get("PAYMENT-RESPONSE")).success === false && dec(r.headers.get("PAYMENT-RESPONSE")).errorReason === "invalid_transaction_state", "settle fail -> 402, empty body, no data leaked");
mode = "cg429"; calls = []; cgCalls = []; r = await paid("?symbol=BTC"); j = await r.json(); ok(r.status === 502 && calls.length === 1 && calls[0].u.endsWith("/verify") && !settled() && !r.headers.get("PAYMENT-RESPONSE") && j.upstream_status === 429 && /no payment was taken/.test(j.error), "upstream 429 -> 502, not settled");
mode = "cg500"; calls = []; r = await paid("?symbol=BTC"); ok(r.status === 502 && !settled(), "upstream 500 -> 502, not settled");
mode = "cg500"; calls = []; r = await paid(`?address=${BRETT}&chain=base`); ok(r.status === 502 && !settled(), "on-chain upstream 500 -> 502, not settled");
mode = "cgtimeout"; calls = []; r = await paid("?symbol=BTC"); j = await r.json(); ok(r.status === 502 && !settled() && /aborted/i.test(j.detail || ""), "upstream timeout/abort -> 502, not settled");
mode = "good";

// ---- caches.default guard: works with a stub cache, hits cache on second call, 30s TTL ----
const store = new Map();
globalThis.caches = { default: { match: async (k) => (store.has(String(k)) ? new Response(store.get(String(k)).body, { headers: { "Content-Type": "application/json" } }) : undefined), put: async (k, res) => { store.set(String(k), { body: await res.text(), cc: res.headers.get("Cache-Control") }); } } };
cgCalls = []; r = await paid("?symbol=BTC,ETH"); await new Promise((s) => setTimeout(s, 10)); r = await paid("?symbol=BTC,ETH"); j = await r.json();
ok(cgCalls.length === 1 && store.size === 1 && r.status === 200 && j.results.length === 2, "upstream cached via caches.default (second call served from cache)");
ok([...store.values()][0].cc === "public, max-age=30", "cache TTL is 30 seconds");
cgCalls = []; await paid("?symbol=SOL"); await new Promise((s) => setTimeout(s, 10)); ok(cgCalls.length === 1 && store.size === 2, "different symbols -> different cache key");
// failed upstream responses are not cached
mode = "cg429"; cgCalls = []; await paid("?symbol=DOGE"); mode = "good"; await paid("?symbol=DOGE"); await new Promise((s) => setTimeout(s, 10));
ok(cgCalls.length === 2 && store.size === 3, "429 response not cached; retry refetches");
delete globalThis.caches;

// ---- openapi + POST probe ----
r = await W.fetch(new Request(base + "/openapi.json"), env); const o = await r.json();
const g = o.paths["/price"].get, p = o.paths["/price"].post;
ok(r.status === 200 && o.openapi === "3.1.0" && o.info.title === "Crypto Price" && o.info["x-guidance"].includes("$0.001") && /attribution|Powered by CoinGecko/.test(o.info["x-guidance"]) && g["x-payment-info"].price.amount === "0.001000" && g["x-payment-info"].price.mode === "fixed" && p["x-payment-info"].protocols[0].x402 && p.requestBody.content["application/json"].schema.properties.symbol && g.parameters.map((x) => x.name).join() === "symbol,address,chain" && g.responses["402"] && p.responses["402"] && g.responses["404"] && g.responses["502"], "openapi.json valid (x-guidance mentions attribution)");
r = await W.fetch(new Request(base + "/.well-known/openapi.json"), env); ok(r.status === 200, "well-known openapi alias");
r = await W.fetch(new Request(base + "/price", { method: "POST" }), env); ok(r.status === 402 && r.headers.get("PAYMENT-REQUIRED"), "POST probe without payment -> 402");
r = await W.fetch(new Request(base + "/price", { method: "PUT" }), env); ok(r.status === 405, "PUT -> 405");
r = await W.fetch(new Request(base + "/nope"), env); ok(r.status === 404, "unknown path -> 404");
r = await W.fetch(new Request(base + "/price?symbol=BTC"), { PAY_TO: "nope" }); ok(r.status === 500, "bad PAY_TO -> 500");

// ---- CDP Ed25519 ----
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const jwk = privateKey.export({ format: "jwk" });
const secret = Buffer.concat([Buffer.from(jwk.d, "base64url"), Buffer.from(jwk.x, "base64url")]).toString("base64");
const envC = { PAY_TO: PAY, CDP_API_KEY_ID: "test-key-id", CDP_API_KEY_SECRET: secret };
calls = [];
r = await W.fetch(new Request(base + "/price?symbol=BTC", { headers: { "PAYMENT-SIGNATURE": hdr } }), envC);
ok(r.status === 200 && calls[0].u === "https://api.cdp.coinbase.com/platform/v2/x402/verify", "cdp facilitator used");
const checkJwt = (tok, pub, uri, alg) => { const [h, pl, s] = tok.split("."); const H = JSON.parse(Buffer.from(h, "base64url")), P = JSON.parse(Buffer.from(pl, "base64url"));
  const sigOk = alg === "EdDSA" ? nverify(null, Buffer.from(h + "." + pl), pub, Buffer.from(s, "base64url")) : nverify("sha256", Buffer.from(h + "." + pl), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
  return sigOk && H.alg === alg && H.kid === "test-key-id" && H.nonce.length === 32 && P.iss === "cdp" && P.sub === "test-key-id" && P.uris[0] === uri && P.exp - P.nbf === 120; };
ok(checkJwt(calls[0].init.headers.Authorization.slice(7), publicKey, "POST api.cdp.coinbase.com/platform/v2/x402/verify", "EdDSA"), "Ed25519 JWT valid (verify)");
ok(checkJwt(calls[1].init.headers.Authorization.slice(7), publicKey, "POST api.cdp.coinbase.com/platform/v2/x402/settle", "EdDSA"), "Ed25519 JWT valid (settle)");
const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pem = ec.privateKey.export({ type: "sec1", format: "pem" });
calls = [];
r = await W.fetch(new Request(base + "/price?symbol=BTC", { headers: { "PAYMENT-SIGNATURE": hdr } }), { ...envC, CDP_API_KEY_SECRET: pem.replace(/\n/g, "\\n") });
ok(r.status === 200 && checkJwt(calls[0].init.headers.Authorization.slice(7), ec.publicKey, "POST api.cdp.coinbase.com/platform/v2/x402/verify", "ES256"), "EC SEC1 JWT valid");
r = await W.fetch(new Request(base + "/"), envC); j = await r.json(); ok(j.facilitator === "cdp" && !JSON.stringify(j).includes(secret.slice(0, 12)), "info reports cdp, leaks no secret");

// ---- symbol table sanity (spot-check well-known ids) ----
r = await W.fetch(new Request(base + "/"), env); j = await r.json();
const sym = j.supported_symbols;
ok(["BTC", "ETH", "SOL", "XRP", "USDT", "BNB", "DOGE", "ADA", "TRX", "LINK", "AVAX", "SUI", "XLM", "HBAR", "SHIB", "TON", "DOT", "LTC", "BCH", "PEPE", "UNI", "NEAR", "AAVE", "APT", "ICP"].every((s) => sym.includes(s)), "all required tickers present in table");
cgCalls = [];
for (const [s, id] of [["XRP", "ripple"], ["USDT", "tether"], ["BNB", "binancecoin"], ["AVAX", "avalanche-2"], ["XLM", "stellar"], ["HBAR", "hedera-hashgraph"], ["SHIB", "shiba-inu"], ["TON", "the-open-network"], ["DOT", "polkadot"], ["LTC", "litecoin"], ["BCH", "bitcoin-cash"], ["UNI", "uniswap"], ["APT", "aptos"], ["ICP", "internet-computer"], ["NEAR", "near"], ["PEPE", "pepe"], ["AAVE", "aave"], ["SUI", "sui"]]) {
  await paid("?symbol=" + s);
  const got = new URL(cgCalls.pop().u).searchParams.get("ids");
  ok(got === id, `${s} -> ${id}`);
}

console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exitCode = fails ? 1 : 0;
